/**
 * 以**某个调用方的身份**对会话做的几件事:建一条普通会话、对一条会话做一次资源面的操作(改目录 / 换模型 / 删 …)、
 * 把工作目录夹进这个调用方的沙箱、删之前校验级联到的每一条都归它。
 *
 * 为什么住在会话功能本身(包根归位 B,2026-10-04):这几件事从前只写在界面那条 `sessions` 域里
 * (`sessions-client-api.ts`),而 ACP 认领 / 分叉远端会话要走**同一条路**(归属印、沙箱夹持、事件逐字相同),
 * 于是它动态 import 了那只开给界面的文件 —— 一个功能去引另一个功能的第二入口(D26),`client-api:gate` 只能靠例外放行。
 * 提到这里、经会话入口交出之后,界面的域与 ACP 用的是同一份,那条例外删掉了。
 *
 * 搬家只是挪住处:每一步的判据、先后与失败文案与从前逐字相同。两件事刻意留在界面那条域里:
 * 建「房间」那一支(它拖着协作的整本规则书,协作在会话之上一层),以及把资源面的结局折回 RPC 信封
 * (信封是 HTTP 服务器那一层的东西;这里只交出结局 `Outcome` 与「这次失败在会话契约里叫什么」)。
 *
 * 读写会话仓的那三个函数可以由调用方递进来(`SessionCallerStorePort`):界面那条域递的是会话入口的命名空间,
 * 它的单测替身打在入口上;不递就用会话仓本身。
 */
import { v4 as uuidv4 } from 'uuid'
import type { ChatSession } from '@shared/ipc.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { BackendNotAssembledError, getCurrentBackendInstance } from '@onething/backend/current.js'
import { principalOf } from '@onething/backend/http-server/http-server-principal.js'
import { isHostLocallyTrusted } from '@onething/backend/http-server/http-server-host-trust.js'
import { resolveInsideSandbox, resolveRpcSandbox } from '@onething/backend/http-server/http-server-sandbox.js'
import { consolePort, getLogger } from '@onething/backend/runtime/logging/configure-logging'
import type { ConsoleLikePort } from '@onething/backend/runtime/logging'
import { isValidSpaceId } from '@onething/backend/runtime/spaces/types'
import { requestSessionOwner, sessionAccess, type SessionOwnershipRecord } from './access.js'
import {
  createOnethingSessionForIpc,
  describeInvalidOnethingCreateSessionRequestForIpc,
  ONETHING_SESSION_NOT_FOUND,
  type OnethingSessionsIpcLogger,
} from './ipc-operations.js'
import { SESSION_RESOURCE_SCHEME } from './resource-spec.js'
import * as sessionStore from './session-store.js'
import { collectSessionCascadeDeleteIds } from './store-helpers.js'

/** 与从前界面那条域同一个命名空间:建会话失败的那一行日志,换了住处仍落在 `rpc.sessions` 下。 */
const log = getLogger('rpc.sessions')
const consoleLog: ConsoleLikePort & OnethingSessionsIpcLogger = consolePort(log)

/** 这几件事要读写会话仓的那三个函数。 */
export interface SessionCallerStorePort {
  getSession: typeof sessionStore.getSession
  createSession: typeof sessionStore.createSession
  getSessionsList: typeof sessionStore.getSessionsList
}

/** 缺省就用会话仓本身。用到时才取那三个名字(不在加载时取):替身只换了其中几样的单测照样能加载这只文件。 */
const SESSION_STORE: SessionCallerStorePort = {
  getSession: (...args) => sessionStore.getSession(...args),
  createSession: (...args) => sessionStore.createSession(...args),
  getSessionsList: (...args) => sessionStore.getSessionsList(...args),
}

/**
 * 资源面找不到那条会话。资源的会话提供者(`runtime/resource/session-provider.ts`)抛它,
 * 会话的几条出口按类(不按消息串)认它、答 `Session not found`。
 */
export class SessionNotFoundError extends Error {
  readonly sessionId: string

  constructor(sessionId: string) {
    super(`No such session: ${sessionId}`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/**
 * 「这次失败在会话契约里叫什么」。**只有一条**:二十六条方法共用的那句
 * `Session not found`(`ONETHING_SESSION_NOT_FOUND`)。其余原样交出管线那句话 ——
 * 不发明文案。判据是类不是消息串。
 */
export function describeSessionError(error: Error): string | undefined {
  return error instanceof SessionNotFoundError ? ONETHING_SESSION_NOT_FOUND : undefined
}

/** 交出去的会话不带归属与存储代际那几格(它们是后端自己的账)。 */
export function publicCreatedSession(session: ChatSession): ChatSession {
  const { ownerUserId: _user, ownerWorkspaceId: _workspace, userId: _legacy, storageGeneration: _generation, ...publicSession } = session as ChatSession & SessionOwnershipRecord & { storageGeneration?: string }
  return publicSession
}

/** 这个进程当前那台资源内核。与 `runtime/resource/resource-client-api.ts` 同一条读法、同一句「还没装配」。 */
export function sessionResourceKernel() {
  const backend = getCurrentBackendInstance()
  if (!backend) throw new BackendNotAssembledError()
  return backend.resources
}

/**
 * 一次调用的坐标。
 *
 * **不带 `sessionId`**:那一格是「从哪条会话里发起的」,不是操作对象。界面上改一条
 * 会话的名字与那条会话正在跑的回合无关,拿它顶上去,审计就读成「A 自己改了自己」
 * (K1 留账,K2a 的答案是保留坐标 + `<store>/audit/resource.jsonl`)。
 */
export function sessionCallOptions(context: RpcDispatchContext) {
  return {
    principal: principalOf(context),
    ...(context.signal ? { signal: context.signal } : {}),
  }
}

/** 以这个调用方的身份对一条会话做一次资源面的操作,交出结局(折成信封是调用方的事)。 */
export function runSessionOpAs(
  context: RpcDispatchContext,
  sessionId: string,
  op: string,
  params: Record<string, unknown>,
) {
  return sessionResourceKernel().do(`${SESSION_RESOURCE_SCHEME}:${sessionId}`, op, params, sessionCallOptions(context))
}

/** 夹不住时的答案。**逐字**沿用被删掉的 server 路由那份文案。 */
export const WORKDIR_SANDBOX_ERROR = {
  success: false as const,
  error: 'Working directory must stay inside the workspace sandbox root.',
}

/**
 * 把要设的工作目录夹进这个调用方的沙箱根(与 project-dirs 同一套判定 —— `http-server/http-server-sandbox.ts`,
 * fail-closed)。本机可信的宿主(桌面 / 壳内嵌面、回环 server)不夹;清空(null / '')直接放行:它不是一条路径。
 * 夹不住答 `{ ok: false }`,调用方回 `WORKDIR_SANDBOX_ERROR`。
 */
export function clampSessionWorkingDirectory<T extends string | null | undefined>(
  context: RpcDispatchContext,
  workingDirectory: T,
): { ok: true; workingDirectory: T | string } | { ok: false } {
  if (
    !isHostLocallyTrusted()
    && typeof workingDirectory === 'string'
    && workingDirectory !== ''
  ) {
    const inside = resolveInsideSandbox(resolveRpcSandbox(context), workingDirectory)
    if (!inside) return { ok: false }
    return { ok: true, workingDirectory: inside }
  }
  return { ok: true, workingDirectory }
}

/**
 * 删之前的归属校验:级联到的每一条都必须属于这个调用方,一条不合格整次拒(抛),
 * 在中止任何活流、动任何盘之前。
 */
export function authorizeSessionCascadeDelete(
  context: RpcDispatchContext,
  sessionId: string,
  store: SessionCallerStorePort = SESSION_STORE,
): void {
  sessionAccess.resolveAll(context, collectSessionCascadeDeleteIds(store.getSessionsList(), sessionId), 'delete')
}

/**
 * 建会话请求的前置判定:`workspaceId` 字符集卡死(非法 = 当没带)、自带 id 时要有写权限、
 * 三条规矩(自带 id 的格式、不认领已存在的会话、`kind` 只认 `'room'`)连同失败文案在运行时里。
 * 合法答 `{ ok: true, workspaceId }`,非法答可以原样交回的失败载荷。
 */
export async function checkSessionCreateRequestAs(
  context: RpcDispatchContext,
  request: { sessionId?: string; workspaceId?: string; kind?: string },
  store: SessionCallerStorePort = SESSION_STORE,
): Promise<{ ok: true; workspaceId: string | undefined } | { ok: false; response: { success: false; error: string } }> {
  // workspaceId 进 `workspaces/<id>/` 的路径片段,字符集卡死;非法值
  // 不报错、直接当没带(缺席 = default),不给它拖垮建会话这条路。
  const workspaceId = isValidSpaceId(request.workspaceId) ? request.workspaceId : undefined
  if (request.sessionId) sessionAccess.resolveOptional(context, request.sessionId, 'write')
  const invalidRequest = await describeInvalidOnethingCreateSessionRequestForIpc({
    sessionId: request.sessionId,
    kind: request.kind,
    getSession: id => store.getSession(id),
  })
  if (invalidRequest) return { ok: false, response: invalidRequest }
  return { ok: true, workspaceId }
}

/** 以这个调用方的身份建一条普通会话(不是房间):前置判定 → 建 → 去掉归属那几格交出去。 */
export async function createPlainSessionAs(
  context: RpcDispatchContext,
  request: { name?: string; sessionId?: string; workspaceId?: string; kind?: string },
  store: SessionCallerStorePort = SESSION_STORE,
) {
  const checked = await checkSessionCreateRequestAs(context, request, store)
  if (!checked.ok) return checked.response
  return createOnethingSessionForIpc({
    sessionId: request.sessionId ?? uuidv4(),
    name: request.name,
    createSession: (id, nextName) => publicCreatedSession(
      store.createSession(id, nextName, { workspaceId: checked.workspaceId, initialOwner: requestSessionOwner(context) })),
    logger: consoleLog,
  })
}
