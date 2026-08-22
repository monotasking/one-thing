/**
 * 工作区文件监视 —— 结构债 P4c 第八批。
 *
 * `watchStart` / `watchStop` 两条**请求面**随 `filesRouter` 迁到了通用 RPC 通道,
 * 而 router 今天没有推送面,所以变更事件仍旧由各宿主自己的推送通道发出去
 * (server 的 `GET /api/files/watch/events` SSE)。请求面与推送面因此需要一个
 * 共同的住处 —— 就是这个文件:**监视器登记簿住在装配层,两侧都指着它**。
 *
 * ## 作用域 = 沙箱根
 *
 * 从前这套登记簿住在 `server/runtime.ts` 的闭包里,按 `ownerKey(context)`
 * (`<uid>|<wid>`)分表。这里改按**沙箱根绝对路径**分表 —— 两者一一对应
 * (`ownerSandboxRoot(workspaceRoot, uid, wid)`),但沙箱根是域处理者手上本来
 * 就有的东西(`resolveRpcSandbox(context).root`),不需要再把 owner 身份透传
 * 一遍。server 那侧订阅时用同一个公式算出同一个键。
 *
 * ## 桌面不在这里
 *
 * 桌面(`transport:'ipc'`)的 `watchStart` / `watchStop` 走的是
 * `@onething/runtime/files` 那对**投影桩**(校验 root 之后回 `{success:true}`),
 * 迁移前 `@main/ipc/files.ts` 就是这么做的:全仓没有任何地方往
 * `FILE_WATCH_EVENT` 发过一条消息,桌面从来没有真的监视过。在这一批里给桌面
 * 装上真监视器会是一次**未经拍板的行为变化**(而且是一个没有消费者的
 * fs.watch 泄漏),所以不做 —— 逐条口径见 `rpc/domains/files.ts` 的表。
 */
import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isPathInside } from '../../rpc/sandbox.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('files.watch')

export interface WorkspaceFileChangedPayload {
  root: string
  path: string
  eventType: string
}

export type WorkspaceFileChangedHandler = (payload: WorkspaceFileChangedPayload) => void

/** `<沙箱根> → <被监视目录> → watcher`。 */
const watchersByScope = new Map<string, Map<string, FSWatcher>>()
/** `<沙箱根> → 订阅者`。 */
const handlersByScope = new Map<string, Set<WorkspaceFileChangedHandler>>()

function notify(scope: string, payload: WorkspaceFileChangedPayload): void {
  const handlers = handlersByScope.get(scope)
  if (!handlers) return
  for (const handler of handlers) handler(payload)
}

/**
 * 订阅某个沙箱根下的文件变更。返回退订函数。
 *
 * 语义与被替换掉的 `server/runtime.ts` 闭包版逐字一致:同一个作用域的订阅者
 * 共用一份监视器,最后一个订阅者走掉时只清订阅表 —— 监视器由 `watchStop` 关,
 * 因为「谁开的谁关」这条约定是 `watchStart` / `watchStop` 那对请求定的。
 */
export function subscribeWorkspaceFileChanged(
  scope: string,
  handler: WorkspaceFileChangedHandler,
): () => void {
  let handlers = handlersByScope.get(scope)
  if (!handlers) {
    handlers = new Set()
    handlersByScope.set(scope, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers?.delete(handler)
    if (handlers?.size === 0) handlersByScope.delete(scope)
  }
}

/**
 * 开始监视 `watchRoot`(**必须已经夹进沙箱**:夹紧是域处理者的事,这里只认
 * 已解析的绝对路径)。重复开同一个目录是幂等的。
 */
export async function startWorkspaceWatch(
  scope: string,
  watchRoot: string,
): Promise<{ success: boolean; error?: string }> {
  const rootStats = await stat(watchRoot).catch(() => null)
  if (!rootStats?.isDirectory()) {
    return { success: false, error: 'Workspace watch root must be an existing directory.' }
  }

  let watchers = watchersByScope.get(scope)
  if (!watchers) {
    watchers = new Map()
    watchersByScope.set(scope, watchers)
  }
  if (watchers.has(watchRoot)) return { success: true }

  const createWatcher = (recursive: boolean): FSWatcher =>
    watch(watchRoot, { recursive }, (eventType, fileName) => {
      const changedPath = typeof fileName === 'string' && fileName.length > 0
        ? resolve(watchRoot, fileName)
        : watchRoot
      // 二次夹紧:递归监视在 symlink 上可能报出根外的路径。
      if (!isPathInside(changedPath, scope)) return
      notify(scope, { root: watchRoot, path: changedPath, eventType: eventType || 'change' })
    })

  let watcher: FSWatcher
  try {
    watcher = createWatcher(true)
  } catch {
    watcher = createWatcher(false)
  }
  watcher.on('error', error => {
    log.warn('workspace watcher failed', { watchRoot }, error)
  })
  watchers.set(watchRoot, watcher)
  return { success: true }
}

/** 停止监视 `watchRoot`。没在监视也算成功(与旧 adapter 同义)。 */
export function stopWorkspaceWatch(
  scope: string,
  watchRoot: string,
): { success: boolean; error?: string } {
  const watchers = watchersByScope.get(scope)
  const watcher = watchers?.get(watchRoot)
  if (watcher) {
    watcher.close()
    watchers?.delete(watchRoot)
  }
  if (watchers?.size === 0) watchersByScope.delete(scope)
  return { success: true }
}

/** 关掉全部监视器 —— 宿主 shutdown 与测试用。 */
export function closeAllWorkspaceWatches(): void {
  for (const watchers of watchersByScope.values()) {
    for (const watcher of watchers.values()) watcher.close()
  }
  watchersByScope.clear()
  handlersByScope.clear()
}
