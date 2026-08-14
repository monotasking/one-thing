/**
 * Todo / plan 的窗口面 IPC 工厂。数据面已迁到通用 RPC 通道（todoPlanRouter），
 * 这里只剩四条动窗口的。
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
}
