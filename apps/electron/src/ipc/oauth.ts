import { ipcMain } from 'electron'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronOAuthIpcChannels {
  start: string
  callback: string
  devicePoll: string
  refresh: string
  status: string
  logout: string
}

export interface ElectronOAuthProviderRequest {
  providerId: string
  /**
   * 凭证写回目标(批 B6)。缺席 = 默认空间(`oauth-tokens.json`)。
   * 这一层只搬运,不解释 —— 归一在 `@onething/runtime/auth` 的
   * `normalizeCredentialTarget`(非法/默认 spaceId 一律落回 settings)。
   */
  spaceId?: string
  entryId?: string
  label?: string
}

export interface ElectronOAuthCallbackRequest extends ElectronOAuthProviderRequest {
  code: string
  state: string
}

export interface ElectronOAuthDevicePollRequest extends ElectronOAuthProviderRequest {
  deviceCode?: string
  flowId?: string
}

export interface RegisterElectronOAuthIpcHandlersOptions {
  channels: ElectronOAuthIpcChannels
  start(request: ElectronOAuthProviderRequest): unknown
  callback(request: ElectronOAuthCallbackRequest): unknown
  devicePoll(request: ElectronOAuthDevicePollRequest): unknown
  refresh(request: ElectronOAuthProviderRequest): unknown
  status(request: ElectronOAuthProviderRequest): unknown
  logout(request: ElectronOAuthProviderRequest): unknown
  ipcMain?: ElectronIpcMainLike
}

export function registerElectronOAuthIpcHandlers(
  options: RegisterElectronOAuthIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.start, (_event, request: ElectronOAuthProviderRequest) => {
    return options.start(request)
  })

  host.handle(options.channels.callback, (_event, request: ElectronOAuthCallbackRequest) => {
    return options.callback(request)
  })

  host.handle(options.channels.devicePoll, (_event, request: ElectronOAuthDevicePollRequest) => {
    return options.devicePoll(request)
  })

  host.handle(options.channels.refresh, (_event, request: ElectronOAuthProviderRequest) => {
    return options.refresh(request)
  })

  host.handle(options.channels.status, (_event, request: ElectronOAuthProviderRequest) => {
    return options.status(request)
  })

  host.handle(options.channels.logout, (_event, request: ElectronOAuthProviderRequest) => {
    return options.logout(request)
  })
}
