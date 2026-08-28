/**
 * `permissionGrants` 域 —— 主线 T 批 3 的第二个「带 context 的安全域」。
 *
 * 迁移前横穿五处：`channels.ts` 四个常量、`@main/ipc/permission.ts` 四个
 * handler、`preload/bridge.ts`、`platform/web.ts`、`apps/server` 的四条 HTTP 路由
 * + `canRevokePermissionGrant` / `resolveServerWorkspaceGrantRoot` 两个归属校验。
 *
 * 护栏的实质是**归属**而不是路径：一条 grant 要么挂在某个会话上，要么挂在某个
 * 工作区根上。夹紧宿主要回答的是「这条 grant 属于本次请求的 owner 吗」。
 * 未夹紧宿主（桌面）只有一个 owner，答案恒为是 —— 与迁移前 `@main` handler
 * 逐字同义（它压根不做归属判断）。
 *
 * **与迁移前 server 的一处收紧**（有意为之，写在这里以免日后被当成 bug）：
 * 旧的 `canRevokePermissionGrant` 会把「未盖章会话」的默认 owner 沙箱根
 * （`<base>/local-user/default`）也放进候选根集合。那意味着一个非默认 owner
 * 只要恰好持有一个未盖章会话，就能撤掉默认 owner 名下的工作区 grant ——
 * 跨 owner 的读写面。这里不再补那个根：候选根 = 本 owner 沙箱根 ∪ 自己会话的
 * workingDirectory。单用户 server（唯一的生产形态）下 context 就是默认 owner，
 * 沙箱根本来就等于那个根，行为一字不变；多 owner 下这是修洞不是回归。
 */
import {
  clearOnethingSessionPermissionGrantsForIpc,
  clearOnethingWorkspacePermissionGrantsForIpc,
  listOnethingPermissionGrantsForIpc,
  revokeOnethingPermissionGrantForIpc,
} from '@onething/runtime/permissions'
import type { PermissionGrantsRoutes } from '@shared/ipc/permission-grants.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import * as PermissionGrants from '../../wiring/permission/permission-grants.js'
import { getSessionsList } from '../../stores/sessions.js'
import { resolveInsideSandbox, resolveRpcSandbox, type RpcSandbox } from '../sandbox.js'
import type { RpcRouteHandlers } from '../registry.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingPermissionIpcLogger } from '@onething/runtime/permissions/permission-grants-presentation'
import type { PermissionGrant } from '@onething/core/permission'
import type { ListOnethingPermissionGrantsOptions } from '@onething/runtime/permissions/permission-grants-presentation'

const log = getLogger('ipc.permission')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingPermissionIpcLogger = consolePort(log)


const WORKSPACE_ROOT_OUTSIDE_SANDBOX =
  'Workspace root must stay inside the workspace sandbox root.'
const SESSION_NOT_FOUND = 'Session not found'
const GRANT_NOT_FOUND = 'Permission grant not found'

/**
 * 会话索引里的所有权字段。共享的 `SessionMeta` 不声明它们 —— 它们是
 * `apps/server` 的 `saveSessionImmediately` 往 index.json 上盖的章，桌面上根本
 * 不存在。所以这里按「可能缺席的额外字段」读，而不是改 `SessionMeta`：让一个
 * 单用户桌面产品的核心类型长出多租户字段，比在这里多写一行 cast 更贵。
 */
type OwnedSessionMeta = {
  id: string
  /** @deprecated 存量租户 userId(只读兼容;新写走 ownerUserId)。 */
  userId?: string
  /**
   * 服务端租户两格。**产品空间 `workspaceId` 不在这里** —— 把空间当归属正是
   * `docs/audit/web-lane-sse-diagnosis-2026-08-28.md` 第五节那条 bug。
   */
  ownerUserId?: string
  ownerWorkspaceId?: string
  workingDirectory?: string
}

/**
 * 本次请求 owner 名下的会话。
 *
 * 判据与迁移前 server 的 `ownsSessionMeta` 逐字同义：**未盖章的会话属于所有人**
 * （存量数据没有 owner 字段，拒掉它们等于让老会话的权限账页整个消失），盖了章的
 * 必须两个字段都对上。
 */
function listOwnedSessions(context: RpcDispatchContext): OwnedSessionMeta[] {
  const metas = getSessionsList() as unknown as OwnedSessionMeta[]
  return metas.filter(meta => {
    // 租户两格;存量只回落 `userId`(它历来只由服务端盖)。缺席的一格不参与比较。
    const ownerUserId = meta.ownerUserId ?? meta.userId
    const ownerWorkspaceId = meta.ownerWorkspaceId
    if (!ownerUserId && !ownerWorkspaceId) return true
    return (ownerUserId ?? context.ownerUid) === context.ownerUid
      && (ownerWorkspaceId ?? context.workspaceId) === context.workspaceId
  })
}

/** 夹紧宿主上 owner 一律以 context 为准；未夹紧宿主沿用请求体（桌面语义）。 */
function grantOwner(
  sandbox: RpcSandbox,
  context: RpcDispatchContext,
  request: { userId?: string; workspaceId?: string },
): { userId?: string; workspaceId?: string } {
  if (!sandbox.confined) return { userId: request.userId, workspaceId: request.workspaceId }
  return { userId: context.ownerUid, workspaceId: context.workspaceId }
}

function ownsSession(context: RpcDispatchContext, sessionId: string): boolean {
  return listOwnedSessions(context).some(meta => meta.id === sessionId)
}

/**
 * 这条 grant 是本次请求的 owner 能碰的吗。
 *
 * 未夹紧恒真。夹紧时逐条找：先看自己的会话 grant，再看候选工作区根下的
 * 工作区 grant。找不到就当**不存在**（返回 `GRANT_NOT_FOUND` 而不是
 * "forbidden"）—— 不向调用方泄露「这个 id 存在但不归你」。
 */
function canReachGrant(
  sandbox: RpcSandbox,
  context: RpcDispatchContext,
  grantId: string,
): boolean {
  if (!sandbox.confined) return true

  const sessions = listOwnedSessions(context)
  const workspaceRoots = new Set<string>([sandbox.root])
  for (const session of sessions) {
    if (PermissionGrants.listSessionGrants(session.id).some(grant => grant.id === grantId)) {
      return true
    }
    if (session.workingDirectory) workspaceRoots.add(session.workingDirectory)
  }

  const owner = { userId: context.ownerUid, workspaceId: context.workspaceId }
  for (const workspaceRoot of workspaceRoots) {
    if (PermissionGrants.listWorkspaceGrants(workspaceRoot, owner).some(g => g.id === grantId)) {
      return true
    }
  }
  return false
}

export const permissionGrantsRpcHandlers: RpcRouteHandlers<PermissionGrantsRoutes> = {
  async list(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const input = request ?? {}

    let workspaceRoot = input.workspaceRoot
    if (workspaceRoot) {
      const clamped = resolveInsideSandbox(sandbox, workspaceRoot)
      if (!clamped) return { success: false, error: WORKSPACE_ROOT_OUTSIDE_SANDBOX }
      workspaceRoot = clamped
    }
    if (input.sessionId && sandbox.confined && !ownsSession(context, input.sessionId)) {
      return { success: false, error: SESSION_NOT_FOUND }
    }

    const owner = grantOwner(sandbox, context, input)
    const listOnethingPermissionGrantsOptions: ListOnethingPermissionGrantsOptions<PermissionGrant> & { logger?: OnethingPermissionIpcLogger | undefined; } = {
      sessionId: input.sessionId,
      workspaceRoot,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      listSessionGrants: PermissionGrants.listSessionGrants,
      listWorkspaceGrants: PermissionGrants.listWorkspaceGrants,
      logger: consoleLog,
    };
    return listOnethingPermissionGrantsForIpc(listOnethingPermissionGrantsOptions)
  },

  async revoke(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const id = request?.id ?? ''
    if (!canReachGrant(sandbox, context, id)) {
      return { success: false, error: GRANT_NOT_FOUND }
    }
    return revokeOnethingPermissionGrantForIpc({
      id,
      revokeGrant: PermissionGrants.revokeGrant,
      logger: consoleLog,
    })
  },

  async clearSession(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const sessionId = request?.sessionId ?? ''
    if (sandbox.confined && !ownsSession(context, sessionId)) {
      return { success: false, error: SESSION_NOT_FOUND }
    }
    return clearOnethingSessionPermissionGrantsForIpc({
      sessionId,
      clearSessionGrants: PermissionGrants.clearSessionGrants,
      logger: consoleLog,
    })
  },

  async clearWorkspace(request, context = DESKTOP_RPC_CONTEXT) {
    const sandbox = resolveRpcSandbox(context)
    const requested = request?.workspaceRoot ?? ''
    const workspaceRoot = resolveInsideSandbox(sandbox, requested)
    if (!workspaceRoot) return { success: false, error: WORKSPACE_ROOT_OUTSIDE_SANDBOX }

    const owner = grantOwner(sandbox, context, {})
    return clearOnethingWorkspacePermissionGrantsForIpc({
      workspaceRoot,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      clearWorkspaceGrants: PermissionGrants.clearWorkspaceGrants,
      logger: consoleLog,
    })
  },
}

