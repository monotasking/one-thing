import path from 'node:path'
import {
  configurePermissionGrantStorage,
  decidePermission as decideCorePermission,
  enforcePermissionPolicy as enforceCorePermissionPolicy,
  matchGrant,
  type EnforcePermissionPolicyInput,
  type PermissionBridge,
  type PermissionGrant,
  type PermissionGrantMatcher,
  type PermissionGrantStorage,
  type PermissionPolicyInput,
  type PermissionPolicyResult,
} from '@onething/core/permission'

export interface PermissionGrantFileStorageAdapters {
  getPermissionsDir(): string
  readJsonFile<T>(filePath: string, defaultValue: T): T
  writeJsonFile<T>(filePath: string, data: T): void
}

export interface PermissionGrantWorkspaceFile {
  grants: PermissionGrant[]
}

// S2(I4-缝收口):interface 而不是 type alias —— tsserver 的 Go to Implementation
// 不跟随别名,写成 extends 之后装配层那两处注入才是这道口看得见的实现。
export interface OnethingPermissionGrantStorageAdapters extends PermissionGrantFileStorageAdapters {}

export function getPermissionWorkspaceGrantsPath(getPermissionsDir: () => string): string {
  return path.join(getPermissionsDir(), 'workspace-grants.json')
}

export function createPermissionGrantFileStorage(
  adapters: PermissionGrantFileStorageAdapters,
): PermissionGrantStorage {
  return {
    loadWorkspaceGrants() {
      return adapters.readJsonFile<PermissionGrantWorkspaceFile>(
        getPermissionWorkspaceGrantsPath(adapters.getPermissionsDir),
        { grants: [] },
      ).grants
    },
    saveWorkspaceGrants(grants) {
      adapters.writeJsonFile<PermissionGrantWorkspaceFile>(
        getPermissionWorkspaceGrantsPath(adapters.getPermissionsDir),
        { grants },
      )
    },
  }
}

export function configurePermissionGrantFileStorage(adapters: PermissionGrantFileStorageAdapters): void {
  configurePermissionGrantStorage(createPermissionGrantFileStorage(adapters))
}

export function configureOnethingPermissionGrantStorage(
  adapters: OnethingPermissionGrantStorageAdapters,
): void {
  configurePermissionGrantFileStorage(adapters)
}

export interface OnethingPermissionRuntimeOptions {
  grantMatcher?: PermissionGrantMatcher
  permissionBridge?: PermissionBridge
}

export class OnethingPermissionRuntime {
  constructor(private readonly options: OnethingPermissionRuntimeOptions = {}) {}

  decide(input: PermissionPolicyInput): PermissionPolicyResult {
    return decideCorePermission({
      ...input,
      grantMatcher: input.grantMatcher ?? this.options.grantMatcher ?? matchGrant,
    })
  }

  enforce(input: EnforcePermissionPolicyInput): Promise<void> {
    return enforceCorePermissionPolicy({
      ...input,
      grantMatcher: input.grantMatcher ?? this.options.grantMatcher ?? matchGrant,
      permissionBridge: input.permissionBridge ?? this.options.permissionBridge,
    })
  }
}

const defaultPermissionRuntime = new OnethingPermissionRuntime()

export function createOnethingPermissionRuntime(
  options: OnethingPermissionRuntimeOptions = {},
): OnethingPermissionRuntime {
  return new OnethingPermissionRuntime(options)
}

export function decideOnethingPermission(input: PermissionPolicyInput): PermissionPolicyResult {
  return defaultPermissionRuntime.decide(input)
}

export function enforceOnethingPermissionPolicy(input: EnforcePermissionPolicyInput): Promise<void> {
  return defaultPermissionRuntime.enforce(input)
}
