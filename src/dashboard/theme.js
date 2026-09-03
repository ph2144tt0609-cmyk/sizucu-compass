// 経営ダッシュボード系（早見表・経営・調剤基本料）の色と書体。
//
// 2026-09-03：淡くて読みにくかったので、マネーフォワード寄りに作り替えた。
//   ・文字（ink/sub）は白地で4.5:1以上まで濃くする
//   ・罫線（border/line）は「透明度10%のネイビー」をやめて、見えるグレーの実線にする
//   ・押せるもの・選ばれているものは青（accent）ひと色に統一する
// 値は index.css の :root トークンと同じ。片方だけ直すとズレるので、
// 色を変えるときは index.css とこのファイルの両方を直すこと。
export const C = {
  teal: '#2f4459', // ネイビー（見出し・帯）
  tealDeep: '#1e2c3a', // 濃ネイビー
  tealBright: '#2f6faf', // 青（グラフの明側）
  accent: '#1a6bb0', // 操作の青（選択中・ボタン）
  accentD: '#135690',
  accentL: '#e8f1f9', // 青の淡い面（選択前の下地・タグ）
  sage: '#b6c5d1', // ブルーグレー（チャート副系）
  sageDeep: '#93a6b5',
  amber: '#c39320', // ゴールド（集中率アクセント）
  amberSoft: '#e3c469',
  amberBg: '#fbf3df',
  amberInk: '#8f6b17',
  ink: '#1b2836', // 本文インク
  sub: '#46586a', // サブテキスト
  up: '#4c7a2b', // グリーン（良化・目標達成）
  upBg: '#eef4e6',
  down: '#c0392f', // レッド（悪化）
  downBg: '#fbecea',
  line: '#d2d9e0', // 罫線
  head: '#f4f7f9', // 表・カード見出しの帯
  bg: '#eef1f4', // 地のグレー
  card: '#FFFFFF',
  border: '#d2d9e0', // カードの輪郭
}

export const FONT_SANS =
  '"Zen Kaku Gothic New", -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif'
// 見出しもゴシック。明朝の細い横棒＋広い字間が「淡くて読みにくい」の主因だった。
export const FONT_HEAD = FONT_SANS
