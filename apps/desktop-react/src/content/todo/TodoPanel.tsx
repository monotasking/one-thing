import { useEffect, useRef, useState } from 'react'
import { Ellipsis } from '../../components/icons'
import { useQuery, useMutation } from '../../data/kernel'
import { useHomeDir } from '../../data/home-dir'
import { revealPath } from '../../data/reveal-path'
import {
  createTodoNote,
  deleteTodoNote,
  renameTodoNote,
  todoDocumentFamily,
  todoNoteRef,
  todoNotesQuery,
  useTodoLive,
  type TodoNoteSummary,
} from '../../data/todo-source'
import { activateScopeAfterCommit } from '../../focus/after-commit'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { useConfirm } from '../../ui/Dialog'
import { Field, useFieldControlProps } from '../../ui/Field'
import { IconButton } from '../../ui/IconButton'
import { Input } from '../../ui/Input'
import { useInlineEdit } from '../../ui/inline-edit'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { Tabs } from '../../ui/Tabs'
import { REVEAL_MODES } from '../editing/reveal'
import { openFileInCurrentTarget } from '../viewer/open-target'
import { useTodoPreferences } from './preferences'
import { TodoDocView } from './TodoDocView'
import { useTodoEditorDocument } from './todo-document'
import s from './TodoPanel.module.css'

/**
 * Dock 面板「我的清单」(正本 `docs/todo-2026-09.md` §5.4)。
 *
 * ══ 三张状态表 ══════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──
 *  · 挂载 —— `useTodoLive()` 订 `todo:` 事实;清单列表 `ensure()`;当前清单经文档注册表拿到
 *    一份 `EditorDocument`(与计划抽屉同一套,同一个地址只有一份本地真相);
 *  · 换宿主(架子 / 浮窗 / 舞台)—— 查询格与文档在模块里,不随组件丢;
 *  · 切清单 —— 旧文档先 flush 再放(注册表引用计数归零时);
 *  · 卸载 —— 退订;读数留在格子里。
 *
 * ── ② UI 生命状态 ──
 *  · 首载 —— 不画骨架,头部与正文空着,有了一次出现;
 *  · 没有任何清单 —— 一句「还没有清单」+「新建清单」;
 *  · 列表读失败 / 当前清单读失败 —— 一句话 +「重试」,旧内容留着;
 *  · 超量(50 份清单)—— `Tabs` 自带溢出名单;正文在面板里滚。
 *
 * ── ③ UI 交互状态 ──
 *  · 标签:选中 / hover / focus 随 `ui/Tabs`;右键 = 重命名 / 在访达中显示 / 删除;
 *  · 重命名:标签条原位换成一格输入(↵ 落定 / Esc 收回,`ui/inline-edit`;失焦**不**收回 ——
 *    菜单卸载时那一下结构性归还不是人点走的,判例 `expose/components/SessionRename.tsx`);
 *  · 删除:`useConfirm` 二次确认(删的是文件);
 *  · 「在访达中显示」:没有本机文件系统的宿主(浏览器直开,`useHomeDir()` 为 null)置灰;
 *  · ⋯ 菜单:新建清单 / 打开源文件 / 在访达中显示 / 编辑时显示记号(三档单选)。
 */
export function TodoPanel() {
  const t = useT()
  useTodoLive()
  const notes = useQuery(todoNotesQuery)
  useEffect(() => { void todoNotesQuery.ensure() }, [])
  const creating = useMutation(createTodoNote)
  const activeNoteId = useTodoPreferences(st => st.activeNoteId)
  const setActiveNoteId = useTodoPreferences(st => st.setActiveNoteId)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const list = notes.data?.notes ?? []
  // 选中的清单被删掉(或从没选过)时落到第一份。
  const active = list.find(note => note.id === activeNoteId) ?? list[0]

  const [menu, setMenu] = useState<{ x: number; y: number; noteId: string | null } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const moreRef = useRef<HTMLButtonElement | null>(null)

  const createNote = async () => {
    const id = await createTodoNote.run({ title: t('todo.newListTitle') })
    if (id) setActiveNoteId(id)
  }

  return (
    <FocusScope
      scope="todoLists"
      rootRef={rootRef}
      restingTarget={() =>
        // 改名框开着 → 它;否则选中的那个标签。
        rootRef.current?.querySelector<HTMLElement>('[data-todo-rename]')
        ?? rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?? null}
    >
      {({ scopeProps }) => (
        <div {...scopeProps} className={s.panel} data-testid="todo-panel">
          <div className={s.head}>
            {renaming ? (
              <RenameField
                value={renaming.title}
                label={t('todo.rename')}
                onChange={title => setRenaming({ ...renaming, title })}
                onCommit={() => {
                  const title = renaming.title.trim()
                  if (title) void renameTodoNote.run({ id: renaming.id, title })
                  setRenaming(null)
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <div className={s.tabs}>
                {list.length > 0 && (
                  <Tabs
                    items={list.map(note => ({ id: note.id, label: note.title }))}
                    activeId={active?.id ?? null}
                    onSelect={setActiveNoteId}
                    onTabMenu={(id, at) => setMenu({ ...at, noteId: id })}
                    label={t('todo.lists')}
                  />
                )}
              </div>
            )}
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

          {notes.error && (
            <p className={s.notice}>
              {t('todo.readFailed')}{' '}
              <Button size="sm" onClick={() => void todoNotesQuery.refetch()}>{t('todo.retry')}</Button>
            </p>
          )}

          {notes.data && list.length === 0 && (
            <div className={s.empty}>
              <p>{t('todo.empty')}</p>
              <Button size="sm" disabled={creating.pending} onClick={() => void createNote()}>{t('todo.newList')}</Button>
            </div>
          )}

          {active && <NoteBody key={active.id} note={active} />}

          {menu && (
            <TodoMenu
              at={menu}
              note={menu.noteId === null ? active : list.find(note => note.id === menu.noteId)}
              contextual={menu.noteId !== null}
              anchor={menu.noteId === null ? () => moreRef.current?.getBoundingClientRect() ?? null : undefined}
              onClose={() => setMenu(null)}
              onCreate={() => void createNote()}
              onRename={note => {
                setRenaming({ id: note.id, title: note.title })
                // 开的人点名(判例 `expose/components/SessionRename.tsx`):菜单卸载时响应链会把焦点
                // 归还给右键之前的地方,这一句排在归还之后,最后说话的是「焦点进改名框」。
                activateScopeAfterCommit('todoLists')
              }}
            />
          )}
        </div>
      )}
    </FocusScope>
  )
}

function NoteBody({ note }: { note: TodoNoteSummary }) {
  const t = useT()
  const { document, error } = useTodoEditorDocument(todoNoteRef(note.id))
  return (
    <div className={s.body}>
      {error && !document && (
        <p className={s.notice}>
          {t('todo.readFailed')}{' '}
          <Button size="sm" onClick={() => void todoDocumentFamily.get(todoNoteRef(note.id)).refetch()}>{t('todo.retry')}</Button>
        </p>
      )}
      {document && <TodoDocView document={document} density="panel" owner={`note:${note.id}`} />}
    </div>
  )
}

function TodoMenu({ at, note, contextual, anchor, onClose, onCreate, onRename }: {
  at: { x: number; y: number }
  note: TodoNoteSummary | undefined
  /** 右键开在某个标签上(只列这一份清单的动作);否则是 ⋯ 菜单。 */
  contextual: boolean
  anchor?: () => DOMRect | null
  onClose: () => void
  onCreate: () => void
  onRename: (note: TodoNoteSummary) => void
}) {
  const t = useT()
  const confirm = useConfirm()
  const revealMode = useTodoPreferences(st => st.revealMode)
  const setRevealMode = useTodoPreferences(st => st.setRevealMode)
  const act = (action: () => void) => () => { onClose(); action() }

  return (
    <Menu x={at.x} y={at.y} onClose={onClose} label={t('todo.more')} anchor={anchor} anchorPlace="below-end">
      {contextual && note ? (
        <>
          <MenuItem onClick={act(() => onRename(note))}>{t('todo.rename')}</MenuItem>
          <NoteFileItems note={note} withOpen={false} act={act} />
          <MenuSeparator />
          <MenuItem
            danger
            onClick={act(() => {
              void confirm({
                title: t('todo.deleteTitle'),
                description: t('todo.deleteConfirm', { title: note.title }),
                confirmLabel: t('todo.delete'),
              }).then(ok => { if (ok) void deleteTodoNote.run({ id: note.id }) })
            })}
          >
            {t('todo.delete')}
          </MenuItem>
        </>
      ) : (
        <>
          <MenuItem onClick={act(onCreate)}>{t('todo.newList')}</MenuItem>
          {note && <NoteFileItems note={note} withOpen act={act} />}
          <MenuSeparator />
          <MenuSection>{t('todo.revealMode')}</MenuSection>
          {REVEAL_MODES.map(mode => (
            <MenuItem key={mode} checked={revealMode === mode} onClick={act(() => setRevealMode(mode))}>
              {t(`todo.revealMode.${mode}`)}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  )
}

/**
 * 与一份清单的源文件有关的两项。路径在文档读数上(`document` 读法带 `filePath`),
 * 列表摘要里没有 —— 所以这一件自己问那一格(当前清单那格早已读过,别的标签上右键才会补一发)。
 */
function NoteFileItems({ note, withOpen, act }: {
  note: TodoNoteSummary
  withOpen: boolean
  act: (action: () => void) => () => void
}) {
  const t = useT()
  const canReveal = useHomeDir() !== null
  const query = todoDocumentFamily.get(todoNoteRef(note.id))
  const view = useQuery(query).data
  useEffect(() => { void query.ensure() }, [query])
  const filePath = view?.filePath || undefined
  return (
    <>
      {withOpen && (
        <MenuItem disabled={!filePath} onClick={act(() => { if (filePath) openFileInCurrentTarget(filePath) })}>
          {t('todo.openSource')}
        </MenuItem>
      )}
      <MenuItem disabled={!canReveal || !filePath} onClick={act(() => { if (filePath) void revealPath(filePath) })}>
        {t('todo.reveal')}
      </MenuItem>
    </>
  )
}

function RenameField({ value, label, onChange, onCommit, onCancel }: {
  value: string
  label: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <Field layout="inline" size="sm" labelHidden label={label} className={s.rename}>
      <RenameInput value={value} onChange={onChange} onCommit={onCommit} onCancel={onCancel} />
    </Field>
  )
}

/** 单独一件:`useFieldControlProps()` 只在 `<Field>` 之内拿得到(判例 `WorkspaceOverview.RenameInput`)。 */
function RenameInput({ value, onChange, onCommit, onCancel }: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const field = useFieldControlProps()
  const edit = useInlineEdit({ controlId: field.id, onCommit, onCancel })
  return <Input {...field} {...edit} size="sm" className={s.renameInput} value={value} onValueChange={onChange} data-todo-rename="" />
}
