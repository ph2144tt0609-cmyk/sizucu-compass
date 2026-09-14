// クラウドを読めなかったときに、どのタブでも同じ形で出す赤帯。
// 「データは消えていない」「いま見ているのは何か」「いまは保存できない」の3つを必ず言う。
import { fmtCachedAt } from '../loadNotice'

export function LoadBanner({
  what,
  source,
  cachedAt,
  fallbackNote,
}: {
  what: string // 「補助金のデータ」など
  source: 'cloud' | 'cache' | 'none'
  cachedAt: string | null
  fallbackNote?: string // 控えが無いときに代わりに何を出しているか（例：基準データ）
}) {
  const at = fmtCachedAt(cachedAt)
  return (
    <div className="load-banner" role="alert">
      <span className="load-banner-mark">！</span>
      <span className="load-banner-text">
        サーバーに繋がらないため、<b>{what}</b>
        {source === 'cache' ? (
          <>
            は<b>この端末の控え{at && `（${at} 時点）`}</b>を表示しています。
          </>
        ) : (
          <>を読み込めませんでした。{fallbackNote ?? 'この端末に控えも無いため表示できません。'}</>
        )}
        <b>いまは変更・保存できません。</b>
        <span className="load-banner-sub">（データは消えていません）</span>
      </span>
      <button className="load-banner-btn" onClick={() => location.reload()}>
        再読み込み
      </button>
    </div>
  )
}
