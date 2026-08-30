import { useEffect, useMemo, useState } from 'react'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import type { SegmentedOption } from '../ui/Segmented'
import { useNotifyStore } from '../services/notify-store'
import type { NotifyLevel, NotifyRecord } from '../services/notify-store'
import { useSessionTime } from '../expose/components/session-time'
import { usePanelVisibility } from './visibility'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import s from './NotificationsPanel.module.css'

/**
 * 通知中心 = 一块**普通的 Dock 内容**(id 'notifications'),所以它能上舞台 / 变浮窗 /
 * 钉到边,三种形态里长得一模一样。它一点特权都没有:不自己 portal、不自己管 z 层、
 * 不知道自己被摆在哪儿 —— 这正是 renderContent 那张表存在的理由。
 *
 * 形状:头(标题 + 级别过滤 + 两枚静默小钮)/ 身(按天分组的行)/ 脚(通往完整日志的门)。
 * 一行永远是四件东西:级别色点 / 标题(未读加粗)+ 正文一行 / 产地 / 相对时间。
 * 点开在行**下方**展开 detail —— 一块 surface-1 圆角衬块,mono 原样。
 * **不用左竖线**:那是账页画线风,已被否决;衬块本身就说明了「这段属于上面那行」。
 */

export type NotifyFilter = 'all' | 'warn' | 'error'
export type DayBucket = 'today' | 'yesterday' | 'earlier'

const FILTERS: NotifyFilter[] = ['all', 'warn', 'error']

const FILTER_LABELS: Record<NotifyFilter, MessageKey> = {
  all: 'notify.filterAll',
  warn: 'notify.filterWarn',
  error: 'notify.filterError',
}

const BUCKET_LABELS: Record<DayBucket, MessageKey> = {
  today: 'notify.today',
  yesterday: 'notify.yesterday',
  earlier: 'notify.earlier',
}

/** 级别 → 那颗色点的类。silent 也有一颗(line-2 的灰):它进了存档,就得看得见。 */
const DOT_CLASS: Record<NotifyLevel, string> = {
  success: 'dotSuccess',
  info: 'dotInfo',
  warn: 'dotWarn',
  error: 'dotError',
  silent: 'dotSilent',
}

/** 过滤是**减法**,不是重排:'all' 原样返回,别的只留那一档。 */
export function filterRecords(
  items: readonly NotifyRecord[],
  filter: NotifyFilter,
): NotifyRecord[] {
  if (filter === 'all') return items.slice()
  return items.filter((x) => x.level === filter)
}

/**
 * 落在哪一天。按**本地自然日**分,不按「距今 24 小时」——
 * 凌晨一点看昨晚十一点那条,它该在「昨天」而不是「今天」。
 */
export function dayBucket(time: number, now: number): DayBucket {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (time >= startOfToday) return 'today'
  const startOfYesterday = new Date(startOfToday).setDate(new Date(startOfToday).getDate() - 1)
  return time >= startOfYesterday ? 'yesterday' : 'earlier'
}

export interface DayGroup {
  bucket: DayBucket
  items: NotifyRecord[]
}

/**
 * 按天分组。输入已经是「最新在前」,所以这里只是**连续切段** ——
 * 不排序、不去重,组的次序就是记录的次序。空组不产出:一个只有标题没有行的组头
 * 是「这里本来该有东西」的错觉。
 */
export function groupByDay(items: readonly NotifyRecord[], now: number): DayGroup[] {
  const groups: DayGroup[] = []
  for (const item of items) {
    const bucket = dayBucket(item.time, now)
    const last = groups[groups.length - 1]
    if (last && last.bucket === bucket) last.items.push(item)
    else groups.push({ bucket, items: [item] })
  }
  return groups
}

export function NotificationsPanel() {
  const t = useT()
  const { visible, interactive } = usePanelVisibility()
  const items = useNotifyStore((st) => st.items)
  const markAllRead = useNotifyStore((st) => st.markAllRead)
  const clear = useNotifyStore((st) => st.clear)
  const act = useNotifyStore((st) => st.act)
  const [filter, setFilter] = useState<NotifyFilter>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  const timeOf = useSessionTime()

  /*
   * 面板到场 = 这些都看见了,未读清零。
   *
   * 判据是 `visible && interactive`,不是「组件挂上了」:Dock 悬停预览泡里也挂着
   * **同一块内容的第二份**(visible 但 interactive: false),悬停看一眼不该把未读抹掉
   * —— 这与 ExposeView 不许在泡里抢键盘是同一条判据(见 content/visibility.ts)。
   *
   * 依赖里带 items 是有意的:面板开着时新来的通知同样是「当场就看见了」。
   * 这不会自激,因为 markAllRead 在全都已读时原样返回旧 state(zustand 不通知)。
   */
  useEffect(() => {
    if (visible && interactive) act()
  }, [visible, interactive, act, items])

  const shown = useMemo(() => filterRecords(items, filter), [items, filter])
  // 「今天」的边界在整个面板里取一次:同一屏里两行不该因为渲染差了几毫秒而落进不同的天。
  const groups = useMemo(() => groupByDay(shown, Date.now()), [shown])

  const options: Array<SegmentedOption<NotifyFilter>> = FILTERS.map((value) => ({
    value,
    label: t(FILTER_LABELS[value]),
  }))

  return (
    <div className={s.panel}>
      <div className={s.head}>
        <h2 className={s.title}>{t('item.notifications')}</h2>
        <Segmented
          options={options}
          value={filter}
          onChange={setFilter}
          label={t('notify.filterLabel')}
        />
        <span className={s.spacer} />
        <Button onClick={markAllRead} disabled={items.length === 0}>
          {t('notify.markAllRead')}
        </Button>
        <Button onClick={clear} disabled={items.length === 0}>
          {t('notify.clear')}
        </Button>
      </div>

      <div className={s.body}>
        {groups.length === 0 ? (
          <p className={s.none}>{t('notify.empty')}</p>
        ) : (
          groups.map((group, i) => (
            <section key={`${group.bucket}-${i}`} className={s.group}>
              <h3 className={s.groupHead}>{t(BUCKET_LABELS[group.bucket])}</h3>
              {group.items.map((record) => (
                <div key={record.id} className={s.item}>
                  <button
                    type="button"
                    className={s.row}
                    aria-expanded={record.detail ? openId === record.id : undefined}
                    onClick={() => setOpenId((id) => (id === record.id ? null : record.id))}
                  >
                    <span className={`${s.dot} ${s[DOT_CLASS[record.level]]}`} aria-hidden="true" />
                    <span className={record.read ? s.rowTitle : `${s.rowTitle} ${s.unread}`}>
                      {record.title}
                    </span>
                    {record.count > 1 && (
                      <span className={s.repeat}>{t('notify.repeat', { count: record.count })}</span>
                    )}
                    {record.body ? <span className={s.rowBody}>{record.body}</span> : null}
                    <span className={s.source}>{record.source}</span>
                    <span className={s.time}>{timeOf(record.time)}</span>
                  </button>
                  {openId === record.id && record.detail ? (
                    <pre className={s.detail}>{record.detail}</pre>
                  ) : null}
                </div>
              ))}
            </section>
          ))
        )}
      </div>

      {/*
       * 完整日志的门。**今天它是禁用的,这是诚实缺口不是占位装饰**:
       * 壳里还没有「打开一个本地路径」这件能力(platform 面上没有 openPath,
       * 主进程侧那条 configureShellHost 也还没接到新壳这一侧)。
       * 接上之后换掉的就是这一个节点 —— 面板结构、分组、详情一格不动。
       */}
      <div className={s.foot}>
        <button type="button" className={s.footLink} disabled>
          {t('notify.openLog')}
        </button>
      </div>
    </div>
  )
}
