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

/**
 * 账页上的一条 grant,外加一格**投影**:它属于哪个应用。
 *
 * `app` 不在核的 grant 形状里 —— 它是从 `pattern` 上读出来的,由
 * `rpc/domains/permission-grants.ts` 在返回前算一次。设置页「每个应用一格,能撤销」
 * 就是按这一格分组;缺席 = 这条 grant 不是应用级许可(一条具体路径、一个工具名、
 * 一串命令),照旧按原来的样子逐条列。
 */
export interface PermissionGrantProjection extends PermissionGrant {
  /** 应用级许可(pattern 形如 `<scheme>:*`)所属的资源命名空间。 */
  app?: string
}

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
  sessionGrants?: PermissionGrantProjection[]
  workspaceGrants?: PermissionGrantProjection[]
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
