/**
 * Todo / plan 的窗口面 IPC 工厂。数据面已迁到通用 RPC 通道（todoPlanRouter），
 * 这里只剩动窗口的那几条。
 */
import { ipcMain } from 'electron'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronTodoPlanIpcChannels {
  openWindow: string
  hideWindow: string
  toggleWindow: string
  setWindowPinned: string
  minimizeWindow: string
  zoomWindow: string
  dragWindow: string
}

export interface ElectronTodoPlanPinnedRequest {
  pinned: boolean
}

export interface RegisterElectronTodoPlanIpcHandlersOptions {
  channels: ElectronTodoPlanIpcChannels
  openWindow(request?: unknown): unknown
  hideWindow(request?: unknown): unknown
  toggleWindow(request?: unknown): unknown
  setWindowPinned(request: ElectronTodoPlanPinnedRequest): unknown
  minimizeWindow(request?: unknown): unknown
  zoomWindow(request?: unknown): unknown
  /**
   * 拖窗是**高频**通道:拖拽期间每帧一条 invoke(rAF 节流,其余时候一条不发)。
   * 刻意不走通用 RPC 的重封装 —— 那一层的信封与路由开销按帧摊是纯浪费。
   */
  dragWindow(request?: unknown): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronTodoPlanIpcHandlers(
  options: RegisterElectronTodoPlanIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.openWindow, (_event, request?: unknown) => {
    return options.openWindow(request)
  })

  host.handle(options.channels.hideWindow, (_event, request?: unknown) => {
    return options.hideWindow(request)
  })

  host.handle(options.channels.toggleWindow, (_event, request?: unknown) => {
    return options.toggleWindow(request)
  })

  host.handle(options.channels.setWindowPinned, (_event, request: ElectronTodoPlanPinnedRequest) => {
    return options.setWindowPinned(request)
  })

  host.handle(options.channels.minimizeWindow, (_event, request?: unknown) => {
    return options.minimizeWindow(request)
  })

  host.handle(options.channels.zoomWindow, (_event, request?: unknown) => {
    return options.zoomWindow(request)
  })

  host.handle(options.channels.dragWindow, (_event, request?: unknown) => {
    return options.dragWindow(request)
  })
}
