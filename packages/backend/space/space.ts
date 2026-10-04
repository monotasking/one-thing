/**
 * space:空间(workspace)是谁,以及每个空间自己的那几份数据。
 *
 * 一个空间有身份记录(id、名字、色点)和名册;每个空间在 store 里有一只目录,里面放它的
 * 服务商设置(`provider-settings.json`)与覆盖层(`overlay.json`,连接目录等按空间覆盖的设置)。
 * 这些读写都落在用户的 store 里,所以它是「能力」(L2),不是纯事实。
 *
 * 对外交出五类东西:
 *   1. 身份与名册:默认空间 id、id 合法性判据、名册单例与「空间被删」的订阅;
 *   2. 空间目录:某个空间的目录在哪、建目录(测试可改根目录);
 *   3. 覆盖层:读写覆盖层、取连接目录与合并连接目录;
 *   4. 服务商设置:读写、判空与空设置;
 *   5. 变更通知与凭证操作的请求 / 应答形状(类型)。
 *
 * 依赖:storage(store 目录)、logging。开给界面的操作在第二入口 `space-client-api.ts`,不经这里。
 * 只用具名导出,每个名字从声明它的那只文件转交。
 */

// 1. 身份与名册
export { DEFAULT_SPACE_ID, isValidSpaceId } from './space-types.js'
export { getSpacesStore, onSpaceRemoved } from './space-store.js'

// 2. 空间目录
export { ensureSpaceDir, setRootDirForTests, spaceDir } from './space-persistence.js'

// 3. 覆盖层
export {
  getSpaceOverlayConnectedDirectories,
  mergeConnectedDirectories,
  readSpaceOverlay,
  writeSpaceOverlay,
} from './space-overlay.js'
export type { SpaceOverlay } from './space-overlay.js'

// 4. 服务商设置
export {
  createEmptySpaceProviderSettings,
  hasSpaceProviderSettings,
  readSpaceProviderSettings,
  writeSpaceProviderSettings,
} from './space-provider-settings.js'
export type { SpaceProviderSettings } from './space-provider-settings.js'

// 5. 变更通知与凭证操作的形状
export { notifySpaceDataChanged } from './space-notifications.js'
export type {
  SpaceCredentialImportSkip,
  SpaceCredentialsSummary,
  SpacesClearCredentialRequest,
  SpacesSetCredentialPoolRequest,
  SpacesSetCredentialRequest,
} from './space-ipc-operations.js'
