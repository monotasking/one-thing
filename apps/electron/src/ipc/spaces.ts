import { IPC_CHANNELS } from '@shared/ipc.js'
import {
  clearOnethingSpaceCredentialForIpc,
  createOnethingSpaceForIpc,
  getOnethingSpaceCredentialsForIpc,
  getOnethingSpaceOverlayForIpc,
  importOnethingSpaceCredentialsForIpc,
  listOnethingSpacesForIpc,
  removeOnethingSpaceForIpc,
  setOnethingSpaceCredentialForIpc,
  setOnethingSpaceOverlayForIpc,
  updateOnethingSpaceForIpc,
  type SpacesClearCredentialRequest,
  type SpacesCreateRequest,
  type SpacesGetCredentialsRequest,
  type SpacesGetOverlayRequest,
  type SpacesImportCredentialsRequest,
  type SpacesRemoveRequest,
  type SpacesSetCredentialRequest,
  type SpacesSetOverlayRequest,
  type SpacesUpdateRequest,
} from '@onething/runtime/spaces'
import { readSpaceOverlay, writeSpaceOverlay } from '@onething/runtime/spaces/overlay'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { countSessionsInWorkspace } from '@onething/app/stores/sessions.js'
import {
  clearSpaceProviderCredential,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  setSpaceProviderCredential,
} from '@onething/app/providers/space-credentials.js'
import { registerElectronSpacesIpcHandlers } from './spaces-controller.js'

export { registerElectronSpacesIpcHandlers } from './spaces-controller.js'
export type {
  ElectronIpcMainLike,
  ElectronSpacesIpcChannels,
  RegisterElectronSpacesIpcHandlersOptions,
} from './spaces-controller.js'

export function registerSpacesHandlers(): void {
  registerElectronSpacesIpcHandlers({
    channels: {
      list: IPC_CHANNELS.SPACES_LIST,
      create: IPC_CHANNELS.SPACES_CREATE,
      update: IPC_CHANNELS.SPACES_UPDATE,
      remove: IPC_CHANNELS.SPACES_REMOVE,
      getOverlay: IPC_CHANNELS.SPACES_GET_OVERLAY,
      setOverlay: IPC_CHANNELS.SPACES_SET_OVERLAY,
      getCredentials: IPC_CHANNELS.SPACES_GET_CREDENTIALS,
      setCredential: IPC_CHANNELS.SPACES_SET_CREDENTIAL,
      clearCredential: IPC_CHANNELS.SPACES_CLEAR_CREDENTIAL,
      importCredentials: IPC_CHANNELS.SPACES_IMPORT_CREDENTIALS,
    },
    listSpaces: () => {
      return listOnethingSpacesForIpc({ listSpaces: () => getSpacesStore().list() })
    },
    createSpace: (request: SpacesCreateRequest) => {
      return createOnethingSpaceForIpc({
        request,
        createSpace: input => getSpacesStore().create(input),
      })
    },
    updateSpace: (request: SpacesUpdateRequest) => {
      return updateOnethingSpaceForIpc({
        request,
        updateSpace: (id, patch) => getSpacesStore().update(id, patch),
      })
    },
    removeSpace: (request: SpacesRemoveRequest) => {
      return removeOnethingSpaceForIpc({
        request,
        // 「只删空的」的占用统计:spaces store 不认识会话,由这里注入。
        countSessions: spaceId => countSessionsInWorkspace(spaceId),
        removeSpace: (id, opts) => getSpacesStore().remove(id, opts),
      })
    },
    // overlay 落在 `workspaces/<id>/space.json`,只对**已登记**的空间开放 ——
    // 否则一个手滑的 id 会在 workspaces/ 下长出一个没有主人的目录。
    getSpaceOverlay: (request: SpacesGetOverlayRequest) => {
      return getOnethingSpaceOverlayForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        readOverlay: id => readSpaceOverlay(id),
      })
    },
    setSpaceOverlay: (request: SpacesSetOverlayRequest) => {
      return setOnethingSpaceOverlayForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        writeOverlay: (id, overlay) => writeSpaceOverlay(id, overlay),
      })
    },
    // provider 凭证池(批 B3)。默认空间一律拒绝:它的凭证层就是 settings.ai,
    // 往 credentials.json 里再写一份等于造第二份真相。
    getSpaceCredentials: (request: SpacesGetCredentialsRequest) => {
      return getOnethingSpaceCredentialsForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        readCredentials: id => getSpaceCredentialsSummary(id),
      })
    },
    setSpaceCredential: (request: SpacesSetCredentialRequest) => {
      return setOnethingSpaceCredentialForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        isDefaultSpace: id => id === DEFAULT_SPACE_ID,
        writeCredential: input => setSpaceProviderCredential(input),
      })
    },
    clearSpaceCredential: (request: SpacesClearCredentialRequest) => {
      return clearOnethingSpaceCredentialForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        isDefaultSpace: id => id === DEFAULT_SPACE_ID,
        clearCredential: input => clearSpaceProviderCredential(input),
      })
    },
    importSpaceCredentials: (request: SpacesImportCredentialsRequest) => {
      return importOnethingSpaceCredentialsForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        isDefaultSpace: id => id === DEFAULT_SPACE_ID,
        importCredentials: id => importDefaultSpaceCredentials(id),
      })
    },
    logger: console,
  })
}
