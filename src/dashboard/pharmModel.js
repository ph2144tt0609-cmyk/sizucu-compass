// 経営数字の「持ち方」をまとめた場所。
//
// 同じ数字を 3か所（経営ダッシュボード／早見表／調剤基本料の判定）が見るので、
//   ・手入力(override)の読み書き
//   ・暗号化seed（基準値）との重ね合わせ
//   ・派生指標（集中率・技術料率など）
//   ・法人（各薬局の合算）の作り方
// はここ1か所だけに置く。画面側でもう一度計算しない＝数字がズレない。
import { seed } from './seed.js'
import { cloudLoadEx, CLOUD_KEYS } from '../cloud'
import { periodToYm } from '../dashboardReceipts'

export const CORP_NAME = '株式会社しずく' // 法人（各薬局の合算を自動表示）
export const OV_KEY = 'pharmacy-dashboard-overrides-v1' // 画面から手入力した月次データ

// 会計年度は10月始まり（10月→翌9月）。この並びで月を並べる。
export const FISCAL_MONTHS = [
  '10月', '11月', '12月', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月',
]
export const monthRank = (p) => {
  const i = FISCAL_MONTHS.indexOf(p)
  return i < 0 ? 99 : i
}
export const sortFiscal = (rows) => [...rows].sort((a, b) => monthRank(a.period) - monthRank(b.period))

// ── 手入力(override)の読み書き ───────────────────────────
// 形＝{ pharm:{ "薬局名":{ "年度":{ "月":{total,other,tech,drug} } } }, corpLabor:{ "年度":{ "月":labor } }, years:[追加年度] }
export function loadOverrides() {
  try {
    const o = JSON.parse(localStorage.getItem(OV_KEY))
    if (o && typeof o === 'object')
      return {
        pharm: o.pharm || {},
        corpLabor: o.corpLabor || {},
        years: o.years || [],
        excluded: o.excluded || {},
        _ts: o._ts || 0,
      }
  } catch {
    // 無視
  }
  return { pharm: {}, corpLabor: {}, years: [], excluded: {}, _ts: 0 }
}

// 手入力が1件でもあるか（空データで実データを上書きしないための判定）
export const ovHasData = (o) =>
  !!(
    o &&
    (Object.keys(o.pharm || {}).length ||
      Object.keys(o.corpLabor || {}).length ||
      (o.years || []).length ||
      Object.keys(o.excluded || {}).length)
  )

export function saveOverrides(o) {
  try {
    localStorage.setItem(OV_KEY, JSON.stringify(o))
  } catch {
    // 無視
  }
}

/**
 * クラウドとこの端末の手入力を突き合わせ、「中身があって新しい方」を返す（読み取り専用）。
 * status も返すのは、早見表が「読み込み失敗」と「本当に空」を区別するため
 * （失敗を空として表示すると、入っているはずの数字が消えたように見えてしまう）。
 */
export async function loadOverridesMerged() {
  const local = loadOverrides()
  const res = await cloudLoadEx(CLOUD_KEYS.dashboard).catch(() => ({ data: null, status: 'error' }))
  const cloud = res.data
  const useCloud = ovHasData(cloud) && (!ovHasData(local) || (cloud._ts || 0) >= (local._ts || 0))
  const ov = useCloud
    ? {
        pharm: cloud.pharm || {},
        corpLabor: cloud.corpLabor || {},
        years: cloud.years || [],
        excluded: cloud.excluded || {},
        _ts: cloud._ts || 0,
      }
    : local
  return { ov, status: res.status, usedLocal: !useCloud && ovHasData(local) }
}

// ── 派生指標 ───────────────────────────────────────────
export function enrich(rows) {
  return rows.map((r) => {
    const main = r.total - r.other // メインクリニック枚数
    return {
      ...r,
      main,
      concentration: r.total ? (main / r.total) * 100 : 0, // 集中率
      otherRate: r.total ? (r.other / r.total) * 100 : 0, // 他科率
      techRate: r.sales ? (r.tech / r.sales) * 100 : 0, // 技術料率
      perRx: r.total ? r.sales / r.total : 0, // 処方箋1枚あたり売上
      laborDist: r.labor && r.tech ? (r.labor / r.tech) * 100 : 0, // 労働分配率（人件費÷技術料）
    }
  })
}

// 法人（株式会社しずく）の月次を各薬局の合算で自動生成する。
// total/other/sales/tech/drug は薬局の単純合計。labor（人件費）は合算できないので corpLabor から補う。
// ★半月対策★：その年度にデータを持つ全薬局がそろって報告している月だけを合算対象にする。
export function buildCorpRows(pharmData, corpLabor, year) {
  const contributing = pharmData.filter((p) => p.years && p.years[year] && p.years[year].length)
  const nP = contributing.length
  const map = new Map() // period -> 集計（count=その月を報告した薬局数）
  contributing.forEach((p) => {
    p.years[year].forEach((r) => {
      const a = map.get(r.period) || { period: r.period, total: 0, other: 0, sales: 0, tech: 0, drug: 0, count: 0 }
      a.total += r.total || 0
      a.other += r.other || 0
      a.sales += r.sales || 0
      a.tech += r.tech || 0
      a.drug += r.drug || 0
      a.count += 1
      map.set(r.period, a)
    })
  })
  const labor = (corpLabor && corpLabor[year]) || {}
  const rows = [...map.values()]
    .filter((a) => a.count === nP) // 全薬局がそろった月のみ
    .map(({ count, ...rest }) => ({ ...rest, labor: labor[rest.period] || 0 }))
  return sortFiscal(rows)
}

// ── seed と手入力の重ね合わせ ───────────────────────────
/** 薬局ごとの月次（seed の基準値に、手入力を上書きしたもの） */
export function mergePharmData(overrides) {
  return (seed.pharmacies || []).map((p) => {
    const ov = (overrides.pharm && overrides.pharm[p.name]) || {}
    const yearKeys = new Set([...Object.keys(p.years || {}), ...Object.keys(ov)])
    const years = {}
    yearKeys.forEach((y) => {
      const map = new Map(((p.years && p.years[y]) || []).map((r) => [r.period, r]))
      Object.entries(ov[y] || {}).forEach(([period, v]) => {
        map.set(period, {
          period,
          total: v.total || 0,
          other: v.other || 0,
          tech: v.tech || 0,
          drug: v.drug || 0,
          sales: (v.tech || 0) + (v.drug || 0),
        })
      })
      years[y] = [...map.values()]
    })
    return { name: p.name, years }
  })
}

/** 法人の人件費（seed ＋ 手入力） */
export function mergeCorpLabor(overrides) {
  const out = { ...(seed.corpLabor || {}) }
  Object.entries(overrides.corpLabor || {}).forEach(([y, months]) => {
    out[y] = { ...(out[y] || {}), ...months }
  })
  return out
}

/** 存在する年度の一覧（新しい順） */
export function collectYears(overrides) {
  const s = new Set()
  ;(seed.pharmacies || []).forEach((p) => Object.keys(p.years || {}).forEach((y) => s.add(y)))
  Object.keys(seed.corpLabor || {}).forEach((y) => s.add(y))
  Object.values(overrides.pharm || {}).forEach((byY) => Object.keys(byY).forEach((y) => s.add(y)))
  Object.keys(overrides.corpLabor || {}).forEach((y) => s.add(y))
  ;(overrides.years || []).forEach((y) => s.add(y))
  return [...s].sort((a, b) => Number(b) - Number(a))
}

/** 指定した薬局（index が末尾＝法人）・年度の月次 */
export function rowsFor(pharmData, corpLabor, index, year) {
  if (index === pharmData.length) return buildCorpRows(pharmData, corpLabor, year)
  const p = pharmData[index]
  return sortFiscal((p && p.years && p.years[year]) || [])
}

/**
 * 年度をまたいで一列に並べた月次（古い順・ym 付き）。
 * 早見表の「直近の確定月」と「前月比」は、年度の切れ目（9月→10月）をまたぐので
 * 年度ごとの配列ではなくこの一本の並びで見る。
 */
export function seriesOf(pharmData, corpLabor, index, years) {
  const out = []
  ;[...years]
    .sort((a, b) => Number(a) - Number(b))
    .forEach((y) => {
      enrich(rowsFor(pharmData, corpLabor, index, y))
        // 枚数も売上も0の月は「枠だけあって未入力」なので、確定月として扱わない
        // （これを混ぜると早見表の「直近の確定月」が 0 の月になってしまう）
        .filter((r) => (r.total || 0) > 0 || (r.sales || 0) > 0)
        .forEach((r) => {
          out.push({ ...r, year: y, ym: periodToYm(y, r.period) || '' })
        })
    })
  return out.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0))
}
