// 調剤基本料の判定（令和6年〜の施設基準）。
//
// ★調剤基本料2（30点）になるのは「月平均受付回数 1,800回超」かつ「処方箋集中率 85%超」の"両方"に該当したときのみ。★
//   受付回数：時間外・休日・深夜加算を算定した処方箋は除外できる（＝除外枚数を差し引く）。
//   集中率：最も多い1医療機関の割合。他科（別医療機関）が多いほど下がる。
//   判定期間：前年5/1〜当年4/30 の実績（翌年6/1〜適用）。
//
// 判定は「調剤基本料 判定」タブと早見表の両方が使うので、計算はここ1か所に置く。

export const RECEIPT_LIMIT = 1800 // 月平均受付回数の基準（超で条件成立）
export const CONC_LIMIT = 85 // 処方箋集中率の基準%（超で条件成立）

export const BASIC_MONTHS = [
  '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '1月', '2月', '3月', '4月',
]
const PREV_MONTHS = new Set(['5月', '6月', '7月', '8月', '9月']) // 前会計年度(P-1)から取る月

// 各月がどの会計年度キーに属するか（5〜9月=P-1 / 10〜4月=P）
export const fiscalOf = (P, month) => String(PREV_MONTHS.has(month) ? P - 1 : P)

/** 薬局 pharm の 基本料期間 P（P年5/1〜P+1年4/30）の月次を組み立てる */
export function basicRows(pharm, P) {
  const prev = (pharm.years && pharm.years[String(P - 1)]) || []
  const cur = (pharm.years && pharm.years[String(P)]) || []
  const find = (rows, m) => rows.find((r) => r.period === m)
  return BASIC_MONTHS.map((m) => {
    const src = PREV_MONTHS.has(m) ? prev : cur
    const r = find(src, m)
    return {
      period: m,
      fiscalYear: fiscalOf(P, m),
      total: r ? r.total : null, // 受付回数（除外前）
      other: r ? r.other : 0, // 他科枚数
    }
  })
}

/**
 * 選べる基本料期間の一覧（新しい順）。
 * 各会計年度K は 基本料期間K（10〜4月分）と K+1（5〜9月分）に使われるので、両方を候補に含める。
 */
export function basicPeriods(pharmData) {
  const s = new Set()
  pharmData.forEach((p) =>
    Object.keys(p.years || {}).forEach((y) => {
      const k = Number(y)
      s.add(k)
      s.add(k + 1)
    }),
  )
  return [...s].sort((a, b) => b - a)
}

/**
 * 薬局1件の判定。excluded＝{薬局名:{会計年度:{月:除外枚数}}}
 * 返す値：n=登録月数／avgAdj=除外後の月平均受付回数／conc=集中率／
 *         overReceipt・overConc=各条件に該当か／isBasic2=基本料2に該当か
 */
export function judgeBasicFee(pharm, P, excluded = {}) {
  const rows = basicRows(pharm, P)
  const exOf = (r) => Number(((excluded[pharm.name] || {})[r.fiscalYear] || {})[r.period] || 0)
  const present = rows.filter((r) => r.total != null)
  const n = present.length
  const sumTotal = present.reduce((s, r) => s + r.total, 0)
  const sumOther = present.reduce((s, r) => s + (r.other || 0), 0)
  const sumEx = present.reduce((s, r) => s + exOf(r), 0)
  const avgAdj = n ? (sumTotal - sumEx) / n : 0 // 除外後の月平均受付回数
  const avgRaw = n ? sumTotal / n : 0
  const conc = sumTotal ? ((sumTotal - sumOther) / sumTotal) * 100 : 0 // 集中率＝最多院/全体（他科を除いた分）
  const overReceipt = n > 0 && avgAdj > RECEIPT_LIMIT
  const overConc = n > 0 && conc > CONC_LIMIT
  return {
    rows,
    exOf,
    n,
    sumTotal,
    sumOther,
    sumEx,
    avgAdj,
    avgRaw,
    conc,
    overReceipt,
    overConc,
    isBasic2: overReceipt && overConc,
  }
}
