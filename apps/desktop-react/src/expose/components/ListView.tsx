import { useMemo, useState } from 'react'
import { ChevronRight } from '../../components/icons'
import { plural, useT } from '../../i18n'
import type { MessageKey } from '../../i18n'
import { useSessionsSource } from '../../data/sessions-source'
import { findGroup, sessionsOfGroup } from '../projection'
import { useExposeStore } from '../store'
import { timeBucket } from '../transitions'
import type { TimeBucket } from '../transitions'
import type { SessionSummary } from '../types'
import { useSessionTime } from './session-time'
import s from './ListView.module.css'

/** 桶的次序在这里,桶的名字在字典里 —— 状态机只产出标识。 */
const BUCKETS: TimeBucket[] = ['thisWeek', 'earlier']
const BUCKET_KEY: Record<TimeBucket, MessageKey> = {
  thisWeek: 'list.bucketThisWeek',
  earlier: 'list.bucketEarlier',
}

interface Props {
  /** 组 id(数据源里的组 id),不是 projectId —— 协作组与独立组各进各的。 */
  groupId: string
}

export function ListView({ groupId }: Props) {
  const t = useT()
  const timeOf = useSessionTime()
  const groups = useSessionsSource((st) => st.groups)
  const backToOverview = useExposeStore((st) => st.backToOverview)
  const enterSession = useExposeStore((st) => st.enterSession)
  // 本组过滤是「看的方式」,不是形态 —— 所以留在组件里,不进状态机。
  const [filter, setFilter] = useState('')

  const all = useMemo(() => sessionsOfGroup(groups, groupId), [groups, groupId])
  // 组名两种来源,恰有其一:合成组给 key(界面文案),项目组给数据 —— 与总览同一读法。
  const group = findGroup(groups, groupId)
  const groupName = group?.nameKey ? t(group.nameKey) : (group?.name ?? groupId)
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? all.filter((x) => x.title.toLowerCase().includes(q)) : all
  }, [all, filter])

  // 「本周 / 更早」的分界是**此刻**,所以 now 在这一次渲染里只取一次。
  const now = Date.now()
  const grouped: [TimeBucket, SessionSummary[]][] = BUCKETS.map((b) => [
    b,
    rows.filter((x) => timeBucket(x.updatedAt, now) === b),
  ])

  return (
    <div className={s.list}>
      <header className={s.top}>
        <button type="button" className={s.crumb} onClick={backToOverview}>
          {t('list.backToOverview')}
        </button>
        <ChevronRight className={s.crumbIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.here}>
          {t(plural(all.length, 'list.hereOne', 'list.here'), {
            group: groupName,
            count: all.length,
          })}
        </span>
        <input
          className={s.filter}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('list.filter')}
          aria-label={t('list.filter')}
        />
      </header>

      <div className={s.scroll}>
        <div className={s.inner}>
          {grouped.map(([bucket, items]) =>
            items.length === 0 ? null : (
              <section key={bucket} className={s.section}>
                <h3 className={s.sectionHead}>{t(BUCKET_KEY[bucket])}</h3>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={s.row}
                    onClick={() => enterSession(item.id)}
                  >
                    <span className={s.rowTitle}>{item.title}</span>
                    <span className={s.rowTime}>{timeOf(item.updatedAt)}</span>
                  </button>
                ))}
              </section>
            ),
          )}
          {rows.length === 0 && <p className={s.empty}>{t('expose.noMatchingSessions')}</p>}
        </div>
      </div>
    </div>
  )
}
