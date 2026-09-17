import {
  OnethingTodoPlanStore,
  OnethingTodoPlanWatcher,
  resolveOnethingTodoPlanDirectory,
  type TodoPlanChangedPayload,
  type TodoPlanContext,
  type TodoPlanDocument,
  type TodoPlanSnapshot,
  type TodoPlanUpdateRequest,
} from '@onething/runtime/todo-plan'
import { getSettings } from '../../stores/settings.js'
import { getOnethingStorePath } from '@onething/runtime/storage'
import { getCurrentBackendInstance } from '../../current.js'
import { getCurrentSessionId } from '../../stores/app-state.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('todo-plan')


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
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetTodoPlanHost(): void {
  hostPorts = {}
}

/**
 * 当前注入的端口。单槽端口的**串联**要靠它:A 期桌面内嵌 HTTP 面之后,
 * todo/plan 的变更既要走 IPC 给 renderer,又要走 SSE 给浏览器 —— 后来的那位
 * 必须先读到前一位再把自己叠上去,否则就是把宿主的接线覆盖掉。
 */
export function getTodoPlanHostPorts(): TodoPlanHostPorts {
  return hostPorts
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

/** 谁改的:`app` = 经这台后端的 store 自己写;`external` = 文件监听器看到的别人写(AI 的写文件工具、用户自己的编辑器)。 */
export type TodoPlanChangeOrigin = 'app' | 'external'
export type TodoPlanChangeListener = (payload: TodoPlanChangedPayload, origin: TodoPlanChangeOrigin) => void

/** One Backend owns the store's self-write cache and the watcher of that same store. */
export class TodoPlanRuntime {
  readonly store: OnethingTodoPlanStore
  readonly watcher: OnethingTodoPlanWatcher
  private disposed = false
  private readonly listeners = new Set<TodoPlanChangeListener>()

  /**
   * 订阅变更(`todo:` 资源 provider 用)。与宿主端口 `broadcastChanged` 并存而不是替代:
   * 端口是宿主的推送面(React 壳注入的是 null),这里是进程内的读者,**不经过宿主端口**,
   * 所以桌面 / server / CLI 三个宿主上资源事件的行为一致。
   */
  onChanged(listener: TodoPlanChangeListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(payload: TodoPlanChangedPayload, origin: TodoPlanChangeOrigin): void {
    if (this.disposed) return
    broadcast(payload)
    for (const listener of this.listeners) {
      try { listener(payload, origin) } catch (error) { log.error('todo plan change listener failed', {}, error) }
    }
  }

  constructor(private readonly options: { storePath: string; assertActive(): void }) {
    this.store = new OnethingTodoPlanStore({
      getConfiguredDirectory: () => {
        if (this.disposed) throw new Error('Todo runtime is disposed')
        return getSettings().general?.todoPlan?.directory
      },
      getDefaultStorePath: () => options.storePath,
      notifyChanged: payload => this.notify(payload, 'app'),
      revealDirectory: directory => {
        if (this.disposed) throw new Error('Todo runtime is disposed')
        return hostPorts.revealDirectory?.(directory)
      },
    })
    this.watcher = new OnethingTodoPlanWatcher({
      store: this.store,
      notifyChanged: payload => this.notify(payload, 'external'),
      onError: error => log.error('todo plan watch failed', {}, error),
    })
  }

  async start(): Promise<void> {
    this.options.assertActive()
    return this.watcher.start()
  }

  stop(): void { this.watcher.stop() }
  quiesce(): void { this.watcher.quiesce() }
  drain(): Promise<void> { return this.watcher.drain() }
  dispose(): void { this.disposed = true; this.listeners.clear(); this.watcher.quiesce() }
}

function getTodoPlanRuntime(): TodoPlanRuntime {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new Error('Todo runtime is not bound to a backend')
  return backend.todoPlans
}

export function getTodoPlanStore(): OnethingTodoPlanStore { return getTodoPlanRuntime().store }

/** 订阅当前装配的待办变更(带来源);返回退订。 */
export function onTodoPlanChanged(listener: TodoPlanChangeListener): () => void {
  return getTodoPlanRuntime().onChanged(listener)
}

export async function startTodoPlanWatcher(): Promise<void> {
  return getTodoPlanRuntime().start()
}

export function stopTodoPlanWatcher(): void {
  getTodoPlanRuntime().stop()
}

export function getTodoPlanDirectory(): string {
  const backend = getCurrentBackendInstance()
  if (backend) return backend.todoPlans.store.getDirectory()
  // Prompt composition also runs without an assembled Backend. Resolve only
  // the path there; no store, watcher, cache or writable fallback is created.
  return resolveOnethingTodoPlanDirectory(getOnethingStorePath(), getSettings().general?.todoPlan?.directory)
}

// The detached todo window has no session of its own — it is a view of whatever
// session is active in the main window. Only the host knows that, so callers
// that omit a session id mean "the active one" and get resolved here.
function resolveSessionId(sessionId?: string): string | undefined {
  return sessionId || getCurrentSessionId() || undefined
}

export function readTodoPlanSnapshot(context: TodoPlanContext = {}): Promise<TodoPlanSnapshot> {
  return readTodoPlanSnapshotForSession({ sessionId: resolveSessionId(context.sessionId) })
}

/** Read a target already resolved and authorized by an application entry. */
export function readTodoPlanSnapshotForSession(context: TodoPlanContext): Promise<TodoPlanSnapshot> {
  return getTodoPlanStore().readSnapshot(context)
}

export function createUserTodoNote(title: string, content?: string): Promise<TodoPlanDocument> {
  return getTodoPlanStore().createUserNote(title, content)
}

export function updateTodoPlanDocument(request: TodoPlanUpdateRequest): Promise<TodoPlanDocument> {
  return getTodoPlanStore().updateDocument({
    ...request,
    sessionId: resolveSessionId(request.sessionId),
  })
}

export function renameUserTodoNote(id: string, title: string): Promise<TodoPlanDocument> {
  return getTodoPlanStore().renameUserNote(id, title)
}

export function deleteUserTodoNote(id: string): Promise<void> {
  return getTodoPlanStore().deleteUserNote(id)
}

export function deleteSessionAiTodo(sessionId: string): Promise<void> {
  return getTodoPlanStore().deleteSessionAiTodo(sessionId)
}

// The detached todo window follows the active session, which it learns only by
// re-reading. 'all' is the payload that tells every view to reload.
export function notifyTodoPlanActiveSessionChanged(): void {
  broadcast({ scope: 'all' })
}

export function revealTodoPlanDirectory(): Promise<void> {
  return getTodoPlanStore().revealDirectory()
}

export function broadcastTodoPlanChanged(payload: TodoPlanChangedPayload): void {
  getTodoPlanStore().notifyChanged(payload)
}
