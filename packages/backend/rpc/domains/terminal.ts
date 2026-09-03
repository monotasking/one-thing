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
 * node-pty —— 本域的宿主闸(见下)保证了这一点不会因为「域挂上了」而破。
 *
 * 每条的错误包装逐字照搬旧 `@main/ipc/terminal.ts`:
 *  - `create` / `list` / `attach` 用 try/catch 折成结构化失败(`list` 额外带
 *    `terminals: []`);
 *  - `write` / `resize` / `kill` 直接调服务并恒回 `{ success: true }`(服务对
 *    未知 id 是 no-op,旧线也没有别的答案);
 *  - `ack` 从前是单向 `ipcRenderer.send` 无回执,搬到只有请求/响应面的 router
 *    上之后补一条空回执 `{ success: true }` —— 渲染侧本来就不等它。
 *
 * ## 闸:这台宿主有没有终端输出通道(B1,不再问 transport)
 *
 * 闸的理由从来不是「远不远」,而是**只能写不能读的终端不如不开**:输出推送
 * (`configureTerminalBroadcaster`)今天只有 Electron 那一个实现,没有它,开出来的
 * shell 是个哑巴。从前这件事写成 `transport === 'http'`,于是同一台装了广播器的
 * 桌面,从自己的内嵌 HTTP 面问就被拒 —— 用传输回答了外设。
 *
 * B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2)改成问
 * `hasTerminalHost()`,也就是 `OnethingHostPorts.terminal` 那一格注没注入。
 * **上面那句「将来放开 = 去掉分叉 + 给 server 接广播器」现在是同一件事**:
 * 谁接了广播器谁就有终端,一处。
 *
 * 七条的拒绝逐字不变:结构化失败,不抛、不读盘、不碰服务 —— `getTerminalService()`
 * 在拒绝这一支上一次都不会被求值,所以 `server:start` / CLI daemon 依旧不 load
 * node-pty。安全性也没松:任何拿到 Bearer 的浏览器仍开不了宿主机器上的真 shell,
 * 因为那要求这台进程本来就装着一条能把输出送回去的通道。
 */
import {
  getTerminalService,
  hasTerminalHost,
} from '@onething/runtime/terminal/service.wiring'
import type { TerminalRoutes } from '@shared/ipc/terminal.js'
import type { RpcRouteHandlers } from '../registry.js'

/** 七条拒绝共用的那一句话(宿主没有终端输出通道时)。 */
export const TERMINAL_DESKTOP_ONLY_ERROR =
  'Terminal is available on the desktop host only'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const terminalRpcHandlers: RpcRouteHandlers<TerminalRoutes> = {
  async create(request) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return { success: true, terminal: getTerminalService().create(request ?? {}) }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async list() {
    if (!hasTerminalHost()) {
      return { success: false, terminals: [], error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return { success: true, terminals: getTerminalService().list() }
    } catch (error) {
      return { success: false, terminals: [], error: errorMessage(error) }
    }
  },
  async write(request) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().write(request.terminalId, request.data)
    return { success: true }
  },
  async resize(request) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().resize(request.terminalId, request.cols, request.rows)
    return { success: true }
  },
  async kill(request) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().kill(request.terminalId)
    return { success: true }
  },
  async attach(request) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    try {
      return getTerminalService().attach(request.terminalId)
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async ack(payload) {
    if (!hasTerminalHost()) {
      return { success: false, error: TERMINAL_DESKTOP_ONLY_ERROR }
    }
    getTerminalService().ack(payload.terminalId, payload.bytes, payload.generation)
    return { success: true }
  },
}

