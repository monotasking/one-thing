import { ipcMain } from 'electron'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

/**
 * 主线 T 批 3：授权账页那四条（listGrants / revokeGrant / clearSessionGrants /
 * clearWorkspaceGrants）已整只迁到通用 RPC 通道的 `permissionGrants` 域，连同
 * server 侧的归属校验一起收成一份实现。这里只剩**运行中**的权限询问那两条 ——
 * 它们与流式生命周期同呼吸，不属于账页。
 */
export interface ElectronPermissionIpcChannels {
  getPending: string
  clearSession: string
}

export type ElectronPermissionSessionId = string

export interface RegisterElectronPermissionIpcHandlersOptions {
  channels: ElectronPermissionIpcChannels
  getPending(sessionId: ElectronPermissionSessionId): unknown
  clearSession(sessionId: ElectronPermissionSessionId): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronPermissionIpcHandlers(
  options: RegisterElectronPermissionIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.getPending, (_event, sessionId: ElectronPermissionSessionId) => {
    return options.getPending(sessionId)
  })

  host.handle(options.channels.clearSession, (_event, sessionId: ElectronPermissionSessionId) => {
    return options.clearSession(sessionId)
  })
}
