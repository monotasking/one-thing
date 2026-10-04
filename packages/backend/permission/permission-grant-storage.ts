// 功能内部只引兄弟文件、不引自家入口(D126;越层清零单 3 收口时从 `@onething/backend/permission` 改过来)。
import { configureOnethingPermissionGrantStorage, type OnethingPermissionGrantStorageAdapters } from './permission-runtime.js'
import {
  getOnethingPermissionsDir,
  readJsonFile,
  writeJsonFile,
} from '@onething/backend/storage'
import { registerBuiltinCapabilities } from './permission-capabilities.js'

let permissionGrantsConfigured = false

/** Explicit assembly step: grant storage paths + builtin capability set. */
export function configureAppPermissionGrants(): void {
  if (permissionGrantsConfigured) return
  permissionGrantsConfigured = true
  const permissionGrantStorageAdapters: OnethingPermissionGrantStorageAdapters = {
    getPermissionsDir: getOnethingPermissionsDir,
    readJsonFile,
    writeJsonFile,
  }
  configureOnethingPermissionGrantStorage(permissionGrantStorageAdapters)
  registerBuiltinCapabilities()
}

export {
  configureOnethingPermissionGrantStorage,
  configurePermissionGrantFileStorage,
  createPermissionGrantFileStorage,
  getPermissionWorkspaceGrantsPath,
} from './permission-runtime.js'
export {
  addGrant,
  clearSessionGrants,
  clearWorkspaceGrants,
  configurePermissionGrantStorage,
  listSessionGrants,
  findWorkspaceGrant,
  listWorkspaceGrants,
  matchGrant,
  resetPermissionGrantsForTests,
  revokeGrant,
} from './permission-asks.js'
export type {
  OnethingPermissionGrantStorageAdapters,
  PermissionGrantFileStorageAdapters,
  PermissionGrantWorkspaceFile,
} from './permission-runtime.js'
export type {
  PermissionGrantInput,
  PermissionGrantMatchInput,
  PermissionGrantStorage,
} from './permission-asks.js'
export type { PermissionGrant, PermissionGrantScope } from '@shared/permission/grant'
