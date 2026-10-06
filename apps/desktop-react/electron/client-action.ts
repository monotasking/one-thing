import path from 'node:path'
import type {
  BackendHostState,
  ClientAction,
  ClientActionDone,
  ClientActionResults,
  ShowOpenDialogProperty,
  ShowOpenDialogRequest,
  ShowOpenDialogResponse,
} from '@shared/contracts/client-action'

/**
 * **`host:client-action` 的主进程那一半**(第④步批 1,决策 D5 / D278;契约 `@shared/contracts/client-action`)。
 *
 * 渲染层要开一扇原生对话框、把网址交给系统浏览器、用默认程序打开一个路径、在访达里定位一个路径 —— 这四件
 * 从前经后端绕一圈(`dialog` / `shell` 两个 RPC 域 → 后端 → 宿主端口 → 这里)。它们只在用户的屏幕上发生,
 * 后端第④步要搬出 Electron 进程,所以改成渲染层经 preload 的一条 `invoke` 直接交给主进程。
 *
 * ── 为什么每一格都要在这里再校验一遍 ──────────────────────────────────────
 * 载荷来自渲染进程,而渲染进程里跑着一整台页面(以及它加载的一切)。这条口能做的事是「在这台机器上拉起
 * 浏览器 / 用默认程序执行一个文件」,所以判据住在**收件这一侧**,不信发件人:
 *  · `openExternal` 只放行 http(s) 与 mailto —— `file:` 与自定义 scheme 会拉起本机程序,那是 `openPath`
 *    的事,不该借这扇门进来;
 *  · `openPath` / `revealPath` 只收**绝对**路径(相对路径的意思取决于主进程此刻的 cwd,那不是调用方能
 *    说清楚的东西);
 *  · `showOpenDialog` 的 `properties` 只认契约里那四个词,`filters` 只认 `{ name, extensions[] }`;
 *  · 认不出的 `kind` 一律拒,不猜。
 *
 * 零 electron import:真正动手的那几下由 `main.ts` 以端口注入(`ClientActionPorts`),于是这只文件在
 * vitest(node)里跑得起来。
 */

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const DIALOG_PROPERTIES = new Set<ShowOpenDialogProperty>(['openFile', 'openDirectory', 'multiSelections', 'createDirectory'])

/** 主进程递进来的真动作(四下屏幕上的事 + 三下后端进程的事,后三下第④步批 2b 加)。 */
export interface ClientActionPorts {
  showOpenDialog(request: ShowOpenDialogRequest): Promise<ShowOpenDialogResponse>
  openExternal(url: string): Promise<void>
  /** Electron `shell.openPath` 的约定:resolve 空串 = 成功,非空串 = 失败原因。 */
  openPath(filePath: string): Promise<string>
  revealPath(filePath: string): void
  backendStatus(): BackendHostState
  /** 失败答一句为什么(别人起的 `server:start` 不归这台桌面重启)。 */
  restartBackend(): Promise<ClientActionDone>
  revealBackendLog(): void
}

/** 收件侧对载荷的判词:合规矩就是一个 `ClientAction`,不合就是一句为什么。 */
export function parseClientAction(raw: unknown): ClientAction | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'client action must be an object' }
  const value = raw as Record<string, unknown>
  switch (value.kind) {
    case 'openExternal': {
      if (typeof value.url !== 'string' || !value.url.trim()) return { error: 'url is required' }
      let protocol: string
      try {
        protocol = new URL(value.url).protocol
      } catch {
        return { error: 'url is not a valid absolute URL' }
      }
      if (!EXTERNAL_SCHEMES.has(protocol)) return { error: `scheme ${protocol} is not allowed` }
      return { kind: 'openExternal', url: value.url }
    }
    case 'openPath':
    case 'revealPath': {
      if (typeof value.path !== 'string' || !value.path) return { error: 'path is required' }
      if (!path.isAbsolute(value.path)) return { error: 'path must be absolute' }
      return { kind: value.kind, path: value.path }
    }
    case 'showOpenDialog': {
      const request = parseDialogRequest(value.request)
      return 'error' in request ? request : { kind: 'showOpenDialog', request }
    }
    // 后端那三下不收参数:地址、日志路径、要停的是哪一台,全由主进程自己知道,渲染层说不了也不该说。
    case 'backendStatus':
    case 'restartBackend':
    case 'revealBackendLog':
      return { kind: value.kind }
    default:
      return { error: `unknown client action ${JSON.stringify(value.kind)}` }
  }
}

function parseDialogRequest(raw: unknown): ShowOpenDialogRequest | { error: string } {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object') return { error: 'dialog request must be an object' }
  const value = raw as Record<string, unknown>
  const request: ShowOpenDialogRequest = {}
  if (value.properties !== undefined) {
    if (!Array.isArray(value.properties)) return { error: 'properties must be an array' }
    for (const property of value.properties) {
      if (!DIALOG_PROPERTIES.has(property as ShowOpenDialogProperty)) return { error: `unknown dialog property ${JSON.stringify(property)}` }
    }
    request.properties = value.properties as ShowOpenDialogProperty[]
  }
  if (value.title !== undefined) {
    if (typeof value.title !== 'string') return { error: 'title must be a string' }
    request.title = value.title
  }
  if (value.defaultPath !== undefined) {
    if (typeof value.defaultPath !== 'string') return { error: 'defaultPath must be a string' }
    request.defaultPath = value.defaultPath
  }
  if (value.filters !== undefined) {
    if (!Array.isArray(value.filters)) return { error: 'filters must be an array' }
    const filters: NonNullable<ShowOpenDialogRequest['filters']> = []
    for (const filter of value.filters) {
      const entry = filter as { name?: unknown; extensions?: unknown } | null
      if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.extensions)
        || !entry.extensions.every(ext => typeof ext === 'string')) {
        return { error: 'each filter needs a name and a list of extensions' }
      }
      filters.push({ name: entry.name, extensions: entry.extensions as string[] })
    }
    request.filters = filters
  }
  return request
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 跑一件。**永不抛**:不合规矩与动作失败都折成契约里的那一支结局(打开类 `{ ok:false, error }`;对话框
 * 答 `{ canceled: true, filePaths: [] }` —— 渲染层对「没开成」与「取消」走同一条退路)。
 */
export async function runClientAction(
  raw: unknown,
  ports: ClientActionPorts,
): Promise<ClientActionResults[keyof ClientActionResults]> {
  const action = parseClientAction(raw)
  const isDialog = (raw as { kind?: unknown } | null)?.kind === 'showOpenDialog'
  if ('error' in action) {
    return isDialog ? { canceled: true, filePaths: [] } : { ok: false, error: action.error } satisfies ClientActionDone
  }
  try {
    switch (action.kind) {
      case 'showOpenDialog':
        return await ports.showOpenDialog(action.request)
      case 'openExternal':
        await ports.openExternal(action.url)
        return { ok: true }
      case 'openPath': {
        const failure = await ports.openPath(action.path)
        return failure ? { ok: false, error: failure } : { ok: true }
      }
      case 'revealPath':
        ports.revealPath(action.path)
        return { ok: true }
      case 'backendStatus':
        return ports.backendStatus()
      case 'restartBackend':
        return await ports.restartBackend()
      case 'revealBackendLog':
        ports.revealBackendLog()
        return { ok: true }
    }
  } catch (error) {
    if (action.kind === 'showOpenDialog') return { canceled: true, filePaths: [] }
    if (action.kind === 'backendStatus') return { phase: 'idle', error: errorText(error) }
    return { ok: false, error: errorText(error) }
  }
}
