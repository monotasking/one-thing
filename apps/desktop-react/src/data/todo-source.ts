import { useEffect } from 'react'
import type { LineEdit } from '@onething/core/text'
import type { ResourceOutcomeView, ResourceReadView } from '@shared/ipc/resources'
import { createMutation, createQuery, createQueryFamily } from './kernel'
import type { Mutation, Query } from './kernel'
import { ResourcePortSlot, type ResourceEventFact, type ResourcePort } from './resource-port'

/**
 * 待办的数据层(正本 `apps/desktop-react/docs/todo-2026-09.md` §4、`todo-editor-2026-09.md` §5)。
 *
 * 后端是 `todo:` 资源:`todo:notes`(用户清单一组)、`todo:note/<id>`、`todo:session/<sessionId>`。
 * 读法两条(`list` / `document`,原文 + revision),做法 `edit`(一批 `LineEdit`,后端对账)与
 * 清单的建 / 改名 / 删、计划的第一项。
 *
 * 文档正文的乐观更新不在这里 —— 编辑时本地的真相是 `content/editing/EditorDocument`,它攒行编辑、
 * 停手发一批;这一层只给它一只 `submitTodoEdits`,并在事实到达时标脏那一格,让持有文档的一层
 * 把后端那一份交回给它。
 *
 * ══ 生命周期(这条线不是组件,只一张表)══════════════════════════════════
 *  · import —— 只建空格子,零往返、零订阅;
 *  · 首个消费者挂上 —— 等传输面 ready → 订 `todo:` 前缀的资源事实(先订后拉);
 *  · 事实到达 —— `changed` / `created` / `deleted` 标脏对应那一格与清单列表,有人看就后台补拉、不清屏;
 *  · 最后一个消费者卸下 —— 退订;读数留在格子里,下次开先画旧的再对账;
 *  · HMR —— `resetTodoSource()`(同一口拆卸)。
 */

export const TODO_SCHEME_PREFIX = 'todo:'
export const TODO_NOTES_REF = 'todo:notes'

export function todoSessionRef(sessionId: string): string {
  return `todo:session/${sessionId}`
}

export function todoNoteRef(id: string): string {
  return `todo:note/${id}`
}

export interface TodoDocumentView {
  readonly exists: boolean
  readonly title: string
  readonly filePath: string
  readonly content: string
  readonly revision: string
  readonly updatedAt: number
  readonly total: number
  readonly done: number
}

export interface TodoNoteSummary {
  readonly ref: string
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly total: number
  readonly done: number
}

const slot = new ResourcePortSlot()

/** 测试 / 实验台用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureTodoPort(next: ResourcePort | undefined): void {
  slot.configure(next)
}

function failureText(view: ResourceReadView | ResourceOutcomeView): string {
  switch (view.kind) {
    case 'invalid': return view.message
    case 'denied': return view.reason
    case 'failed': return view.error.message
    case 'aborted': return view.reason ?? ''
    default: return ''
  }
}

async function read<T>(ref: string, name: string, query?: Record<string, unknown>): Promise<T> {
  const port = await slot.get()
  await port.ready()
  const answer = await port.read(ref, name, query)
  if (answer.kind === 'ok') return answer.value as T
  throw new Error(failureText(answer))
}

async function run(ref: string, op: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const port = await slot.get()
  await port.ready()
  const outcome = await port.do(ref, op, params)
  if (outcome.kind !== 'ok') throw new Error(failureText(outcome))
  try {
    return JSON.parse(outcome.text) as Record<string, unknown>
  } catch {
    return {}
  }
}

/* ── 读数 ───────────────────────────────────────────────────────────────── */

export const todoNotesQuery: Query<{ notes: TodoNoteSummary[] }> = createQuery('todo.notes', () =>
  read<{ notes: TodoNoteSummary[] }>(TODO_NOTES_REF, 'list'),
)

/** 一份文档一格,键就是地址。 */
export const todoDocumentFamily = createQueryFamily<TodoDocumentView>('todo.document', ({ key }) =>
  read<TodoDocumentView>(key, 'document'),
)

export interface TodoSearchHits {
  readonly lists: readonly { ref: string; id: string; title: string }[]
  readonly items: readonly { ref: string; id: string; title: string; line: number; text: string; done: boolean }[]
  /** 被上限截掉的项命中还有几条。 */
  readonly more: number
}

/**
 * 跨全部清单搜(待办 B 形 U2)。一个词一格,键就是那个词(已去首尾空白)。
 * 停手节流在调用方(弹层):这一层只管「这个词的答案」;空词恒答空、不发请求。
 */
export const todoSearchFamily = createQueryFamily<TodoSearchHits>('todo.search', ({ key }) =>
  key ? read<TodoSearchHits>(TODO_NOTES_REF, 'search', { q: key }) : Promise.resolve(EMPTY_SEARCH_HITS),
)

const EMPTY_SEARCH_HITS: TodoSearchHits = { lists: [], items: [], more: 0 }

/* ── 写 ─────────────────────────────────────────────────────────────────── */

/** 编辑器交来的一批行编辑。冲突不是错误:如实交回 `{ conflict: true }`,由编辑器去重读。 */
export async function submitTodoEdits(ref: string, edits: readonly LineEdit[], baseRevision: string): Promise<{ conflict: boolean; revision?: string }> {
  const result = await run(ref, 'edit', { edits, baseRevision })
  return { conflict: result.conflict === true, ...(typeof result.revision === 'string' ? { revision: result.revision } : {}) }
}

export const createTodoNote: Mutation<{ title: string }, string | undefined> = createMutation('todo.createNote', {
  run: async ({ title }) => {
    const result = await run(TODO_NOTES_REF, 'create', { title })
    return typeof result.id === 'string' ? result.id : undefined
  },
  settle: () => todoNotesQuery.invalidate(),
})

export const renameTodoNote: Mutation<{ id: string; title: string }, string | undefined> = createMutation('todo.renameNote', {
  key: ({ id }) => id,
  optimistic: ({ id, title }) =>
    todoNotesQuery.patch(prev => prev && { notes: prev.notes.map(note => (note.id === id ? { ...note, title } : note)) }),
  run: async ({ id, title }) => {
    const result = await run(todoNoteRef(id), 'rename', { title })
    return typeof result.id === 'string' ? result.id : undefined
  },
  settle: () => todoNotesQuery.invalidate(),
})

export const deleteTodoNote: Mutation<{ id: string }, void> = createMutation('todo.deleteNote', {
  key: ({ id }) => id,
  optimistic: ({ id }) => todoNotesQuery.patch(prev => prev && { notes: prev.notes.filter(note => note.id !== id) }),
  run: async ({ id }) => { await run(todoNoteRef(id), 'delete', {}) },
  settle: (_result, { id }) => {
    todoNotesQuery.invalidate()
    todoDocumentFamily.drop(todoNoteRef(id))
  },
})

export const createTodoPlan: Mutation<{ sessionId: string; text: string }, void> = createMutation('todo.createPlan', {
  run: async ({ sessionId, text }) => { await run(todoSessionRef(sessionId), 'createPlan', { text }) },
  settle: (_result, { sessionId }) => todoDocumentFamily.invalidate(todoSessionRef(sessionId)),
})

/* ── 事实 → 标脏 ───────────────────────────────────────────────────────── */

/** 最近一次事实的来源(`app` = 经本后端写的;`external` = 文件监听器看到的)。编辑器据它决定闪不闪。 */
const lastOrigin = new Map<string, 'app' | 'external'>()

export function lastTodoChangeOrigin(ref: string): 'app' | 'external' | undefined {
  return lastOrigin.get(ref)
}

function onTodoFact(fact: ResourceEventFact): void {
  // 任何一份清单变了,已经搜过的词都可能换答案;没人看的格只标脏,不发请求。
  for (const key of todoSearchFamily.keys()) todoSearchFamily.invalidate(key)
  const origin = (fact.payload as { origin?: unknown } | undefined)?.origin
  if (origin === 'app' || origin === 'external') lastOrigin.set(fact.ref, origin)
  if (fact.ref === TODO_NOTES_REF) {
    todoNotesQuery.invalidate()
    // 监听器分不出是哪一份清单:清单这一族全部标脏(没人看的格不会发请求)。
    for (const key of todoDocumentFamily.keys()) if (key.startsWith('todo:note/')) {
      if (origin === 'app' || origin === 'external') lastOrigin.set(key, origin)
      todoDocumentFamily.invalidate(key)
    }
    return
  }
  if (fact.event === 'created' || fact.event === 'deleted') todoNotesQuery.invalidate()
  todoDocumentFamily.invalidate(fact.ref)
}

let openCount = 0
let unsubscribe: (() => void) | undefined

export async function openTodoSource(): Promise<void> {
  openCount += 1
  if (openCount > 1) return
  const port = await slot.get()
  await port.ready()
  if (openCount === 0) return
  unsubscribe?.()
  unsubscribe = port.onResourceEvent(TODO_SCHEME_PREFIX, onTodoFact)
}

export function closeTodoSource(): void {
  if (openCount > 0) openCount -= 1
  if (openCount > 0) return
  unsubscribe?.()
  unsubscribe = undefined
}

/** 挂着就活着。消费面(计划条、面板)各调一次,引用计数。 */
export function useTodoLive(): void {
  useEffect(() => {
    void openTodoSource()
    return () => closeTodoSource()
  }, [])
}

export function resetTodoSource(): void {
  openCount = 0
  unsubscribe?.()
  unsubscribe = undefined
  lastOrigin.clear()
  todoNotesQuery.reset()
  todoDocumentFamily.reset()
  todoSearchFamily.reset()
  createTodoNote.reset()
  renameTodoNote.reset()
  deleteTodoNote.reset()
  createTodoPlan.reset()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetTodoSource)
}
