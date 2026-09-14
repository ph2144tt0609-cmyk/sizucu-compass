// 合言葉で暗号化した状態を Supabase の app_state テーブルに置くための入れ物。
//
// ・保存されるのは AES-256-GCM の暗号文だけ。合言葉を知らなければ中身は読めない。
// ・そのため RLS は anon にも開けてある（＝ログイン不要でどの端末からでも同じ数字が見える）。
//   守っているのは「合言葉」であって「ログイン」ではない、という設計。
// ・経営ダッシュボード（Netlify Functions + Blobs）が採っていた方式と同じモデルで、
//   保存先を Supabase に寄せて1つにまとめたもの。
import { supabase } from './supabase'

const PASS_KEY = 'sizucu-dash-pass'

export const getPass = () => {
  try {
    return sessionStorage.getItem(PASS_KEY) || '1111'
  } catch {
    return '1111'
  }
}
export const setPass = (p: string) => {
  try {
    sessionStorage.setItem(PASS_KEY, p)
  } catch {
    /* 無視 */
  }
}
export const clearPass = () => {
  try {
    sessionStorage.removeItem(PASS_KEY)
  } catch {
    /* 無視 */
  }
}

export interface Enc {
  salt: string
  iv: string
  ct: string
  iter: number
}

const ITER = 200000

const b2u = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const u2b = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s)
}

async function deriveKey(pass: string, salt: Uint8Array, iter: number) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pass) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: iter, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJSON(obj: unknown, pass = getPass()): Promise<Enc> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(pass, salt, ITER)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(obj)) as BufferSource,
  )
  return { salt: u2b(salt), iv: u2b(iv), ct: u2b(ct), iter: ITER }
}

export async function decryptJSON<T>(enc: Enc, pass = getPass()): Promise<T> {
  const key = await deriveKey(pass, b2u(enc.salt), enc.iter)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b2u(enc.iv) as BufferSource },
    key,
    b2u(enc.ct) as BufferSource,
  )
  return JSON.parse(new TextDecoder().decode(pt)) as T
}

// 保存キー（1行1機能）
export const CLOUD_KEYS = {
  subsidies: 'subsidies',
  baseup: 'baseup',
  // 薬局別（v3）から法人1本（v4）へ移す前のベースアップデータの控え。書き込みは移行時の1回だけ。
  baseupBackupV3: 'baseup-backup-v3',
  dashboard: 'dashboard-overrides',
} as const

/**
 * 読み込みの結果。null が返る理由を区別する。
 *   ok    … 読めた
 *   empty … まだ1件も保存されていない（＝本当に空）
 *   error … 通信・サーバ側で失敗した（＝中身は不明。空として扱ってはいけない）
 *   locked… 復号できない（合言葉違い or 壊れている）
 */
export type LoadStatus = 'ok' | 'empty' | 'error' | 'locked'

/**
 * クラウドから読んで復号し、結果と一緒に「なぜ null なのか」を返す。
 * 早見表のように「入っていないデータ」を出す画面では、
 * 読み込み失敗を『0件』と表示してしまうと嘘になるので、この形で受け取る。
 * 読めたときは、暗号文のまま端末の控えにも写しておく（→ loadGuarded）。
 */
export async function cloudLoadEx<T>(key: string): Promise<{ data: T | null; status: LoadStatus }> {
  const { data, error } = await supabase
    .from('app_state')
    .select('enc')
    .eq('key', key)
    .maybeSingle()
  if (error) {
    console.error(error)
    return { data: null, status: 'error' }
  }
  if (!data?.enc) return { data: null, status: 'empty' }
  try {
    const obj = await decryptJSON<T>(data.enc as Enc)
    putCache(key, data.enc as Enc)
    return { data: obj, status: 'ok' }
  } catch {
    return { data: null, status: 'locked' } // 合言葉違い or 壊れている
  }
}

/** クラウドから読んで復号する。無い／読めないときは null（呼び出し側で初期値を使う） */
export async function cloudLoad<T>(key: string): Promise<T | null> {
  return (await cloudLoadEx<T>(key)).data
}

/** 暗号化してクラウドへ保存する */
export async function cloudSave(key: string, obj: unknown): Promise<boolean> {
  try {
    const enc = await encryptJSON(obj)
    const { error } = await supabase
      .from('app_state')
      .upsert({ key, enc, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    if (error) {
      console.error(error)
      return false
    }
    putCache(key, enc)
    return true
  } catch (e) {
    console.error(e)
    return false
  }
}

// ── 端末の控え（クラウドに届かないときの見るだけ用）──────────────────
// 正本はあくまで Supabase。控えは「最後にクラウドと読み書きできた時点」の写しで、
// 暗号文のまま localStorage に置く（合言葉なしでは読めない＝クラウドと同じ守り方）。
const CACHE_PREFIX = 'sizucu-compass-cache:'

function putCache(key: string, enc: Enc) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ enc, at: new Date().toISOString() }))
  } catch {
    /* 容量超過・プライベートモードなどは無視（控えが無いだけ） */
  }
}

async function readCache<T>(key: string): Promise<{ data: T; at: string } | null> {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const { enc, at } = JSON.parse(raw) as { enc: Enc; at: string }
    return { data: await decryptJSON<T>(enc), at }
  } catch {
    return null
  }
}

/**
 * 各タブ共通の読み込み。どのタブも同じ振る舞いにするための1か所。
 *   ok    → クラウドの中身。編集できる
 *   empty → 本当にまだ何も保存されていない。編集できる（初回）
 *   error / locked → 【端末の控え】を見せる（読み直しは supabase-js が済ませている）。
 *                    控えも無ければ中身なし。どちらも readOnly＝保存させない
 * ★読み込みに失敗した状態で保存させると、空やひな形でクラウドの本物を上書きしてしまう★
 *   （2026-09-14 に Supabase が一時停止し、補助金が空欄・ベースアップがひな形で表示された）
 */
export interface GuardedLoad<T> {
  data: T | null
  status: LoadStatus
  source: 'cloud' | 'cache' | 'none'
  cachedAt: string | null // 控えを出したときの「いつ時点か」
  readOnly: boolean
}

export async function loadGuarded<T>(key: string): Promise<GuardedLoad<T>> {
  // 一過性の失敗の読み直しは supabase-js（postgrest-js）が GET を 1s・2s・4s 待ちで3回やってくれる。
  // ここで重ねて読み直すと、止まっているときに「読み込み中」が倍（約15秒）になるので重ねない
  const res = await cloudLoadEx<T>(key).catch(() => ({
    data: null,
    status: 'error' as LoadStatus,
  }))
  if (res.status === 'ok') return { ...res, source: 'cloud', cachedAt: null, readOnly: false }
  if (res.status === 'empty') return { ...res, source: 'none', cachedAt: null, readOnly: false }
  const cache = await readCache<T>(key)
  return cache
    ? { data: cache.data, status: res.status, source: 'cache', cachedAt: cache.at, readOnly: true }
    : { data: null, status: res.status, source: 'none', cachedAt: null, readOnly: true }
}
