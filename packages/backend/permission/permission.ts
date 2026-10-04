/**
 * permission —— 授权:工具调用前按效果判允许 / 询问 / 拒绝、授权记录(本次 / 会话 / 工作区)的落盘与撤销、
 * 待批的提问、无人值守的降级,以及「工具可读可写哪些根」的沙箱判据。
 *
 * 对外交出几类东西(各段按来源分组):授权运行时与授权记录的落盘;开给设置页的授权记录与待批读写;
 * 执行面(判、执行、无人值守);沙箱根与路径判据;以及进程里那一份 `Permission` 与几只装配口。
 * 依赖 session、settings、file、note、todo-plan、tool、agent-loop、storage、logging。
 */
export {
  OnethingPermissionRuntime,
  configureOnethingPermissionGrantStorage,
  configurePermissionGrantFileStorage,
  createPermissionGrantFileStorage,
  createOnethingPermissionRuntime,
  decideOnethingPermission,
  enforceOnethingPermissionPolicy,
  getPermissionWorkspaceGrantsPath,
} from './permission-runtime.js'
export {
  clearOnethingSessionPermissionGrants,
  clearOnethingSessionPermissionGrantsForIpc,
  clearOnethingWorkspacePermissionGrants,
  clearOnethingWorkspacePermissionGrantsForIpc,
  listOnethingPermissionGrants,
  listOnethingPermissionGrantsForIpc,
  revokeOnethingPermissionGrant,
  revokeOnethingPermissionGrantForIpc,
} from './permission-grants-presentation.js'
export {
  clearOnethingPermissionSession,
  clearOnethingPermissionSessionForIpc,
  getOnethingPendingPermissions,
  getOnethingPendingPermissionsForIpc,
} from './permission-session-presentation.js'
export type {
  OnethingPermissionGrantStorageAdapters,
  OnethingPermissionRuntimeOptions,
  PermissionGrantFileStorageAdapters,
  PermissionGrantWorkspaceFile,
} from './permission-runtime.js'
export type {
  ClearOnethingPermissionGrantsResult,
  ClearOnethingSessionPermissionGrantsOptions,
  ClearOnethingWorkspacePermissionGrantsOptions,
  ListOnethingPermissionGrantsOptions,
  ListOnethingPermissionGrantsResult,
  OnethingPermissionIpcLogger,
  RevokeOnethingPermissionGrantOptions,
  RevokeOnethingPermissionGrantResult,
} from './permission-grants-presentation.js'
export type {
  ClearOnethingPermissionSessionOptions,
  ClearOnethingPermissionSessionResult,
  GetOnethingPendingPermissionsOptions,
  GetOnethingPendingPermissionsResult,
  OnethingPermissionSessionIpcLogger,
} from './permission-session-presentation.js'
export {
  addGrant,
  clearSessionGrants,
  clearWorkspaceGrants,
  coversAll,
  isGrantableType,
  listCapabilities,
  registerCapability,
  resetCapabilitiesForTests,
  resolveCapability,
  rejectionFor,
  unregisterCapability,
  configurePermissionGrantStorage,
  listSessionGrants,
  findWorkspaceGrant,
  listWorkspaceGrants,
  matchGrant,
  resetPermissionGrantsForTests,
  revokeGrant,
} from './permission-asks.js'
export type {
  Capability,
  CapabilityAction,
  CapabilityAuthority,
  CapabilityRejection,
  CapabilityResolution,
  EnforcePermissionPolicyInput,
  PermissionBridge,
  PermissionEffect,
  PermissionGrantInput,
  PermissionGrantMatchInput,
  PermissionGrantOwner,
  PermissionGrantMatcher,
  PermissionGrantStorage,
  PermissionMetadata,
  PermissionPolicyDecision,
  PermissionPolicyInput,
  PermissionPolicyMode,
  PermissionPolicyResult,
  PermissionPreview,
} from './permission-asks.js'
// 授权的执行面(授权记录 + 无人值守 + 会话读面)与「工具可读可写哪些根」。越层清零 C7(2026-10-04)
// 从 `tool/access-control/` 搬来:前者就是 `decidePermission` / `enforcePermissionPolicy`,后者是同一个
// 问题的另一半;`configureSandboxHost` 宿主端口随它住在这里。
export {
  decidePermission,
  enforcePermissionPolicy,
  enforcePermissionPolicyRejectingUnanswered,
} from './permission-enforcement.js'
export {
  checkFileAccess,
  configureAppToolSandbox,
  configureSandboxHost,
  expandPath,
  findReadSandboxRootForPath,
  findSandboxRootForPath,
  getDefaultReadRoots,
  getDownloadsDirectory,
  getReadSandboxRoots,
  getSandboxBoundary,
  getSandboxRoots,
  isPathContained,
  resetSandboxHost,
  resolveToolPath,
  type CoreFileAccessTargetType,
  type SandboxHost,
} from './permission-sandbox-roots.js'

// 进程里那一份 `Permission`(带授权落盘)、授权落盘的装配、无人值守的标记、权限卡挂在哪条消息上(深层引用收口第四批补进入口)。
export { Permission } from './permission-with-grant-storage.js'
export { configureAppPermissionGrants } from './permission-grant-storage.js'
export { markHostUnattended, markSessionUnattended } from './permission-unattended.js'
export { resolvePermissionMessageAnchor } from './permission-message-anchor.js'
