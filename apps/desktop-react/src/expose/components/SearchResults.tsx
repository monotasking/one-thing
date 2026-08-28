import { useT } from '../../i18n'
import { turnTimeAt } from '../data'
import { searchSessions } from '../transitions'
import { Highlight } from './Highlight'
import s from './SearchResults.module.css'

interface Props {
  query: string
  onEnter: (sessionId: string) => void
}

/**
 * 三层缩进 = SearchHit 的三层,过滤在纯函数里做完了,
 * 这里一次 filter 都没有 —— 否则三层会各自漂移。
 */
export function SearchResults({ query, onEnter }: Props) {
  const t = useT()
  const hits = searchSessions(query)

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
              <Highlight text={hit.session.summary} query={query} />
            </span>
          </button>

          {hit.segments.map((seg) => (
            <div key={seg.title} className={s.segRow}>
              <span className={s.segTitle}>§ {seg.title}</span>
              <span className={s.sep}>·</span>
              <span className={s.segDetail}>
                <Highlight text={seg.detail} query={query} />
              </span>
            </div>
          ))}

          {hit.turns.map((turn) => (
            <div key={turn.index} className={s.turnRow}>
              <span className={s.turnText}>
                {t('search.youPrefix')}
                <Highlight text={turn.text} query={query} />
              </span>
              <span className={s.turnTime}>{turnTimeAt(turn.index)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
