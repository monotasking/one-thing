export type CoreToolPermissionGuard =
  | 'safe'
  | 'sandboxed'
  | 'internal-check'
  | 'permission-gated'
  | 'external'

export interface CoreToolPermissionGuardLike {
  id: string
  permissionGuard?: CoreToolPermissionGuard
}

export type CoreToolPermissionGuardPlan =
  | { allowed: true }
  | { allowed: false; message: string }

export const CORE_INJECTABLE_PERMISSION_GUARDS = new Set<CoreToolPermissionGuard>([
  'safe',
  'sandboxed',
  'internal-check',
  'permission-gated',
])

export const CORE_AUTO_EXECUTE_PERMISSION_GUARDS = new Set<CoreToolPermissionGuard>([
  'safe',
  'sandboxed',
  'internal-check',
  'permission-gated',
])

export function isInjectablePermissionGuard(guard: CoreToolPermissionGuard | undefined): boolean {
  return Boolean(guard && CORE_INJECTABLE_PERMISSION_GUARDS.has(guard))
}

export function isAutoExecutePermissionGuard(guard: CoreToolPermissionGuard | undefined): boolean {
  return Boolean(guard && CORE_AUTO_EXECUTE_PERMISSION_GUARDS.has(guard))
}

export function planToolPermissionGuardInjection(tool: CoreToolPermissionGuardLike): CoreToolPermissionGuardPlan {
  if (isInjectablePermissionGuard(tool.permissionGuard)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    message: `[ToolRegistry] Skipping tool without injectable permission guard: ${tool.id}`,
  }
}

export function planToolPermissionGuardAutoExecute(tool: CoreToolPermissionGuardLike): CoreToolPermissionGuardPlan {
  if (isAutoExecutePermissionGuard(tool.permissionGuard)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    message: `[ToolRegistry] Refusing autoExecute for tool without safe permission guard: ${tool.id}`,
  }
}
