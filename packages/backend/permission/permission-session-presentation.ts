type MaybePromise<T> = T | Promise<T>

export interface OnethingPermissionSessionIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface GetOnethingPendingPermissionsOptions<TPending = unknown> {
  sessionId: string
  getPending(sessionId: string): MaybePromise<TPending[]>
}

export interface GetOnethingPendingPermissionsResult<TPending = unknown> {
  success: true
  pending: TPending[]
}

export async function getOnethingPendingPermissions<TPending = unknown>(
  options: GetOnethingPendingPermissionsOptions<TPending>,
): Promise<GetOnethingPendingPermissionsResult<TPending>> {
  return {
    success: true,
    pending: await options.getPending(options.sessionId),
  }
}

export async function getOnethingPendingPermissionsForIpc<TPending = unknown>(
  options: GetOnethingPendingPermissionsOptions<TPending> & { logger?: OnethingPermissionSessionIpcLogger },
): Promise<GetOnethingPendingPermissionsResult<TPending> | { success: false; error: string }> {
  try {
    return await getOnethingPendingPermissions(options)
  } catch (error) {
    return permissionSessionIpcError(options.logger, 'getting pending permissions', error, 'Failed to get pending permissions')
  }
}

export interface ClearOnethingPermissionSessionOptions {
  sessionId: string
  clearSession(sessionId: string): MaybePromise<void>
}

export interface ClearOnethingPermissionSessionResult {
  success: true
}

export async function clearOnethingPermissionSession(
  options: ClearOnethingPermissionSessionOptions,
): Promise<ClearOnethingPermissionSessionResult> {
  await options.clearSession(options.sessionId)
  return { success: true }
}

export async function clearOnethingPermissionSessionForIpc(
  options: ClearOnethingPermissionSessionOptions & { logger?: OnethingPermissionSessionIpcLogger },
): Promise<ClearOnethingPermissionSessionResult | { success: false; error: string }> {
  try {
    return await clearOnethingPermissionSession(options)
  } catch (error) {
    return permissionSessionIpcError(options.logger, 'clearing session', error, 'Failed to clear session')
  }
}

function permissionSessionIpcError(
  logger: OnethingPermissionSessionIpcLogger | undefined,
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
