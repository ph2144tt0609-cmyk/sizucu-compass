import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { cloudLoad, cloudSave, CLOUD_KEYS } from '../cloud'
import { loadDashboardReceipts } from '../dashboardReceipts'
import {
  DEFAULT_HOURS,
  FIRST_YM,
  PHARMACY_NAMES,
  ROLES,
  YEN_PER_POINT,
  defaultState,
  fiscalLabel,
  migrateBaseup,
  buildBaseupRows,
  sumBaseupRows,
  nextYm,
  pointsForMonth,
  projection,
  resolveMonths,
  shortYm,
  staffAmounts,
  yen,
} from '../baseupCalc'
import type {
  BStaff,
  BaseupState,
  ReceiptsByShop,
  SurchargeMode,
} from '../baseupCalc'
import { WageLedgerImport, type ImportResult } from './WageLedgerImport'
import '../Baseup.css'

// 調剤ベースアップ評価料 月次管理（令和8年度改定）
// 収入と賃金改善の突合を表示・編集する画面。計算式は baseupCalc.ts 側にある。
//
// ・評価料は社員全体に配るものなので、職員・係数・判定は【法人1本】で管理する。
//   収入の内訳だけは薬局別に見えるようにする（どの店でいくら算定したかは把握したいため）。
// ・受付回数は入力しない。経営ダッシュボードタブの「処方箋枚数」を自動参照する
//   （同じ数字なので、二度入力して食い違うのを防ぐ）。例外月だけ手動上書きできる。

function today() {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`
}
function download(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

// 移行前データの控え（この端末）。クラウド側の控えは CLOUD_KEYS.baseupBackupV3。
const BACKUP_KEY = 'baseup-backup-v3'
const NOTICE_KEY = 'baseup-merged-notice-v4'

// 内訳列の並びは PHARMACY_NAMES 順。そこに無い薬局は後ろへ。
const sortShops = (names: string[]) =>
  [...names].sort((a, b) => {
    const ia = PHARMACY_NAMES.indexOf(a)
    const ib = PHARMACY_NAMES.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

// ── 読み込み・保存（Supabase: app_state に合言葉で暗号化して1件） ──────────
export function BaseupTab() {
  const [state, setState] = useState<BaseupState | null>(null)
  const [receipts, setReceipts] = useState<ReceiptsByShop>({})
  const [shops, setShops] = useState<string[]>([])
  const [notice, setNotice] = useState<{ backup: string; cloudSaved: boolean } | null>(null)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const skipNextSave = useRef(true)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // 経営ダッシュボードの処方箋枚数（＝算定回数）を読む
      try {
        const r = await loadDashboardReceipts()
        if (alive) {
          setReceipts(r.receipts)
          setShops(sortShops(r.shops.length ? r.shops : PHARMACY_NAMES))
        }
      } catch {
        if (alive) setShops(PHARMACY_NAMES)
      }

      const saved = await cloudLoad<unknown>(CLOUD_KEYS.baseup)
      const m = migrateBaseup(saved)

      // 薬局別（v3）→ 法人1本（v4）への移行。
      // 上書きする前に、必ず移行前データの控えを取ってから切り替える。
      if (m?.mergedFromShops) {
        const backup = JSON.stringify(saved, null, 2)
        try {
          localStorage.setItem(BACKUP_KEY, backup)
          localStorage.setItem(NOTICE_KEY, '1')
        } catch {
          /* 保存できなくても続ける（控えはクラウド側にも置く） */
        }
        const cloudSaved = await cloudSave(CLOUD_KEYS.baseupBackupV3, saved)
        // 控えが取れてから新しい形で保存し直す（移行は1回きり）
        await cloudSave(CLOUD_KEYS.baseup, m.state)
        if (alive) setNotice({ backup, cloudSaved })
      } else {
        // 前回の移行のお知らせがまだ閉じられていなければ出し続ける
        const read = (key: string) => {
          try {
            return localStorage.getItem(key) || ''
          } catch {
            return ''
          }
        }
        if (alive && read(NOTICE_KEY) === '1')
          setNotice({ backup: read(BACKUP_KEY), cloudSaved: true })
      }

      if (!alive) return
      setState(m?.state ?? defaultState())
    })()
    return () => {
      alive = false
    }
  }, [])

  // 変更を保存（初回ロード直後の1回はスキップ・以降は0.8秒デバウンス）
  useEffect(() => {
    if (!state) return
    if (skipNextSave.current) {
      skipNextSave.current = false
      return
    }
    const t = setTimeout(() => {
      setSaveStatus('saving')
      cloudSave(CLOUD_KEYS.baseup, state).then((ok) => {
        if (!ok) {
          setSaveStatus('error')
        } else {
          setSaveStatus('saved')
          // 2.5秒後にトースト表示を消す
          window.setTimeout(() => setSaveStatus('idle'), 2500)
        }
      })
    }, 800)
    return () => clearTimeout(t)
  }, [state])

  if (!state) return <p className="muted center">読み込み中…</p>

  const closeNotice = () => {
    try {
      localStorage.removeItem(NOTICE_KEY)
    } catch {
      /* 無視 */
    }
    setNotice(null)
  }

  return (
    <div className="baseup">
      {notice && (
        <div className="notice">
          <div>
            <b>薬局ごとの管理をやめ、法人1本にまとめました。</b>
            評価料は社員全体に配るものなので、職員・係数・判定は法人でまとめて見ます
            （収入の内訳は月次明細で薬局別に確認できます）。
            <br />
            緑ヶ丘・鷹匠それぞれに登録していた<b>職員はすべて残してあります</b>
            （同じ方が二重に入っている場合は、下の職員表で不要な行を削除してください）。
            <br />
            移行前のデータは
            {notice.cloudSaved ? 'クラウドとこの端末に控えてあります' : 'この端末に控えてあります'}。
            {notice.backup && (
              <>
                {' '}
                <button
                  className="btn ghost"
                  onClick={() =>
                    download(`ベースアップ_移行前バックアップ_${today()}.json`, notice.backup, 'application/json')
                  }
                >
                  移行前データをJSONで保存
                </button>
              </>
            )}
          </div>
          <button className="btn ghost" onClick={closeNotice}>
            閉じる
          </button>
        </div>
      )}

      <BaseupView
        state={state}
        receipts={receipts}
        shops={shops}
        onChange={setState}
        saveStatus={saveStatus}
      />
    </div>
  )
}

// ── 表示・編集 ────────────────────────────────────────────────
function BaseupView({
  state,
  receipts,
  shops,
  onChange,
  saveStatus,
}: {
  state: BaseupState
  receipts: ReceiptsByShop
  shops: string[]
  onChange: (next: BaseupState) => void
  saveStatus: SaveStatus
}) {
  const { staff, factor, overtimeRate } = state
  const [showShops, setShowShops] = useState(true)
  const [showImport, setShowImport] = useState(false)
  const [imported, setImported] = useState<ImportResult | null>(null)

  // 職員ID → 台帳が入っている月数（職員表に「台帳 n か月」と出す）
  const ledgerCount = useMemo(() => {
    const out: Record<string, number> = {}
    Object.entries(state.ledger ?? {}).forEach(([id, months]) => {
      out[id] = Object.keys(months).length
    })
    return out
  }, [state.ledger])
  const ledgerMonths = useMemo(
    () => new Set(Object.values(state.ledger ?? {}).flatMap((m) => Object.keys(m))),
    [state.ledger],
  )
  const hasLedger = ledgerMonths.size > 0

  // 受付回数を確定させる（手動上書きの月以外は経営ダッシュボードの値）
  const resolved = useMemo(() => resolveMonths(state, receipts), [state, receipts])

  // 月次行と累計の作り方は ../baseupCalc.ts に置いてある（早見表も同じ関数を使う＝充当率がズレない）
  const rows = useMemo(() => buildBaseupRows(state, resolved), [state, resolved])
  const enteredRows = useMemo(() => rows.filter((r) => r.entered), [rows])
  const totals = useMemo(() => sumBaseupRows(enteredRows, shops), [enteredRows, shops])

  const byFiscal = useMemo(() => {
    const map = new Map<
      string,
      {
        fiscal: string
        receipts: number
        income: number
        bea: number
        allowance: number
        overtime: number
        surcharge: number
        improve: number
      }
    >()
    enteredRows.forEach((r) => {
      const k = fiscalLabel(r.ym)
      const g = map.get(k) ?? {
        fiscal: k,
        receipts: 0,
        income: 0,
        bea: 0,
        allowance: 0,
        overtime: 0,
        surcharge: 0,
        improve: 0,
      }
      g.receipts += r.receipts || 0
      g.income += r.income
      g.bea += r.bea
      g.allowance += r.allowance
      g.overtime += r.overtime
      g.surcharge += r.surcharge
      g.improve += r.improve
      map.set(k, g)
    })
    return [...map.values()]
  }, [enteredRows])

  // グラフは賃金改善の中身（ベア/手当/残業/法定福利費）を積み上げで見せる
  const chartData = useMemo(
    () =>
      enteredRows.map((r) => ({
        name: shortYm(r.ym),
        収入: Math.round(r.income),
        ベア: Math.round(r.bea),
        手当: Math.round(r.allowance),
        残業: Math.round(r.overtime),
        法定福利費: Math.round(r.surcharge),
        累計差額: Math.round(r.cumDiff),
      })),
    [enteredRows],
  )

  // 全期間の着地見込み（未入力月を平均受付回数で補完）
  const proj = useMemo(() => projection(state, resolved), [state, resolved])

  const staffTotal = useMemo(
    () =>
      staff.reduce(
        (a, s) => {
          const x = staffAmounts(s, factor, overtimeRate)
          return {
            bea: a.bea + x.bea,
            allowance: a.allowance + x.allowance,
            overtime: a.overtime + x.overtime,
            surcharge: a.surcharge + x.surcharge,
            charged: a.charged + x.charged,
          }
        },
        { bea: 0, allowance: 0, overtime: 0, surcharge: 0, charged: 0 },
      ),
    [staff, factor, overtimeRate],
  )

  // ── 編集ハンドラ（state をまるごと差し替えて onChange） ──
  // 手動上書きの切替。自動値を初期値として渡すので、実数から手直しできる。
  const setManual = (ym: string, on: boolean, seedValue = 0) => {
    const exists = state.months.some((m) => m.ym === ym)
    const months = exists
      ? state.months.map((m) =>
          m.ym === ym ? { ...m, manual: on, receipts: on ? seedValue : 0 } : m,
        )
      : [...state.months, { ym, manual: on, receipts: on ? seedValue : 0 }]
    onChange({ ...state, months: months.sort((a, b) => a.ym.localeCompare(b.ym)) })
  }
  const setReceipts = (ym: string, v: string) =>
    onChange({
      ...state,
      months: state.months.map((m) =>
        m.ym === ym ? { ...m, receipts: v === '' ? 0 : Math.max(0, Number(v) || 0) } : m,
      ),
    })
  const addMonth = () => {
    const last = rows.length ? rows[rows.length - 1].ym : null
    const ym = last ? nextYm(last) : FIRST_YM
    if (state.months.some((m) => m.ym === ym)) return
    onChange({
      ...state,
      months: [...state.months, { ym, receipts: 0, manual: false }].sort((a, b) =>
        a.ym.localeCompare(b.ym),
      ),
    })
  }
  const removeMonth = () =>
    onChange({
      ...state,
      months: state.months.length > 1 ? state.months.slice(0, -1) : state.months,
    })

  const updStaff = (id: number, key: keyof BStaff, v: string | number) =>
    onChange({ ...state, staff: staff.map((x) => (x.id === id ? { ...x, [key]: v } : x)) })
  const addStaff = () =>
    onChange({
      ...state,
      staff: [
        ...staff,
        {
          id: (staff.reduce((a, x) => Math.max(a, x.id), 0) || 0) + 1,
          name: '',
          role: '薬剤師',
          baseUp: 0,
          allowance: 0,
          monthlyHours: DEFAULT_HOURS,
          overtimeHours: 0,
          startYm: rows[0]?.ym ?? FIRST_YM,
        },
      ],
    })
  const delStaff = (id: number) =>
    onChange({ ...state, staff: staff.filter((x) => x.id !== id) })
  const setFactor = (f: number) => onChange({ ...state, factor: f })
  const setOvertimeRate = (r: number) => onChange({ ...state, overtimeRate: r })
  const setSurchargeMode = (m: SurchargeMode) => onChange({ ...state, surchargeMode: m })

  // 賃金台帳の取り込み。同じ職員の同じ月は新しい台帳で置き換え、それ以外は残す。
  const applyLedger = (r: ImportResult) => {
    const ledger = { ...state.ledger }
    Object.entries(r.ledger).forEach(([id, months]) => {
      ledger[id] = { ...(ledger[id] ?? {}), ...months }
    })
    onChange({
      ...state,
      ledger,
      ledgerMap: r.map,
      staff: r.addedStaff.length ? [...staff, ...r.addedStaff] : staff,
    })
    setShowImport(false)
    setImported(r)
  }
  const clearLedger = (id?: number) => {
    if (id == null) {
      if (!window.confirm('取り込んだ賃金台帳の実績をすべて削除します。よろしいですか？\n（職員表の固定額での計算に戻ります）'))
        return
      onChange({ ...state, ledger: {} })
      setImported(null)
      return
    }
    const ledger = { ...state.ledger }
    delete ledger[String(id)]
    onChange({ ...state, ledger })
  }

  const resetAll = () => {
    if (
      !window.confirm(
        '職員・係数・手動上書きを初期サンプルに戻します。よろしいですか？\n（経営ダッシュボードの処方箋枚数はそのままです）',
      )
    )
      return
    onChange(defaultState())
  }

  const exportCsv = () => {
    const head = [
      '算定月',
      ...shops.map((s) => `${s} 受付回数`),
      '合計 受付回数',
      '受付回数の入力方法',
      '点数',
      ...shops.map((s) => `${s} 収入(円)`),
      '合計 評価料収入(円)',
      'ベア相当額(円)',
      'ベースアップ手当(円)',
      '残業代増額分(円)',
      '実残業時間(h・賃金台帳)',
      state.surchargeMode === 'actual'
        ? '増加分法定福利費(円・賃金台帳の実額)'
        : `増加分法定福利費(円・${((factor - 1) * 100).toFixed(1)}%)`,
      `賃金改善(円・×${factor})`,
      '当月差額(円)',
      '累計差額(円)',
      '状態',
    ]
    const lines = rows.map((r) =>
      [
        r.ym,
        ...shops.map((s) => (r.byShop[s] ? r.byShop[s] : '')),
        r.entered ? r.receipts : '',
        r.manual ? '手入力' : '経営ダッシュボード',
        r.pts,
        ...shops.map((s) => (r.incomeByShop[s] ? Math.round(r.incomeByShop[s]) : '')),
        r.entered ? Math.round(r.income) : '',
        r.entered ? Math.round(r.bea) : '',
        r.entered ? Math.round(r.allowance) : '',
        r.entered ? Math.round(r.overtime) : '',
        r.entered && r.fromLedger > 0 ? r.otHours.toFixed(2) : '',
        r.entered ? Math.round(r.surcharge) : '',
        r.entered ? Math.round(r.improve) : '',
        r.entered ? Math.round(r.diff) : '',
        r.entered ? Math.round(r.cumDiff) : '',
        r.entered ? '入力済' : '未入力',
      ].join(','),
    )
    const csv = '﻿' + [head.join(','), ...lines].join('\r\n')
    download(`ベースアップ管理_月次明細_法人合算_${today()}.csv`, csv, 'text/csv;charset=utf-8')
  }

  const nowPoints = pointsForMonth(
    `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
  )
  const autoCount = rows.filter((r) => r.entered && !r.manual).length
  const manualCount = rows.filter((r) => r.manual).length

  return (
    <div className="baseup">
      <div className="app-head">
        <p>
          算定で得た収入（処方箋受付 × 点数 × 10円）と、職員の賃金改善額を突き合わせ、
          充当不足がないかを管理します。評価料は社員全体に配るため、
          <b>法人（緑ヶ丘＋鷹匠）でまとめて</b>管理します（収入の内訳は月次明細で薬局別に確認できます）。
        </p>
        <p className="note" style={{ marginTop: 4 }}>
          ※ 処方箋受付回数は<b>経営ダッシュボードタブの処方箋枚数を自動参照</b>します（入力は1か所だけ）。
          入力した内容は自動で保存されます（保存の状況は画面右下に表示）。
        </p>
      </div>

      <div className={'save-toast save-' + saveStatus} aria-live="polite">
        {saveStatus === 'saving' && '保存中…'}
        {saveStatus === 'saved' && '✓ 保存しました'}
        {saveStatus === 'error' && '⚠ 保存できませんでした（通信をご確認ください）'}
      </div>

      {/* ステータス */}
      <div className="stats" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="label">累計 評価料収入</div>
          <div className="value">
            {yen(totals.income)}
            <small> 円</small>
          </div>
          <div className="note breakdown">
            {shops.map((s) => (
              <span key={s}>
                {s} {yen(totals.byShop[s]?.income || 0)}
                <br />
              </span>
            ))}
          </div>
        </div>
        <div className="stat">
          <div className="label">累計 賃金改善額（充当）</div>
          <div className="value">
            {yen(totals.improve)}
            <small> 円</small>
          </div>
          <div className="note breakdown">
            ベア {yen(totals.bea)} ／ 手当 {yen(totals.allowance)} ／ 残業 {yen(totals.overtime)}
            <br />
            小計 {yen(totals.bea + totals.allowance + totals.overtime)} ＋ 増加分法定福利費{' '}
            <b>{yen(totals.surcharge)}</b>（{((factor - 1) * 100).toFixed(1)}%）
          </div>
        </div>
        <div className="stat">
          <div className="label">充当率（改善 ÷ 収入）</div>
          <div className="value">
            {totals.rate.toFixed(1)}
            <small> %</small>
          </div>
          <div
            className="rate-bar"
            role="img"
            aria-label={`充当率 ${totals.rate.toFixed(1)}%（100%以上で適合）`}
          >
            <div
              className={'rate-fill ' + (totals.ok ? 'ok' : 'warn')}
              style={{ width: `${Math.min(totals.rate, 100)}%` }}
            />
          </div>
          <div className="note" style={{ marginTop: 4 }}>
            100% 以上で適合（バーが満タン＝収入を全額充当）
          </div>
        </div>
        <div className="stat">
          <div className="label">判定（入力済 {totals.count} か月）</div>
          <div style={{ marginTop: 4 }}>
            <span className={`badge ${totals.ok ? 'ok' : 'warn'}`}>
              {totals.ok ? '適合（充当OK）' : '要改善（賃金改善が不足）'}
            </span>
            <div className="note" style={{ marginTop: 6 }}>
              {totals.ok ? `余裕 ${yen(totals.diff)} 円` : `不足 ${yen(-totals.diff)} 円`}
            </div>
          </div>
        </div>
      </div>

      {/* 着地見込み（未入力月を平均で補完した全期間の試算） */}
      {proj && (
        <div className={'insight ' + (proj.ok ? 'insight-ok' : 'insight-warn')}>
          <span className="insight-title">
            {proj.ok ? '✅' : '⚠️'} 全期間の着地見込み
          </span>
          {proj.pending > 0 ? (
            <>
              未入力{proj.pending}か月を平均受付 {yen(proj.avgReceipts)} 回/月で補完すると、
              収入 {yen(proj.income)} 円 ／ 賃金改善 {yen(proj.improve)} 円 →{' '}
              <b>
                {proj.ok
                  ? `適合見込み（余裕 ${yen(proj.diff)} 円）`
                  : `不足見込み ${yen(-proj.diff)} 円`}
              </b>
            </>
          ) : (
            <>
              全月入力済み — 収入 {yen(proj.income)} 円 ／ 賃金改善 {yen(proj.improve)} 円 →{' '}
              <b>{proj.ok ? `適合（余裕 ${yen(proj.diff)} 円）` : `不足 ${yen(-proj.diff)} 円`}</b>
            </>
          )}
          {!proj.ok && proj.pending > 0 && (
            <span className="insight-hint">
              💡 適合の目安：未入力の各月に 月額あと約{' '}
              <b>{yen(Math.ceil(proj.needMonthly / 100) * 100)} 円</b>{' '}
              の賃上げ（ベア・手当・残業の小計。増加分法定福利費{((factor - 1) * 100).toFixed(1)}%は自動上乗せ）で解消できます
            </span>
          )}
          {!proj.ok && proj.pending === 0 && (
            <span className="insight-hint">
              💡 期間内の遡及賃上げや手当の上乗せなど、追加の賃金改善をご検討ください
            </span>
          )}
        </div>
      )}

      {/* グラフ */}
      <section className="card">
        <h2>
          <span className="num">1</span>月次推移（収入 vs 賃金改善の内訳・累計差額）
        </h2>
        {chartData.length === 0 ? (
          <p className="note">
            経営ダッシュボードタブに処方箋枚数が入ると、月次の推移グラフが表示されます。
          </p>
        ) : (
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="#e8edf1" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                <Tooltip formatter={(v) => `${yen(Number(v))} 円`} labelStyle={{ color: '#2a3540' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="収入" fill="#3d4e5e" radius={[2, 2, 0, 0]} />
                <Bar dataKey="ベア" stackId="w" fill="#5a86b2" />
                <Bar dataKey="手当" stackId="w" fill="#6eb4c7" />
                <Bar dataKey="残業" stackId="w" fill="#d9b040" />
                <Bar dataKey="法定福利費" stackId="w" fill="#c2cfd8" radius={[2, 2, 0, 0]} />
                <Line type="monotone" dataKey="累計差額" stroke="#d98f40" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="note">
          濃い緑の棒＝収入（法人合算）。積み上げ棒＝賃金改善の内訳（ベア／手当／残業代増額分／増加分法定福利費）。
          積み上げが収入の棒に届いていれば、その月は充当できています。折れ線＝累計差額（マイナスに沈むと充当不足）。
        </p>
      </section>

      {/* 月次明細 */}
      <section className="card">
        <h2>
          <span className="num">2</span>月次明細（受付回数は経営ダッシュボードから自動参照）
        </h2>
        <div className="detail-toolbar">
          <label className="chk">
            <input
              type="checkbox"
              checked={showShops}
              onChange={(e) => setShowShops(e.target.checked)}
            />
            薬局別の内訳を表示（{shops.join('・')}）
          </label>
          <span className="note">
            自動参照 {autoCount} か月{manualCount > 0 ? ` ／ 手入力 ${manualCount} か月` : ''}
          </span>
        </div>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>算定月</th>
                {showShops &&
                  shops.map((s) => (
                    <th key={'rc-' + s} className="shop-col">
                      {s}
                      <br />
                      受付回数
                    </th>
                  ))}
                <th>合計 受付回数</th>
                <th>点数</th>
                {showShops &&
                  shops.map((s) => (
                    <th key={'in-' + s} className="shop-col">
                      {s}
                      <br />
                      収入(円)
                    </th>
                  ))}
                <th>合計 収入(円)</th>
                <th>ベア相当額</th>
                <th>ベースアップ手当</th>
                <th>残業代増額分</th>
                <th>増加分法定福利費</th>
                <th>賃金改善(円)</th>
                <th>当月差額</th>
                <th>累計差額</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ym} className={!r.entered ? 'pending' : r.cumDiff < 0 ? 'short' : ''}>
                  <td>{r.ym}</td>
                  {showShops &&
                    shops.map((s) => (
                      <td key={'rc-' + s} className="shop-col">
                        {r.manual ? '—' : r.byShop[s] ? yen(r.byShop[s]) : '未入力'}
                      </td>
                    ))}
                  <td className="receipts-cell">
                    {r.manual ? (
                      <div className="receipts-manual">
                        <input
                          type="number"
                          min="0"
                          aria-label={`${r.ym} の処方箋受付回数（手入力）`}
                          value={r.receipts || ''}
                          onChange={(e) => setReceipts(r.ym, e.target.value)}
                        />
                        <span className="tag tag-manual">手入力</span>
                        <button
                          className="link-btn"
                          onClick={() => setManual(r.ym, false)}
                          title="経営ダッシュボードの処方箋枚数に戻します"
                        >
                          自動に戻す
                        </button>
                      </div>
                    ) : (
                      <div className="receipts-auto">
                        <b>{r.entered ? yen(r.receipts) : '未入力'}</b>
                        {r.entered && <span className="tag tag-auto">自動</span>}
                        <button
                          className="link-btn"
                          onClick={() => setManual(r.ym, true, r.receipts)}
                          title="この月だけ手入力で上書きします"
                        >
                          手入力にする
                        </button>
                      </div>
                    )}
                  </td>
                  <td>{r.pts}点</td>
                  {showShops &&
                    shops.map((s) => (
                      <td key={'in-' + s} className="shop-col">
                        {r.manual ? '—' : r.incomeByShop[s] ? yen(r.incomeByShop[s]) : '—'}
                      </td>
                    ))}
                  <td>{r.entered ? yen(r.income) : '—'}</td>
                  <td>{r.entered ? yen(r.bea) : '—'}</td>
                  <td>{r.entered ? yen(r.allowance) : '—'}</td>
                  <td>
                    {r.entered ? (
                      <span className="ot-cell">
                        {yen(r.overtime)}
                        {r.fromLedger > 0 && (
                          <span
                            className="tag tag-auto"
                            title={`賃金台帳の実績を使った職員 ${r.fromLedger}名（実残業 計 ${r.otHours.toFixed(1)}h）。ほかの職員は職員表の固定値`}
                          >
                            台帳 {r.fromLedger}名 {r.otHours.toFixed(1)}h
                          </span>
                        )}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{r.entered ? yen(r.surcharge) : '—'}</td>
                  <td>{r.entered ? yen(r.improve) : '—'}</td>
                  <td style={{ color: !r.entered ? '#9aa8a8' : r.diff < 0 ? '#c25454' : '#6f8a2c' }}>
                    {!r.entered ? '—' : `${r.diff >= 0 ? '+' : ''}${yen(r.diff)}`}
                  </td>
                  <td style={{ color: !r.entered ? '#9aa8a8' : r.cumDiff < 0 ? '#c25454' : '#6f8a2c' }}>
                    {!r.entered ? '—' : `${r.cumDiff >= 0 ? '+' : ''}${yen(r.cumDiff)}`}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>合計（入力済）</td>
                {showShops &&
                  shops.map((s) => (
                    <td key={'rc-' + s} className="shop-col">
                      {yen(totals.byShop[s]?.receipts || 0)}
                    </td>
                  ))}
                <td>{yen(totals.receipts)}</td>
                <td>—</td>
                {showShops &&
                  shops.map((s) => (
                    <td key={'in-' + s} className="shop-col">
                      {yen(totals.byShop[s]?.income || 0)}
                    </td>
                  ))}
                <td>{yen(totals.income)}</td>
                <td>{yen(totals.bea)}</td>
                <td>{yen(totals.allowance)}</td>
                <td>{yen(totals.overtime)}</td>
                <td>{yen(totals.surcharge)}</td>
                <td>{yen(totals.improve)}</td>
                <td colSpan={2}>
                  {totals.ok ? '+' : ''}
                  {yen(totals.diff)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row-actions">
          <button className="btn" onClick={addMonth}>
            ＋ 次の月を追加
          </button>
          <button className="btn ghost" onClick={removeMonth}>
            最終月を削除
          </button>
        </div>
        <p className="note">
          受付回数は<b>経営ダッシュボードタブの処方箋枚数</b>（＝レセコン日計明細で「介護等除く」が1以上の行数）を
          そのまま使います。同じ数字なので、こちらで入力し直す必要はありません。
          ダッシュボードに無い月は「未入力」として集計から除外します。
          <br />
          例外的に数字が食い違う月・ダッシュボードに無い過去月は「手入力にする」で上書きできます（
          <span className="tag tag-manual">手入力</span> と表示されます）。「自動に戻す」でいつでも元に戻せます。
          <br />
          点数は 2026-06〜2027-05 が <b>4点</b>、2027-06（令和9年6月）以降は <b>8点</b>（200%）に自動切替（1点＝10円）。
          <br />
          <b>ベア相当額＋ベースアップ手当＋残業代増額分＋増加分法定福利費＝賃金改善</b>（増加分法定福利費＝社会保険料など事業主負担の増加分
          {state.surchargeMode === 'actual'
            ? '。賃金台帳の実額から月ごとに算出しています'
            : `で、その3つの合計の${((factor - 1) * 100).toFixed(1)}%`}）。
          <br />
          <span className="tag tag-auto">台帳</span> が付いた月は<b>賃金台帳の実残業時間</b>で計算した月です。
          付いていない月は職員表の固定値（月平均）を使っています。
        </p>
      </section>

      {/* 賃金台帳の取り込み */}
      {showImport ? (
        <WageLedgerImport
          staff={staff}
          map={state.ledgerMap}
          onApply={applyLedger}
          onCancel={() => setShowImport(false)}
        />
      ) : (
        <section className="card">
          <h2>
            <span className="num">3</span>賃金台帳の取り込み（毎月の実績で自動計算）
          </h2>
          <div className="ledger-status">
            {hasLedger ? (
              <>
                <span className="badge ok">台帳 取り込み済み</span>
                <span className="note">
                  {Object.keys(ledgerCount).length} 名 ／ {ledgerMonths.size} か月分（
                  {[...ledgerMonths].sort()[0]}〜{[...ledgerMonths].sort().slice(-1)[0]}）。
                  台帳のある月は<b>実残業時間</b>で残業代増額分を計算しています。
                </span>
              </>
            ) : (
              <>
                <span className="badge warn">台帳 未取り込み</span>
                <span className="note">
                  いまは職員表の固定値で計算しているため、<b>残業代増額分が毎月同じ額</b>になります。
                  賃金台帳を読み込むと、月ごとの実残業時間で自動計算されます。
                </span>
              </>
            )}
          </div>
          {imported && (
            <p className="note">
              ✓ {imported.people} ファイル・{imported.months.length} か月分を取り込みました
              {imported.addedStaff.length > 0 &&
                `（新しく ${imported.addedStaff.length} 名を職員表に追加しました）`}
              。
            </p>
          )}
          <div className="row-actions">
            <button className="btn primary" onClick={() => setShowImport(true)}>
              賃金台帳を読み込む
            </button>
            {hasLedger && (
              <button className="btn ghost" onClick={() => clearLedger()}>
                取り込んだ実績を全部消す
              </button>
            )}
          </div>

          <div className="mode-pick">
            <div className="pick-title">増加分法定福利費の出し方</div>
            <label className="chk">
              <input
                type="radio"
                name="surcharge-mode"
                checked={state.surchargeMode !== 'actual'}
                onChange={() => setSurchargeMode('fixed')}
              />
              便宜計算（係数 {factor}＝{((factor - 1) * 100).toFixed(1)}%）
            </label>
            <label className="chk">
              <input
                type="radio"
                name="surcharge-mode"
                checked={state.surchargeMode === 'actual'}
                disabled={!hasLedger}
                onChange={() => setSurchargeMode('actual')}
              />
              賃金台帳の実額（事業主負担 ÷ 支給合計をその月の負担率にする）
              {!hasLedger && <span className="note">（台帳を取り込むと選べます）</span>}
            </label>
            <p className="note">
              実額を選んでも、事業主負担が読めない月は自動で便宜計算（{((factor - 1) * 100).toFixed(1)}%）に戻します。
              実績報告でどちらを使うかは、月次明細の数字を見比べて決められます。
            </p>
          </div>
          <p className="note">
            読み込むのは給与ソフトの<b>賃金台帳CSV（1人1ファイル・列が○月度）</b>です。
            ファイルの中身はこの画面の中だけで読み取り、原本はどこにも送りません。
            取り込んだ数字（氏名・月別の残業時間と金額）は、他のデータと同じく合言葉で暗号化して保存されます。
          </p>
        </section>
      )}

      {/* 職員 */}
      <section className="card">
        <h2>
          <span className="num">4</span>対象職員の賃上げ（法人全体・ベア相当額・ベースアップ手当・残業代増額分）
        </h2>
        <p className="note" style={{ marginTop: -4, marginBottom: 10 }}>
          ここの数字は<b>賃金台帳が無い月に使う基準値</b>です。台帳を取り込んだ月は、そちらの実績が優先されます。
        </p>
        <div className="tbl-scroll">
          <table className="staff-table">
            <thead>
              <tr>
                <th>氏名</th>
                <th>職種</th>
                <th>ベア相当額(円)</th>
                <th>ベースアップ手当(円)</th>
                <th>所定労働(h/月)</th>
                <th>残業(h/月)</th>
                <th>賃金台帳</th>
                <th>残業代増額分(円)</th>
                <th>増加分法定福利費(円)</th>
                <th>適用開始月</th>
                <th>充当/月(×{factor})</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => {
                const a = staffAmounts(s, factor, overtimeRate)
                return (
                  <tr key={s.id}>
                    <td data-label="氏名">
                      <input
                        type="text"
                        value={s.name}
                        placeholder="氏名"
                        aria-label="職員の氏名"
                        onChange={(e) => updStaff(s.id, 'name', e.target.value)}
                      />
                      {s.origin && <span className="origin-tag">元：{s.origin}</span>}
                    </td>
                    <td data-label="職種">
                      <select value={s.role} aria-label="職種" onChange={(e) => updStaff(s.id, 'role', e.target.value)}>
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    </td>
                    <td data-label="ベア相当額(円)">
                      <input
                        type="number"
                        min="0"
                        aria-label="ベア相当額"
                        value={s.baseUp || ''}
                        onChange={(e) => updStaff(s.id, 'baseUp', Number(e.target.value) || 0)}
                      />
                    </td>
                    <td data-label="ベースアップ手当(円)">
                      <input
                        type="number"
                        min="0"
                        aria-label="ベースアップ手当"
                        value={s.allowance || ''}
                        onChange={(e) => updStaff(s.id, 'allowance', Number(e.target.value) || 0)}
                      />
                    </td>
                    <td data-label="所定労働(h/月)">
                      <input
                        className="hours"
                        type="number"
                        min="0"
                        step="0.5"
                        aria-label="月平均所定労働時間"
                        value={s.monthlyHours || ''}
                        onChange={(e) =>
                          updStaff(s.id, 'monthlyHours', Number(e.target.value) || 0)
                        }
                      />
                    </td>
                    <td data-label="残業(h/月)">
                      <input
                        className="hours"
                        type="number"
                        min="0"
                        step="0.5"
                        aria-label="月の残業時間"
                        value={s.overtimeHours || ''}
                        onChange={(e) =>
                          updStaff(s.id, 'overtimeHours', Number(e.target.value) || 0)
                        }
                      />
                    </td>
                    <td data-label="賃金台帳">
                      {ledgerCount[String(s.id)] ? (
                        <span className="ledger-cell">
                          <span className="tag tag-auto">{ledgerCount[String(s.id)]} か月</span>
                          <button
                            className="link-btn"
                            onClick={() => clearLedger(s.id)}
                            title="この職員の取り込み実績を消して、上の固定値での計算に戻します"
                          >
                            消す
                          </button>
                        </span>
                      ) : (
                        <span className="note">—</span>
                      )}
                    </td>
                    <td data-label="残業代増額分(円)">{yen(a.overtime)}</td>
                    <td data-label="増加分法定福利費(円)">{yen(a.surcharge)}</td>
                    <td data-label="適用開始月">
                      <input
                        type="month"
                        aria-label="適用開始月"
                        value={s.startYm}
                        onChange={(e) => updStaff(s.id, 'startYm', e.target.value)}
                      />
                    </td>
                    <td data-label="充当/月">{yen(a.charged)}</td>
                    <td className="staff-del-cell">
                      <button className="btn del" onClick={() => delStaff(s.id)}>
                        削除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>合計</td>
                <td data-label="ベア相当額 合計">{yen(staffTotal.bea)}</td>
                <td data-label="ベースアップ手当 合計">{yen(staffTotal.allowance)}</td>
                <td></td>
                <td></td>
                <td></td>
                <td data-label="残業代増額分 合計">{yen(staffTotal.overtime)}</td>
                <td data-label="増加分法定福利費 合計">{yen(staffTotal.surcharge)}</td>
                <td></td>
                <td data-label="充当/月 合計">{yen(staffTotal.charged)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="row-actions">
          <button className="btn" onClick={addStaff}>
            ＋ 職員を追加
          </button>
          <label className="field-row" style={{ marginLeft: 'auto' }}>
            増加分法定福利費の係数
            <input
              type="number"
              step="0.001"
              min="1"
              aria-label="増加分法定福利費の係数"
              value={factor}
              onChange={(e) => setFactor(Number(e.target.value) || 1)}
            />
          </label>
          <label className="field-row">
            時間外割増率
            <input
              type="number"
              step="0.05"
              min="1"
              aria-label="時間外割増率"
              value={overtimeRate}
              onChange={(e) => setOvertimeRate(Number(e.target.value) || 1)}
            />
          </label>
        </div>
        <p className="note">
          職員は<b>法人（緑ヶ丘＋鷹匠）でまとめて</b>登録します。「元：薬局名」は、薬局別に分けていた頃のデータの出どころです（同じ方が二重に入っていたら片方を削除してください）。
          <br />
          <b>ベア相当額</b>＝基本給等の引上げ分（月額）。<b>ベースアップ手当</b>＝手当として支給している分（月額）。この2つは別枠で集計します。
          <br />
          <b>残業代増額分</b>＝（ベア相当額＋ベースアップ手当）÷ 月平均所定労働時間 × 割増率{overtimeRate} × 残業時間。ベアで時間単価が上がった分だけ残業代も増えるため、その増額分を賃金改善に算入します。
          <br />
          この3つの合計に、増加分法定福利費の係数 <b>{factor}</b>（＝{((factor - 1) * 100).toFixed(1)}%・社会保険料など事業主負担の増加分。厚労省Q&Aで一律16.5%の便宜計算が認められています）を掛けた額を充当額とみなします。実績報告では実額をご確認ください。
        </p>
      </section>

      {/* 年度サマリー */}
      <section className="card">
        <h2>
          <span className="num">5</span>年度サマリー（実績報告の目安・法人合算）
        </h2>
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th>算定年度</th>
                <th>受付回数 計</th>
                <th>評価料収入 計(円)</th>
                <th>ベア相当額 計</th>
                <th>ベースアップ手当 計</th>
                <th>残業代増額分 計</th>
                <th>増加分法定福利費 計</th>
                <th>賃金改善 計(円)</th>
                <th>差額(改善−収入)</th>
                <th>充当率</th>
              </tr>
            </thead>
            <tbody>
              {byFiscal.length === 0 ? (
                <tr className="pending">
                  <td colSpan={10} style={{ textAlign: 'center' }}>
                    経営ダッシュボードに処方箋枚数が入ると集計されます
                  </td>
                </tr>
              ) : (
                byFiscal.map((g) => {
                  const diff = g.improve - g.income
                  const rate = g.income > 0 ? (g.improve / g.income) * 100 : 0
                  return (
                    <tr key={g.fiscal} className={diff < 0 ? 'short' : ''}>
                      <td>{g.fiscal}</td>
                      <td>{yen(g.receipts)}</td>
                      <td>{yen(g.income)}</td>
                      <td>{yen(g.bea)}</td>
                      <td>{yen(g.allowance)}</td>
                      <td>{yen(g.overtime)}</td>
                      <td>{yen(g.surcharge)}</td>
                      <td>{yen(g.improve)}</td>
                      <td style={{ color: diff < 0 ? '#c25454' : '#6f8a2c' }}>
                        {diff >= 0 ? '+' : ''}
                        {yen(diff)}
                      </td>
                      <td>{rate.toFixed(1)}%</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="note">
          賃金改善実績報告書は毎年8月に提出します。評価料収入は全額を賃金改善に充てる必要があるため、差額がプラス（改善 ≧ 収入）になっているか各年度で確認してください。
        </p>
      </section>

      {/* データ管理 */}
      <section className="card">
        <h2>
          <span className="num">6</span>データ管理
        </h2>
        <div className="row-actions">
          <button className="btn" onClick={exportCsv}>
            月次明細をCSV出力
          </button>
          <button className="btn ghost" onClick={resetAll}>
            サンプルに戻す
          </button>
        </div>
        <p className="note">
          <b>処方箋受付回数の入力欄はありません。</b>
          経営ダッシュボードタブに月次データ（処方箋枚数）を入れれば、こちらへ自動で反映されます。
          レセコンからの取り込みも経営ダッシュボード側で行ってください。
        </p>
        <p className="note">
          職員・係数の入力内容は合言葉で暗号化してクラウド（Supabase）に保存され、どの端末からでも同じ内容が見られます。現在の単価＝1点{YEN_PER_POINT}円／今月の点数＝{nowPoints}点。
        </p>
      </section>
    </div>
  )
}
