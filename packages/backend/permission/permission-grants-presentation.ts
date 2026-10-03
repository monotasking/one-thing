type MaybePromise<T> = T | Promise<T>

export interface OnethingPermissionIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface ListOnethingPermissionGrantsOptions<TGrant = unknown> {
  sessionId?: string
  workspaceRoot?: string
  userId?: string
  workspaceId?: string
  listSessionGrants(sessionId: string): MaybePromise<TGrant[]>
  listWorkspaceGrants(workspaceRoot: string, owner?: { userId?: string; workspaceId?: string }): MaybePromise<TGrant[]>
}

export interface ListOnethingPermissionGrantsResult<TGrant = unknown> {
  success: true
  sessionGrants: TGrant[]
  workspaceGrants: TGrant[]
}

export async function listOnethingPermissionGrants<TGrant = unknown>(
  options: ListOnethingPermissionGrantsOptions<TGrant>,
): Promise<ListOnethingPermissionGrantsResult<TGrant>> {
  const owner = ownerFromOptions(options)
  return {
    success: true,
    sessionGrants: options.sessionId
      ? await options.listSessionGrants(options.sessionId)
      : [],
    workspaceGrants: options.workspaceRoot
      ? owner
        ? await options.listWorkspaceGrants(options.workspaceRoot, owner)
        : await options.listWorkspaceGrants(options.workspaceRoot)
      : [],
  }
}

export async function listOnethingPermissionGrantsForIpc<TGrant = unknown>(
  options: ListOnethingPermissionGrantsOptions<TGrant> & { logger?: OnethingPermissionIpcLogger },
): Promise<ListOnethingPermissionGrantsResult<TGrant> | { success: false; error: string }> {
  try {
    return await listOnethingPermissionGrants(options)
  } catch (error) {
    return permissionIpcError(options.logger, 'list permission grants', error, 'Failed to list permission grants')
  }
}

export interface RevokeOnethingPermissionGrantOptions {
  id: string
  revokeGrant(id: string): MaybePromise<boolean>
}

export interface RevokeOnethingPermissionGrantResult {
  success: boolean
}

export async function revokeOnethingPermissionGrant(
  options: RevokeOnethingPermissionGrantOptions,
): Promise<RevokeOnethingPermissionGrantResult> {
  return {
    success: await options.revokeGrant(options.id),
  }
}

export async function revokeOnethingPermissionGrantForIpc(
  options: RevokeOnethingPermissionGrantOptions & { logger?: OnethingPermissionIpcLogger },
): Promise<RevokeOnethingPermissionGrantResult | { success: false; error: string }> {
  try {
    return await revokeOnethingPermissionGrant(options)
  } catch (error) {
    return permissionIpcError(options.logger, 'revoke permission grant', error, 'Failed to revoke permission grant')
  }
}

export interface ClearOnethingSessionPermissionGrantsOptions {
  sessionId: string
  clearSessionGrants(sessionId: string): MaybePromise<void>
}

export interface ClearOnethingWorkspacePermissionGrantsOptions {
  workspaceRoot: string
  userId?: string
  workspaceId?: string
  clearWorkspaceGrants(workspaceRoot: string, owner?: { userId?: string; workspaceId?: string }): MaybePromise<void>
}

export interface ClearOnethingPermissionGrantsResult {
  success: true
}

export async function clearOnethingSessionPermissionGrants(
  options: ClearOnethingSessionPermissionGrantsOptions,
): Promise<ClearOnethingPermissionGrantsResult> {
  await options.clearSessionGrants(options.sessionId)
  return { success: true }
}

export async function clearOnethingSessionPermissionGrantsForIpc(
  options: ClearOnethingSessionPermissionGrantsOptions & { logger?: OnethingPermissionIpcLogger },
): Promise<ClearOnethingPermissionGrantsResult | { success: false; error: string }> {
  try {
    return await clearOnethingSessionPermissionGrants(options)
  } catch (error) {
    return permissionIpcError(options.logger, 'clear session grants', error, 'Failed to clear session grants')
  }
}

export async function clearOnethingWorkspacePermissionGrants(
  options: ClearOnethingWorkspacePermissionGrantsOptions,
): Promise<ClearOnethingPermissionGrantsResult> {
  const owner = ownerFromOptions(options)
  if (owner) {
    await options.clearWorkspaceGrants(options.workspaceRoot, owner)
  } else {
    await options.clearWorkspaceGrants(options.workspaceRoot)
  }
  return { success: true }
}

function ownerFromOptions(options: { userId?: string; workspaceId?: string }): { userId?: string; workspaceId?: string } | undefined {
  return options.userId || options.workspaceId
    ? { userId: options.userId, workspaceId: options.workspaceId }
    : undefined
}

export async function clearOnethingWorkspacePermissionGrantsForIpc(
  options: ClearOnethingWorkspacePermissionGrantsOptions & { logger?: OnethingPermissionIpcLogger },
): Promise<ClearOnethingPermissionGrantsResult | { success: false; error: string }> {
  try {
    return await clearOnethingWorkspacePermissionGrants(options)
  } catch (error) {
    return permissionIpcError(options.logger, 'clear workspace grants', error, 'Failed to clear workspace grants')
  }
}

function permissionIpcError(
  logger: OnethingPermissionIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Permission IPC] Error ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
