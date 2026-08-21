/**
 * Permissions Module
 * Permission-related type definitions for IPC communication
 */

import { defineRouter } from './router.js'
import type { JsonObject } from '../json.js'

// Permission related types
export interface PermissionInfo {
  id: string
  type: string
  pattern?: string | string[]
  sessionId: string
  messageId: string
  callId?: string
  title: string
  metadata: JsonObject
  createdAt: number
  targetChannel?: string
  /** Working directory for persistent directory-level permissions */
  workingDirectory?: string
  userId?: string
  workspaceId?: string
  /**
   * 'actionable' — emitted prompt awaiting a response; 'queued' — waiting
   * behind the session's prompt queue (show a waiting state, no respond card).
   * Absent from older backends; treat as 'actionable'.
   */
  promptState?: 'actionable' | 'queued'
}

/**
 * Permission response types:
 * - 'once': Allow this single operation only (本次)
 * - 'session': Allow for the duration of this session (本会话)
 * - 'workdir': Permanently allow in this working directory (本工作目录)
 * - 'reject': Deny the operation
 */
export type PermissionResponse = 'once' | 'session' | 'workdir' | 'reject'

export interface PermissionRespondRequest {
  sessionId: string
  permissionId: string
  response: PermissionResponse
  /** Optional reason for rejection */
  rejectReason?: string
}

/**
 * permission(运行中的权限询问)域 —— 结构债 P4c 第四域。
 *
 * 两个方法,都读/清**引擎内存里的活状态**:`getPending` 拉一个会话当前挂着的
 * prompt(含 `promptState` 的排队位,重载后要靠它重建等待态),`clearSession`
 * 清同一份活状态。
 *
 * **应答不在这个域里**:`command:permission-respond` 走命令总线(EventBus),
 * 由 core 校验通道亲和性 —— 那是一条命令,不是一次 RPC。授权账页(列/撤/清)也
 * 不在这里,它是 `permissionGrants` 域(主线 T 批 3 迁的)。
 */
export interface PermissionSessionRequest {
  sessionId: string
}

export interface PermissionGetPendingResponse {
  success: boolean
  pending?: PermissionInfo[]
  error?: string
}

export interface PermissionClearSessionResponse {
  success: boolean
  error?: string
}

export type PermissionRoutes = {
  getPending: { input: PermissionSessionRequest; output: PermissionGetPendingResponse }
  clearSession: { input: PermissionSessionRequest; output: PermissionClearSessionResponse }
}

export const permissionRouter = defineRouter<PermissionRoutes>('permission', [
  'getPending',
  'clearSession',
])
