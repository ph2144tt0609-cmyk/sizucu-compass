// 経営ダッシュボードタブが持っている「処方箋枚数(total)」を、
// ベースアップ評価料の算定回数として読み出すための橋渡し（読み取り専用）。
//
// 処方箋枚数 ＝ 調剤ベースアップ評価料の算定回数。
// どちらもレセコン日計明細の「処方箋枚数(介護等除く)が1以上の行数」で、同じ数字になる。
// そのため入力の正本は経営ダッシュボードタブ側に置き、ここでは読むだけにする。
//
// データの持ち方は DashboardTab.jsx と同じで、
//   暗号化seed（基準値）＋ 画面からの手入力(override)
// の重ね合わせ。override はクラウド（Supabase）とこの端末の localStorage の両方にあるので、
// ダッシュボードタブと同じく「中身があって新しい方」を採用する。
import { seed } from './dashboard/seed.js'
import { cloudLoad, CLOUD_KEYS } from './cloud'
import type { ReceiptsByShop } from './baseupCalc'

// 会計年度は10月始まり（10月→翌9月）。
// 年度2025 の 10〜12月 → 2025-10〜2025-12、1〜9月 → 2026-01〜2026-09。
const FISCAL_MONTHS = [
  '10月', '11月', '12月', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月',
]

export function periodToYm(fiscalYear: string | number, period: string): string | null {
  if (FISCAL_MONTHS.indexOf(period) < 0) return null
  const y = Number(fiscalYear)
  if (!Number.isFinite(y)) return null
  const m = Number(period.replace('月', ''))
  if (!m) return null
  const year = m >= 10 ? y : y + 1
  return `${year}-${String(m).padStart(2, '0')}`
}

const OV_KEY = 'pharmacy-dashboard-overrides-v1' // DashboardTab.jsx と同じキー

interface MonthValue {
  total?: number
}
export interface Overrides {
  pharm?: Record<string, Record<string, Record<string, MonthValue>>>
  corpLabor?: Record<string, unknown>
  years?: unknown[]
  excluded?: Record<string, unknown>
  _ts?: number
}

function loadLocalOverrides(): Overrides | null {
  try {
    const s = localStorage.getItem(OV_KEY)
    if (!s) return null
    const o = JSON.parse(s)
    return o && typeof o === 'object' ? (o as Overrides) : null
  } catch {
    return null
  }
}

// 中身が1件でもあるか（空データを「新しい」と見て実データを取りこぼさないための判定）
const hasData = (o: Overrides | null) =>
  !!(
    o &&
    (Object.keys(o.pharm || {}).length ||
      Object.keys(o.corpLabor || {}).length ||
      (o.years || []).length ||
      Object.keys(o.excluded || {}).length)
  )

interface SeedRow {
  period: string
  total?: number
}
interface SeedPharmacy {
  name: string
  years?: Record<string, SeedRow[]>
}

/**
 * 経営ダッシュボードの処方箋枚数を ym → 薬局名 → 回数 の形で返す。
 * 薬局名の並び（shops）は月次明細の内訳列に使う。
 */
export async function loadDashboardReceipts(): Promise<{
  receipts: ReceiptsByShop
  shops: string[]
}> {
  const local = loadLocalOverrides()
  // 通信できないときはローカルの内容だけで続ける
  const cloud = await cloudLoad<Overrides>(CLOUD_KEYS.dashboard).catch(() => null)
  const useCloud =
    hasData(cloud) && (!hasData(local) || (cloud?._ts || 0) >= (local?._ts || 0))
  return buildReceipts((useCloud ? cloud : local) || {})
}

/**
 * 手入力(override)と暗号化seedから、受付回数を ym → 薬局名 → 回数 の形に組み立てる（通信しない）。
 * 早見表はすでに override を読んでいるので、こちらを直接呼んで二重に読みに行かない。
 */
export function buildReceipts(ov: Overrides): {
  receipts: ReceiptsByShop
  shops: string[]
} {
  const receipts: ReceiptsByShop = {}
  const shops: string[] = []
  const put = (ym: string, shop: string, total: unknown) => {
    const n = Number(total) || 0
    if (n <= 0) return // 0 は「その月は未入力」とみなす
    if (!receipts[ym]) receipts[ym] = {}
    receipts[ym][shop] = n
    if (!shops.includes(shop)) shops.push(shop)
  }

  // ① 基準値（暗号化seed。Gate が復号して注入している）
  const pharmacies = (seed.pharmacies || []) as SeedPharmacy[]
  pharmacies.forEach((p) => {
    if (!shops.includes(p.name)) shops.push(p.name)
    Object.entries(p.years || {}).forEach(([y, rows]) => {
      ;(rows || []).forEach((r) => {
        const ym = periodToYm(y, r.period)
        if (ym) put(ym, p.name, r.total)
      })
    })
  })

  // ② 画面からの手入力（同じ月があれば、こちらが基準値に優先する）
  Object.entries(ov.pharm || {}).forEach(([shop, byYear]) => {
    Object.entries(byYear || {}).forEach(([y, byPeriod]) => {
      Object.entries(byPeriod || {}).forEach(([period, v]) => {
        const ym = periodToYm(y, period)
        if (ym) put(ym, shop, v?.total)
      })
    })
  })

  return { receipts, shops }
}
