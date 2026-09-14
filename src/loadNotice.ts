// クラウドを読めなかったときの表示まわりの小道具（LoadBanner と各タブで共有）

export function fmtCachedAt(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 読み取り専用のときに編集しようとしたら、最初の1回だけ理由を知らせる（入力のたびに出さない）
export function makeBlockedNotice() {
  let shown = false
  return () => {
    if (shown) return
    shown = true
    alert('サーバーに繋がっていないため、いまは変更できません。\n画面上の赤い帯の「再読み込み」を押してください。')
  }
}
