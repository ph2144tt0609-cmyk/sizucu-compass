// 調剤ベースアップ評価料（令和8年度改定）の計算ロジックとデータ定義。
//   評価料収入   = 処方箋受付回数 × 点数(4点→2027-06以降8点) × 10円
//   残業代増額分 = (ベア相当額 + ベースアップ手当) ÷ 月平均所定労働時間 × 割増率 × 残業時間
//   小計         = ベア相当額 + ベースアップ手当 + 残業代増額分
//   増加分法定福利費 = 小計 × (係数 - 1)   ← 既定 16.5%（社会保険料など事業主負担の増加分）
//   賃金改善     = 小計 + 増加分法定福利費 = 小計 × 係数
// 画面（BaseupTab.tsx）から切り離してあるので、単体で呼び出して検算できる。
//
// 評価料は社員全体に配るものなので、職員・係数・判定は【法人1本】で管理する（v4）。
// 受付回数は経営ダッシュボードタブの「処方箋枚数(total)」を正本として自動参照し、
// ここでは薬局別の内訳と合計を受け取って計算するだけにする（同じ数字の二重入力をなくす）。

export const YEN_PER_POINT = 10
export const DOUBLE_FROM = '2027-06'
export const POINT_BASE = 4
// 評価料の算定開始月。これより前の月は経営ダッシュボードに数字があっても取り込まない。
export const FIRST_YM = '2026-06'

export const SCHEMA_VERSION = 5
// 収入の内訳を薬局別に見せるための並び順（法人＝この2薬局の合算）
export const PHARMACY_NAMES = ['緑ヶ丘薬局', '鷹匠薬局 公園店']
export const DEFAULT_FACTOR = 1.165 // 増加分法定福利費 16.5%（厚労省Q&Aの便宜計算値）
export const DEFAULT_OT_RATE = 1.25 // 時間外割増率（法定）
export const DEFAULT_HOURS = 160 // 月平均所定労働時間
// 過去の既定係数。保存データがこの値のまま（＝手動変更していない）なら現行既定へ置き換える。
//   1.29  = v1（法定福利費＋連動賞与）／ 1.168 = v2初期（16.8%と誤設定していた期間）
const LEGACY_FACTORS = [1.29, 1.168]

export interface BMonth {
  ym: string
  // 手動上書きの受付回数。manual=false のときは使わず、経営ダッシュボードの値を参照する。
  receipts: number
  // true＝この月だけ手入力で上書きしている（経営ダッシュボードに無い過去月・例外月の逃げ道）
  manual?: boolean
}
export interface BStaff {
  id: number
  name: string
  role: string
  baseUp: number // ベア相当額（月額）
  allowance: number // ベースアップ手当（月額）
  monthlyHours: number // 月平均所定労働時間
  overtimeHours: number // 月の残業時間
  startYm: string
  // 薬局別管理だった頃のデータを法人1本へ結合したときの出どころ（目視整理の手がかり）
  origin?: string
}
// 賃金台帳から読んだ、その職員のその月の実績。
// null＝台帳にその行が無い（職員マスタの固定値で補う）。
export interface BLedgerMonth {
  overtimeHours: number | null // 実残業時間
  baseUp: number | null // ベア相当額（台帳で指定した行の合計）
  allowance: number | null // ベースアップ手当（同上）
  employerIns: number | null // 事業主負担の社会保険料等（実額）
  paid: number | null // 支給合計（実額負担率の分母）
}

// 台帳のどの行を何として読むかの対応。台帳の様式が変わっても画面で直せるようにしておく。
export interface LedgerMap {
  overtime: string // 残業時間の行
  baseUp: string[] // ベア相当額に当たる行（複数可）
  allowance: string[] // ベースアップ手当に当たる行（複数可）
  employer: string[] // 事業主負担の行（実額モードで使う）
  paid: string // 支給合計の行
}

export const DEFAULT_LEDGER_MAP: LedgerMap = {
  overtime: '残業時間',
  baseUp: [],
  allowance: [],
  employer: [
    '健康保険料(会社)',
    '子ども・子育て支援金(会社)',
    '厚生年金保険料(会社)',
    '子ども・子育て拠出金(会社)',
    '雇用保険料(会社)',
    '労災保険料(会社)',
    '一般拠出金(会社)',
  ],
  paid: '支給合計',
}

// 増加分法定福利費の出し方。
//   fixed  … 厚労省Q&Aの便宜計算（既定16.5%）
//   actual … 賃金台帳の事業主負担額 ÷ 支給合計 を、その月・その人の負担率として使う
export type SurchargeMode = 'fixed' | 'actual'

// 職員1人ぶんの台帳データ。ym → その月の実績
export type StaffLedger = Record<string, BLedgerMonth>

export interface BaseupState {
  version: number
  months: BMonth[]
  staff: BStaff[]
  factor: number // 増加分法定福利費の係数
  overtimeRate: number // 時間外割増率
  // 賃金台帳から取り込んだ月別実績（職員ID → 年月 → 実績）
  ledger: Record<string, StaffLedger>
  ledgerMap: LedgerMap
  surchargeMode: SurchargeMode
}

// 経営ダッシュボードから読んだ受付回数。ym → 薬局名 → 回数
export type ReceiptsByShop = Record<string, Record<string, number>>

// 月次明細1行分（手動上書きと自動参照を解決したあとの姿）
export interface ResolvedMonth {
  ym: string
  receipts: number // 合計受付回数
  byShop: Record<string, number> // 薬局別の内訳（手動上書きの月は空）
  manual: boolean
  entered: boolean // 受付回数が確定している月か（未入力の月は集計から除外する）
}

export const ROLES = ['薬剤師', '事務職員', 'その他']

export function pointsForMonth(ym: string) {
  return ym >= DOUBLE_FROM ? POINT_BASE * 2 : POINT_BASE
}
// 算定年度ラベル。評価料の算定期間に合わせて6月始まり（6月〜翌5月）で区切る。
// 例: 2026-06〜2027-05 = 令和8年度、2027-06〜2028-05 = 令和9年度
export function fiscalLabel(ym: string) {
  const [y, m] = ym.split('-').map(Number)
  const startYear = m >= 6 ? y : y - 1
  return `令和${startYear - 2018}年度`
}
export function shortYm(ym: string) {
  const [y, m] = ym.split('-')
  return `${y.slice(2)}/${Number(m)}`
}
export function nextYm(ym: string) {
  let [y, m] = ym.split('-').map(Number)
  m++
  if (m > 12) {
    m = 1
    y++
  }
  return `${y}-${String(m).padStart(2, '0')}`
}
export const yen = (n: number) => Math.round(n).toLocaleString('ja-JP')

// 職員1人の月額内訳。ベア・手当で上がった時間単価から残業代の増額分も出す。
// surcharge（増加分法定福利費）は画面に列で出すため、charged との差として明示的に返す。
// 手入力で負の値が紛れても計算が壊れないよう、数値は0未満を切り上げる。
export function staffAmounts(s: BStaff, factor: number, otRate: number) {
  const nn = (v: unknown) => Math.max(0, Number(v) || 0)
  const bea = nn(s.baseUp)
  const allowance = nn(s.allowance)
  const hours = nn(s.monthlyHours)
  const otHours = nn(s.overtimeHours)
  const hourlyUp = hours > 0 ? (bea + allowance) / hours : 0
  const overtime = hourlyUp * otRate * otHours
  const gross = bea + allowance + overtime
  const charged = gross * factor
  return { bea, allowance, overtime, gross, surcharge: charged - gross, charged }
}

// 賃金台帳が入っている月は、その月の実績（残業時間・ベア・手当・事業主負担）で計算する。
// 台帳に無い項目は職員マスタの固定値で補うので、台帳が1枚も無くても今までどおり動く。
//   ・fromLedger  … その月に台帳の値を1つでも使ったか（画面で「台帳」と出すため）
//   ・surchargeRate … 実際に使った増加分法定福利費の率（実額モードの検算用）
export function staffAmountsAt(
  s: BStaff,
  ym: string,
  state: Pick<BaseupState, 'factor' | 'overtimeRate' | 'ledger' | 'surchargeMode'>,
) {
  const nn = (v: unknown) => Math.max(0, Number(v) || 0)
  const L = state.ledger?.[String(s.id)]?.[ym]
  const pick = (v: number | null | undefined, fallback: number) =>
    v == null ? { value: nn(fallback), used: false } : { value: nn(v), used: true }

  const bea = pick(L?.baseUp, s.baseUp)
  const allowance = pick(L?.allowance, s.allowance)
  const otHours = pick(L?.overtimeHours, s.overtimeHours)
  const hours = nn(s.monthlyHours)

  const hourlyUp = hours > 0 ? (bea.value + allowance.value) / hours : 0
  const overtime = hourlyUp * nn(state.overtimeRate) * otHours.value
  const gross = bea.value + allowance.value + overtime

  // 実額モード：事業主負担 ÷ 支給合計 をその月の負担率とする。
  // 台帳に両方そろっていない月は、便宜計算（係数）へ自動で戻す。
  const factor = nn(state.factor) || 1
  let rate = factor - 1
  let actual = false
  if (state.surchargeMode === 'actual' && L && L.employerIns != null && L.paid != null && L.paid > 0) {
    rate = Math.max(0, L.employerIns / L.paid)
    actual = true
  }
  const surcharge = gross * rate

  return {
    bea: bea.value,
    allowance: allowance.value,
    overtime,
    gross,
    surcharge,
    charged: gross + surcharge,
    overtimeHours: otHours.value,
    surchargeRate: rate,
    surchargeFromLedger: actual,
    // 残業時間そのものを台帳から取れたか（画面の「台帳 ○h」の集計はこれだけを足す）
    otFromLedger: otHours.used,
    fromLedger: bea.used || allowance.used || otHours.used,
  }
}

// その月に適用開始を迎えている職員全員の充当額（賃金改善）合計
export function monthlyImprove(
  staffList: BStaff[],
  ym: string,
  state: Pick<BaseupState, 'factor' | 'overtimeRate' | 'ledger' | 'surchargeMode'>,
) {
  return staffList
    .filter((s) => (s.startYm || '0000-00') <= ym)
    .reduce((a, s) => a + staffAmountsAt(s, ym, state).charged, 0)
}

// 表示する月と、その月の受付回数を確定させる。
//   ・手動上書き（manual）の月 … 入力値をそのまま使う（薬局別の内訳は出せない）
//   ・それ以外               … 経営ダッシュボードの薬局別 total を合算する
// 行は「保存してある月の枠」と「ダッシュボードに数字がある算定月」の和集合。
// ダッシュボードに新しい月が入れば、こちらで足さなくても行が増える。
export function resolveMonths(
  state: BaseupState,
  receipts: ReceiptsByShop,
): ResolvedMonth[] {
  const yms = new Set<string>(state.months.map((m) => m.ym))
  Object.keys(receipts).forEach((ym) => {
    if (ym >= FIRST_YM) yms.add(ym)
  })
  const saved = new Map(state.months.map((m) => [m.ym, m]))
  return [...yms]
    .sort()
    .map((ym) => {
      const mo = saved.get(ym)
      const manual = mo?.manual === true
      const byShop = receipts[ym] || {}
      const auto = Object.values(byShop).reduce((a, n) => a + (Number(n) || 0), 0)
      const value = manual ? Math.max(0, Number(mo?.receipts) || 0) : auto
      return {
        ym,
        receipts: value,
        byShop: manual ? {} : byShop,
        manual,
        entered: value > 0,
      }
    })
}

// 全期間の着地見込み。未入力の月を「入力済み月の平均受付回数」で補完して、
// 期間全体の収入と賃金改善を試算する。1か月も入力がなければ null。
export function projection(state: BaseupState, rows: ResolvedMonth[]) {
  const entered = rows.filter((r) => r.entered)
  if (!entered.length) return null
  const avgReceipts = entered.reduce((a, r) => a + r.receipts, 0) / entered.length
  let income = 0
  let improve = 0
  let pending = 0
  rows.forEach((r) => {
    if (!r.entered) pending++
    const receipts = r.entered ? r.receipts : avgReceipts
    income += receipts * pointsForMonth(r.ym) * YEN_PER_POINT
    improve += monthlyImprove(state.staff, r.ym, state)
  })
  const diff = improve - income
  // 不足を未入力の月だけで取り返す場合の、1か月あたり必要な賃上げ小計（法定福利費を掛ける前）
  const needMonthly = diff < 0 && pending > 0 ? -diff / (pending * state.factor) : 0
  return { avgReceipts, income, improve, diff, pending, needMonthly, ok: diff >= 0 }
}

// 既定の月の枠（2026-06〜2027-05）。受付回数は経営ダッシュボードから入るので0で置く。
function buildDefaultMonths(): BMonth[] {
  const out: BMonth[] = []
  let ym = FIRST_YM
  for (let i = 0; i < 12; i++) {
    out.push({ ym, receipts: 0 })
    ym = nextYm(ym)
  }
  return out
}
const DEFAULT_STAFF: BStaff[] = [
  {
    id: 1,
    name: '藤田',
    role: '薬剤師',
    baseUp: 10000,
    allowance: 0,
    monthlyHours: DEFAULT_HOURS,
    overtimeHours: 0,
    startYm: FIRST_YM,
  },
  {
    id: 2,
    name: '薬剤師B',
    role: '薬剤師',
    baseUp: 0,
    allowance: 8000,
    monthlyHours: DEFAULT_HOURS,
    overtimeHours: 0,
    startYm: FIRST_YM,
  },
  {
    id: 3,
    name: '事務A',
    role: '事務職員',
    baseUp: 0,
    allowance: 5000,
    monthlyHours: DEFAULT_HOURS,
    overtimeHours: 0,
    startYm: FIRST_YM,
  },
]

export function defaultState(): BaseupState {
  return {
    version: SCHEMA_VERSION,
    months: buildDefaultMonths(),
    staff: DEFAULT_STAFF.map((s) => ({ ...s })),
    factor: DEFAULT_FACTOR,
    overtimeRate: DEFAULT_OT_RATE,
    ledger: {},
    ledgerMap: { ...DEFAULT_LEDGER_MAP },
    surchargeMode: 'fixed',
  }
}

const num = (v: unknown, fallback = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)

// 保存済みデータ1本ぶんを現行スキーマへ寄せる。
// v1（ベア額1枠・係数1.29）で保存された内容も、そのまま開けるようにする。
function migrateOne(raw: unknown): BaseupState | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.months) || !Array.isArray(o.staff)) return null

  // 受付回数は経営ダッシュボードが正本。手動上書きと明示された月の値だけを残す。
  const months: BMonth[] = (o.months as unknown[]).map((m) => {
    const x = (m ?? {}) as Record<string, unknown>
    const manual = x.manual === true
    return {
      ym: str(x.ym, FIRST_YM),
      receipts: manual ? Math.max(0, num(x.receipts)) : 0,
      manual,
    }
  })
  const staff: BStaff[] = (o.staff as unknown[]).map((s, i) => {
    const x = (s ?? {}) as Record<string, unknown>
    return {
      id: num(x.id, i + 1),
      name: str(x.name),
      role: str(x.role, '薬剤師'),
      // v1 の baseUp は「月額ベア額」＝ベア相当額として引き継ぐ
      baseUp: num(x.baseUp),
      allowance: num(x.allowance),
      monthlyHours: num(x.monthlyHours) || DEFAULT_HOURS,
      overtimeHours: num(x.overtimeHours),
      startYm: str(x.startYm, months[0]?.ym ?? FIRST_YM),
      origin: str(x.origin) || undefined,
    }
  })

  // 旧既定の係数（1.29 / 1.168）で保存されたデータは増加分法定福利費16.5%へ移行する。
  // 手で変えた値は尊重したいので、旧既定と一致するときだけ入れ替える。
  const savedFactor = num(o.factor, DEFAULT_FACTOR)
  const factor = LEGACY_FACTORS.some((lf) => Math.abs(savedFactor - lf) < 1e-6)
    ? DEFAULT_FACTOR
    : savedFactor

  return {
    version: SCHEMA_VERSION,
    months,
    staff,
    factor: factor || DEFAULT_FACTOR,
    overtimeRate: num(o.overtimeRate) || DEFAULT_OT_RATE,
    ledger: readLedger(o.ledger),
    ledgerMap: readLedgerMap(o.ledgerMap),
    surchargeMode: o.surchargeMode === 'actual' ? 'actual' : 'fixed',
  }
}

// 保存済みの台帳データを読み直す（欠けた項目は null＝固定値で補う扱いにする）
function readLedger(raw: unknown): Record<string, StaffLedger> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, StaffLedger> = {}
  Object.entries(raw as Record<string, unknown>).forEach(([staffId, byYm]) => {
    if (!byYm || typeof byYm !== 'object') return
    const months: StaffLedger = {}
    Object.entries(byYm as Record<string, unknown>).forEach(([ym, v]) => {
      if (!v || typeof v !== 'object') return
      const x = v as Record<string, unknown>
      const n = (k: string) => {
        const val = Number(x[k])
        return x[k] == null || !Number.isFinite(val) ? null : val
      }
      months[ym] = {
        overtimeHours: n('overtimeHours'),
        baseUp: n('baseUp'),
        allowance: n('allowance'),
        employerIns: n('employerIns'),
        paid: n('paid'),
      }
    })
    if (Object.keys(months).length) out[staffId] = months
  })
  return out
}

function readLedgerMap(raw: unknown): LedgerMap {
  const d = DEFAULT_LEDGER_MAP
  if (!raw || typeof raw !== 'object') return { ...d, baseUp: [...d.baseUp], allowance: [...d.allowance], employer: [...d.employer] }
  const o = raw as Record<string, unknown>
  const list = (v: unknown, fb: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...fb]
  return {
    overtime: str(o.overtime, d.overtime) || d.overtime,
    baseUp: list(o.baseUp, d.baseUp),
    allowance: list(o.allowance, d.allowance),
    employer: list(o.employer, d.employer),
    paid: str(o.paid, d.paid) || d.paid,
  }
}

// 法人1本スキーマ（v4）への移行。
//   { shops: [...] }        … 薬局別に分かれていた頃のデータ。職員を結合して1本にする。
//                             同姓同名の自動name寄せ・自動削除はしない（画面で目視整理する）。
//   { months, staff, ... }  … すでに1本のデータ。そのまま読む。
// 戻り値の mergedFromShops が true のときは、呼び出し側で移行前データの控えを取ること。
export function migrateBaseup(
  raw: unknown,
): { state: BaseupState; mergedFromShops: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  if (Array.isArray(o.shops) && o.shops.length) {
    const shops = (o.shops as unknown[])
      .map((s, i) => {
        const x = (s ?? {}) as Record<string, unknown>
        const one = migrateOne(x)
        return one
          ? { state: one, name: str(x.name, PHARMACY_NAMES[i] ?? `薬局${i + 1}`) }
          : null
      })
      .filter((s): s is { state: BaseupState; name: string } => s !== null)
    if (!shops.length) return null

    // 職員は全薬局ぶんを結合。どの薬局から来たかを残して、画面で見分けられるようにする。
    let seq = 0
    const staff = shops.flatMap((s) =>
      s.state.staff.map((st) => ({ ...st, id: ++seq, origin: st.origin || s.name })),
    )
    // 係数は法人で1つ。既定から変えてある値（＝手で決めた値）を優先して引き継ぐ。
    const pick = (values: number[], def: number) =>
      values.find((v) => Math.abs(v - def) > 1e-6) ?? values[0] ?? def
    const factor = pick(
      shops.map((s) => s.state.factor),
      DEFAULT_FACTOR,
    )
    const overtimeRate = pick(
      shops.map((s) => s.state.overtimeRate),
      DEFAULT_OT_RATE,
    )
    // 月の枠は和集合。受付回数は経営ダッシュボードから入るので引き継がない。
    const yms = [...new Set(shops.flatMap((s) => s.state.months.map((m) => m.ym)))].sort()
    const months: BMonth[] = (yms.length ? yms : buildDefaultMonths().map((m) => m.ym)).map(
      (ym) => ({ ym, receipts: 0, manual: false }),
    )

    return {
      state: {
        version: SCHEMA_VERSION,
        months,
        staff,
        factor,
        overtimeRate,
        // 台帳の取り込みは薬局別だった頃には無い機能なので、まっさらから始める
        ledger: {},
        ledgerMap: readLedgerMap(o.ledgerMap),
        surchargeMode: o.surchargeMode === 'actual' ? 'actual' : 'fixed',
      },
      mergedFromShops: true,
    }
  }

  const one = migrateOne(o)
  return one ? { state: one, mergedFromShops: false } : null
}

// ── 月次の組み立てと累計 ────────────────────────────────
// ベースアップ評価料タブと早見表が同じ数字を出すよう、月次行と累計はここで作る。
// （画面側でもう一度足し直さない＝表と早見表で充当率がズレない）

export interface BaseupRow extends ResolvedMonth {
  pts: number
  income: number
  incomeByShop: Record<string, number>
  bea: number
  allowance: number
  overtime: number
  surcharge: number
  improve: number
  diff: number
  cumIncome: number
  cumImprove: number
  cumDiff: number
  fromLedger: number // その月に賃金台帳の実績を使った人数
  otHours: number // その月の実残業時間の合計
}

export interface BaseupTotals {
  income: number
  improve: number
  bea: number
  allowance: number
  overtime: number
  surcharge: number
  receipts: number
  byShop: Record<string, { receipts: number; income: number }>
  diff: number
  /** 充当率＝賃金改善 ÷ 評価料収入（%） */
  rate: number
  /** 100%以上＝適合 */
  ok: boolean
  /** 集計に入った月数（受付回数が確定している月） */
  count: number
}

/** 解決済みの月（resolveMonths の結果）から、収入・賃金改善・累計を載せた月次行を作る */
export function buildBaseupRows(state: BaseupState, resolved: ResolvedMonth[]): BaseupRow[] {
  const staff = state.staff
  return resolved.reduce<{ list: BaseupRow[]; cumIncome: number; cumImprove: number }>(
    (acc, mo) => {
      const pts = pointsForMonth(mo.ym)
      const income = mo.entered ? mo.receipts * pts * YEN_PER_POINT : 0
      // 薬局別の収入＝その薬局の受付回数 × 点数 × 10円（点数は法人共通）
      const incomeByShop: Record<string, number> = {}
      Object.entries(mo.byShop).forEach(([name, n]) => {
        incomeByShop[name] = n * pts * YEN_PER_POINT
      })

      // 適用開始月を迎えた職員だけを、その月の賃金改善に算入する
      const active = staff.filter((s) => (s.startYm || '0000-00') <= mo.ym)
      const zero = {
        bea: 0,
        allowance: 0,
        overtime: 0,
        surcharge: 0,
        improve: 0,
        fromLedger: 0,
        otHours: 0,
      }
      // 賃金台帳が入っている月はその月の実績で、無ければ職員マスタの固定値で計算する
      const sums = mo.entered
        ? active.reduce((t, s) => {
            const a = staffAmountsAt(s, mo.ym, state)
            return {
              bea: t.bea + a.bea,
              allowance: t.allowance + a.allowance,
              overtime: t.overtime + a.overtime,
              surcharge: t.surcharge + a.surcharge,
              improve: t.improve + a.charged,
              fromLedger: t.fromLedger + (a.fromLedger ? 1 : 0),
              // 台帳から読めた人の残業時間だけを足す（固定値の人は混ぜない）
              otHours: t.otHours + (a.otFromLedger ? a.overtimeHours : 0),
            }
          }, zero)
        : zero

      const cumIncome = acc.cumIncome + income
      const cumImprove = acc.cumImprove + sums.improve
      acc.list.push({
        ...mo,
        pts,
        income,
        incomeByShop,
        ...sums,
        diff: sums.improve - income,
        cumIncome,
        cumImprove,
        cumDiff: cumImprove - cumIncome,
      })
      return { list: acc.list, cumIncome, cumImprove }
    },
    { list: [], cumIncome: 0, cumImprove: 0 },
  ).list
}

/** 入力済みの月次行から累計と充当率を出す */
export function sumBaseupRows(enteredRows: BaseupRow[], shops: string[]): BaseupTotals {
  const sum = (f: (r: BaseupRow) => number) => enteredRows.reduce((a, r) => a + f(r), 0)
  const income = sum((r) => r.income)
  const improve = sum((r) => r.improve)
  // 薬局別の受付回数・収入の累計（内訳表示用）
  const byShop: Record<string, { receipts: number; income: number }> = {}
  shops.forEach((name) => {
    byShop[name] = { receipts: 0, income: 0 }
  })
  enteredRows.forEach((r) => {
    Object.entries(r.byShop).forEach(([name, n]) => {
      if (!byShop[name]) byShop[name] = { receipts: 0, income: 0 }
      byShop[name].receipts += n
      byShop[name].income += r.incomeByShop[name] || 0
    })
  })
  return {
    income,
    improve,
    bea: sum((r) => r.bea),
    allowance: sum((r) => r.allowance),
    overtime: sum((r) => r.overtime),
    surcharge: sum((r) => r.surcharge),
    receipts: sum((r) => r.receipts),
    byShop,
    diff: improve - income,
    rate: income > 0 ? (improve / income) * 100 : 0,
    ok: improve >= income,
    count: enteredRows.length,
  }
}

/** 早見表用：状態と受付回数から、月次行と累計をまとめて出す */
export function baseupSummary(
  state: BaseupState,
  receipts: ReceiptsByShop,
  shops: string[],
): { rows: BaseupRow[]; entered: BaseupRow[]; totals: BaseupTotals } {
  const rows = buildBaseupRows(state, resolveMonths(state, receipts))
  const entered = rows.filter((r) => r.entered)
  return { rows, entered, totals: sumBaseupRows(entered, shops) }
}
