// 早見表 ─ コンパスの1ページめ。
//
// ねらいは「開いた瞬間に全体像がつかめること」。各論（月を選ぶ・数字を入れる・表を見る）は
// それぞれのタブに任せ、ここでは
//   ① 法人の直近月の数字（売上・枚数・技術料率・集中率）
//   ② 気になるところ（期限・基本料の危険水域・充当不足・入力もれ）
//   ③ 4つの道具の現在地（押すとそのタブへ飛ぶ）
//   ④ 薬局別の一覧
// だけを、上から順に読めば分かる形で並べる。
//
// ★このページは読み取り専用★ クラウドへ書き込まない（数字を触るのは各タブ）。
import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { C, FONT_SANS, FONT_HEAD } from "./theme.js";
import {
  CORP_NAME,
  loadOverridesMerged,
  mergePharmData,
  mergeCorpLabor,
  collectYears,
  seriesOf,
} from "./pharmModel.js";
import { judgeBasicFee, basicPeriods, RECEIPT_LIMIT, CONC_LIMIT } from "./basicFeeCalc.js";
import { cloudLoadEx, CLOUD_KEYS } from "../cloud";
import { buildReceipts, periodToYm } from "../dashboardReceipts";
import { migrateBaseup, defaultState, baseupSummary, PHARMACY_NAMES } from "../baseupCalc";
import { progressOf } from "../subsidyStatus";
import { daysUntil, daysLabel } from "../expiry";

const yen = (n) => "¥" + Math.round(n || 0).toLocaleString("ja-JP");
const man = (n) => (Math.round(n / 10000) || 0).toLocaleString("ja-JP") + "万";
const pct = (n) => (n || 0).toFixed(1) + "%";
const mai = (n) => Math.round(n || 0).toLocaleString("ja-JP") + "枚";
const ymLabel = (ym) => (ym ? `${ym.slice(0, 4)}年${Number(ym.slice(5, 7))}月` : "—");

// 今月を "YYYY-MM" で
const thisYm = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
// ym どうしの月数の差（a が b より何か月あとか）
const ymDiff = (a, b) => {
  if (!a || !b) return 0;
  return (Number(a.slice(0, 4)) - Number(b.slice(0, 4))) * 12 + (Number(a.slice(5, 7)) - Number(b.slice(5, 7)));
};
// 先月（＝締まっている最後の月）。今月はまだ数字が出そろわないので、未入力の判定はここまでで見る。
const lastClosedYm = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
// from 〜 to の月を並べる（両端を含む）
const ymRange = (from, to) => {
  if (!from || !to || from > to) return [];
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  for (let i = 0; i < 240; i++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym >= to) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};
const ymShort = (ym) => (ym ? `${ym.slice(2, 4)}/${Number(ym.slice(5, 7))}` : "—");
// 月をならべて見せる（多いときは頭だけ出す＝1行に収める）
const ymList = (yms, keep = 6) =>
  yms.length <= keep
    ? yms.map(ymShort).join("・")
    : `${yms.slice(0, keep).map(ymShort).join("・")} ほか${yms.length - keep}か月`;

// 前月比（増えた方が良い数字＝invert なし／率は pt で見る）
function Delta({ cur, prev, unit, invert }) {
  if (prev == null || cur == null) return <span style={{ color: C.sub, fontSize: 11 }}>—</span>;
  const isPt = unit === "pt";
  const d = isPt ? cur - prev : prev ? ((cur - prev) / prev) * 100 : 0;
  if (!isFinite(d)) return <span style={{ color: C.sub, fontSize: 11 }}>—</span>;
  const good = invert ? d <= 0 : d >= 0;
  return (
    <span style={{ color: good ? C.up : C.down, fontWeight: 700, fontSize: 11.5, whiteSpace: "nowrap" }}>
      {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}
      {isPt ? "pt" : "%"}
    </span>
  );
}

// 通信の一過性の失敗で「データなし」に見えるのを防ぐため、1回だけ読み直す
async function loadCloud(key) {
  let res = await cloudLoadEx(key).catch(() => ({ data: null, status: "error" }));
  if (res.status === "error") {
    await new Promise((r) => setTimeout(r, 800));
    res = await cloudLoadEx(key).catch(() => ({ data: null, status: "error" }));
  }
  return res;
}

const LOAD_LABEL = { error: "読み込めませんでした", locked: "合言葉で開けませんでした" };

export default function OverviewTab({ onJump }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState({ dashboard: "ok", baseup: "ok", subsidies: "ok" });
  const [ov, setOv] = useState(null);
  const [bstate, setBstate] = useState(null);
  const [receipts, setReceipts] = useState({});
  const [shops, setShops] = useState(PHARMACY_NAMES);
  const [subsidies, setSubsidies] = useState([]);

  // 4つの道具のデータをまとめて読む（どれかが落ちても他は出す）。
  // ★読み込みに失敗したものを「0件・未入力」として描かない★
  //   このページは「入っていないデータ」を出すのが役目なので、通信の失敗を空データとして
  //   表示すると、入っているはずの数字が消えたように見えてしまう（2026-09-04 に本番で発生）。
  useEffect(() => {
    let alive = true;
    (async () => {
      const [o, b, s] = await Promise.all([
        loadOverridesMerged().catch(() => ({ ov: null, status: "error" })),
        loadCloud(CLOUD_KEYS.baseup),
        loadCloud(CLOUD_KEYS.subsidies),
      ]);
      if (!alive) return;
      const merged = o.ov || { pharm: {}, corpLabor: {}, years: [], excluded: {} };
      setOv(merged);
      // 受付回数は、いま読んだ手入力からその場で組み立てる（同じデータを二度読みに行かない）
      const r = buildReceipts(merged);
      setReceipts(r.receipts || {});
      if (r.shops && r.shops.length) setShops(r.shops);
      // migrateBaseup は変換するだけ（保存はしない＝早見表は読むだけ）
      const m = migrateBaseup(b.data);
      setBstate(m ? m.state : defaultState());
      setSubsidies(Array.isArray(s.data) ? s.data : []);
      setStatus({ dashboard: o.status, baseup: b.status, subsidies: s.status });
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ── 経営（薬局別＋法人の直近月と前月）──
  const pharmData = useMemo(() => (ov ? mergePharmData(ov) : []), [ov]);
  const corpLabor = useMemo(() => (ov ? mergeCorpLabor(ov) : {}), [ov]);
  const years = useMemo(() => (ov ? collectYears(ov) : []), [ov]);

  const lines = useMemo(() => {
    if (!pharmData.length) return [];
    const names = [...pharmData.map((p) => p.name), CORP_NAME];
    return names.map((name, i) => {
      const ser = seriesOf(pharmData, corpLabor, i, years);
      return {
        name,
        isCorp: i === pharmData.length,
        ser,
        cur: ser.length ? ser[ser.length - 1] : null,
        prev: ser.length > 1 ? ser[ser.length - 2] : null,
        months: ser.length,
      };
    });
  }, [pharmData, corpLabor, years]);

  const corp = lines.find((l) => l.isCorp) || null;

  // 直近12か月の流れ（1点の数字より、上がっているのか下がっているのかが分かる）
  const trend = useMemo(() => {
    if (!corp) return [];
    // 目盛りには年も入れる（未入力の月が抜けると「4月→10月」のように飛ぶので、
    // 月だけだと同じ月が2回出ているように見えてしまう）
    return corp.ser.slice(-12).map((r) => ({
      label: `${r.ym.slice(2, 4)}/${Number(r.ym.slice(5, 7))}`,
      売上: r.sales,
      処方箋枚数: r.total,
    }));
  }, [corp]);

  // ── 調剤基本料の判定（いちばん新しい判定期間）──
  const basic = useMemo(() => {
    if (!pharmData.length) return { P: null, list: [] };
    const P = basicPeriods(pharmData)[0];
    const ex = (ov && ov.excluded) || {};
    return { P, list: pharmData.map((p) => ({ name: p.name, ...judgeBasicFee(p, P, ex) })) };
  }, [pharmData, ov]);

  // ── ベースアップ評価料（充当率）──
  // 月次行まで持っておく（累計だけでなく「どの月が未入力か」を出すため）
  const baseupAll = useMemo(
    () => (bstate ? baseupSummary(bstate, receipts, shops) : null),
    [bstate, receipts, shops]
  );
  const baseup = baseupAll ? baseupAll.totals : null;

  // ── 補助金（件数・未入金・いちばん近い期限）──
  const subsidy = useMemo(() => {
    let appliedSum = 0;
    let paidSum = 0;
    let done = 0;
    subsidies.forEach((s) => {
      const amt = Number(s.amount) || 0;
      if (s.applied) appliedSum += amt;
      if (s.paid) paidSum += amt;
      if (progressOf(s).done) done += 1;
    });
    // 申請期限が意味を持つのは「まだ申請していないもの」だけ。
    // 申請済みのものに期限の警告を出しても打てる手がない（＝雑音になる）ので外す。
    const todo = subsidies
      .filter((s) => !s.applied && s.deadline)
      .sort((a, b) => a.deadline.localeCompare(b.deadline));
    return {
      count: subsidies.length,
      done,
      active: subsidies.length - done,
      unapplied: subsidies.filter((s) => !s.applied).length,
      unpaid: appliedSum - paidSum,
      nearest: todo[0] || null,
      todo,
    };
  }, [subsidies]);

  // ── 入っていないデータ（何を入れれば全部そろうか）──
  // 「どの数字が足りないのか」が分からないと、早見表の数字が正しいのかも判断できない。
  // そろっている項目もあえて残して、確認済みであることが分かるようにする。
  const gaps = useMemo(() => {
    const out = [];
    const last = lastClosedYm();
    // 読めなかったものは「入っていない」ではなく「読めなかった」と出す
    const badLoad = (st) => st === "error" || st === "locked";
    const loadRow = (tab, label, st) => ({
      tab,
      label,
      ok: false,
      state: LOAD_LABEL[st] || "読み込めませんでした",
      detail: "通信の状態を確かめて、画面を再読み込みしてください（データは消えていません）",
      reload: true, // タブへ飛んでも直らないので、行の操作は「再読み込み」にする
    });
    if (badLoad(status.dashboard)) out.push(loadRow("dashboard", "経営の月次", status.dashboard));

    // ① 薬局ごとの月次（最初に入力した月〜先月 のあいだで抜けている月）
    lines
      .filter((l) => !l.isCorp)
      .forEach((l) => {
        if (!l.ser.length) {
          out.push({
            tab: "dashboard",
            label: `経営の月次（${l.name}）`,
            ok: false,
            state: "1か月も入っていません",
            detail: "レセコンの日計明細から入れてください",
          });
          return;
        }
        const have = new Set(l.ser.map((r) => r.ym));
        const miss = ymRange(l.ser[0].ym, last).filter((m) => !have.has(m));
        out.push({
          tab: "dashboard",
          label: `経営の月次（${l.name}）`,
          ok: miss.length === 0,
          state: miss.length ? `${miss.length}か月ぶん未入力` : `${l.ser.length}か月そろっています`,
          detail: miss.length ? ymList(miss) : `${ymShort(l.ser[0].ym)}〜${ymShort(l.cur.ym)}`,
        });
      });

    // ② 片方の薬局しか入っていない月（法人の合算に入らない＝法人の数字が飛ぶ原因）
    const shopLines = lines.filter((l) => !l.isCorp && l.ser.length);
    if (corp && shopLines.length >= 2) {
      // 開局が遅い薬局に合わせて数える（開局前の月まで「片落ち」と言わない）
      const commonFrom = shopLines.map((l) => l.ser[0].ym).sort().pop();
      const union = new Set(shopLines.flatMap((l) => l.ser.map((r) => r.ym)));
      const corpSet = new Set(corp.ser.map((r) => r.ym));
      const half = [...union].filter((m) => m >= commonFrom && !corpSet.has(m)).sort();
      out.push({
        tab: "dashboard",
        label: "法人合算に入らない月（片方だけ入力）",
        ok: half.length === 0,
        state: half.length ? `${half.length}か月` : "ありません",
        detail: half.length ? ymList(half) : `${ymShort(commonFrom)}以降は両薬局そろっています`,
      });
    }

    // ③ 法人の人件費（労働分配率の計算に使う）
    if (corp && corp.ser.length) {
      const miss = corp.ser.filter((r) => !r.labor).map((r) => r.ym);
      out.push({
        tab: "dashboard",
        label: "法人の人件費（労働分配率に使う）",
        ok: miss.length === 0,
        state: miss.length ? `${miss.length}か月ぶん未入力` : "そろっています",
        detail: miss.length ? ymList(miss) : "",
      });
    }

    // ④ 調剤基本料の判定期間（まだ来ていない月は「未入力」と数えない）
    basic.list.forEach((b) => {
      const cells = b.rows.map((r) => ({ ...r, ym: periodToYm(r.fiscalYear, r.period) }));
      const past = cells.filter((c) => c.ym && c.ym <= last); // 経過した月だけ
      const miss = past.filter((c) => c.total == null);
      out.push({
        tab: "kihonryo",
        label: `調剤基本料の判定期間（${b.name}）`,
        ok: miss.length === 0,
        state: `経過 ${past.length}か月中 ${past.length - miss.length}か月`,
        detail: miss.length
          ? `未入力 ${ymList(miss.map((c) => c.ym))}`
          : `判定期間 12か月のうち ${past.length}か月が経過（いまのところ全部入っています）`,
      });
    });

    // ⑤ ベースアップ：受付回数（＝処方箋枚数）と賃金台帳
    if (badLoad(status.baseup)) {
      out.push(loadRow("baseup", "ベースアップ評価料のデータ", status.baseup));
    } else if (baseupAll) {
      // 月の枠は先の月まで用意されているので、まだ来ていない月は数えない
      const noReceipt = baseupAll.rows.filter((r) => !r.entered && r.ym <= last).map((r) => r.ym);
      out.push({
        tab: "baseup",
        label: "ベースアップの受付回数",
        ok: noReceipt.length === 0,
        state: noReceipt.length
          ? `${noReceipt.length}か月ぶん未入力`
          : `${baseupAll.entered.length}か月そろっています`,
        detail: noReceipt.length ? `${ymList(noReceipt)}（経営の月次を入れると自動で入ります）` : "",
      });
      const noLedger = baseupAll.entered.filter((r) => !r.fromLedger).map((r) => r.ym);
      out.push({
        tab: "baseup",
        label: "ベースアップの賃金台帳",
        ok: noLedger.length === 0,
        state: noLedger.length
          ? `${noLedger.length}か月ぶん未取込`
          : `${baseupAll.entered.length}か月 取込済み`,
        detail: noLedger.length ? `${ymList(noLedger)}（いまは職員表の固定値で計算）` : "",
      });
    }

    // ⑥ 補助金：金額・期限が空のもの
    if (badLoad(status.subsidies)) {
      out.push(loadRow("hojokin", "補助金のデータ", status.subsidies));
    } else if (subsidies.length) {
      const noAmount = subsidies.filter((s) => !Number(s.amount));
      const noDeadline = subsidies.filter((s) => !s.deadline);
      out.push({
        tab: "hojokin",
        label: "補助金の金額・期限",
        ok: !noAmount.length && !noDeadline.length,
        state:
          noAmount.length || noDeadline.length
            ? `${noAmount.length + noDeadline.length}件で未設定`
            : `${subsidies.length}件 すべて設定済み`,
        detail: [
          noAmount.length ? `金額なし ${noAmount.length}件` : "",
          noDeadline.length ? `期限なし ${noDeadline.length}件（期限が無いと未申請の警告を出せません）` : "",
        ]
          .filter(Boolean)
          .join("／"),
      });
    }

    // 足りないものを上に、そろっているものを下に
    return out.sort((a, b) => Number(a.ok) - Number(b.ok));
  }, [lines, corp, basic, baseupAll, subsidies, status]);

  const gapCount = gaps.filter((g) => !g.ok).length;

  // 読み込めなかったもの（画面の先頭で断る）
  const failedLoads = [
    status.dashboard !== "ok" && status.dashboard !== "empty" ? "経営の月次" : "",
    status.baseup !== "ok" && status.baseup !== "empty" ? "ベースアップ評価料" : "",
    status.subsidies !== "ok" && status.subsidies !== "empty" ? "補助金" : "",
  ].filter(Boolean);

  // ── 気になるところ（上から順に手を打つ順番）──
  const alerts = useMemo(() => {
    const out = [];
    // ① 補助金の申請期限（未申請のもののうち30日以内・超過）
    subsidy.todo.forEach((s) => {
      const d = daysUntil(s.deadline);
      if (d == null || d > 30) return;
      out.push({
        level: d <= 7 ? "bad" : "warn",
        tab: "hojokin",
        title: `補助金「${s.name}」が未申請（申請期限は${daysLabel(s.deadline)}）`,
        note: `${s.department || "区分なし"}／${yen(s.amount)}`,
      });
    });
    // ② 調剤基本料（該当＝減点／片方だけ該当＝危険水域）
    basic.list.forEach((b) => {
      if (!b.n) return;
      if (b.isBasic2) {
        out.push({
          level: "bad",
          tab: "kihonryo",
          title: `${b.name}：調剤基本料2に該当（2条件とも超過）`,
          note: `月平均 ${mai(b.avgAdj)}（${mai(RECEIPT_LIMIT)}超）／集中率 ${pct(b.conc)}（${CONC_LIMIT}%超）`,
        });
      } else if (b.overReceipt || b.overConc) {
        const which = b.overReceipt ? `月平均受付回数 ${mai(b.avgAdj)}` : `集中率 ${pct(b.conc)}`;
        const other = b.overReceipt ? `集中率 ${pct(b.conc)}（${CONC_LIMIT}%以下）` : `月平均 ${mai(b.avgAdj)}（${mai(RECEIPT_LIMIT)}以下）`;
        out.push({
          level: "warn",
          tab: "kihonryo",
          title: `${b.name}：${which} が基準を超過（いまは基本料1を維持）`,
          note: `もう一方（${other}）も超えると基本料2になる`,
        });
      }
    });
    // ③ ベースアップの充当不足／未入力
    if (baseup) {
      if (!baseup.count) {
        out.push({
          level: "warn",
          tab: "baseup",
          title: "ベースアップ評価料：集計できる月がまだありません",
          note: "経営ダッシュボードに処方箋枚数を入れると自動で入ります",
        });
      } else if (!baseup.ok) {
        out.push({
          level: "bad",
          tab: "baseup",
          title: `ベースアップ評価料：賃金改善が ${yen(-baseup.diff)} 不足`,
          note: `充当率 ${pct(baseup.rate)}（100%以上で適合・入力済 ${baseup.count} か月）`,
        });
      }
    }
    // ④ 月次の入力もれ（法人の直近月が2か月以上前）
    if (corp && corp.cur) {
      const behind = ymDiff(thisYm(), corp.cur.ym);
      if (behind >= 2) {
        out.push({
          level: "warn",
          tab: "dashboard",
          title: `経営の数字が ${ymLabel(corp.cur.ym)} まで（${behind - 1} か月ぶん未入力）`,
          note: "レセコンの日計明細から月次を入れてください",
        });
      }
    }
    const rank = { bad: 0, warn: 1 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
  }, [subsidy, basic, baseup, corp]);

  // 一度に読めるのは6件くらいまで。あふれた分は1行にまとめ、続きは各タブで見てもらう。
  const SHOW_ALERTS = 6;
  const shownAlerts = alerts.slice(0, SHOW_ALERTS);
  const hiddenAlerts = alerts.length - shownAlerts.length;

  if (loading) {
    return (
      <div style={{ padding: "40px 0", textAlign: "center", color: C.sub, fontFamily: FONT_SANS, fontSize: 13 }}>
        読み込んでいます…
      </div>
    );
  }

  return (
    <div style={{ padding: "6px 0 44px", fontFamily: FONT_SANS, color: C.ink }}>
      {/* ── 見出し ── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ fontFamily: FONT_HEAD, fontSize: 21, fontWeight: 700, color: C.ink }}>早見表</div>
        <div style={{ fontSize: 12.5, color: C.sub }}>
          {CORP_NAME}｜{corp && corp.cur ? `${ymLabel(corp.cur.ym)}までの数字` : "月次データがまだありません"}
        </div>
      </div>

      {/* 読み込めなかったものがあるときは、まずそれを言う（数字が欠けて見える理由） */}
      {failedLoads.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            border: `1px solid ${C.down}`,
            borderLeft: `3px solid ${C.down}`,
            borderRadius: 4,
            background: C.downBg,
            padding: "10px 12px",
            marginBottom: 14,
            fontSize: 13,
          }}
        >
          <span style={{ fontWeight: 800, color: C.down }}>！</span>
          <span style={{ minWidth: 0 }}>
            <b>{failedLoads.join("・")}</b> を読み込めませんでした。
            この画面の数字は不完全です（データは消えていません）。
          </span>
          <button
            onClick={() => location.reload()}
            style={{
              marginLeft: "auto",
              font: "inherit",
              fontSize: 12,
              fontWeight: 700,
              color: "#fff",
              background: C.accent,
              border: "none",
              borderRadius: 4,
              padding: "6px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            再読み込み
          </button>
        </div>
      )}

      {/* ── ① 法人の直近月 ── */}
      {corp && corp.cur ? (
        <div style={{ background: C.teal, borderRadius: 6, padding: "16px 18px", color: "#fff", marginBottom: 14 }}>
          <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 10, letterSpacing: 0.02 }}>
            法人合計（{CORP_NAME}）・{ymLabel(corp.cur.ym)}　※両薬局そろった月だけを合算
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
            <BigNum label="売上" value={yen(corp.cur.sales)} delta={<Delta cur={corp.cur.sales} prev={corp.prev && corp.prev.sales} />} wide />
            <BigNum label="処方箋枚数" value={mai(corp.cur.total)} delta={<Delta cur={corp.cur.total} prev={corp.prev && corp.prev.total} />} />
            <BigNum label="技術料率" value={pct(corp.cur.techRate)} delta={<Delta cur={corp.cur.techRate} prev={corp.prev && corp.prev.techRate} unit="pt" />} />
            <BigNum label="集中率（メイン）" value={pct(corp.cur.concentration)} delta={<Delta cur={corp.cur.concentration} prev={corp.prev && corp.prev.concentration} unit="pt" invert />} />
          </div>
        </div>
      ) : (
        <Panel>
          <div style={{ padding: "18px 4px", textAlign: "center", color: C.sub, fontSize: 13 }}>
            経営ダッシュボードに月次データを入れると、ここに全体像が出ます。
          </div>
        </Panel>
      )}

      {/* ── ①-2 直近12か月の流れ（数字1点ではなく傾きを見る） ── */}
      {trend.length > 1 && (
        <Panel title="法人の売上と処方箋枚数（直近12か月ぶん）" sub="棒＝売上／線＝処方箋枚数">
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={trend} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={C.line} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: C.sub }} axisLine={{ stroke: C.line }} tickLine={false} />
                <YAxis
                  yAxisId="l"
                  tick={{ fontSize: 10, fill: C.sub }}
                  axisLine={false}
                  tickLine={false}
                  width={46}
                  tickFormatter={(v) => man(v)}
                />
                <YAxis
                  yAxisId="r"
                  orientation="right"
                  tick={{ fontSize: 10, fill: C.sub }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickFormatter={(v) => Math.round(v).toLocaleString("ja-JP")}
                />
                <Tooltip
                  formatter={(v, n) => [n === "処方箋枚数" ? mai(v) : yen(v), n]}
                  contentStyle={{ borderRadius: 6, border: `1px solid ${C.border}`, fontSize: 12 }}
                />
                <Bar yAxisId="l" dataKey="売上" fill={C.tealBright} radius={[2, 2, 0, 0]} maxBarSize={26} />
                <Line yAxisId="r" type="monotone" dataKey="処方箋枚数" stroke={C.amber} strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      {/* ── ② 気になるところ ── */}
      <Panel title="気になるところ" sub={alerts.length ? `${alerts.length} 件` : ""}>
        {alerts.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 2px", color: C.up, fontSize: 13, fontWeight: 700 }}>
            <span>✓</span>
            <span>いま手を打つべきことはありません。</span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 7 }}>
            {shownAlerts.map((a, i) => (
              <button
                key={i}
                onClick={() => onJump && onJump(a.tab)}
                style={{
                  textAlign: "left",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 9,
                  width: "100%",
                  border: `1px solid ${C.border}`,
                  borderLeft: `3px solid ${a.level === "bad" ? C.down : C.amber}`,
                  borderRadius: 4,
                  background: a.level === "bad" ? C.downBg : C.amberBg,
                  padding: "9px 11px",
                  font: "inherit",
                  cursor: "pointer",
                }}
              >
                <span style={{ flex: "0 0 auto", fontSize: 13, color: a.level === "bad" ? C.down : C.amberInk, fontWeight: 800 }}>
                  {a.level === "bad" ? "！" : "・"}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13, fontWeight: 700, color: C.ink, lineHeight: 1.5 }}>{a.title}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>{a.note}</span>
                </span>
                <span style={{ marginLeft: "auto", flex: "0 0 auto", fontSize: 12, color: C.accentD, fontWeight: 700 }}>開く ›</span>
              </button>
            ))}
            {hiddenAlerts > 0 && (
              <div style={{ fontSize: 12, color: C.sub, padding: "2px 4px" }}>
                ほか {hiddenAlerts} 件（続きは各タブで）
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ── ②-2 入っていないデータ ── */}
      {gaps.length > 0 && (
        <Panel
          title="入っていないデータ"
          sub={gapCount ? `あと ${gapCount} 項目` : "すべてそろっています"}
        >
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
              <thead>
                <tr>
                  {["データ", "状態", "内訳・入れ方", ""].map((h, i) => (
                    <th
                      key={h || i}
                      style={{
                        textAlign: "left",
                        padding: "6px 8px",
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: C.sub,
                        background: C.head,
                        borderBottom: `1px solid ${C.line}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={g.label} style={{ background: g.ok ? "#fff" : C.amberBg }}>
                    <td
                      style={{
                        padding: "7px 8px",
                        borderBottom: `1px solid ${C.line}`,
                        borderLeft: `3px solid ${g.ok ? "transparent" : C.amber}`,
                        whiteSpace: "nowrap",
                        fontWeight: 700,
                        color: g.ok ? C.sub : C.ink,
                      }}
                    >
                      {g.ok ? "✓ " : "・ "}
                      {g.label}
                    </td>
                    <td
                      style={{
                        padding: "7px 8px",
                        borderBottom: `1px solid ${C.line}`,
                        whiteSpace: "nowrap",
                        fontWeight: 700,
                        color: g.ok ? C.up : C.amberInk,
                      }}
                    >
                      {g.state}
                    </td>
                    <td
                      style={{
                        padding: "7px 8px",
                        borderBottom: `1px solid ${C.line}`,
                        color: C.sub,
                        lineHeight: 1.5,
                      }}
                    >
                      {g.detail}
                    </td>
                    <td style={{ padding: "7px 8px", borderBottom: `1px solid ${C.line}`, textAlign: "right" }}>
                      {!g.ok && (
                        <button
                          onClick={() => (g.reload ? location.reload() : onJump && onJump(g.tab))}
                          style={{
                            font: "inherit",
                            fontWeight: 700,
                            fontSize: 12,
                            color: C.accentD,
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {g.reload ? "再読み込み" : "入れる ›"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 8, lineHeight: 1.7 }}>
            未入力の判定は「最初に入力した月〜先月」で見ています（今月はまだ数字が出そろわないので数えません）。
          </div>
        </Panel>
      )}

      {/* ── ③ 4つの道具の現在地 ── */}
      <Panel title="4つの道具の現在地" sub="押すとその画面へ">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
          <ToolCard
            title="経営ダッシュボード"
            onClick={() => onJump && onJump("dashboard")}
            badge={corp && corp.cur ? ymLabel(corp.cur.ym) : "未入力"}
            badgeColor={corp && corp.cur ? C.accent : C.sub}
            rows={
              corp && corp.cur
                ? [
                    ["直近月の売上（法人）", yen(corp.cur.sales)],
                    ["処方箋枚数", mai(corp.cur.total)],
                    ["入力済み", `${corp.months} か月`],
                  ]
                : [["状態", "月次データなし"]]
            }
          />
          <ToolCard
            title="調剤基本料 判定"
            onClick={() => onJump && onJump("kihonryo")}
            badge={
              basic.list.some((b) => b.isBasic2)
                ? "基本料2に該当"
                : basic.list.some((b) => b.n)
                  ? "基本料1を維持"
                  : "未入力"
            }
            badgeColor={basic.list.some((b) => b.isBasic2) ? C.down : basic.list.some((b) => b.n) ? C.up : C.sub}
            rows={
              basic.list.length
                ? basic.list.map((b) => [
                    b.name,
                    b.n ? `${mai(b.avgAdj)}・${pct(b.conc)}` : "データなし",
                  ])
                : [["状態", "月次データなし"]]
            }
          />
          <ToolCard
            title="ベースアップ評価料"
            onClick={() => onJump && onJump("baseup")}
            badge={baseup && baseup.count ? (baseup.ok ? "適合（充当OK）" : "要改善") : "未集計"}
            badgeColor={baseup && baseup.count ? (baseup.ok ? C.up : C.down) : C.sub}
            rows={
              baseup && baseup.count
                ? [
                    ["充当率", pct(baseup.rate)],
                    [baseup.ok ? "余裕" : "不足", yen(Math.abs(baseup.diff))],
                    ["集計した月", `${baseup.count} か月`],
                  ]
                : [["状態", "集計できる月がありません"]]
            }
          />
          <ToolCard
            title="補助金管理"
            onClick={() => onJump && onJump("hojokin")}
            badge={
              status.subsidies === "ok" || status.subsidies === "empty"
                ? `進行中 ${subsidy.active} 件`
                : LOAD_LABEL[status.subsidies]
            }
            badgeColor={
              status.subsidies === "ok" || status.subsidies === "empty"
                ? subsidy.active
                  ? C.accent
                  : C.up
                : C.down
            }
            rows={
              status.subsidies !== "ok" && status.subsidies !== "empty"
                ? [["状態", "再読み込みしてください"]]
                : [
              ["未入金（申請済−振込済）", yen(subsidy.unpaid)],
              ["完了", `${subsidy.done} / ${subsidy.count} 件`],
              [
                "未申請の期限",
                subsidy.nearest
                  ? `${daysLabel(subsidy.nearest.deadline)}（${subsidy.nearest.name}）`
                  : subsidy.unapplied
                    ? `未申請 ${subsidy.unapplied} 件（期限なし）`
                    : "未申請はありません",
              ],
                  ]
            }
          />
        </div>
      </Panel>

      {/* ── ④ 薬局別の一覧 ── */}
      {lines.length > 0 && (
        <Panel title="薬局別（直近の確定月）" sub="矢印は前月比">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["薬局", "対象月", "処方箋枚数", "売上", "技術料", "技術料率", "集中率", "他科率"].map((h, i) => (
                    <th
                      key={h}
                      style={{
                        textAlign: i === 0 || i === 1 ? "left" : "right",
                        padding: "7px 8px",
                        fontSize: 11.5,
                        fontWeight: 700,
                        color: C.sub,
                        background: C.head,
                        borderBottom: `1px solid ${C.line}`,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.name} style={{ background: l.isCorp ? C.head : "#fff", fontWeight: l.isCorp ? 700 : 400 }}>
                    <Td left bold>
                      {l.name}
                    </Td>
                    <Td left>{l.cur ? ymLabel(l.cur.ym) : "—"}</Td>
                    <Td>
                      {l.cur ? mai(l.cur.total) : "—"}{" "}
                      {l.cur && <Delta cur={l.cur.total} prev={l.prev && l.prev.total} />}
                    </Td>
                    <Td>{l.cur ? yen(l.cur.sales) : "—"}</Td>
                    <Td>{l.cur ? man(l.cur.tech) : "—"}</Td>
                    <Td>{l.cur ? pct(l.cur.techRate) : "—"}</Td>
                    <Td>{l.cur ? pct(l.cur.concentration) : "—"}</Td>
                    <Td>{l.cur ? pct(l.cur.otherRate) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 8, lineHeight: 1.7 }}>
            法人合計は、両薬局がそろって報告している月だけを足しています（片方だけの月は入りません）。
            集中率＝メインの医療機関の割合、他科率＝それ以外の割合。
          </div>
        </Panel>
      )}
    </div>
  );
}

// ── 部品 ─────────────────────────────────────────────
function BigNum({ label, value, delta, wide }) {
  return (
    <div style={{ background: "rgba(255,255,255,.10)", borderRadius: 4, padding: "9px 11px", minWidth: 0 }}>
      <div style={{ fontSize: 11, opacity: 0.82, marginBottom: 2 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
        <span style={{ fontSize: wide ? 26 : 20, fontWeight: 800, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>
          {value}
        </span>
        <span style={{ filter: "brightness(1.9)" }}>{delta}</span>
      </div>
    </div>
  );
}

function Panel({ title, sub, children }) {
  return (
    <div
      style={{
        background: "#fff",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        boxShadow: "0 1px 2px rgba(27,40,54,.06)",
        marginBottom: 13,
        overflow: "hidden",
      }}
    >
      {title && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "9px 13px",
            background: C.head,
            borderBottom: `1px solid ${C.border}`,
            fontFamily: FONT_HEAD,
            fontSize: 13.5,
            fontWeight: 700,
            color: C.ink,
          }}
        >
          <span style={{ width: 3, height: 14, borderRadius: 2, background: C.accent, flex: "0 0 auto" }} />
          {title}
          {sub && <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 500, color: C.sub }}>{sub}</span>}
        </div>
      )}
      <div style={{ padding: "12px 13px" }}>{children}</div>
    </div>
  );
}

function ToolCard({ title, badge, badgeColor, rows, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        font: "inherit",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        background: "#fff",
        padding: "12px 13px",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: FONT_HEAD, fontSize: 13.5, fontWeight: 700, color: C.ink }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: C.accentD, fontWeight: 700 }}>›</span>
      </div>
      <span
        style={{
          alignSelf: "flex-start",
          fontSize: 11.5,
          fontWeight: 700,
          color: "#fff",
          background: badgeColor,
          borderRadius: 999,
          padding: "2px 10px",
          whiteSpace: "nowrap",
        }}
      >
        {badge}
      </span>
      <div style={{ display: "grid", gap: 3, width: "100%" }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12.5 }}>
            <span style={{ color: C.sub, whiteSpace: "nowrap" }}>{k}</span>
            <span
              style={{
                marginLeft: "auto",
                textAlign: "right",
                fontWeight: 700,
                color: C.ink,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {v}
            </span>
          </div>
        ))}
      </div>
    </button>
  );
}

function Td({ children, left, bold }) {
  return (
    <td
      style={{
        textAlign: left ? "left" : "right",
        padding: "7px 8px",
        borderBottom: `1px solid ${C.line}`,
        whiteSpace: "nowrap",
        fontWeight: bold ? 700 : undefined,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </td>
  );
}
