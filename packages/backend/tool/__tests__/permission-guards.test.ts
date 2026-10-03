import { describe, expect, it } from 'vitest'
import {
  isAutoExecutePermissionGuard,
  isInjectablePermissionGuard,
  planToolPermissionGuardAutoExecute,
  planToolPermissionGuardInjection,
} from '../permission-guards.js'

describe('core tool permission guards', () => {
  it('allows locally guarded tools to be injected and auto-executed', () => {
    for (const guard of ['safe', 'sandboxed', 'internal-check', 'permission-gated'] as const) {
      expect(isInjectablePermissionGuard(guard)).toBe(true)
      expect(isAutoExecutePermissionGuard(guard)).toBe(true)
      expect(planToolPermissionGuardInjection({ id: `tool-${guard}`, permissionGuard: guard })).toEqual({
        allowed: true,
      })
      expect(planToolPermissionGuardAutoExecute({ id: `tool-${guard}`, permissionGuard: guard })).toEqual({
        allowed: true,
      })
    }
  })

  it('blocks opaque external tools from provider injection and auto execution', () => {
    expect(isInjectablePermissionGuard('external')).toBe(false)
    expect(isAutoExecutePermissionGuard('external')).toBe(false)
    expect(planToolPermissionGuardInjection({ id: 'remote-tool', permissionGuard: 'external' })).toEqual({
      allowed: false,
      message: '[ToolRegistry] Skipping tool without injectable permission guard: remote-tool',
    })
    expect(planToolPermissionGuardAutoExecute({ id: 'remote-tool', permissionGuard: 'external' })).toEqual({
      allowed: false,
      message: '[ToolRegistry] Refusing autoExecute for tool without safe permission guard: remote-tool',
    })
  })

  it('blocks tools without an explicit permission guard', () => {
    expect(isInjectablePermissionGuard(undefined)).toBe(false)
    expect(isAutoExecutePermissionGuard(undefined)).toBe(false)
    expect(planToolPermissionGuardInjection({ id: 'legacy-tool' })).toEqual({
      allowed: false,
      message: '[ToolRegistry] Skipping tool without injectable permission guard: legacy-tool',
    })
    expect(planToolPermissionGuardAutoExecute({ id: 'legacy-tool' })).toEqual({
      allowed: false,
      message: '[ToolRegistry] Refusing autoExecute for tool without safe permission guard: legacy-tool',
    })
  })
})
