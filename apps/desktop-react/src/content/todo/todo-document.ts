import { useEffect, useState } from 'react'
import { useQuery } from '../../data/kernel'
import { lastTodoChangeOrigin, submitTodoEdits, todoDocumentFamily, type TodoDocumentView } from '../../data/todo-source'
import { EditorDocument } from '../editing/editor-document'

/**
 * 一个 `todo:` 地址 → 一份编辑器文档(`EditorDocument`)。
 *
 * **同一个地址一份,按引用计数共享**:计划抽屉与清单面板、抽屉换宿主重挂,拿到的是同一份
 * 本地真相 —— 否则两处各攒一队行编辑,互相覆盖。最后一个使用者离开时先 flush 再丢。
 *
 * 后端那一份每到一次就交给文档(`receive`);最近一次事实若来自文件监听器(AI / 别的编辑器),
 * 文档把新出现的行记下,屏幕淡淡闪一下。
 */

interface Entry {
  document: EditorDocument
  users: number
}

const registry = new Map<string, Entry>()

/**
 * 每份文档上次滚到哪儿(计划抽屉关了再开、切会话回来、清单面板切走切回都接着看)。
 * 只在内存里:重启应用回到顶部是可以接受的,跨重启记它不值一格存档。
 */
const scrolls = new Map<string, number>()

export const todoScrollPorts = {
  read: (ref: string): number | undefined => scrolls.get(ref),
  write: (ref: string, top: number): void => { scrolls.set(ref, top) },
}

function acquire(ref: string, view: TodoDocumentView): EditorDocument {
  const existing = registry.get(ref)
  if (existing) {
    existing.users += 1
    return existing.document
  }
  const query = todoDocumentFamily.get(ref)
  const document = new EditorDocument(view.content, view.revision, {
    submit: (edits, baseRevision) => submitTodoEdits(ref, edits, baseRevision),
    requestReload: () => { void query.refetch() },
  })
  registry.set(ref, { document, users: 1 })
  return document
}

function release(ref: string): void {
  const entry = registry.get(ref)
  if (!entry) return
  entry.users -= 1
  if (entry.users > 0) return
  registry.delete(ref)
  void entry.document.dispose()
}

export interface TodoEditorDocumentState {
  readonly view: TodoDocumentView | undefined
  readonly document: EditorDocument | null
  readonly error: string | undefined
  readonly loading: boolean
}

export function useTodoEditorDocument(ref: string): TodoEditorDocumentState {
  const query = todoDocumentFamily.get(ref)
  const snapshot = useQuery(query)
  const view = snapshot.data
  const [document, setDocument] = useState<EditorDocument | null>(null)
  const ready = view !== undefined && view.exists

  useEffect(() => { void query.ensure() }, [query])

  useEffect(() => {
    if (!ready || !view) return undefined
    const doc = acquire(ref, view)
    setDocument(doc)
    return () => {
      setDocument(null)
      release(ref)
    }
    // 只在「有没有这份文档」变的时候换;内容更新走下面那条 receive。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ready])

  useEffect(() => {
    if (!document || !view || !view.exists) return
    document.receive(view.content, view.revision, lastTodoChangeOrigin(ref) === 'external')
  }, [document, view, ref])

  return { view, document, error: snapshot.error, loading: snapshot.phase === 'initial' || (snapshot.data === undefined && snapshot.inflight) }
}

export function resetTodoDocuments(): void {
  for (const entry of registry.values()) void entry.document.dispose()
  registry.clear()
  scrolls.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetTodoDocuments)
}
