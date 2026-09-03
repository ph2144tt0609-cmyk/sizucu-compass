import React, { useState, useMemo, useEffect, useRef } from "react";
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
import { seed } from "./seed.js"; // 医師名（doctors）は seed から直接読む
import BasicFee from "./BasicFee.jsx";
import { cloudLoad, cloudSave, CLOUD_KEYS } from "../cloud";
import { C, FONT_SANS, FONT_HEAD } from "./theme.js";
import {
  CORP_NAME,
  FISCAL_MONTHS,
  loadOverrides,
  saveOverrides,
  ovHasData,
  enrich,
  mergePharmData,
  mergeCorpLabor,
  collectYears,
  rowsFor as rowsForModel,
} from "./pharmModel.js";

// 経営数字(pharmacies)・医師名(doctors)・法人人件費(corpLabor)は src/seed.local.js に分離し、
// 暗号化して seed 経由で供給する（＝私が用意する基準値）。それに画面からの手入力(override)を重ねる。
//
// ★数字の作り方（override の読み書き・seed との重ね合わせ・派生指標・法人の合算）は
//   ./pharmModel.js に置いてある。早見表・調剤基本料の判定と同じ数字を使うため、ここでは計算しない。

const toNum = (s) => Number(String(s).replace(/[^0-9.-]/g, "")) || 0;

// ── クラウド同期 ───────────────────────────────────────
// 手入力データを合言葉でAES-256-GCM暗号化して Supabase に保存し、全端末で共有する。
// サーバには暗号文しか渡らない（平文の経営数字はクラウドに残らない）。
// 暗号化・保存の実体は ../cloud.ts（補助金・ベースアップと同じ置き場を使う）。

const yen = (n) => "¥" + Math.round(n).toLocaleString("ja-JP");
const man = (n) => (n / 10000).toLocaleString("ja-JP", { maximumFractionDigits: 0 }) + "万";
const pct = (n) => n.toFixed(1) + "%";
const mai = (n) => Math.round(n).toLocaleString("ja-JP") + "枚";

// ── 医師面会記録・定例イベント ───────────────────────────
const DOCTOR_KEY = "pharmacy-dashboard-doctors-v1"; // 面会記録・誕生日
const EVENTS_KEY = "pharmacy-dashboard-events-v1"; // 定例イベント
const DEFAULT_EVENTS = [
  { id: "otyugen", title: "お中元", md: "07-01", note: "取引先・医師へのお中元手配" },
  { id: "oseibo", title: "お歳暮", md: "12-01", note: "取引先・医師へのお歳暮手配" },
];

function loadJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    if (!s) return fallback;
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 無視
  }
}

const todayISO = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// "MM-DD" の次回到来日と残り日数（毎年くり返し）
function nextAnnual(md) {
  const [m, d] = md.split("-").map(Number);
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let occ = new Date(t0.getFullYear(), m - 1, d);
  if (occ < t0) occ = new Date(t0.getFullYear() + 1, m - 1, d);
  const days = Math.round((occ - t0) / 86400000);
  return { occ, days };
}
const mdLabel = (md) => {
  const [m, d] = md.split("-").map(Number);
  return `${m}/${d}`;
};

const DROP_PATH =
  "M256 150 C 206 240, 160 300, 160 350 A 96 96 0 1 0 352 350 C 352 300, 306 240, 256 150 Z";

function Logo({ size = 44 }) {
  return (
    <img
      src={import.meta.env.BASE_URL + "sizucu-logo-color.png"}
      alt="株式会社しずく"
      style={{ height: size, width: "auto", flex: "0 0 auto", display: "block" }}
    />
  );
}

function DropMark({ style }) {
  return (
    <svg viewBox="0 0 512 512" style={style} aria-hidden="true">
      <path d={DROP_PATH} fill="#fff" />
    </svg>
  );
}

// 数字のカードは白のまま（面を塗ると輪郭がぼやける）。系統は左の細い縦線で示す。

function Delta({ cur, prev, invert, unit, light }) {
  if (prev == null) return null;
  const isPt = unit === "pt";
  const d = isPt ? cur - prev : prev ? ((cur - prev) / prev) * 100 : 0;
  const good = invert ? d <= 0 : d >= 0;
  const color = light ? (good ? "#b6e8cd" : "#ffc4bf") : good ? C.up : C.down;
  return (
    <span style={{ color, fontWeight: 700 }}>
      {d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}{unit || "%"}
    </span>
  );
}

// 画面幅を監視して、PC（横広）レイアウトかどうかを返す。
// スマホ／縦持ちタブレット（< 960px）は1カラム、PC（>= 960px）は複数カラムに切替える。
function useIsDesktop(bp = 960) {
  const [d, setD] = useState(() => typeof window !== "undefined" && window.innerWidth >= bp);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width:${bp}px)`);
    const on = () => setD(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [bp]);
  return d;
}

// view は上位（App のタブ）から渡す。"keiei"=経営ダッシュボード / "kihonryo"=調剤基本料 判定
export default function DashboardTab({ view = "keiei" }) {
  const isDesktop = useIsDesktop();

  // データ＝暗号化seed（基準値）＋ この端末に保存した手入力(override)をマージ
  const [overrides, setOverrides] = useState(loadOverrides);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle|loading|saving|synced|offline|error

  // クラウドへ暗号化して保存
  const pushCloud = async (o) => {
    try {
      setSyncStatus("saving");
      const ok = await cloudSave(CLOUD_KEYS.dashboard, o);
      setSyncStatus(ok ? "synced" : "error");
    } catch {
      setSyncStatus("error");
    }
  };
  const applyOverrides = (o) => {
    const stamped = { ...o, _ts: Date.now() }; // 更新時刻を刻む（端末間の新旧判定に使う）
    setOverrides(stamped);
    saveOverrides(stamped); // オフライン用のローカルキャッシュ
    pushCloud(stamped); // クラウドへ同期
  };

  // 起動時にクラウドと突き合わせ（全端末で同じ数字を表示）
  // ・クラウドが有効でローカルより新しい → クラウドを採用
  // ・ローカルの方が新しい/クラウドが空 → ローカルを守り、クラウドへアップロード（＝空データで実データを消さない）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setSyncStatus("loading");
        const cloud = await cloudLoad(CLOUD_KEYS.dashboard);
        const localNow = loadOverrides();
        if (!alive) return;
        const cloudOk = ovHasData(cloud);
        const localOk = ovHasData(localNow);
        if (cloud && cloudOk && (!localOk || (cloud._ts || 0) >= (localNow._ts || 0))) {
          const norm = { pharm: cloud.pharm || {}, corpLabor: cloud.corpLabor || {}, years: cloud.years || [], excluded: cloud.excluded || {}, _ts: cloud._ts || 0 };
          setOverrides(norm);
          saveOverrides(norm);
          setSyncStatus("synced");
        } else if (localOk) {
          // 手元のローカルが正 → クラウドへ反映（他端末に届くようにする）
          setSyncStatus("saving");
          try {
            const ok = await cloudSave(CLOUD_KEYS.dashboard, localNow);
            if (alive) setSyncStatus(ok ? "synced" : "error");
          } catch {
            if (alive) setSyncStatus("error");
          }
        } else {
          setSyncStatus("synced");
        }
      } catch {
        if (alive) setSyncStatus("offline"); // 通信不可時はローカルの内容で継続
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const pharmData = useMemo(() => mergePharmData(overrides), [overrides]);
  const corpLabor = useMemo(() => mergeCorpLabor(overrides), [overrides]);

  // 選択：薬局（0..n-1＝各薬局 / n＝法人）と年度・月
  const [phIdx, setPhIdx] = useState(0);
  const isCorp = phIdx === pharmData.length;
  const activeName = isCorp ? CORP_NAME : (pharmData[phIdx] ? pharmData[phIdx].name : "");

  // 存在する年度の一覧（新しい順）
  const years = useMemo(() => collectYears(overrides), [overrides]);

  const [year, setYear] = useState(() => years[0]);
  useEffect(() => {
    if (years.length && !years.includes(year)) setYear(years[0]);
  }, [years, year]);

  const [selPeriod, setSelPeriod] = useState(null); // 選択中の月（"4月" など）
  const [cmpMode, setCmpMode] = useState("mom"); // "mom"=前月比 / "yoy"=前年同期比

  // 月データの入力フォーム
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ total: "", other: "", tech: "", drug: "", labor: "" });

  // 医師面会記録・定例イベント
  const [doctorInfo, setDoctorInfo] = useState(() => loadJSON(DOCTOR_KEY, {}));
  const [events, setEvents] = useState(() => loadJSON(EVENTS_KEY, DEFAULT_EVENTS));
  const [openDoctor, setOpenDoctor] = useState(null);
  const [mtgDate, setMtgDate] = useState(todayISO());
  const [mtgNote, setMtgNote] = useState("");
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [evTitle, setEvTitle] = useState("");
  const [evDate, setEvDate] = useState("");

  // 指定した薬局インデックス・年度の月次（法人は自動合算）
  const rowsFor = (index, yr) => rowsForModel(pharmData, corpLabor, index, yr);

  const prevYearLabel = String(Number(year) - 1);
  const data = useMemo(() => enrich(rowsFor(phIdx, year)), [phIdx, year, pharmData, corpLabor]);
  const prevYearData = useMemo(() => enrich(rowsFor(phIdx, prevYearLabel)), [phIdx, prevYearLabel, pharmData, corpLabor]);

  // 薬局・年度を切り替えたら、データのある最新月を選択（無ければ10月）
  useEffect(() => {
    const last = data.length ? data[data.length - 1].period : FISCAL_MONTHS[0];
    setSelPeriod(last);
    setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phIdx, year]);

  // ── 月送り（◀▶ボタン／キーボード左右キー）────────────────
  const monthRowRef = useRef(null);
  const monthIdx = FISCAL_MONTHS.indexOf(selPeriod);
  const goMonth = (delta) => {
    const i = monthIdx < 0 ? 0 : monthIdx;
    const ni = Math.min(FISCAL_MONTHS.length - 1, Math.max(0, i + delta));
    setSelPeriod(FISCAL_MONTHS[ni]);
  };
  // 左右キーで月を移動（入力中・フォーム内は無効）
  useEffect(() => {
    const onKey = (e) => {
      if (editing) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goMonth(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goMonth(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selPeriod, editing]);
  // 選択中の月を月バーの中央へスクロール（横スクロール時に見失わない）
  useEffect(() => {
    const row = monthRowRef.current;
    if (!row || !selPeriod) return;
    const btn = row.querySelector(`[data-month="${selPeriod}"]`);
    if (!btn) return;
    const left = btn.offsetLeft - row.clientWidth / 2 + btn.clientWidth / 2;
    row.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
  }, [selPeriod]);

  const hasYearData = data.length > 0;
  const cur = data.find((d) => d.period === selPeriod) || null; // 選択月の実データ（無ければnull）
  const curIdxInData = cur ? data.findIndex((d) => d.period === selPeriod) : -1;
  const prevMonth = curIdxInData > 0 ? data[curIdxInData - 1] : null;
  const prevYear = useMemo(
    () => (cur ? prevYearData.find((d) => d.period === cur.period) || null : null),
    [prevYearData, cur]
  );
  const focus = cur || (data.length ? data[data.length - 1] : null);

  const isYoY = cmpMode === "yoy";
  const cmp = isYoY ? prevYear : prevMonth;
  const cmpLabel = isYoY ? "前年同期比" : "前月比";
  const yoyMissing = isYoY && cur && !prevYear;

  const OTHER_TARGET_RATE = 15;
  const targetOther = focus ? Math.round(focus.total * (OTHER_TARGET_RATE / 100)) : 0;
  const otherGap = focus ? targetOther - focus.other : 0;
  const otherAchieved = focus ? focus.otherRate >= OTHER_TARGET_RATE : false;
  const otherProgress = focus ? Math.max(0, Math.min(1, focus.otherRate / OTHER_TARGET_RATE)) : 0;
  const achievedCount = data.filter((d) => d.otherRate >= OTHER_TARGET_RATE).length;

  const xInterval = data.length > 8 ? 1 : 0;
  const hasLabor = data.some((r) => r.labor > 0);
  const hasOther = data.some((r) => r.other > 0);

  const monthsCount = data.length;
  const avgTotal = monthsCount ? data.reduce((s, d) => s + d.total, 0) / monthsCount : 0;
  const avgSales = monthsCount ? data.reduce((s, d) => s + d.sales, 0) / monthsCount : 0;
  const avgOther = monthsCount ? data.reduce((s, d) => s + d.other, 0) / monthsCount : 0;
  const sumTotal = data.reduce((s, d) => s + d.total, 0);

  const hasOverrides =
    Object.keys(overrides.pharm || {}).length > 0 ||
    Object.keys(overrides.corpLabor || {}).length > 0 ||
    (overrides.years || []).length > 0;

  const selectPharmacy = (i) => {
    setPhIdx(i);
    setEditing(false);
  };

  // ── 月データの入力・編集 ──────────────────────────────
  const openEditor = () => {
    if (isCorp) {
      const storedLabor = corpLabor[year] && corpLabor[year][selPeriod] != null ? corpLabor[year][selPeriod] : (cur ? cur.labor : "");
      setForm({ total: "", other: "", tech: "", drug: "", labor: storedLabor === "" ? "" : String(storedLabor) });
    } else {
      setForm({
        total: cur ? String(cur.total) : "",
        other: cur ? String(cur.other) : "",
        tech: cur ? String(cur.tech) : "",
        drug: cur ? String(cur.drug) : "",
        labor: "",
      });
    }
    setEditing(true);
  };
  const saveMonth = () => {
    const o = {
      pharm: { ...(overrides.pharm || {}) },
      corpLabor: { ...(overrides.corpLabor || {}) },
      years: [...(overrides.years || [])],
      excluded: { ...(overrides.excluded || {}) },
    };
    if (isCorp) {
      const byYear = { ...(o.corpLabor[year] || {}) };
      byYear[selPeriod] = toNum(form.labor);
      o.corpLabor[year] = byYear;
    } else {
      const byName = { ...(o.pharm[activeName] || {}) };
      const byYear = { ...(byName[year] || {}) };
      byYear[selPeriod] = { total: toNum(form.total), other: toNum(form.other), tech: toNum(form.tech), drug: toNum(form.drug) };
      byName[year] = byYear;
      o.pharm[activeName] = byName;
    }
    applyOverrides(o);
    setEditing(false);
  };
  const deleteMonth = () => {
    const o = {
      pharm: { ...(overrides.pharm || {}) },
      corpLabor: { ...(overrides.corpLabor || {}) },
      years: [...(overrides.years || [])],
      excluded: { ...(overrides.excluded || {}) },
    };
    if (isCorp) {
      if (o.corpLabor[year]) {
        const c = { ...o.corpLabor[year] };
        delete c[selPeriod];
        o.corpLabor[year] = c;
      }
    } else if (o.pharm[activeName] && o.pharm[activeName][year]) {
      const c = { ...o.pharm[activeName][year] };
      delete c[selPeriod];
      o.pharm[activeName] = { ...o.pharm[activeName], [year]: c };
    }
    applyOverrides(o);
    setEditing(false);
  };
  const addYear = () => {
    const input = window.prompt("追加する年度（西暦4桁）を入力してください。例：2026");
    if (!input) return;
    const y = input.replace(/[^0-9]/g, "").slice(0, 4);
    if (!/^\d{4}$/.test(y)) return;
    applyOverrides({ ...overrides, years: [...new Set([...(overrides.years || []), y])] });
    setYear(y);
  };
  // 調剤基本料の「除外枚数」（時間外・休日・深夜等を算定した処方箋）を月別に保存
  const setExcluded = (name, fiscalYear, month, value) => {
    const o = {
      pharm: { ...(overrides.pharm || {}) },
      corpLabor: { ...(overrides.corpLabor || {}) },
      years: [...(overrides.years || [])],
      excluded: { ...(overrides.excluded || {}) },
    };
    const byName = { ...(o.excluded[name] || {}) };
    const byYear = { ...(byName[fiscalYear] || {}) };
    const n = Number(String(value).replace(/[^0-9.-]/g, ""));
    if (!value || !n) delete byYear[month];
    else byYear[month] = n;
    byName[fiscalYear] = byYear;
    o.excluded[name] = byName;
    applyOverrides(o);
  };

  const resetOverrides = () => {
    if (window.confirm("この端末で手入力した数字をすべて消して、基準データに戻します。よろしいですか？")) {
      applyOverrides({ pharm: {}, corpLabor: {}, years: [] });
      setEditing(false);
    }
  };

  // 医師面会記録の操作
  const docKey = (pharmacy, doctor) => `${pharmacy}::${doctor}`;
  const getDoc = (pharmacy, doctor) => doctorInfo[docKey(pharmacy, doctor)] || { birthday: null, meetings: [] };
  const updateDoc = (pharmacy, doctor, patch) => {
    const k = docKey(pharmacy, doctor);
    const cur0 = doctorInfo[k] || { birthday: null, meetings: [] };
    const next = { ...doctorInfo, [k]: { ...cur0, ...patch } };
    setDoctorInfo(next);
    saveJSON(DOCTOR_KEY, next);
  };
  const addMeeting = (pharmacy, doctor) => {
    if (!mtgNote.trim()) return;
    const cur0 = getDoc(pharmacy, doctor);
    updateDoc(pharmacy, doctor, { meetings: [{ date: mtgDate, note: mtgNote.trim() }, ...cur0.meetings] });
    setMtgNote("");
    setMtgDate(todayISO());
    setOpenDoctor(null);
  };
  const setBirthday = (pharmacy, doctor, md) => updateDoc(pharmacy, doctor, { birthday: md || null });
  const addEvent = () => {
    if (!evTitle.trim() || !evDate) return;
    const next = [...events, { id: "ev" + Date.now(), title: evTitle.trim(), md: evDate.slice(5), note: "" }];
    setEvents(next);
    saveJSON(EVENTS_KEY, next);
    setEvTitle("");
    setEvDate("");
    setShowAddEvent(false);
  };
  const deleteEvent = (id) => {
    const next = events.filter((e) => e.id !== id);
    setEvents(next);
    saveJSON(EVENTS_KEY, next);
  };

  // 面会記録で表示する {pharmacy, doctor} 一覧（法人タブは全薬局を集約）
  const doctorPairs = !isCorp && seed.doctors[activeName]
    ? seed.doctors[activeName].map((d) => ({ pharmacy: activeName, doctor: d }))
    : Object.entries(seed.doctors).flatMap(([ph, ds]) => ds.map((d) => ({ pharmacy: ph, doctor: d })));

  const calendar = [
    ...events.map((e) => ({ title: e.title, md: e.md, note: e.note, kind: "event", id: e.id })),
    ...Object.entries(seed.doctors).flatMap(([ph, ds]) =>
      ds
        .map((doc) => ({ doc, ph, bd: (doctorInfo[`${ph}::${doc}`] || {}).birthday }))
        .filter((x) => x.bd)
        .map((x) => ({ title: `${x.doc} 誕生日`, md: x.bd, note: x.ph, kind: "birthday", id: `${x.ph}::${x.doc}` }))
    ),
  ]
    .map((it) => ({ ...it, ...nextAnnual(it.md) }))
    .sort((a, b) => a.days - b.days);

  return (
    // 背景（ペーパー＋ミスト）はアプリ外枠（index.css の body）が敷くので、ここでは重ねない
    <div style={{ padding: "6px 0 44px", fontFamily: FONT_SANS, color: C.ink }}>
      <div style={{ maxWidth: isDesktop ? 1180 : 440, margin: "0 auto" }}>

        {/* マストヘッド */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <Logo size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10.5, letterSpacing: 2.5, color: C.teal, fontWeight: 700 }}>株式会社しずく</div>
            <div style={{ fontFamily: FONT_HEAD, fontSize: 21, fontWeight: 600, letterSpacing: 0.5, lineHeight: 1.2, color: C.ink, whiteSpace: "nowrap" }}>
              {view === "kihonryo" ? "調剤基本料 判定" : "経営ダッシュボード"}
            </div>
          </div>
          <SyncBadge status={syncStatus} />
        </div>

        {view === "kihonryo" && (
          <BasicFee
            pharmData={pharmData}
            isDesktop={isDesktop}
            excluded={overrides.excluded || {}}
            onSetExcluded={setExcluded}
          />
        )}

        {view === "keiei" && (
        <>
        {/* 薬局・法人セレクタ（セグメント） */}
        <div style={{ display: "flex", background: "#fff", borderRadius: 6, border: `1px solid ${C.border}`, overflow: "hidden" }}>
          {[...pharmData.map((p) => p.name), CORP_NAME].map((name, i, arr) => (
            <button
              key={i}
              onClick={() => selectPharmacy(i)}
              style={{
                flex: 1, padding: "11px 4px", borderRadius: 0, border: "none",
                borderRight: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                background: i === phIdx ? C.accent : "#fff",
                color: i === phIdx ? "#fff" : C.sub,
                fontWeight: 700, fontSize: 12.5, lineHeight: 1.25, cursor: "pointer",
                transition: "background .15s, color .15s",
              }}
            >
              {name}
            </button>
          ))}
        </div>

        {/* 年度セレクタ */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.sub, letterSpacing: 1, flex: "0 0 auto" }}>年度</span>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: 1 }}>
            {years.map((y) => (
              <button
                key={y}
                onClick={() => setYear(y)}
                style={{
                  padding: "7px 16px", borderRadius: 4,
                  border: `1px solid ${y === year ? C.accent : C.border}`,
                  background: y === year ? C.accent : "#fff",
                  color: y === year ? "#fff" : C.sub,
                  fontWeight: 700, fontSize: 13, cursor: "pointer",
                }}
              >
                {y}年度
              </button>
            ))}
            <button
              onClick={addYear}
              title="新しい年度を追加"
              style={{ padding: "7px 14px", borderRadius: 4, border: `1px dashed ${C.accent}80`, background: "#e8f1f9", color: C.accentD, fontWeight: 700, fontSize: 13, cursor: "pointer" }}
            >
              ＋年度
            </button>
          </div>
        </div>

        {/* 月セレクタ（会計年度の12か月を常に表示。データが無い月は淡色）＋左右の月送り */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 0 8px" }}>
          <NavArrow dir="left" onClick={() => goMonth(-1)} disabled={monthIdx <= 0} label="前の月" />
          <div ref={monthRowRef} style={{ display: "flex", gap: 7, overflowX: "auto", flex: 1, scrollbarWidth: "none", WebkitOverflowScrolling: "touch" }}>
            {FISCAL_MONTHS.map((mp) => {
              const has = data.some((d) => d.period === mp);
              const sel = mp === selPeriod;
              return (
                <button
                  key={mp}
                  data-month={mp}
                  onClick={() => setSelPeriod(mp)}
                  title={has ? "" : "データ未登録"}
                  style={{
                    flex: "0 0 auto", padding: "6px 15px", borderRadius: 4,
                    border: `1px ${has || sel ? "solid" : "dashed"} ${sel ? C.accent : has ? C.border : C.line}`,
                    background: sel ? C.accent : has ? "#fff" : "#f4f7f9",
                    color: sel ? "#fff" : has ? C.sub : "#9aa7b3",
                    fontWeight: 700, fontSize: 13, cursor: "pointer",
                  }}
                >
                  {mp}
                </button>
              );
            })}
          </div>
          <NavArrow dir="right" onClick={() => goMonth(1)} disabled={monthIdx >= FISCAL_MONTHS.length - 1} label="次の月" />
        </div>
        {isDesktop && (
          <div style={{ textAlign: "center", fontSize: 10.5, color: C.sub, marginBottom: 8 }}>
            キーボードの ← → でも月を切り替えられます
          </div>
        )}

        {/* この月の数字を入力・編集 */}
        <div style={{ marginBottom: 12 }}>
          {!editing ? (
            <button
              onClick={openEditor}
              style={{ width: "100%", padding: "11px 12px", borderRadius: 6, border: "1px solid #c5daed", background: "#e8f1f9", color: C.accentD, fontWeight: 700, fontSize: 13.5, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
            >
              ✎ {year}年度 {selPeriod} の数字を{cur ? "編集" : "入力"}
            </button>
          ) : (
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 14, background: "#fff", boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontFamily: FONT_HEAD, fontSize: 15, fontWeight: 600, color: C.ink }}>{activeName}・{year}年度 {selPeriod} の入力</div>
                <button onClick={() => setEditing(false)} aria-label="閉じる" style={{ border: "none", background: "transparent", color: C.sub, fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              {isCorp ? (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 11.5, color: C.sub, lineHeight: 1.6 }}>
                    法人の枚数・売上は<b>各薬局の合算で自動計算</b>されます。ここでは<b>人件費</b>だけを入力します。
                  </div>
                  <Field label="人件費（円）" value={form.labor} onChange={(v) => setForm({ ...form, labor: v })} />
                  {!cur && (
                    <div style={{ fontSize: 11, color: "#8f6b17", background: "#fbf3df", borderRadius: 6, padding: "8px 10px", lineHeight: 1.6 }}>
                      ※ この月（{selPeriod}）はまだ各薬局のデータがそろっていません。保存した人件費は、各薬局の数字がそろうと自動で表示されます。
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Field label="処方箋枚数（受付回数）" value={form.total} onChange={(v) => setForm({ ...form, total: v })} />
                  <Field label="他科枚数" value={form.other} onChange={(v) => setForm({ ...form, other: v })} />
                  <Field label="技術料（円）" value={form.tech} onChange={(v) => setForm({ ...form, tech: v })} />
                  <Field label="薬剤料（円）" value={form.drug} onChange={(v) => setForm({ ...form, drug: v })} />
                  <div style={{ gridColumn: "1 / -1", fontSize: 12, color: C.sub, background: "#f4f7f9", borderRadius: 6, padding: "8px 10px" }}>
                    売上（保険合計）＝技術料＋薬剤料＝<b style={{ color: C.ink }}>{yen(toNum(form.tech) + toNum(form.drug))}</b>（自動計算）
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={saveMonth} style={{ flex: 1, minWidth: 120, padding: 12, borderRadius: 6, border: "none", background: C.accent, color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer" }}>
                  {selPeriod} を保存する
                </button>
                {(cur || (isCorp && corpLabor[year] && corpLabor[year][selPeriod] != null)) && (
                  <button onClick={deleteMonth} style={{ padding: "12px 14px", borderRadius: 6, border: `1px solid ${C.down}55`, background: "#fff", color: C.down, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>この月を削除</button>
                )}
                <button onClick={() => setEditing(false)} style={{ padding: "12px 14px", borderRadius: 6, border: `1px solid ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>キャンセル</button>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 9 }}>
                <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.5 }}>※ 入力はこのブラウザ（端末）に保存されます。別の端末には反映されません。</div>
                {hasOverrides && (
                  <button onClick={resetOverrides} style={{ flex: "0 0 auto", border: "none", background: "transparent", color: C.sub, textDecoration: "underline", fontSize: 10.5, cursor: "pointer" }}>手入力を全消去</button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 年度にデータが1件も無い場合の案内 */}
        {!hasYearData && !editing && (
          <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "20px 18px", margin: "0 0 14px", textAlign: "center", boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.ink, marginBottom: 6 }}>
              「{activeName}・{year}年度」のデータはまだありません
            </div>
            <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.7 }}>
              {isCorp
                ? "法人は各薬局の合算です。各薬局に当年度のデータを入れると自動で表示されます。"
                : "上の「✎ …の数字を入力」から、月ごとに数字を入れてください。"}
            </div>
          </div>
        )}

        {hasYearData && (
          <>
            {/* 比較ベース切替（前月比 / 前年同期比） */}
            <div style={{ display: "flex", background: "#fff", borderRadius: 6, border: `1px solid ${C.border}`, overflow: "hidden", margin: "0 0 12px" }}>
              {[["mom", "前月比"], ["yoy", "前年同期比"]].map(([m, label]) => (
                <button
                  key={m}
                  onClick={() => setCmpMode(m)}
                  style={{
                    flex: 1, padding: "7px 4px", borderRadius: 6, border: "none",
                    background: cmpMode === m ? C.accent : "#fff",
                    color: cmpMode === m ? "#fff" : C.sub,
                    fontWeight: 700, fontSize: 12, cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {yoyMissing && (
              <div style={{ background: "#fbf3df", border: `1px solid ${C.amber}33`, borderRadius: 6, padding: "10px 12px", marginBottom: 12, fontSize: 12, color: "#8f6b17", lineHeight: 1.6 }}>
                「{activeName}・{cur.period}」の<b>前年度（{prevYearLabel}年度）データがありません</b>。前年度のデータが入ると前年同期比が表示されます。
              </div>
            )}

            {/* 選択月のKPI（データがある月のみ。無い月は未登録カード） */}
            {cur ? (
              <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "1fr 1fr" : "1fr", gap: isDesktop ? 14 : 0, alignItems: "start", marginBottom: isDesktop ? 14 : 0 }}>
                {/* メインKPI：売上（ヒーロー） */}
                <div style={{ position: "relative", overflow: "hidden", background: C.teal, borderRadius: 6, padding: "20px 20px 18px", color: "#fff", marginBottom: isDesktop ? 0 : 14, boxShadow: "0 2px 10px rgba(27,40,54,.16)" }}>
                  <DropMark style={{ position: "absolute", right: -34, bottom: -46, width: 210, height: 210, opacity: 0.08, transform: "rotate(8deg)" }} />
                  <div style={{ position: "absolute", inset: 0, background: "radial-gradient(75% 50% at 82% 0%, rgba(255,255,255,.18), transparent 60%)", pointerEvents: "none" }} />
                  <div style={{ position: "relative" }}>
                    <div style={{ fontSize: 12.5, opacity: 0.88, fontWeight: 600 }}>{activeName}・{year}年度 {cur.period}の売上</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 2, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 0.5, fontVariantNumeric: "tabular-nums" }}>{yen(cur.sales)}</div>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,.18)", padding: "3px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, backdropFilter: "blur(2px)" }}>
                        {cmpLabel}{" "}
                        {cmp ? <Delta cur={cur.sales} prev={cmp.sales} light /> : <span style={{ opacity: 0.85 }}>—</span>}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      {[
                        { l: "技術料", v: man(cur.tech) },
                        { l: "薬剤料", v: man(cur.drug) },
                        { l: "技術料率", v: pct(cur.techRate) },
                      ].map((m) => (
                        <div key={m.l} style={{ flex: 1, background: "rgba(255,255,255,.12)", borderRadius: 6, padding: "9px 10px" }}>
                          <div style={{ opacity: 0.82, fontSize: 11 }}>{m.l}</div>
                          <div style={{ fontSize: 15.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", marginTop: 1 }}>{m.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* KPI 2×2 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: isDesktop ? 0 : 12, alignContent: "start" }}>
                  <Kpi label="処方箋枚数" value={mai(cur.total)} sub="" delta={cmp ? <Delta cur={cur.total} prev={cmp.total} /> : null} />
                  <Kpi label="集中率（メイン）" value={pct(cur.concentration)} sub={`メイン ${mai(cur.main)}`} delta={cmp ? <Delta cur={cur.concentration} prev={cmp.concentration} unit="pt" /> : null} accent={C.amber} />
                  <Kpi label="他科処方箋率" value={pct(cur.otherRate)} sub={`${mai(cur.other)}・目標15%`} delta={cmp ? <Delta cur={cur.otherRate} prev={cmp.otherRate} unit="pt" /> : null} accent={cur.otherRate >= OTHER_TARGET_RATE ? C.up : C.amber} />
                  <Kpi label="処方箋1枚あたり売上" value={yen(cur.perRx)} sub={`技術料 ${yen(cur.total ? cur.tech / cur.total : 0)}/枚`} delta={cmp ? <Delta cur={cur.perRx} prev={cmp.perRx} /> : null} accent={C.teal} />
                </div>
              </div>
            ) : (
              <div style={{ background: "#fff", border: `1px dashed ${C.line}`, borderRadius: 6, padding: "22px 18px", textAlign: "center", marginBottom: 14, boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{selPeriod}のデータはまだありません</div>
                <div style={{ fontSize: 12.5, color: C.sub, marginTop: 6, lineHeight: 1.6 }}>
                  上の「✎ {selPeriod} の数字を入力」から登録できます。<br />下のグラフ・月平均は登録済みの月をもとに表示しています。
                </div>
              </div>
            )}

            {/* 年間サマリー（月平均） */}
            <div style={{ background: "#fff", borderRadius: 6, padding: "14px 15px", margin: "0 0 16px", border: `1px solid ${C.border}`, boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600, color: C.ink, fontFamily: FONT_HEAD }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: C.teal, flex: "0 0 auto" }} />
                  {year}年度の月平均（{activeName}）
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.sub, whiteSpace: "nowrap" }}>対象 {monthsCount} か月</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { l: "月平均 処方箋枚数", v: mai(avgTotal), accent: C.teal },
                  { l: "月平均 売上", v: man(avgSales), accent: C.up },
                  { l: "月平均 他科枚数", v: mai(avgOther), accent: C.amber },
                ].map((m) => (
                  <div key={m.l} style={{ background: "#fff", borderRadius: 6, padding: "10px 11px", border: `1px solid ${m.accent}22` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: C.sub, fontWeight: 700, lineHeight: 1.3 }}>
                      <span style={{ width: 5, height: 5, borderRadius: 999, background: m.accent, flex: "0 0 auto" }} />
                      {m.l}
                    </div>
                    <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4, fontVariantNumeric: "tabular-nums", color: C.ink }}>{m.v}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10.5, color: C.sub, marginTop: 8, lineHeight: 1.5 }}>
                登録済み {monthsCount} か月の平均。年間の処方箋枚数は合計 {mai(sumTotal)}。
              </div>
            </div>

            {/* 人件費・労働分配率（法人タブのみ／選択月にデータがあるとき） */}
            {cur && hasLabor && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                <Kpi label="人件費" value={man(cur.labor)} sub="給与＋法定福利＋福利厚生" delta={cmp ? <Delta cur={cur.labor} prev={cmp.labor} invert /> : null} accent={C.teal} />
                <Kpi label="労働分配率（人件費÷技術料）" value={pct(cur.laborDist)} sub="低いほど人件費に余裕" delta={cmp ? <Delta cur={cur.laborDist} prev={cmp.laborDist} invert unit="pt" /> : null} accent={C.teal} />
              </div>
            )}

            {/* 他科処方箋の目標管理（総処方箋枚数の15%以上） */}
            <div style={{ background: "#fff", borderRadius: 6, padding: "14px 15px", marginBottom: 16, border: `1px solid ${C.border}`, borderLeft: `3px solid ${otherAchieved ? C.up : C.amber}`, boxShadow: "0 1px 2px rgba(27,40,54,.06)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: 600, color: C.ink, fontFamily: FONT_HEAD }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: otherAchieved ? C.up : C.amber, flex: "0 0 auto" }} />
                  他科処方箋の目標（15%以上）{focus && <span style={{ fontSize: 11, color: C.sub, fontWeight: 700, fontFamily: FONT_SANS }}>／{focus.period}</span>}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: otherAchieved ? C.up : C.amber, padding: "3px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>
                  {otherAchieved ? "達成" : `あと ${mai(Math.max(0, otherGap))}`}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginBottom: 11 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700 }}>現在の他科率</div>
                  <div style={{ fontSize: 25, fontWeight: 800, color: otherAchieved ? C.up : C.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{focus ? pct(focus.otherRate) : "—"}</div>
                </div>
                <div style={{ paddingBottom: 3 }}>
                  <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700 }}>目標枚数（15%）</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.ink, fontVariantNumeric: "tabular-nums" }}>{mai(targetOther)}<span style={{ fontSize: 11, color: C.sub, fontWeight: 600 }}> 以上</span></div>
                </div>
                <div style={{ paddingBottom: 3, marginLeft: "auto", textAlign: "right" }}>
                  <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700 }}>現在 / 総処方箋</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, fontVariantNumeric: "tabular-nums" }}>{focus ? `${mai(focus.other)} / ${mai(focus.total)}` : "—"}</div>
                </div>
              </div>
              <div style={{ position: "relative", height: 8, borderRadius: 999, background: "#dfe6ec", overflow: "hidden" }}>
                <div style={{ width: `${otherProgress * 100}%`, height: "100%", borderRadius: 999, background: otherAchieved ? C.up : C.amber, transition: "width .3s" }} />
              </div>
              <div style={{ fontSize: 10.5, color: C.sub, marginTop: 7, lineHeight: 1.5 }}>
                総処方箋の15%以上を他科で確保するのが目標。バーは目標（15%）に対する達成度です。
              </div>

              <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.sub }}>月別の達成状況</div>
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: achievedCount > 0 ? C.up : C.sub }}>
                    達成 {achievedCount} / {data.length} か月
                  </span>
                </div>
                <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2, WebkitOverflowScrolling: "touch" }}>
                  {data.map((d, i) => {
                    const tgt = Math.round(d.total * (OTHER_TARGET_RATE / 100));
                    const ok = d.otherRate >= OTHER_TARGET_RATE;
                    const gap = Math.max(0, tgt - d.other);
                    return (
                      <button
                        key={i}
                        onClick={() => setSelPeriod(d.period)}
                        style={{
                          flex: "0 0 auto", minWidth: 58, padding: "7px 8px", borderRadius: 6, cursor: "pointer",
                          border: d.period === selPeriod ? `1.5px solid ${ok ? C.up : C.amber}` : `1px solid ${C.line}`,
                          background: ok ? "#eef4e6" : "#fff", textAlign: "center",
                        }}
                      >
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.sub }}>{d.period}</div>
                        <div style={{ fontSize: 13, fontWeight: 800, color: ok ? C.up : C.ink, fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
                          {ok ? "✓" : pct(d.otherRate)}
                        </div>
                        <div style={{ fontSize: 9.5, color: ok ? C.up : C.sub, fontVariantNumeric: "tabular-nums" }}>
                          {ok ? "達成" : `あと${gap}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* グラフ群：PCでは複数列、スマホでは1列 */}
            <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "repeat(auto-fit, minmax(300px, 1fr))" : "1fr", gap: 13, marginBottom: 13 }}>
              <Card flush title="売上の構成（技術料＋薬剤料）">
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gTech" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor={C.tealBright} />
                        <stop offset="1" stopColor={C.teal} />
                      </linearGradient>
                      <linearGradient id="gDrug" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor={C.sage} />
                        <stop offset="1" stopColor={C.sageDeep} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="period" tick={{ fontSize: 11, fill: C.sub }} tickLine={false} axisLine={false} interval={xInterval} />
                    <YAxis tickFormatter={man} tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip formatter={(v, n) => [yen(v), n]} contentStyle={{ borderRadius: 6, border: "none", boxShadow: "0 4px 14px rgba(0,0,0,.1)", fontSize: 12 }} />
                    <Bar name="技術料" dataKey="tech" stackId="s" fill="url(#gTech)" maxBarSize={24} radius={[0, 0, 0, 0]} />
                    <Bar name="薬剤料" dataKey="drug" stackId="s" fill="url(#gDrug)" maxBarSize={24} radius={[4, 4, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>

              <Card flush title="処方箋枚数と集中率">
                <ResponsiveContainer width="100%" height={190}>
                  <ComposedChart data={data} margin={{ top: 6, right: 4, left: -8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor={C.tealBright} stopOpacity={0.85} />
                        <stop offset="1" stopColor={C.sage} stopOpacity={0.9} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="period" tick={{ fontSize: 11, fill: C.sub }} tickLine={false} axisLine={false} interval={xInterval} />
                    <YAxis yAxisId="l" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={36} />
                    <YAxis yAxisId="r" orientation="right" domain={[60, 100]} tickFormatter={(v) => v + "%"} tick={{ fontSize: 10, fill: C.amber }} tickLine={false} axisLine={false} width={36} />
                    <Tooltip formatter={(v, n) => [n === "集中率" ? v.toFixed(1) + "%" : v.toLocaleString("ja-JP") + "枚", n]} contentStyle={{ borderRadius: 6, border: "none", boxShadow: "0 4px 14px rgba(0,0,0,.1)", fontSize: 12 }} />
                    <Bar yAxisId="l" name="処方箋枚数" dataKey="total" fill="url(#gTotal)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                    <Line yAxisId="r" name="集中率" dataKey="concentration" stroke={C.amber} strokeWidth={2.5} dot={{ r: 2.5, fill: C.amber }} activeDot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>

              <Card flush title="技術料率の推移">
                <ResponsiveContainer width="100%" height={170}>
                  <ComposedChart data={data} margin={{ top: 6, right: 4, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={C.line} vertical={false} />
                    <XAxis dataKey="period" tick={{ fontSize: 11, fill: C.sub }} tickLine={false} axisLine={false} interval={xInterval} />
                    <YAxis tickFormatter={(v) => v.toFixed(0) + "%"} tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={42} />
                    <Tooltip formatter={(v, n) => [v.toFixed(1) + "%", n]} contentStyle={{ borderRadius: 6, border: "none", boxShadow: "0 4px 14px rgba(0,0,0,.1)", fontSize: 12 }} />
                    <Line name="技術料率" dataKey="techRate" stroke={C.teal} strokeWidth={2.5} dot={{ r: 2.5, fill: C.teal }} activeDot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              </Card>
            </div>
          </>
        )}

        {/* 医師面会記録＋カレンダー：PCでは横並び、スマホでは縦積み */}
        <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "1fr 1fr" : "1fr", gap: 13, marginBottom: 13, alignItems: "start" }}>
          <Card flush title="医師面会記録">
            <div style={{ display: "grid", gap: 10, padding: "0 2px 4px" }}>
              {doctorPairs.map(({ pharmacy, doctor }) => {
                const info = getDoc(pharmacy, doctor);
                const k = docKey(pharmacy, doctor);
                const isOpen = openDoctor === k;
                return (
                  <div key={k} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: "11px 12px", background: "#fff" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span style={{ width: 26, height: 26, borderRadius: 999, background: "#e8f1f9", color: C.teal, fontWeight: 800, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" }}>医</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13.5, color: C.ink }}>{doctor}</div>
                          {activeName !== pharmacy && <div style={{ fontSize: 10.5, color: C.sub }}>{pharmacy}</div>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "0 0 auto" }}>
                        <span style={{ fontSize: 10.5, color: C.sub }}>誕生日</span>
                        <input
                          type="date"
                          value={info.birthday ? `2000-${info.birthday}` : ""}
                          onChange={(e) => setBirthday(pharmacy, doctor, e.target.value ? e.target.value.slice(5) : "")}
                          style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: "3px 6px", fontSize: 11, color: C.ink }}
                        />
                      </div>
                    </div>

                    {info.meetings.length > 0 && (
                      <div style={{ marginTop: 9, display: "grid", gap: 6 }}>
                        {info.meetings.slice(0, 4).map((m, i) => (
                          <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
                            <span style={{ flex: "0 0 auto", color: C.teal, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{(m.date || "").replace(/-/g, "/").slice(5)}</span>
                            <span style={{ color: C.ink }}>{m.note}</span>
                          </div>
                        ))}
                        {info.meetings.length > 4 && <div style={{ fontSize: 10.5, color: C.sub }}>ほか {info.meetings.length - 4} 件</div>}
                      </div>
                    )}

                    {isOpen ? (
                      <div style={{ marginTop: 9, borderTop: `1px solid ${C.line}`, paddingTop: 9, display: "grid", gap: 7 }}>
                        <input type="date" value={mtgDate} onChange={(e) => setMtgDate(e.target.value)} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 8px", fontSize: 12 }} />
                        <textarea value={mtgNote} onChange={(e) => setMtgNote(e.target.value)} placeholder="面会内容（例：在宅の相談、新規採用薬の説明 など）" style={{ minHeight: 56, border: `1px solid ${C.line}`, borderRadius: 6, padding: 8, fontSize: 12, resize: "vertical", boxSizing: "border-box" }} />
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => addMeeting(pharmacy, doctor)} style={{ flex: 1, padding: 9, borderRadius: 6, border: "none", background: C.accent, color: "#fff", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>記録する</button>
                          <button onClick={() => { setOpenDoctor(null); setMtgNote(""); }} style={{ padding: "9px 14px", borderRadius: 6, border: `1px solid ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>閉じる</button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => { setOpenDoctor(k); setMtgDate(todayISO()); setMtgNote(""); }} style={{ marginTop: 9, width: "100%", padding: "8px", borderRadius: 6, border: `1px dashed ${C.teal}66`, background: "#e8f1f9", color: C.teal, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>＋ 面会記録を追加</button>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card flush title="定例イベントカレンダー">
            <div style={{ padding: "0 2px 4px" }}>
              <div style={{ display: "grid", gap: 7 }}>
                {calendar.length === 0 && <div style={{ fontSize: 12, color: C.sub }}>イベントがありません。下から追加できます。</div>}
                {calendar.map((it) => (
                  <div key={it.kind + it.id + it.md} style={{ display: "flex", alignItems: "center", gap: 10, border: `1px solid ${C.line}`, borderRadius: 6, padding: "9px 11px" }}>
                    <div style={{ flex: "0 0 auto", width: 40, textAlign: "center" }}>
                      <div style={{ fontSize: 9.5, color: C.sub, fontWeight: 700 }}>{it.kind === "birthday" ? "誕生日" : "予定"}</div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: it.kind === "birthday" ? C.amber : C.teal, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{mdLabel(it.md)}</div>
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: C.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                      {it.note && <div style={{ fontSize: 10.5, color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.note}</div>}
                    </div>
                    <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 800, color: it.days <= 14 ? C.down : C.sub, fontVariantNumeric: "tabular-nums" }}>{it.days === 0 ? "今日" : `あと${it.days}日`}</span>
                      {it.kind === "event" && <button onClick={() => deleteEvent(it.id)} title="削除" style={{ border: "none", background: "transparent", color: C.sub, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>}
                    </div>
                  </div>
                ))}
              </div>

              {showAddEvent ? (
                <div style={{ marginTop: 9, border: `1px solid ${C.line}`, borderRadius: 6, padding: 11, display: "grid", gap: 7 }}>
                  <input value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="イベント名（例：お盆休み、医師会総会 など）" style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 9px", fontSize: 12 }} />
                  <input type="date" value={evDate} onChange={(e) => setEvDate(e.target.value)} style={{ border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 9px", fontSize: 12 }} />
                  <div style={{ fontSize: 10.5, color: C.sub }}>※ 毎年この月日にくり返します（年は無視されます）</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={addEvent} style={{ flex: 1, padding: 9, borderRadius: 6, border: "none", background: C.accent, color: "#fff", fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>追加する</button>
                    <button onClick={() => setShowAddEvent(false)} style={{ padding: "9px 14px", borderRadius: 6, border: `1px solid ${C.line}`, background: "#fff", color: C.sub, fontWeight: 700, fontSize: 12.5, cursor: "pointer" }}>閉じる</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowAddEvent(true)} style={{ marginTop: 9, width: "100%", padding: "8px", borderRadius: 6, border: `1px dashed ${C.teal}66`, background: "#e8f1f9", color: C.teal, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>＋ イベントを追加</button>
              )}
              <div style={{ fontSize: 10.5, color: C.sub, marginTop: 8, lineHeight: 1.5 }}>
                医師の誕生日は「医師面会記録」で各医師の誕生日を設定すると、ここに自動で表示されます。
              </div>
            </div>
          </Card>
        </div>
        </>
        )}

        {/* 出典の注記は経営ダッシュボードの数字に対するもの（基本料判定は独自の注記を持つ） */}
        {view === "keiei" && (
          <div style={{ textAlign: "center", fontSize: 11, color: C.sub, marginTop: 20, lineHeight: 1.7 }}>
            出典：DPC各エリア集計／処方箋枚数＝受付回数・売上＝保険合計（技術料＋薬剤料）。会計年度は10月始まり。<br />
            {CORP_NAME}は各薬局の合算を自動表示（人件費のみ法人で入力）。前年同期比は一つ前の年度から自動計算。<br />
            {hasOther
              ? "他科枚数＝医院別調剤内訳の最多クリニック以外。データ未取得の月は0です。"
              : "※ 他科枚数は未入力（0）のため、集中率は参考値です。"}
            {hasOverrides && <><br />（この端末で手入力した数字を反映して表示中）</>}
          </div>
        )}

        {/* ブランドフッター */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 18, opacity: 0.7 }}>
          <Logo size={20} />
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: C.teal }}>sizucu</span>
        </div>
      </div>
    </div>
  );
}

// クラウド同期の状態バッジ
function SyncBadge({ status }) {
  const map = {
    loading: { t: "同期中…", c: C.sub, bg: "#eef2f5" },
    saving: { t: "保存中…", c: C.teal, bg: "#e8f1f9" },
    synced: { t: "☁ 同期済み", c: C.up, bg: "#eef4e6" },
    offline: { t: "⚠ オフライン", c: "#8f6b17", bg: "#fbf3df" },
    error: { t: "⚠ 同期失敗", c: C.down, bg: "#fbecea" },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <span
      title="入力した数字はクラウドに暗号化して保存され、全端末で共有されます"
      style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 800, color: m.c, background: m.bg, padding: "5px 10px", borderRadius: 999, whiteSpace: "nowrap" }}
    >
      {m.t}
    </span>
  );
}

// 月送りの矢印ボタン（左右）
function NavArrow({ dir, onClick, disabled, label }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        flex: "0 0 auto", width: 34, height: 34, borderRadius: 999,
        border: `1px solid ${disabled ? C.line : C.border}`,
        background: disabled ? "#f4f7f9" : "#fff",
        color: disabled ? "#a9b4bf" : C.teal,
        fontSize: 18, fontWeight: 800, lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        boxShadow: disabled ? "none" : "none",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {dir === "left" ? "‹" : "›"}
    </button>
  );
}

function Field({ label, value, onChange }) {
  return (
    <label style={{ display: "block" }}>
      <div style={{ fontSize: 11, color: C.sub, fontWeight: 700, marginBottom: 3 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        placeholder="0"
        style={{ width: "100%", height: 42, border: `1px solid ${C.line}`, borderRadius: 6, padding: "0 11px", fontSize: 16, fontVariantNumeric: "tabular-nums", boxSizing: "border-box", background: "#fff", color: C.ink }}
      />
    </label>
  );
}

function Kpi({ label, value, sub, delta, accent, wide }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 6,
        padding: "12px 14px",
        boxShadow: "0 1px 2px rgba(27,40,54,.06)",
        border: `1px solid ${C.border}`,
        borderLeft: `3px solid ${accent || C.sage}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.sub, fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ fontSize: wide ? 27 : 22, fontWeight: 800, marginTop: 2, color: C.ink, fontVariantNumeric: "tabular-nums", letterSpacing: 0 }}>{value}</div>
        {wide && <span style={{ fontSize: 12 }}>{delta}</span>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 3, fontSize: 11 }}>
        <span style={{ color: C.sub }}>{sub}</span>
        {!wide && <span>{delta}</span>}
      </div>
    </div>
  );
}

function Card({ title, children, flush }) {
  return (
    <div style={{ background: "#fff", borderRadius: 6, marginBottom: flush ? 0 : 13, boxShadow: "0 1px 2px rgba(27,40,54,.06)", border: `1px solid ${C.border}`, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: C.ink, padding: "9px 13px", background: C.head, borderBottom: `1px solid ${C.border}`, fontFamily: FONT_HEAD }}>
        <span style={{ width: 3, height: 14, borderRadius: 2, background: C.accent, flex: "0 0 auto" }} />
        {title}
      </div>
      <div style={{ padding: "13px 12px 8px" }}>{children}</div>
    </div>
  );
}
