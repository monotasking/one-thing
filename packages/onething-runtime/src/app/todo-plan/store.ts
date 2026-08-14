import {
  OnethingTodoPlanStore,
  OnethingTodoPlanWatcher,
  type TodoPlanChangedPayload,
  type TodoPlanContext,
  type TodoPlanDocument,
  type TodoPlanSnapshot,
  type TodoPlanUpdateRequest,
} from '@onething/runtime/todo-plan'
import { getSettings } from '../stores/settings.js'
import { getStorePath } from '../stores/paths.js'
import { getCurrentSessionId } from '../stores/app-state.js'

/**
 * Host injection points. The Electron host broadcasts changes to its windows
 * and reveals the directory in Finder; headless hosts leave both unset.
 */
export interface TodoPlanHostPorts {
  broadcastChanged?: (payload: TodoPlanChangedPayload) => void
  revealDirectory?: (directory: string) => Promise<unknown> | unknown
}

let hostPorts: TodoPlanHostPorts = {}

export function configureTodoPlanHost(ports: TodoPlanHostPorts): void {
  hostPorts = ports
}

/**
 * 宿主到底有没有「在文件管理器里显示目录」这个能力。
 *
 * 端口没注入时 `revealTodoPlanDirectory()` 静默成功——那对内部调用没问题,但对
 * 一条要回给用户的 RPC 就是在撒谎(server 迁移前给的是明确的"此宿主不支持")。
 * 传输面统一之后由这个谓词把那句实话留住。
 */
export function canRevealTodoPlanDirectory(): boolean {
  return typeof hostPorts.revealDirectory === 'function'
}

function broadcast(payload: TodoPlanChangedPayload): void {
  hostPorts.broadcastChanged?.(payload)
}

export const todoPlanStore = new OnethingTodoPlanStore({
  getConfiguredDirectory: () => getSettings().general?.todoPlan?.directory,
  getDefaultStorePath: () => getStorePath(),
  notifyChanged: broadcast,
  revealDirectory: directory => hostPorts.revealDirectory?.(directory),
})

// The AI writes its todo with the ordinary write/edit tools, which do not go
// through this store, so the watcher is what tells the UI those edits happened.
const todoPlanWatcher = new OnethingTodoPlanWatcher({
  store: todoPlanStore,
  notifyChanged: broadcast,
  onError: error => console.error('[todo-plan] watch failed:', error),
})

export function startTodoPlanWatcher(): Promise<void> {
  return todoPlanWatcher.start()
}

export function stopTodoPlanWatcher(): void {
  todoPlanWatcher.stop()
}

export function getTodoPlanDirectory(): string {
  return todoPlanStore.getDirectory()
}

// The detached todo window has no session of its own — it is a view of whatever
// session is active in the main window. Only the host knows that, so callers
// that omit a session id mean "the active one" and get resolved here.
function resolveSessionId(sessionId?: string): string | undefined {
  return sessionId || getCurrentSessionId() || undefined
}

export function readTodoPlanSnapshot(context: TodoPlanContext = {}): Promise<TodoPlanSnapshot> {
  return todoPlanStore.readSnapshot({ sessionId: resolveSessionId(context.sessionId) })
}

export function createUserTodoNote(title: string, content?: string): Promise<TodoPlanDocument> {
  return todoPlanStore.createUserNote(title, content)
}

export function updateTodoPlanDocument(request: TodoPlanUpdateRequest): Promise<TodoPlanDocument> {
  return todoPlanStore.updateDocument({
    ...request,
    sessionId: resolveSessionId(request.sessionId),
  })
}

export function renameUserTodoNote(id: string, title: string): Promise<TodoPlanDocument> {
  return todoPlanStore.renameUserNote(id, title)
}

export function deleteUserTodoNote(id: string): Promise<void> {
  return todoPlanStore.deleteUserNote(id)
}

export function deleteSessionAiTodo(sessionId: string): Promise<void> {
  return todoPlanStore.deleteSessionAiTodo(sessionId)
}

// The detached todo window follows the active session, which it learns only by
// re-reading. 'all' is the payload that tells every view to reload.
export function notifyTodoPlanActiveSessionChanged(): void {
  broadcast({ scope: 'all' })
}

export function revealTodoPlanDirectory(): Promise<void> {
  return todoPlanStore.revealDirectory()
}

export function broadcastTodoPlanChanged(payload: TodoPlanChangedPayload): void {
  todoPlanStore.notifyChanged(payload)
}
