import { useT } from '../../i18n'
import { searchSessions } from '../transitions'
import type { SessionChapter, SessionSummary } from '../types'
import { Highlight } from './Highlight'
import s from './SearchResults.module.css'

interface Props {
  query: string
  sessions: SessionSummary[]
  /** 已经拉到手的按会话章节缓存 —— 命中的第二层只在这份里找。 */
  chapters: Record<string, SessionChapter[]>
  onEnter: (sessionId: string) => void
}

/**
 * 两层缩进 = SearchHit 的两层,过滤在纯函数里做完了,
 * 这里一次 filter 都没有 —— 否则两层会各自漂移。
 *
 * 第三层(消息正文)在 D1 不存在:后端没有跨会话内容检索面,判据与缺口写在
 * expose/transitions.ts 的 searchSessions 上。
 */
export function SearchResults({ query, sessions, chapters, onEnter }: Props) {
  const t = useT()
  const hits = searchSessions(query, sessions, chapters)

  if (hits.length === 0) {
    return <p className={s.empty}>{t('expose.noMatchingSessions')}</p>
  }

  return (
    <div className={s.results}>
      {hits.map((hit) => (
        <div key={hit.session.id} className={s.hit}>
          <button type="button" className={s.sessionRow} onClick={() => onEnter(hit.session.id)}>
            <span className={s.sessionTitle}>
              <Highlight text={hit.session.title} query={query} />
            </span>
            <span className={s.sessionSummary}>
              <Highlight text={hit.session.preview} query={query} />
            </span>
          </button>

          {hit.chapters.map((chapter) => (
            <div key={chapter.id} className={s.segRow}>
              <span className={s.segTitle}>§ {chapter.title}</span>
              <span className={s.sep}>·</span>
              <span className={s.segDetail}>
                <Highlight text={chapter.detail} query={query} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
