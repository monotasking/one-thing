import type { JsonObject } from '../json.js'

/**
 * 一条常驻授权的形状。
 *
 * 它是 `permissionGrants` RPC 域(`@shared/ipc/permission-grants.ts`)的载荷;授权的
 * 存取、匹配与签发住在后端 `packages/core/permission/permission-grants.ts`(那边要用
 * `node:crypto` / `node:path`),从这里取形状。
 */
export type PermissionGrantScope = 'session' | 'workspace'

export interface PermissionGrant {
  id: string
  scope: PermissionGrantScope
  type: string
  pattern: string | string[]
  sessionId?: string
  workspaceRoot?: string
  userId?: string
  workspaceId?: string
  createdAt: number
  updatedAt: number
  createdFrom: {
    messageId: string
    toolCallId?: string
    title: string
  }
  metadata?: JsonObject
  revokedAt?: number
}
