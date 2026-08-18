import { IPC_CHANNELS } from '@shared/ipc.js'
import {
  clearOnethingSpaceCredentialForIpc,
  createOnethingSpaceForIpc,
  getOnethingSpaceCredentialsForIpc,
  getOnethingSpaceOverlayForIpc,
  getOnethingSpaceProviderSettingsForIpc,
  setOnethingSpaceProviderSettingsForIpc,
  importOnethingSpaceCredentialsForIpc,
  listOnethingSpacesForIpc,
  removeOnethingSpaceForIpc,
  setOnethingSpaceCredentialForIpc,
  setOnethingSpaceCredentialPoolForIpc,
  setOnethingSpaceOverlayForIpc,
  updateOnethingSpaceForIpc,
  type SpacesClearCredentialRequest,
  type SpacesCreateRequest,
  type SpacesGetCredentialsRequest,
  type SpacesGetOverlayRequest,
  type SpacesGetProviderSettingsRequest,
  type SpacesSetProviderSettingsRequest,
  type SpacesImportCredentialsRequest,
  type SpacesRemoveRequest,
  type SpacesSetCredentialPoolRequest,
  type SpacesSetCredentialRequest,
  type SpacesSetOverlayRequest,
  type SpacesUpdateRequest,
} from '@onething/runtime/spaces'
import { readSpaceOverlay, writeSpaceOverlay } from '@onething/runtime/spaces/overlay'
import {
  createEmptySpaceProviderSettings,
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
} from '@onething/runtime/spaces/provider-settings'
import { getSpacesStore } from '@onething/runtime/spaces/store'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import { countSessionsInWorkspace } from '@onething/app/stores/sessions.js'
import {
  clearSpaceProviderCredential,
  getSpaceCredentialsSummary,
  importDefaultSpaceCredentials,
  setSpaceProviderCredential,
  setSpaceProviderCredentialPoolForRequest,
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
      getProviderSettings: IPC_CHANNELS.SPACES_GET_PROVIDER_SETTINGS,
      setProviderSettings: IPC_CHANNELS.SPACES_SET_PROVIDER_SETTINGS,
      getCredentials: IPC_CHANNELS.SPACES_GET_CREDENTIALS,
      setCredential: IPC_CHANNELS.SPACES_SET_CREDENTIAL,
      setCredentialPool: IPC_CHANNELS.SPACES_SET_CREDENTIAL_POOL,
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
    // 整套 provider 设置(C2):`workspaces/<id>/providers.json`。与 overlay 同
    // 一条纪律 —— 只对**已登记**的空间开放。缺文件 = 这个空间还是空的(无回落)。
    getSpaceProviderSettings: (request: SpacesGetProviderSettingsRequest) => {
      return getOnethingSpaceProviderSettingsForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        readProviderSettings: id => readSpaceProviderSettings(id) ?? createEmptySpaceProviderSettings(),
      })
    },
    setSpaceProviderSettings: (request: SpacesSetProviderSettingsRequest) => {
      return setOnethingSpaceProviderSettingsForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        writeProviderSettings: (id, ai) => writeSpaceProviderSettings(id, ai),
      })
    },
    // provider 凭证池(批 B3;C1 起 default 也走这条)。唯一还挡着默认空间的
    // 是「导入」—— 它就是导入的来源,导给自己是句废话。
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
        writeCredential: input => setSpaceProviderCredential(input),
      })
    },
    // 整池写(批 D):排序 + 删除 + 策略。密钥原文走上面那条 setCredential。
    setSpaceCredentialPool: (request: SpacesSetCredentialPoolRequest) => {
      return setOnethingSpaceCredentialPoolForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
        writePool: input => setSpaceProviderCredentialPoolForRequest(input),
      })
    },
    clearSpaceCredential: (request: SpacesClearCredentialRequest) => {
      return clearOnethingSpaceCredentialForIpc({
        request,
        hasSpace: id => getSpacesStore().list().some(space => space.id === id),
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
