import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Ellipsis, ListChecks, Search } from '../../components/icons'
import { useQuery } from '../../data/kernel'
import { createTodoNote, renameTodoNote, todoNotesQuery, useTodoLive, type TodoNoteSummary } from '../../data/todo-source'
import { activateScopeAfterCommit } from '../../focus/after-commit'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { currentKeymapPlatform, useKeymapState } from '../../keymap/store'
import { effectiveCombos, formatCombo } from '../../keymap/transitions'
import { ButtonBase } from '../../ui/ButtonBase'
import { IconButton } from '../../ui/IconButton'
import { Kbd } from '../../ui/Kbd'
import { Tooltip } from '../../ui/Tooltip'
import type { StripHeaderProps } from '../../workbench/kinds'
import { useTodoPanelState } from './panel-state'
import { useTodoPreferences } from './preferences'
import { RenameField, TodoMenu } from './TodoMenus'
import { TodoSwitcher } from './TodoSwitcher'
import s from './TodoHeader.module.css'

/**
 * 待办窗的头(B 形,正本 `docs/todo-app-b-2026-09.md` §2.1 / §3)。
 *
 * 它是 `panel:todo` 自带的头:独占一片叶时叶把它画在标签条上(`placement='strip'`,
 * 宿主的窗口钮与拖窗手势照旧),叶里有别的格时正文自己把它画在顶上(`inline`)。
 * 两处是同一只组件 —— 头随内容走,永远只有一条。
 *
 * ══ 三张状态表 ══════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──
 *  · 挂载 —— 订 `todo:` 事实、`ensure` 清单列表;
 *  · 换宿主(条上 ⇄ 正文顶上、架子 / 浮窗 / 舞台)—— 这是一次重挂:改名框与菜单是
 *    本地瞬态,丢了就丢了(与标签条上的改名同形);切换弹层开没开在 `panel-state`,
 *    跟着新的一任接着开;
 *  · 卸载 —— 退订,弹层随之卸载,焦点结构性归还。
 *
 * ── ② UI 生命状态 ──
 *  · 首载 / 没有清单 —— 名字那格写「我的清单」,点开弹层里只有「新建清单」;
 *  · 读失败 —— 头不说话(正文那句「读不到」+ 重试是唯一出口,不画两遍);
 *  · 超量(清单名很长)—— 名字截断 + Tooltip 全名;头窄于 420 —— 搜索框收成放大镜。
 *
 * ── ③ UI 交互状态 ──
 *  · 名字:rest / hover(淡底)/ 弹层开着(选中底)/ focus(全局环);单击 = 开弹层;
 *    右键 = 重命名 / 在访达中显示 / 删除;
 *  · 搜索框:hover 描深边;单击或 ⌘F = 开同一个弹层;
 *  · ⋯:新建清单 / 打开源文件 / 在访达中显示 / 编辑时显示记号;
 *  · 改名:↵ 落定 / Esc 收回(`ui/inline-edit`);新建在飞时「新建」不重复发。
 */
export function TodoHeader({ placement }: StripHeaderProps & { placement: 'strip' | 'inline' }) {
  const t = useT()
  useTodoLive()
  const notes = useQuery(todoNotesQuery)
  useEffect(() => { void todoNotesQuery.ensure() }, [])
  const activeNoteId = useTodoPreferences(st => st.activeNoteId)
  const setActiveNoteId = useTodoPreferences(st => st.setActiveNoteId)
  const replaceNoteId = useTodoPreferences(st => st.replaceNoteId)
  const switcherOpen = useTodoPanelState(st => st.switcherOpen)
  const openSwitcher = useTodoPanelState(st => st.openSwitcher)
  const closeSwitcher = useTodoPanelState(st => st.closeSwitcher)
  const keymap = useKeymapState()
  const findCombo = effectiveCombos(keymap, 'view.find')[0] ?? null

  const list = notes.data?.notes ?? []
  const active = list.find(note => note.id === activeNoteId) ?? list[0]

  const rootRef = useRef<HTMLDivElement | null>(null)
  const headRef = useRef<HTMLDivElement | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; noteId: string | null } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)

  const createNote = async (title?: string) => {
    const id = await createTodoNote.run({ title: title || t('todo.newListTitle') })
    if (id) setActiveNoteId(id)
  }

  const commitRename = () => {
    if (!renaming) return
    const title = renaming.title.trim()
    const from = renaming.id
    setRenaming(null)
    if (!title) return
    // 改名换的是文件名,id 跟着换:「当前」与「最近」一起跟过去。
    void renameTodoNote.run({ id: from, title }).then(to => { if (to) replaceNoteId(from, to) })
  }

  const title = active?.title ?? t('todo.lists')

  return (
    <FocusScope
      scope="todoLists"
      owner="header"
      rootRef={rootRef}
      restingTarget={() =>
        rootRef.current?.querySelector<HTMLElement>('[data-todo-rename]')
        ?? rootRef.current?.querySelector<HTMLElement>('[data-todo-name]')
        ?? null}
      commands={{ 'view.find': openSwitcher }}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.wrap} data-placement={placement} data-testid="todo-header">
          <div ref={headRef} className={s.head}>
            <ListChecks className={s.appIcon} strokeWidth={1.75} aria-hidden="true" />
            {renaming ? (
              <RenameField
                value={renaming.title}
                label={t('todo.rename')}
                onChange={value => setRenaming({ ...renaming, title: value })}
                onCommit={commitRename}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <>
                <Tooltip content={title}>
                  <ButtonBase
                    className={s.name}
                    data-todo-name=""
                    data-testid="todo-switcher-trigger"
                    aria-haspopup="dialog"
                    aria-expanded={switcherOpen}
                    aria-label={t('todo.switchList', { title })}
                    onClick={openSwitcher}
                    onContextMenu={event => {
                      if (!active) return
                      event.preventDefault()
                      setMenu({ x: event.clientX, y: event.clientY, noteId: active.id })
                    }}
                  >
                    <span className={s.nameText}>{title}</span>
                    <ChevronDown className={s.caret} strokeWidth={1.75} aria-hidden="true" />
                  </ButtonBase>
                </Tooltip>
                <div className={s.spacer} />
              </>
            )}
            <ButtonBase className={s.search} data-testid="todo-search-trigger" onClick={openSwitcher}>
              <Search className={s.searchIcon} strokeWidth={1.75} aria-hidden="true" />
              <span className={s.searchText}>{t('todo.search')}</span>
              {findCombo && formatCombo(findCombo, currentKeymapPlatform()).map(cap => <Kbd key={cap}>{cap}</Kbd>)}
            </ButtonBase>
            <IconButton className={s.searchNarrow} icon={Search} label={t('todo.search')} size="sm" onClick={openSwitcher} />
            <IconButton
              ref={moreRef}
              icon={Ellipsis}
              label={t('todo.more')}
              size="sm"
              onClick={() => {
                const rect = moreRef.current?.getBoundingClientRect()
                if (rect) setMenu({ x: rect.left, y: rect.bottom, noteId: null })
              }}
            />
          </div>

          {menu && (
            <TodoMenu
              at={menu}
              note={menu.noteId === null ? active : list.find(note => note.id === menu.noteId)}
              contextual={menu.noteId !== null}
              anchor={menu.noteId === null ? () => moreRef.current?.getBoundingClientRect() ?? null : undefined}
              onClose={() => setMenu(null)}
              onCreate={() => void createNote()}
              onRename={(note: TodoNoteSummary) => {
                setRenaming({ id: note.id, title: note.title })
                // 开的人点名(判例 `expose/components/SessionRename.tsx`):菜单卸载时的结构性归还
                // 排在前面,这一句最后说话 —— 焦点进改名框。
                activateScopeAfterCommit('todoLists', { owner: 'header' })
              }}
            />
          )}

          {switcherOpen && (
            <TodoSwitcher
              anchor={() => headRef.current?.getBoundingClientRect() ?? null}
              notes={list}
              activeId={active?.id ?? null}
              onClose={closeSwitcher}
              onOpenList={id => { setActiveNoteId(id); closeSwitcher() }}
              onCreate={name => { closeSwitcher(); void createNote(name) }}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}

/** 条上那一格(`ContentKind.stripHeader` 交出去的组件)。 */
export function TodoStripHeader(props: StripHeaderProps) {
  return <TodoHeader {...props} placement="strip" />
}
