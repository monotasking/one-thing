import { ipcMain } from 'electron'
import type {
  SpacesClearCredentialRequest,
  SpacesCreateRequest,
  SpacesGetCredentialsRequest,
  SpacesGetOverlayRequest,
  SpacesImportCredentialsRequest,
  SpacesRemoveRequest,
  SpacesSetCredentialPoolRequest,
  SpacesSetCredentialRequest,
  SpacesSetOverlayRequest,
  SpacesGetProviderSettingsRequest,
  SpacesSetProviderSettingsRequest,
  SpacesUpdateRequest,
} from '@onething/runtime/spaces'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronSpacesIpcChannels {
  list: string
  create: string
  update: string
  remove: string
  getOverlay: string
  setOverlay: string
  getProviderSettings: string
  setProviderSettings: string
  getCredentials: string
  setCredential: string
  setCredentialPool: string
  clearCredential: string
  importCredentials: string
}

export interface RegisterElectronSpacesIpcHandlersOptions {
  channels: ElectronSpacesIpcChannels
  listSpaces(): unknown
  createSpace(request: SpacesCreateRequest): unknown
  updateSpace(request: SpacesUpdateRequest): unknown
  removeSpace(request: SpacesRemoveRequest): unknown
  getSpaceOverlay(request: SpacesGetOverlayRequest): unknown
  setSpaceOverlay(request: SpacesSetOverlayRequest): unknown
  getSpaceProviderSettings(request: SpacesGetProviderSettingsRequest): unknown
  setSpaceProviderSettings(request: SpacesSetProviderSettingsRequest): unknown
  getSpaceCredentials(request: SpacesGetCredentialsRequest): unknown
  setSpaceCredential(request: SpacesSetCredentialRequest): unknown
  setSpaceCredentialPool(request: SpacesSetCredentialPoolRequest): unknown
  clearSpaceCredential(request: SpacesClearCredentialRequest): unknown
  importSpaceCredentials(request: SpacesImportCredentialsRequest): unknown
  ipcMain?: ElectronIpcMainLike
  logger?: Pick<Console, 'log'>
}

export function registerElectronSpacesIpcHandlers(
  options: RegisterElectronSpacesIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.list, () => {
    return options.listSpaces()
  })

  host.handle(options.channels.create, (_event, request: SpacesCreateRequest) => {
    return options.createSpace(request)
  })

  host.handle(options.channels.update, (_event, request: SpacesUpdateRequest) => {
    return options.updateSpace(request)
  })

  host.handle(options.channels.remove, (_event, request: SpacesRemoveRequest) => {
    return options.removeSpace(request)
  })

  host.handle(options.channels.getOverlay, (_event, request: SpacesGetOverlayRequest) => {
    return options.getSpaceOverlay(request)
  })

  host.handle(options.channels.getProviderSettings, (_event, request: SpacesGetProviderSettingsRequest) => {
    return options.getSpaceProviderSettings(request)
  })

  host.handle(options.channels.setProviderSettings, (_event, request: SpacesSetProviderSettingsRequest) => {
    return options.setSpaceProviderSettings(request)
  })

  host.handle(options.channels.setOverlay, (_event, request: SpacesSetOverlayRequest) => {
    return options.setSpaceOverlay(request)
  })

  host.handle(options.channels.getCredentials, (_event, request: SpacesGetCredentialsRequest) => {
    return options.getSpaceCredentials(request)
  })

  host.handle(options.channels.setCredential, (_event, request: SpacesSetCredentialRequest) => {
    return options.setSpaceCredential(request)
  })

  host.handle(
    options.channels.setCredentialPool,
    (_event, request: SpacesSetCredentialPoolRequest) => {
      return options.setSpaceCredentialPool(request)
    },
  )

  host.handle(options.channels.clearCredential, (_event, request: SpacesClearCredentialRequest) => {
    return options.clearSpaceCredential(request)
  })

  host.handle(
    options.channels.importCredentials,
    (_event, request: SpacesImportCredentialsRequest) => {
      return options.importSpaceCredentials(request)
    },
  )

  options.logger?.log(
    '[spaces] IPC handlers registered (list/create/update/remove/overlay/credentials)',
  )
}
