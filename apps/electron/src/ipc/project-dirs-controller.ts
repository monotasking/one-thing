import { ipcMain } from 'electron'
import type {
  ProjectDirsAddRequest,
  ProjectDirsGetRequest,
  ProjectDirsListRequest,
  ProjectDirsRemoveRequest,
  ProjectDirsUpdateRequest,
} from '@onething/runtime/project-dirs'

export interface ElectronIpcMainLike {
  handle<TArgs extends unknown[]>(
    channel: string,
    listener: (event: unknown, ...args: TArgs) => unknown,
  ): void
}

export interface ElectronProjectDirsIpcChannels {
  list: string
  get: string
  add: string
  update: string
  remove: string
}

export interface RegisterElectronProjectDirsIpcHandlersOptions {
  channels: ElectronProjectDirsIpcChannels
  listProjectDirs(request: ProjectDirsListRequest): unknown
  getProjectDir(request: ProjectDirsGetRequest): unknown
  addProjectDir(request: ProjectDirsAddRequest): unknown
  updateProjectDir(request: ProjectDirsUpdateRequest): unknown
  removeProjectDir(request: ProjectDirsRemoveRequest): unknown
  ipcMain?: ElectronIpcMainLike
  logger?: Pick<Console, 'log'>
}

export function registerElectronProjectDirsIpcHandlers(
  options: RegisterElectronProjectDirsIpcHandlersOptions,
): void {
  const host = options.ipcMain ?? ipcMain

  host.handle(options.channels.list, (_event, request?: ProjectDirsListRequest) => {
    // 旧渲染层不带载荷 —— `{}` = 缺省空间,与批 B4 之前完全一致。
    return options.listProjectDirs(request ?? {})
  })

  host.handle(options.channels.get, (_event, request: ProjectDirsGetRequest) => {
    return options.getProjectDir(request)
  })

  host.handle(options.channels.add, (_event, request: ProjectDirsAddRequest) => {
    return options.addProjectDir(request)
  })

  host.handle(options.channels.update, (_event, request: ProjectDirsUpdateRequest) => {
    return options.updateProjectDir(request)
  })

  host.handle(options.channels.remove, (_event, request: ProjectDirsRemoveRequest) => {
    return options.removeProjectDir(request)
  })

  options.logger?.log('[project-dirs] IPC handlers registered (list/get/add/update/remove)')
}
