import { IPC_CHANNELS } from '@shared/ipc.js'
import {
  addOnethingProjectDirForIpc,
  getOnethingProjectDirForIpc,
  listOnethingProjectDirsForIpc,
  removeOnethingProjectDirForIpc,
  updateOnethingProjectDirForIpc,
  type ProjectDirsAddRequest,
  type ProjectDirsGetRequest,
  type ProjectDirsListRequest,
  type ProjectDirsRemoveRequest,
  type ProjectDirsUpdateRequest,
} from '@onething/runtime/project-dirs'
import { getProjectsStore } from '@onething/runtime/project-dirs/store'
import { registerElectronProjectDirsIpcHandlers } from './project-dirs-controller.js'

export { registerElectronProjectDirsIpcHandlers } from './project-dirs-controller.js'
export type {
  ElectronIpcMainLike,
  ElectronProjectDirsIpcChannels,
  RegisterElectronProjectDirsIpcHandlersOptions,
} from './project-dirs-controller.js'

export function registerProjectDirsHandlers(): void {
  registerElectronProjectDirsIpcHandlers({
    channels: {
      list: IPC_CHANNELS.PROJECT_DIRS_LIST,
      get: IPC_CHANNELS.PROJECT_DIRS_GET,
      add: IPC_CHANNELS.PROJECT_DIRS_ADD,
      update: IPC_CHANNELS.PROJECT_DIRS_UPDATE,
      remove: IPC_CHANNELS.PROJECT_DIRS_REMOVE,
    },
    // 名册 per-space(批 B4):每件都按请求里的 `workspaceId` 取那个空间的 store,
    // 缺省 = default 空间(`getProjectsStore(undefined)` 就是老的那份)。
    listProjectDirs: (request: ProjectDirsListRequest) => {
      const store = getProjectsStore(request.workspaceId)
      return listOnethingProjectDirsForIpc({
        listEntries: () => store.list(),
        getProject: path => store.get(path),
      })
    },
    getProjectDir: (request: ProjectDirsGetRequest) => {
      return getOnethingProjectDirForIpc({
        request,
        getProject: path => getProjectsStore(request.workspaceId).get(path),
      })
    },
    addProjectDir: (request: ProjectDirsAddRequest) => {
      return addOnethingProjectDirForIpc({
        request,
        addProject: input => getProjectsStore(request.workspaceId).add(input),
      })
    },
    updateProjectDir: (request: ProjectDirsUpdateRequest) => {
      return updateOnethingProjectDirForIpc({
        request,
        updateProject: (path, patch) =>
          getProjectsStore(request.workspaceId).update(path, patch),
      })
    },
    removeProjectDir: (request: ProjectDirsRemoveRequest) => {
      return removeOnethingProjectDirForIpc({
        request,
        removeProject: path => getProjectsStore(request.workspaceId).remove(path),
      })
    },
    logger: console,
  })
}
