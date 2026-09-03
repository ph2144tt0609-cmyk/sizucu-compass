import React, { useState, useMemo, useEffect } from "react";
import {
  ComposedChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from "recharts";
import {
  RECEIPT_LIMIT,
  CONC_LIMIT,
  basicPeriods,
  judgeBasicFee,
} from "./basicFeeCalc.js";
import { C, FONT_HEAD } from "./theme.js";

// 調剤基本料の判定ビュー（画面）。
// ★判定の計算（1,800回・85%の2条件、除外枚数の差し引き、期間の組み立て）は ./basicFeeCalc.js に置いてある。
//   早見表も同じ関数を使うので、ここでは計算しない。
// データは経営タブと同じ pharmData（会計年度=10月始まりの years{}）を5月始まりに組み替えて使う。

const mai = (n) => Math.round(n).toLocaleString("ja-JP") + "枚";
const yy = (y) => String(y % 100).padStart(2, "0");

export default function BasicFee({ pharmData, isDesktop, excluded = {}, onSetExcluded }) {
  // 各会計年度K は 基本料期間K（10〜4月分）と K+1（5〜9月分）に使われるので、両方を候補に含める。
  // 例：会計年度2025 があれば '25/5〜'26/4（P=2025）と '26/5〜'27/4（P=2026）を選べる。
  const periods = useMemo(() => basicPeriods(pharmData), [pharmData]);

  const [P, setP] = useState(() => periods[0]);
  useEffect(() => {
    if (periods.length && !periods.includes(P)) setP(periods[0]);
  }, [periods, P]);

  if (!periods.length) {
    return (
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "22px 18px", textAlign: "center", color: C.sub, fontSize: 13 }}>
        経営タブで月次データを入力すると、ここに調剤基本料の判定が表示されます。
      </div>
    );
  }

  return (
    <>
      {/* 説明 */}
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "14px 15px", marginBottom: 14, boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: FONT_HEAD, fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: C.teal }} />
          調剤基本料の判定
        </div>
        <div style={{ fontSize: 12, color: C.sub, lineHeight: 1.7 }}>
          調剤基本料2（減点）になるのは、<b style={{ color: C.ink }}>月平均受付回数 {mai(RECEIPT_LIMIT)}超</b> <b>かつ</b> <b style={{ color: C.ink }}>処方箋集中率 {CONC_LIMIT}%超</b> の<b>両方</b>に該当したときだけです。
          受付回数は<b>時間外・休日・深夜加算</b>を算定した処方箋を<b>除外</b>できます。集中率は他科（別医療機関）が多いほど下がります。判定期間は<b>前年5/1〜当年4/30</b>。
        </div>
      </div>

      {/* 期間セレクタ */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.sub, letterSpacing: 1, flex: "0 0 auto" }}>期間</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
          {periods.map((p) => (
            <button
              key={p}
              onClick={() => setP(p)}
              style={{
                padding: "7px 14px", borderRadius: 4,
                border: `1px solid ${p === P ? C.accent : C.border}`,
                background: p === P ? C.accent : "#fff",
                color: p === P ? "#fff" : C.sub,
                fontWeight: 700, fontSize: 13, cursor: "pointer",
              }}
            >
              {`'${yy(p)}/5〜'${yy(p + 1)}/4`}
            </button>
          ))}
        </div>
      </div>

      {/* 薬局ごとの判定カード */}
      <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "1fr 1fr" : "1fr", gap: 14 }}>
        {pharmData.map((pharm) => (
          <PharmacyCard key={pharm.name} pharm={pharm} P={P} excluded={excluded} onSetExcluded={onSetExcluded} />
        ))}
      </div>

      {/* 出典・正式ルール */}
      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "13px 15px", marginTop: 16, fontSize: 11, color: C.sub, lineHeight: 1.8 }}>
        <div style={{ fontWeight: 800, color: C.ink, fontSize: 12, marginBottom: 4 }}>調剤基本料の正式な基準（令和6年〜／厚生労働省）</div>
        調剤基本料は前年5/1〜当年4/30の実績（受付回数の月平均・処方箋集中率）で判定し、翌年6/1〜適用されます。主な区分：<br />
        ・<b>基本料1（47点）</b>＝下記2・3・特別いずれにも該当しない薬局<br />
        ・<b>基本料2（30点）</b>＝①月<b>1,800回超</b>かつ集中率<b>85%超</b> ／ ②月4,000回超かつ上位3医療機関の合計70%超 ／ ③月4,000回超で特定医療機関 ／ ④都市部の新規（月600〜1,800回かつ集中率85%超）<br />
        ・受付回数から<b>除外</b>：時間外・休日・深夜加算を算定した処方箋、在宅（訪問薬剤管理指導）分 等<br />
        ・集中率＝最も処方箋の多い1医療機関の受付回数 ÷ 全受付回数（同一敷地・同一建物の医療機関は合算）<br />
        <span style={{ color: C.amber }}>※ 本ツールは開局薬局で最も一般的な①（受付1,800×集中率85%）で判定します。集中率は入力済みの「他科枚数」に基づく概算です。正式な届出前は必ず地方厚生局の要件をご確認ください。</span>
      </div>
    </>
  );
}

function PharmacyCard({ pharm, P, excluded, onSetExcluded }) {
  const judged = useMemo(() => judgeBasicFee(pharm, P, excluded), [pharm, P, excluded]);
  const { rows, exOf, n, sumOther, sumEx, avgAdj, avgRaw, conc, overReceipt, overConc, isBasic2 } =
    judged;

  const [openEx, setOpenEx] = useState(false);
  const [draft, setDraft] = useState({});
  useEffect(() => {
    const d = {};
    rows.forEach((r) => {
      const v = exOf(r);
      d[r.period] = v ? String(v) : "";
    });
    setDraft(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pharm.name, P, excluded]);

  const chartData = rows.map((r) => ({ period: r.period, adj: r.total == null ? null : Math.max(0, r.total - exOf(r)) }));

  return (
    <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "16px 16px 12px", boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
      {/* ヘッダ */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
        <div style={{ fontFamily: FONT_HEAD, fontSize: 16, fontWeight: 600, color: C.ink }}>{pharm.name}</div>
        <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", background: n === 0 ? C.sub : isBasic2 ? C.down : C.up, padding: "5px 12px", borderRadius: 999, whiteSpace: "nowrap" }}>
          {n === 0 ? "データなし" : isBasic2 ? "調剤基本料 2（該当）" : "調剤基本料 1（維持）"}
        </span>
      </div>

      {/* 2条件のタイル */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <MetricTile
          label="月平均 受付回数（除外後）"
          value={n ? Math.round(avgAdj).toLocaleString("ja-JP") : "—"}
          unit="枚"
          sub={n ? `除外前 ${mai(avgRaw)}` : ""}
          over={overReceipt}
          limitText={`${mai(RECEIPT_LIMIT)}超で条件`}
        />
        <MetricTile
          label="処方箋集中率"
          value={n ? conc.toFixed(1) : "—"}
          unit="%"
          sub={n ? `他科 月平均 ${mai(sumOther / (n || 1))}` : ""}
          over={overConc}
          limitText={`${CONC_LIMIT}%超で条件`}
        />
      </div>

      {/* 判定ロジック */}
      <div style={{ background: isBasic2 ? "#fbecea" : "#eef4e6", borderRadius: 6, padding: "9px 11px", fontSize: 11.5, color: C.ink, lineHeight: 1.6, marginBottom: 12 }}>
        <b>基本料2</b>は<b>両方</b>に当てはまる時のみ：
        <span style={{ marginLeft: 6, fontWeight: 800, color: overReceipt ? C.down : C.up }}>{overReceipt ? "✓" : "✕"} 受付1,800超</span>
        <span style={{ marginLeft: 8, fontWeight: 800, color: overConc ? C.down : C.up }}>{overConc ? "✓" : "✕"} 集中率85%超</span>
        <div style={{ marginTop: 3, color: C.sub }}>
          {n === 0
            ? "データがありません。"
            : isBasic2
            ? "両方に該当 → 基本料2（30点）。除外枚数の計上や他科の確保で回避余地があります。"
            : overReceipt
            ? `受付は超過中ですが集中率が${CONC_LIMIT}%以下のため基本料1を維持。`
            : overConc
            ? `集中率は高いが受付が${mai(RECEIPT_LIMIT)}以下のため基本料1を維持。`
            : `どちらも基準内。基本料1を維持（登録${n}か月の暫定）。`}
        </div>
      </div>

      {/* 月別バー（除外後受付）＋1,800ライン */}
      <ResponsiveContainer width="100%" height={170}>
        <ComposedChart data={chartData} margin={{ top: 10, right: 6, left: -6, bottom: 0 }}>
          <CartesianGrid stroke={C.line} vertical={false} />
          <XAxis dataKey="period" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} interval={0} />
          <YAxis tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={40} domain={[0, (dm) => Math.max(RECEIPT_LIMIT * 1.1, dm * 1.05)]} tickFormatter={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v)} />
          <Tooltip formatter={(v) => [v == null ? "未登録" : v.toLocaleString("ja-JP") + "枚", "受付(除外後)"]} contentStyle={{ borderRadius: 6, border: "none", boxShadow: "0 4px 14px rgba(0,0,0,.1)", fontSize: 12 }} />
          <ReferenceLine y={RECEIPT_LIMIT} stroke={C.down} strokeDasharray="5 4" strokeWidth={1.5} label={{ value: "1,800", position: "insideTopRight", fontSize: 10, fill: C.down, fontWeight: 700 }} />
          <Bar dataKey="adj" radius={[4, 4, 0, 0]} maxBarSize={20}>
            {chartData.map((r, i) => (
              <Cell key={i} fill={r.adj == null ? "#e9eff5" : r.adj > RECEIPT_LIMIT ? C.down : C.tealBright} />
            ))}
          </Bar>
        </ComposedChart>
      </ResponsiveContainer>

      {/* 除外枚数の入力（時間外・休日・深夜等） */}
      <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 8, paddingTop: 10 }}>
        <button
          onClick={() => setOpenEx((v) => !v)}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", border: "none", background: "transparent", cursor: "pointer", padding: 0, color: C.teal, fontWeight: 800, fontSize: 12.5 }}
        >
          <span>除外枚数を入力（時間外・休日・深夜等）{sumEx ? `　計 ${mai(sumEx)}` : ""}</span>
          <span style={{ fontSize: 14 }}>{openEx ? "▲" : "▼"}</span>
        </button>
        {openEx && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.6, marginBottom: 8 }}>
              各月の受付のうち、<b>時間外・休日・深夜加算を算定した処方箋の枚数</b>を入力すると、受付回数から差し引いて判定します。
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {rows.map((r) => (
                <div key={r.period} style={{ display: "flex", alignItems: "center", gap: 6, opacity: r.total == null ? 0.5 : 1 }}>
                  <span style={{ flex: "0 0 34px", fontSize: 12, fontWeight: 700, color: C.sub }}>{r.period}</span>
                  <span style={{ flex: "0 0 auto", fontSize: 10.5, color: C.sub }}>受付{r.total == null ? "—" : r.total.toLocaleString("ja-JP")}</span>
                  <input
                    value={draft[r.period] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.period]: e.target.value.replace(/[^0-9]/g, "") }))}
                    onBlur={() => onSetExcluded && onSetExcluded(pharm.name, r.fiscalYear, r.period, draft[r.period])}
                    inputMode="numeric"
                    placeholder="除外0"
                    style={{ flex: 1, minWidth: 0, height: 34, border: `1px solid ${C.line}`, borderRadius: 6, padding: "0 8px", fontSize: 13, textAlign: "right", boxSizing: "border-box" }}
                  />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.sub, marginTop: 8 }}>※ 入力するとクラウドに同期され、全端末に反映されます。</div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({ label, value, unit, sub, over, limitText }) {
  const col = over ? C.down : C.up;
  return (
    <div style={{ background: over ? "#fbecea" : "#eef4e6", borderRadius: 6, padding: "10px 11px", border: `1px solid ${col}22` }}>
      <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700, lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: over ? C.down : C.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1, marginTop: 2 }}>
        {value}
        <span style={{ fontSize: 13, color: C.sub, fontWeight: 700 }}> {unit}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3, gap: 6 }}>
        <span style={{ fontSize: 10, color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</span>
        <span style={{ fontSize: 9.5, fontWeight: 800, color: col, whiteSpace: "nowrap" }}>{limitText}</span>
      </div>
    </div>
  );
}
