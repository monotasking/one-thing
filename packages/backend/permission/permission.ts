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
} from '@onething/backend/permission/permission-asks'
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
} from '@onething/backend/permission/permission-asks'
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
