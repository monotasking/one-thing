/**
 * sessions(会话)域 —— 结构债 P4c 第五批,全仓最大的一域。
 *
 * **二十六条**方法,一条不多一条不少 —— 旧线上是 22 条 `IPC_CHANNELS.*` 常量
 * 加**四条写死的字面量通道**(`add-system-message` / `remove-files-changed-message` /
 * `remove-git-status-message` / `remove-message`)。后四条根本不在契约表里,
 * transport 门连数都数不到;搬完之后它们不再存在,归宿分别是
 * `addSystemMessage` / `removeFilesChangedMessage` / `removeGitStatusMessage` /
 * `removeMessage`。
 *
 * **不在这一域里的会话面**(它们各有各的家,别顺手往这里搬):
 *  - `session:command`(命令总线入口)= `sessionCommandRouter`(第四批);
 *  - `session:event` / `session:stream` / `sessions:messages-changed` /
 *    `sessions:context-size-updated` = **推送**,router 没有推送面,留在原地;
 *  - `sessions:update-max-tokens` 桌面侧从来没有处理者(只有 bridge 上一条打空的
 *    包装与 server 的一条 REST 路由),不是本批的 26 条之一,原样不动;
 *  - 目录/TOC 的读面是本域的 `getSegments`,但 TOC 的其余部分在 toc 域。
 *
 * 位置参数一律折成信封(与 media / skills 同一判例):`activate({ sessionId })`、
 * `rename({ sessionId, newName })`;无参的三条(`list` / `listMeta` /
 * `getCacheStats`)按本仓惯例递 `{}`。
 */
import type { PermissionMode } from './tools.js'
import type {
  ActivateSessionResponse,
  ChatMessage,
  CreateBranchResponse,
  CreateSessionOptions,
  CreateSessionResponse,
  DeleteSessionResponse,
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  GetSessionMessagesResponse,
  GetSessionUserMarkersResponse,
  GetSessionsListResponse,
  RenameSessionResponse,
  SwitchSessionResponse,
  UpdateSessionPinResponse,
} from './chat.js'
import type { GetSessionSegmentsResponse } from './toc.js'
import { defineRouter } from './router.js'
import type { SessionAccessOperation } from '../contracts/session-access.js'

/** 只有 `{ success, error? }` 的那批写面共用的回执。 */
export interface SessionMutationResponse {
  success: boolean
  error?: string
}

/**
 * 建会话的请求 —— **唯一一份**。旧线上它在三处各手抄一遍(preload 的包装体、
 * `platform/web.ts` 的 REST 桩、`@main/ipc/sessions.ts` 的 `request as {…}`)。
 *
 * `kind` 收成 `string` 而不是 `SessionKind`:规矩书在运行时里
 * (`describeInvalidOnethingCreateSessionRequestForIpc` 只认 `'room'`),契约层
 * 收窄反而会把「非法 kind 要报什么错」这件事挪到类型系统里说一遍。
 */
export interface SessionsCreateRequest {
  name?: string
  sessionId?: string
  workspaceId?: string
  kind?: string
  room?: CreateSessionOptions['room']
}

/** 会话仓的内存 LRU 快照(桌面页签上那枚 “cached” 徽标的数据源)。 */
export interface SessionCacheStatsResponse {
  size: number
  maxSize: number
  cachedSessionIds: string[]
}

/** `getTokenUsage` 的读数;`normalizeOnethingSessionTokenUsage` 的镜像。 */
export interface SessionTokenUsageReadout {
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  maxTokens: number
  lastInputTokens: number
  contextSize: number
}

export interface GetSessionTokenUsageResponse {
  success: boolean
  usage?: SessionTokenUsageReadout
  error?: string
}

/**
 * 系统标记消息的删除回执。`removedId: null` = 本来就没有这条标记(不是失败),
 * 与迁移前 `removeOnethingSystemMarkerMessage` 的语义逐字相同。
 */
export interface RemoveSystemMarkerMessageResponse {
  success: boolean
  removedId?: string | null
  error?: string
}

/**
 * `/files` 之类的斜杠命令往会话里补的那条系统消息。以前它在 `ElectronAPI` /
 * `bridge.ts` / `platform/web.ts` 三处各写一遍内联字面量类型,这里收成一份。
 */
export interface AddSystemMessageRequest {
  sessionId: string
  message: ChatMessage
}

export interface SessionsListRequest {
  /** Optional product workspace filter, independent of the caller's tenant scope. */
  workspaceId?: string
}

export type SessionsRoutes = {
  /**
   * 旧 `sessions:get-all`。**它返回的一直是元数据**(`store.getSessionsList()`),
   * 与 `listMeta` 逐字同一条实现;从前 `ElectronAPI` 把它标成 `GetSessionsResponse`
   * (含 messages)是一处说谎的类型,搬家时按事实改成 `GetSessionsListResponse`。
   * 零调用点,留着只为「26 条一条不少」的对账。
   */
  list: { input: SessionsListRequest; output: GetSessionsListResponse }
  listMeta: { input: SessionsListRequest; output: GetSessionsListResponse }
  activate: { input: { sessionId: string }; output: ActivateSessionResponse }
  getMessages: { input: { sessionId: string }; output: GetSessionMessagesResponse }
  getMessagesPage: { input: GetSessionMessagesPageRequest; output: GetSessionMessagesPageResponse }
  getUserMarkers: { input: { sessionId: string }; output: GetSessionUserMarkersResponse }
  getSegments: { input: { sessionId: string }; output: GetSessionSegmentsResponse }
  create: { input: SessionsCreateRequest; output: CreateSessionResponse }
  switch: { input: { sessionId: string }; output: SwitchSessionResponse }
  get: { input: { sessionId: string }; output: SwitchSessionResponse }
  delete: { input: { sessionId: string }; output: DeleteSessionResponse }
  rename: { input: { sessionId: string; newName: string }; output: RenameSessionResponse }
  updatePin: { input: { sessionId: string; isPinned: boolean }; output: UpdateSessionPinResponse }
  updateArchived: {
    input: { sessionId: string; isArchived: boolean; archivedAt?: number | null }
    output: SessionMutationResponse
  }
  updateWorkingDirectory: {
    input: { sessionId: string; workingDirectory: string | null }
    output: SessionMutationResponse
  }
  updateModel: {
    input: { sessionId: string; provider: string; model: string }
    output: SessionMutationResponse
  }
  updateAgent: { input: { sessionId: string; agentId?: string }; output: SessionMutationResponse }
  updatePermissionMode: {
    input: { sessionId: string; permissionMode: PermissionMode }
    output: SessionMutationResponse
  }
  createBranch: {
    input: { parentSessionId: string; branchFromMessageId: string }
    output: CreateBranchResponse
  }
  getCacheStats: { input: Record<string, never>; output: SessionCacheStatsResponse }
  evictCache: { input: { sessionId: string }; output: { success: boolean } }
  getTokenUsage: { input: { sessionId: string }; output: GetSessionTokenUsageResponse }
  addSystemMessage: { input: AddSystemMessageRequest; output: SessionMutationResponse }
  removeFilesChangedMessage: {
    input: { sessionId: string }
    output: RemoveSystemMarkerMessageResponse
  }
  removeGitStatusMessage: {
    input: { sessionId: string }
    output: RemoveSystemMarkerMessageResponse
  }
  removeMessage: { input: { sessionId: string; messageId: string }; output: SessionMutationResponse }
}

/*
 * 会话授权**写在契约里**(工单 5 §6,triage C1):每个方法自述"我拿哪一格当会话 id、
 * 对它做哪种操作",执法在 `dispatchRpc` 一处。加一个会话相关的域 = 这里一格,
 * `rpc/registry.ts` 零改动。
 *
 * 没列进这张表的方法(`list` / `listMeta` / `create` / `delete` / `getCacheStats`)
 * 各有各的理由:它们要么本来就按调用者过滤整张表,要么一次动多条会话、要么会话还
 * 没物化 —— 那几条的闸留在处理者里,并且**它们的行为一个字没变**。
 */
export const sessionsRouter = defineRouter<SessionsRoutes, SessionAccessOperation>('sessions', [
  'list',
  'listMeta',
  'activate',
  'getMessages',
  'getMessagesPage',
  'getUserMarkers',
  'getSegments',
  'create',
  'switch',
  'get',
  'delete',
  'rename',
  'updatePin',
  'updateArchived',
  'updateWorkingDirectory',
  'updateModel',
  'updateAgent',
  'updatePermissionMode',
  'createBranch',
  'getCacheStats',
  'evictCache',
  'getTokenUsage',
  'addSystemMessage',
  'removeFilesChangedMessage',
  'removeGitStatusMessage',
  'removeMessage',
], {
  activate: { param: 'sessionId', op: 'write' },
  getMessages: { param: 'sessionId', op: 'read' },
  getMessagesPage: { param: 'sessionId', op: 'read' },
  getUserMarkers: { param: 'sessionId', op: 'read' },
  getSegments: { param: 'sessionId', op: 'read' },
  switch: { param: 'sessionId', op: 'write' },
  get: { param: 'sessionId', op: 'read' },
  rename: { param: 'sessionId', op: 'write' },
  updatePin: { param: 'sessionId', op: 'write' },
  updateArchived: { param: 'sessionId', op: 'write' },
  updateWorkingDirectory: { param: 'sessionId', op: 'write' },
  updateModel: { param: 'sessionId', op: 'write' },
  updateAgent: { param: 'sessionId', op: 'write' },
  updatePermissionMode: { param: 'sessionId', op: 'permission' },
  evictCache: { param: 'sessionId', op: 'write' },
  getTokenUsage: { param: 'sessionId', op: 'read' },
  addSystemMessage: { param: 'sessionId', op: 'write' },
  removeFilesChangedMessage: { param: 'sessionId', op: 'write' },
  removeGitStatusMessage: { param: 'sessionId', op: 'write' },
  removeMessage: { param: 'sessionId', op: 'write' },
  createBranch: { param: 'parentSessionId', op: 'write' },
})
