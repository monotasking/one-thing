import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Plus, Search } from '../../components/icons'
import { useQueryHeld } from '../../data/kernel'
import { todoSearchFamily, type TodoNoteSummary, type TodoSearchHits } from '../../data/todo-source'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { useListSelection } from '../../ui/a11y/list-selection'
import { ButtonBase } from '../../ui/ButtonBase'
import { useFloatDismiss, useFloatPosition } from '../../ui/float'
import { useTodoPanelState } from './panel-state'
import { useTodoPreferences } from './preferences'
import s from './TodoSwitcher.module.css'

/** 有字时「清单」那一组最多几条。 */
export const TODO_SWITCHER_LIST_LIMIT = 8
/** 停手多久才去后端搜项(清单名是本地过滤,不等)。 */
export const TODO_SEARCH_DEBOUNCE_MS = 150

type Row =
  | { kind: 'list'; note: TodoNoteSummary }
  | { kind: 'item'; hit: TodoSearchHits['items'][number] }
  | { kind: 'create'; title: string }

interface Group {
  label: string
  rows: Row[]
}

/**
 * 切换 / 搜索弹层(B 形,正本 `docs/todo-app-b-2026-09.md` §2.2)。一个弹层两种内容,
 * 判据是输入框空不空:空 = 最近 + 全部清单 + 新建;有字 = 名字命中的清单 + 各清单里命中的项。
 *
 * ══ 三张状态表 ══════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──
 *  · 挂载 —— 贴着头的下缘开(`ui/float` 矩锚,头跟着滚它就跟着走),焦点进输入框
 *    (`restingTarget` + `activateOnMount`);
 *  · 换词 —— 清单当场本地过滤;项停手 150ms 后按词取一格(`todoSearchFamily`,一个词一格);
 *  · 关 —— Esc(有字先清空)/ 点外面 / 打开了什么;焦点结构性地回到开它的地方。
 *
 * ── ② UI 生命状态 ──
 *  · 空词 —— 「最近」(没有就不画这一组)+「全部清单」按名字排 +「新建清单」;
 *  · 有字、项还在路上 —— 清单组先出,项组留着上一个词的结果(旧行一像素不动,病型 A);
 *    头一个词还没回来时那一组不画(不画骨架);
 *  · 搜项失败 —— 项组一句「搜不到项」,清单组照常;
 *  · 什么都没命中 —— 一句「没有找到「x」」+「新建清单「x」」;
 *  · 超量 —— 清单组封顶 8、项组封顶 50 + 一行文字读数「还有 N 条」;整块封顶高度内部滚。
 *
 * ── ③ UI 交互状态 ──
 *  · 行:rest / hover(CSS 淡底,不改键盘位)/ active(键盘位,选中底)/ 点击 = 选中并打开;
 *  · ↑↓ 走键盘位(循环),↵ 打开键盘位那一行,⌘F = 全选输入框里的词;
 *  · 当前清单那一行标「当前」;完成的项画 ✓ 并降一档字色。
 */
export function TodoSwitcher({ anchor, notes, activeId, onClose, onOpenList, onCreate }: {
  anchor: () => DOMRect | null
  notes: readonly TodoNoteSummary[]
  activeId: string | null
  onClose: () => void
  onOpenList: (id: string) => void
  /** 新建一份清单;`title` 空 = 缺省名。 */
  onCreate: (title: string) => void
}) {
  const t = useT()
  const recent = useTodoPreferences(st => st.recent)
  const revealItem = useTodoPanelState(st => st.revealItem)
  const ref = useRef<HTMLDivElement | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const term = query.trim()

  const pos = useFloatPosition(ref, { kind: 'rect', get: anchor, place: 'below-start' })
  useFloatDismiss(ref, onClose)
  const width = anchor()?.width ?? 0

  const searchKey = useDebounced(term, TODO_SEARCH_DEBOUNCE_MS)
  const search = useSearchHits(searchKey)

  const groups = useMemo<Group[]>(() => {
    if (!term) {
      const byId = new Map(notes.map(note => [note.id, note]))
      const recents = recent.map(id => byId.get(id)).filter((note): note is TodoNoteSummary => Boolean(note))
      const all = [...notes].sort((a, b) => a.title.localeCompare(b.title))
      return [
        ...(recents.length > 0 ? [{ label: t('todo.recent'), rows: recents.map(note => ({ kind: 'list' as const, note })) }] : []),
        { label: t('todo.allLists'), rows: all.map(note => ({ kind: 'list' as const, note })) },
        { label: '', rows: [{ kind: 'create' as const, title: '' }] },
      ]
    }
    const needle = term.toLocaleLowerCase()
    const lists = notes.filter(note => note.title.toLocaleLowerCase().includes(needle)).slice(0, TODO_SWITCHER_LIST_LIMIT)
    const items = search.hits?.items ?? []
    const exact = notes.some(note => note.title === term)
    return [
      ...(lists.length > 0 ? [{ label: t('todo.searchLists'), rows: lists.map(note => ({ kind: 'list' as const, note })) }] : []),
      ...(items.length > 0 ? [{ label: t('todo.searchItems'), rows: items.map(hit => ({ kind: 'item' as const, hit })) }] : []),
      ...(exact ? [] : [{ label: '', rows: [{ kind: 'create' as const, title: term }] }]),
    ]
  }, [term, notes, recent, search.hits, t])

  const rows = useMemo(() => groups.flatMap(group => group.rows), [groups])
  const { active, select, handleKey, rowRef } = useListSelection({ count: rows.length, loop: true })
  // 换词把键盘位拉回第一条:命中变了还停在第三行,↵ 就会开错。
  useEffect(() => { select(0) }, [term, select])

  const open = (row: Row) => {
    if (row.kind === 'list') onOpenList(row.note.id)
    else if (row.kind === 'item') {
      revealItem(row.hit.id, row.hit.line)
      onOpenList(row.hit.id)
    } else onCreate(row.title)
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (handleKey(event.key)) {
      event.preventDefault()
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const row = rows[active]
      if (row) open(row)
    }
  }

  const listsHit = groups.some(group => group.rows.some(row => row.kind !== 'create'))
  const itemsPending = Boolean(term) && (searchKey !== term || search.loading)
  let index = 0

  return createPortal(
    <FocusScope
      scope="popover"
      rootRef={ref}
      activateOnMount
      restingTarget={() => input.current}
      onEscape={() => {
        if (query) setQuery('')
        else onClose()
        return true
      }}
      commands={{ 'view.find': () => input.current?.select() }}
    >
      {({ scopeProps }) => (
        /* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions --
         * ↑↓ 与 ↵ 是整块面的语法,焦点恒在输入框(命令面板的常规做法,判例 WorkspacePalette)。 */
        <div
          {...scopeProps}
          className={s.panel}
          style={{ left: `${pos.left}px`, top: `${pos.top}px`, ['--todo-switcher-anchor-w' as string]: `${width}px` }}
          role="dialog"
          aria-label={t('todo.search')}
          tabIndex={-1}
          data-focus-ring="none"
          data-testid="todo-switcher"
          onKeyDown={onKeyDown}
        >
          <div className={s.head} data-focus-ring="text">
            <Search className={s.headIcon} strokeWidth={1.75} aria-hidden="true" />
            <input
              ref={input}
              className={s.input}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('todo.search')}
              aria-label={t('todo.search')}
              aria-controls="todo-switcher-list"
              data-testid="todo-switcher-input"
            />
          </div>

          <div className={s.list} id="todo-switcher-list" role="listbox" aria-label={t('todo.search')}>
            {term && !listsHit && !itemsPending && (
              <p className={s.note}>{t('todo.noHit', { query: term })}</p>
            )}
            {groups.map((group, g) => (
              <div key={group.label || `g${g}`} role="group" aria-label={group.label || undefined}>
                {group.label && <div className={s.groupLabel} aria-hidden="true">{group.label}</div>}
                {group.rows.map(row => {
                  const i = index++
                  const on = i === active
                  return (
                    <ButtonBase
                      key={rowKey(row)}
                      role="option"
                      ref={rowRef(i)}
                      aria-selected={on}
                      tabIndex={-1}
                      className={on ? `${s.row} ${s.rowOn}` : s.row}
                      data-testid={`todo-switcher-row-${rowKey(row)}`}
                      onClick={() => { select(i); open(row) }}
                    >
                      <RowBody row={row} term={term} current={row.kind === 'list' && row.note.id === activeId} />
                    </ButtonBase>
                  )
                })}
              </div>
            ))}
            {term && search.error && !search.hits && <p className={s.note}>{t('todo.searchFailed')}</p>}
            {term && search.hits && search.hits.more > 0 && (
              <p className={s.note}>{t('todo.moreHits', { count: search.hits.more })}</p>
            )}
          </div>
        </div>
      )}
    </FocusScope>,
    document.body,
  )
}

function RowBody({ row, term, current }: { row: Row; term: string; current: boolean }) {
  const t = useT()
  if (row.kind === 'create') {
    return (
      <>
        <Plus className={s.rowIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.rowText}>{row.title ? t('todo.createNamed', { title: row.title }) : t('todo.newList')}</span>
      </>
    )
  }
  if (row.kind === 'list') {
    const open = row.note.total - row.note.done
    return (
      <>
        <span className={s.rowText}><Highlight text={row.note.title} term={term} /></span>
        {current && <span className={s.meta}>{t('todo.current')}</span>}
        <span className={s.meta}>{t('todo.openCount', { count: open })}</span>
      </>
    )
  }
  return (
    <>
      <span className={s.check} aria-hidden="true">{row.hit.done && <Check strokeWidth={2} />}</span>
      <span className={row.hit.done ? `${s.rowText} ${s.done}` : s.rowText}><Highlight text={row.hit.text} term={term} /></span>
      <span className={s.meta}>{row.hit.title}</span>
    </>
  )
}

function Highlight({ text, term }: { text: string; term: string }): ReactNode {
  if (!term) return text
  const at = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <mark className={s.mark}>{text.slice(at, at + term.length)}</mark>
      {text.slice(at + term.length)}
    </>
  )
}

function rowKey(row: Row): string {
  if (row.kind === 'list') return `list-${row.note.id}`
  if (row.kind === 'item') return `item-${row.hit.id}-${row.hit.line}`
  return 'create'
}

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (!value) {
      setSettled('')
      return
    }
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * 按词取一格项命中。**换词时旧答案留在屏上**,直到新词的答案回来(律②′,`useQueryHeld`):
 * 一个词一格,新格首载那一刻没有数据,直接读会让项组整组闪没再闪回。
 * 空词那一格恒答空(见 `todoSearchFamily`),不发请求。
 */
function useSearchHits(key: string): { hits: TodoSearchHits | null; loading: boolean; error: boolean } {
  const query = todoSearchFamily.get(key)
  const state = useQueryHeld(query)
  useEffect(() => { if (key) void query.ensure() }, [key, query])
  if (!key) return { hits: null, loading: false, error: false }
  return { hits: state.data ?? null, loading: (state.data === undefined || state.stale) && !state.error, error: Boolean(state.error) }
}
