/**
 * 权限授权账页域（`permission-grants`）—— 主线 T 批 3 迁入通用 RPC 通道。
 *
 * 批 1 把它记进「不可迁清单」第 2 类：server 侧的 `canRevokePermissionGrant` /
 * `resolveServerWorkspaceGrantRoot` 是**归属校验**，没有 request context 就没法
 * 判「这条 grant 是不是这个 owner 的」。批 3 的 `RpcDispatchContext` 补上输入。
 *
 * 契约本身与迁移前逐字一致（渲染层拿到的字段一个没变），只有一处**收紧**：
 * 夹紧宿主上 `list` / `clearWorkspace` 的 `userId` / `workspaceId` 以 context 为准，
 * 请求体里带的同名字段被忽略 —— 迁移前 server 也是这么做的（它压根不读请求体里
 * 的 owner 字段），只是那时这条规则写在 `apps/server/src/runtime.ts` 里。
 */
import type { PermissionGrant } from '@onething/core/permission'
import { defineRouter } from './router.js'

export type { PermissionGrant }

export interface ListPermissionGrantsRequest {
  sessionId?: string
  workspaceRoot?: string
  /** 未夹紧宿主（桌面）才生效；夹紧宿主以已认证的 context 为准。 */
  userId?: string
  /** 同上。 */
  workspaceId?: string
}

export interface ListPermissionGrantsResponse {
  success: boolean
  error?: string
  sessionGrants?: PermissionGrant[]
  workspaceGrants?: PermissionGrant[]
}

export interface RevokePermissionGrantRequest {
  id: string
}

export interface ClearSessionPermissionGrantsRequest {
  sessionId: string
}

export interface ClearWorkspacePermissionGrantsRequest {
  workspaceRoot: string
}

export interface PermissionGrantMutationResponse {
  success: boolean
  error?: string
}

export type PermissionGrantsRoutes = {
  list: { input: ListPermissionGrantsRequest; output: ListPermissionGrantsResponse }
  revoke: { input: RevokePermissionGrantRequest; output: PermissionGrantMutationResponse }
  clearSession: {
    input: ClearSessionPermissionGrantsRequest
    output: PermissionGrantMutationResponse
  }
  clearWorkspace: {
    input: ClearWorkspacePermissionGrantsRequest
    output: PermissionGrantMutationResponse
  }
}

export const permissionGrantsRouter = defineRouter<PermissionGrantsRoutes>('permissionGrants', [
  'list',
  'revoke',
  'clearSession',
  'clearWorkspace',
])
