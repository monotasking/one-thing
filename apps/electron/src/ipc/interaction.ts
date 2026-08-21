import { ipcMain } from 'electron'

/**
 * 交互协议的 Electron IPC 注册工厂(claude-code-integration-v2 §4,E1)。
 *
 * 与 `ipc/permission.ts` 同一个形状:这一层只认「通道名 + 一个处理函数」,
 * 不认 `@onething/backend` —— 于是它可以在没有主进程的测试里被直接喂一个假 ipcMain。
 *
 * 请求体**整体透传**给处理函数(C3 纪律):这里不解构、不挑字段,协议加一格
 * 不需要来改这个文件。
 */

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronInteractionIpcChannels {
  respond: string
  getPending: string
}

export type ElectronInteractionSessionId = string

export interface RegisterElectronInteractionIpcHandlersOptions {
  channels: ElectronInteractionIpcChannels
  respond(request: unknown): unknown
  getPending(sessionId: ElectronInteractionSessionId): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronInteractionIpcHandlers(
  options: RegisterElectronInteractionIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.respond, (_event, request: unknown) => {
    return options.respond(request)
  })

  host.handle(options.channels.getPending, (_event, sessionId: ElectronInteractionSessionId) => {
    return options.getPending(sessionId)
  })
}
