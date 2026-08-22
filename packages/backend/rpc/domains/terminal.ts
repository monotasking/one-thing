/**
 * terminal(真 PTY 终端)域 —— 结构债 P4 终态批 D2(用户拍板:「D2 terminal 迁 +
 * 能力位默认关」)。
 *
 * 替换掉两处镜像:`apps/electron/src/ipc/terminal.ts` 那只可移植的裸 `ipcMain`
 * 工厂,与 `@main/ipc/terminal.ts` 里对着它写的七条壳适配。搬完之后主进程那只
 * 文件只剩**广播注入**与**消费者掉线的 detach 边**两件真宿主的事。
 *
 * 服务本体一格没动:`@onething/runtime/terminal/service.wiring` 的
 * `getTerminalService()` 是懒单例(never constructed inside
 * `createOnethingBackend`),所以 CLI daemon 与 readonly server 仍然不会 load
 * node-pty —— 本域的 http 分叉(见下)保证了这一点不会因为「域挂上了」而破。
 *
 * 每条的错误包装逐字照搬旧 `@main/ipc/terminal.ts`:
 *  - `create` / `list` / `attach` 用 try/catch 折成结构化失败(`list` 额外带
 *    `terminals: []`);
 *  - `write` / `resize` / `kill` 直接调服务并恒回 `{ success: true }`(服务对
 *    未知 id 是 no-op,旧线也没有别的答案);
 *  - `ack` 从前是单向 `ipcRenderer.send` 无回执,搬到只有请求/响应面的 router
 *    上之后补一条空回执 `{ success: true }` —— 渲染侧本来就不等它。
 *
 * ## http 分叉:七条一律结构化拒绝
 *
 * 用户拍板「能力位默认关」:web 上的 `terminal` 能力位是 `false`,UI 因此不出现,
 * 这七条本就不会被调到。但桌面自己也挂着同一份 HTTP 面(A 期的内嵌 server),
 * 所以闸必须落在**知道 transport 的这一层**而不是渲染侧客户端 —— 否则任何拿到
 * Bearer 的浏览器都能在宿主机器上开一个真 shell,那是本仓权限模型里最大的一格。
 *
 * 拒绝是**结构化失败**,不是抛、不读盘、不碰服务:`getTerminalService()` 在
 * http 这一支上一次都不会被求值,所以 `server:start` / CLI daemon 依旧不 load
 * node-pty。`/api/capabilities` 也已如实 `terminal: false`。
 *
 * **将来放开 = 去掉这层分叉 + 给 server 接推送广播器,一处。** 推送(输出流)
 * 今天只有 Electron 那一个实现(`configureTerminalBroadcaster` 推 webContents);
 * server 侧要么把它串进一条 SSE、要么上 WS —— 在那之前放开请求面等于开了一个
 * 只能写不能读的终端,所以两件事必须一起做。
 */
import {
  getTerminalService,
} from '@onething/runtime/terminal/service.wiring'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { terminalRouter, type TerminalRoutes } from '@shared/ipc/terminal.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

/** 七条 http 拒绝共用的那一句话。 */
export const TERMINAL_DESKTOP_ONLY_ERROR =
  'Terminal is available on the desktop host only'

/** 终端要的是**宿主机器上**的那个 shell —— 网络那一侧一条都不给。 */
function isRemoteCaller(context: RpcDispatchContext): boolean {
  return context.transport === 'http'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const terminalRpcHandlers: RpcRouteHandlers<TerminalRoutes> = {
  async create(request, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return { success: true, terminal: getTerminalService().create(request ?? {}) }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async list(_input, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, terminals: [], error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return { success: true, terminals: getTerminalService().list() }
    } catch (error) {
      return { success: false, terminals: [], error: errorMessage(error) }
    }
  },
  async write(request, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().write(request.terminalId, request.data)
    return { success: true }
  },
  async resize(request, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().resize(request.terminalId, request.cols, request.rows)
    return { success: true }
  },
  async kill(request, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().kill(request.terminalId)
    return { success: true }
  },
  async attach(request, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return getTerminalService().attach(request.terminalId)
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async ack(payload, context = DESKTOP_RPC_CONTEXT) {
    if (isRemoteCaller(context)) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().ack(payload.terminalId, payload.bytes, payload.generation)
    return { success: true }
  },
}

export function registerTerminalRpcDomain(): () => void {
  return registerRouterHandlers(terminalRouter, terminalRpcHandlers)
}
