import { configureOnethingPermissionGrantStorage } from '@onething/runtime/permissions'
import {
  getOnethingPermissionsDir,
  readJsonFile,
  writeJsonFile,
} from '@onething/runtime/storage'
import { registerBuiltinCapabilities } from './capabilities.js'

let permissionGrantsConfigured = false

/** Explicit assembly step: grant storage paths + builtin capability set. */
export function configureAppPermissionGrants(): void {
  if (permissionGrantsConfigured) return
  permissionGrantsConfigured = true
  configureOnethingPermissionGrantStorage({
    getPermissionsDir: getOnethingPermissionsDir,
    readJsonFile,
    writeJsonFile,
  })
  registerBuiltinCapabilities()
}

export {
  addGrant,
  clearSessionGrants,
  clearWorkspaceGrants,
  configureOnethingPermissionGrantStorage,
  configurePermissionGrantFileStorage,
  configurePermissionGrantStorage,
  createPermissionGrantFileStorage,
  getPermissionWorkspaceGrantsPath,
  listSessionGrants,
  listWorkspaceGrants,
  matchGrant,
  resetPermissionGrantsForTests,
  revokeGrant,
} from '@onething/runtime/permissions'
export type {
  OnethingPermissionGrantStorageAdapters,
  PermissionGrant,
  PermissionGrantFileStorageAdapters,
  PermissionGrantInput,
  PermissionGrantMatchInput,
  PermissionGrantScope,
  PermissionGrantStorage,
  PermissionGrantWorkspaceFile,
} from '@onething/runtime/permissions'
