import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useStageStore } from '../../stage/store'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { Highlight } from '../../expose/components/Highlight'
import { useSessionTime } from '../../expose/components/session-time'
import { Input } from '../../ui/Input'
import { Segmented } from '../../ui/Segmented'
import type { SegmentedOption } from '../../ui/Segmented'
import { notify } from '../../services/notify'
import { Search } from '../../components/icons'
import { useT } from '../../i18n'
import type { MessageKey, TFn } from '../../i18n'
import { SCOPES, moveRow, nextScope, originText, recentRows, searchRows, targetText } from '../transitions'
import type { SearchMaterial } from '../transitions'
import type { SearchBadge, SearchRow, SearchScope } from '../types'
import s from './SearchPanel.module.css'

/**
 * 检索面板 = 一块普通的 Dock 内容(id 'search'),所以它能上舞台 / 变浮窗 / 钉到边,
 * 三种形态里长得一模一样 —— 这正是 renderContent 那张表存在的理由。
 *
 * 终稿的形状:**搜索行 + 一张平铺列表**,没有二次分组、没有分栏、没有分节标题。
 * 一行永远是三件东西:行首小徽 / 命中原文一行 / 行尾灰色出处。
 * 空词时那张列表换成「最近打开」,行的解剖一格没变 —— 所以下面只有一套行渲染。
 *
 * 它自己不写一行检索逻辑:命中、排序、轮转、走行全在 search/transitions 的纯函数里,
 * 组件只有「谁被选中」和「输入框里是什么」两个本地状态。
 */

/** 一次搜索最多为多少条命中会话补拉章节(取数上限,不是结果上限)。 */
const CHAPTER_PREFETCH_LIMIT = 8

const SCOPE_LABELS: Record<SearchScope, MessageKey> = {
  all: 'search.scopeAll',
  sessions: 'search.scopeSessions',
  files: 'search.scopeFiles',
}

/** 徽上的字:前两种是界面文案(走字典),文件那种是从扩展名推出来的数据。 */
function badgeText(badge: SearchBadge, t: TFn): string {
  if (badge.kind === 'file') return badge.ext
  return t(badge.kind === 'session' ? 'search.badgeSession' : 'search.badgeMessage')
}

export function SearchPanel() {
  const t = useT()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SearchScope>('all')
  const [cursor, setCursor] = useState(0)
  const enterSession = useExposeStore((st) => st.enterSession)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const sessions = useSessionsSource((st) => st.sessions)
  const chapters = useSessionsSource((st) => st.chapters)
  const ensureChapters = useSessionsSource((st) => st.ensureChapters)
  const timeOf = useSessionTime()
  const listRef = useRef<HTMLDivElement>(null)

  const searching = query.trim().length > 0
  const material: SearchMaterial = useMemo(
    () => ({ sessions, chapters, timeOf: (session) => timeOf(session.updatedAt) }),
    [sessions, chapters, timeOf],
  )
  const rows = useMemo(
    () => (searching ? searchRows(query, scope, material) : recentRows(scope, material)),
    [query, scope, searching, material],
  )

  /*
   * 章节是**按需**拉的:标题 / 预览命中的那几条先把章节补回来,下一轮渲染里
   * 它们的章节行就一起出现。上限是刻意的 —— 一个字母就为几十条会话各发一次
   * 请求,那不叫按需。会话侧另外两样(标题、预览)本来就在 listMeta 里,即时滤。
   */
  useEffect(() => {
    if (!searching || scope === 'files') return
    const q = query.trim().toLowerCase()
    let asked = 0
    for (const session of sessions) {
      if (asked >= CHAPTER_PREFETCH_LIMIT) break
      if (!session.title.toLowerCase().includes(q) && !session.preview.toLowerCase().includes(q)) {
        continue
      }
      asked += 1
      void ensureChapters(session.id)
    }
  }, [searching, query, scope, sessions, ensureChapters])

  // 换词 / 换范围 = 换了一张列表,选中回到第一行。
  useEffect(() => {
    setCursor(0)
  }, [query, scope])

  // 选中行滚进视野。block:'nearest' = 只在它真的出界时才滚,列表不会为了走一行整屏跳。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [cursor, rows])

  const options: Array<SegmentedOption<SearchScope>> = SCOPES.map((value) => ({
    value,
    label: t(SCOPE_LABELS[value]),
  }))

  const activate = (row: SearchRow) => {
    switch (row.target.kind) {
      case 'session':
        enterSession(row.target.sessionId)
        break
      case 'file':
        /*
         * 这是接真源的缝。壳里还没有「打开一个文件」这件能力(没有编辑器面、
         * 没有主进程),所以这里只把落点如实报出来。接上真实打开器时,
         * 换掉的就是这一行 —— 行模型、跳转目标、收回 Dock 的手感都不动。
         *
         * 走 notify 而不是从前那个散装 toast:级别 info(它既不是成功也不是错,
         * 只是「这就是我能做到的」),于是它同样进通知中心存档 ——
         * 用户过一会儿想不起刚才那行报的是哪个文件时,还翻得到。
         */
        notify({
          level: 'info',
          source: 'search.open',
          title: t('search.openedFile', { file: targetText(row.target) }),
        })
        break
    }
    // 选中就是这块面板的活干完了,收回 Dock —— 与 Quick Look 进会话同一个手感。
    closeToDock('search')
  }

  /*
   * 键盘住在面板自己身上,**不是 keymap 里的命令**:它只在这块面有焦点时才成立,
   * 而命令表管的是「面板关着时也要能触发」的那一类。Esc 这里一个字不写 ——
   * 让位契约由宿主(舞台 / 浮窗 / 架子)执行,内容层不许把它吃掉。
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // 拦下默认行为:这块面里 Tab 是「换搜索范围」,不是「把焦点交出去」。
      e.preventDefault()
      setScope((sc) => nextScope(sc, e.shiftKey ? -1 : 1))
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((i) => moveRow(i, e.key === 'ArrowDown' ? 1 : -1, rows.length))
      return
    }
    if (e.key === 'Enter') {
      const row = rows[cursor]
      if (!row) return
      e.preventDefault()
      activate(row)
    }
  }

  return (
    /* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
     * 这里挂 onKeyDown 是**事件委托**,不是把一个 div 变成控件:真正拿焦点的是里面那个
     * 输入框(autoFocus),↑↓/⏎ 从它冒泡上来,由面板统一按当前 cursor 处理。
     * 规则防的是「给死元素装交互却不给焦点」—— 焦点在,只是在子节点上。 */
    <div className={s.panel} onKeyDown={onKeyDown}>
      <div className={s.head}>
        <Input
          className={s.input}
          value={query}
          onValueChange={setQuery}
          size="lg"
          /* eslint-disable-next-line jsx-a11y/no-autofocus --
           * 命令面板的**唯一**用法就是「⌘P 敲出来就打字」。这里不自动聚焦等于
           * 让每个用户开完面板再按一次 Tab —— 规则防的是「页面一进来就抢焦点」,
           * 而这块面板是用户刚刚显式召唤出来的瞬态浮层,焦点本来就该在它身上。 */
          autoFocus
          prefix={<Search className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
        />
        <Segmented
          options={options}
          value={scope}
          onChange={setScope}
          label={t('search.scopeLabel')}
        />
      </div>

      <div className={s.body} ref={listRef} role="listbox" aria-label={t('search.resultsLabel')}>
        {rows.length === 0 ? (
          <p className={s.none}>{t('search.noResults')}</p>
        ) : (
          rows.map((row, i) => (
            <button
              key={row.id}
              type="button"
              role="option"
              aria-selected={i === cursor}
              data-row={i}
              className={i === cursor ? `${s.row} ${s.rowOn}` : s.row}
              onClick={() => {
                setCursor(i)
                activate(row)
              }}
            >
              <span className={s.chip}>{badgeText(row.badge, t)}</span>
              <span className={row.code ? `${s.text} ${s.code}` : s.text}>
                <Highlight text={row.text} query={searching ? query : ''} />
              </span>
              <span className={s.origin}>{originText(row.origin)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}
