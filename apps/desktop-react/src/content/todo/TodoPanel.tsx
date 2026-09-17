import { useEffect, useRef } from 'react'
import { useMutation, useQuery } from '../../data/kernel'
import {
  createTodoNote,
  todoDocumentFamily,
  todoNoteRef,
  todoNotesQuery,
  useTodoLive,
  type TodoNoteSummary,
} from '../../data/todo-source'
import { FocusScope } from '../../focus/FocusScope'
import { useT } from '../../i18n'
import { Button } from '../../ui/Button'
import { useScrollMemory } from '../../ui/scroll-memory'
import { PANEL_KIND } from '../../stage/panel-ref'
import { usePanelVisibility } from '../visibility'
import { useTodoPanelState } from './panel-state'
import { useTodoPreferences } from './preferences'
import { TodoDocView } from './TodoDocView'
import { TodoHeader } from './TodoHeader'
import { todoScrollPorts, useTodoEditorDocument } from './todo-document'
import s from './TodoPanel.module.css'

/** 这块面的内容引用(头要它;瓦 id 的唯一产地是 `stage/items.ts`,这里只是拼一个 ref)。 */
const TODO_PANEL_REF = { kind: PANEL_KIND, key: 'todo' } as const

/**
 * 待办窗的正文(B 形,正本 `docs/todo-app-b-2026-09.md` §2.3;T3 的 Dock 面板「我的清单」改形而来)。
 *
 * 头不在这里:独占一片叶时它画在叶的标签条上(`ContentKind.stripHeader`),否则由这里画在
 * 正文顶上 —— 判据是宿主说的 `usePanelVisibility().headerInStrip`,头随内容走、永远只有一条。
 *
 * ══ 三张状态表 ══════════════════════════════════════════════════════════
 *
 * ── ① 生命周期 ──
 *  · 挂载 —— `useTodoLive()` 订 `todo:` 事实;清单列表 `ensure()`;当前清单经文档注册表拿到
 *    一份 `EditorDocument`(与计划抽屉同一套,同一个地址只有一份本地真相);
 *  · 换宿主(架子 / 浮窗 / 舞台;条上有头 ⇄ 没头)—— 查询格与文档在模块里,不随组件丢;
 *    滚动位置按清单记(`todoScrollPorts`);
 *  · 切清单 —— 旧文档先 flush 再放(注册表引用计数归零时);
 *  · 从搜索结果打开一项 —— 文档到手后把那一行滚进视野并淡闪一下,然后把这件事消费掉;
 *  · 卸载 —— 退订;读数留在格子里。
 *
 * ── ② UI 生命状态 ──
 *  · 首载 —— 不画骨架,正文空着,有了一次出现;
 *  · 没有任何清单 —— 一句「还没有清单」+「新建清单」;
 *  · 列表读失败 / 当前清单读失败 —— 一句话 +「重试」,旧内容留着;
 *  · 超量(100 份清单)—— 清单不再铺在屏上,切换走头上的弹层;正文在面板里滚。
 *
 * ── ③ UI 交互状态 ──
 *  · ⌘F(焦点在正文里)—— 开头上那个切换 / 搜索弹层;
 *  · 正文编辑的交互状态归 `TodoDocView` / `EditableDoc`。
 */
export function TodoPanel() {
  const t = useT()
  useTodoLive()
  const notes = useQuery(todoNotesQuery)
  useEffect(() => { void todoNotesQuery.ensure() }, [])
  const creating = useMutation(createTodoNote)
  const activeNoteId = useTodoPreferences(st => st.activeNoteId)
  const setActiveNoteId = useTodoPreferences(st => st.setActiveNoteId)
  const openSwitcher = useTodoPanelState(st => st.openSwitcher)
  const { headerInStrip } = usePanelVisibility()
  const rootRef = useRef<HTMLDivElement | null>(null)

  const list = notes.data?.notes ?? []
  // 选中的清单被删掉(或从没选过)时落到第一份。
  const active = list.find(note => note.id === activeNoteId) ?? list[0]

  const createNote = async () => {
    const id = await createTodoNote.run({ title: t('todo.newListTitle') })
    if (id) setActiveNoteId(id)
  }

  return (
    <div className={s.panel} data-testid="todo-panel">
      {!headerInStrip && <TodoHeader contentRef={TODO_PANEL_REF} placement="inline" />}
      <FocusScope
        scope="todoLists"
        owner="body"
        rootRef={rootRef}
        commands={{ 'view.find': openSwitcher }}
      >
        {({ scopeProps }) => (
          <div {...scopeProps} className={s.main} tabIndex={-1} data-focus-ring="none">
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
          </div>
        )}
      </FocusScope>
    </div>
  )
}

function NoteBody({ note }: { note: TodoNoteSummary }) {
  const t = useT()
  const ref = todoNoteRef(note.id)
  const { document, error } = useTodoEditorDocument(ref)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { onScroll } = useScrollMemory(scrollRef, ref, todoScrollPorts)
  const reveal = useTodoPanelState(st => st.reveal)
  const consumeReveal = useTodoPanelState(st => st.consumeReveal)

  // 从搜索结果打开的那一项:文档与那一行都到场之后才算数,然后把这件事消费掉。
  useEffect(() => {
    if (!reveal || reveal.id !== note.id || !document) return
    const land = () => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-unit="${reveal.line}"]`)
      if (!row) return false
      row.scrollIntoView({ block: 'center' })
      document.flash([reveal.line])
      consumeReveal()
      return true
    }
    if (land()) return
    // 文档刚到手那一拍行还没画出来:下一帧再落一次,仍落不到就算了(那一行已经不在了)。
    const frame = requestAnimationFrame(() => { if (!land()) consumeReveal() })
    return () => cancelAnimationFrame(frame)
  }, [reveal, note.id, document, consumeReveal])

  return (
    <div ref={scrollRef} className={s.body} onScroll={onScroll}>
      {error && !document && (
        <p className={s.notice}>
          {t('todo.readFailed')}{' '}
          <Button size="sm" onClick={() => void todoDocumentFamily.get(ref).refetch()}>{t('todo.retry')}</Button>
        </p>
      )}
      {document && <TodoDocView document={document} density="panel" owner={`note:${note.id}`} />}
    </div>
  )
}
