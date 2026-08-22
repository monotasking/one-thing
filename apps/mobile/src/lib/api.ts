import type {
  CreateSessionResponse,
  GetSessionMessagesPageRequest,
  GetSessionMessagesPageResponse,
  GetSessionsListResponse,
} from '@shared/ipc/chat.js'
import type { SessionCommandType } from '@onething/core/events/session-command-types.js'
import { httpRequest, rpc, type ServerTarget } from './rpc'

/**
 * mobile 的数据面 —— 结构债 P4 终态批 E1-a(拍板 #32)之后,**除了配对探针以外
 * 每一条都走通用信封 `POST /api/rpc`**(见 `rpc.ts` 的抬头)。
 *
 * 这个文件因此只剩两件事:把域 / 方法名和入参形状写对,以及把返回类型标成
 * router 声明里的那一个。路径、鉴权、失败形状都在 `rpc.ts` 里,只有一份。
 */

export { ApiError, RpcError, baseUrlOf, type ServerTarget } from './rpc'

/** Mirrors GET /api/capabilities (packages/core/runtime-facade.ts RuntimeHostCapabilities). */
export interface Capabilities {
  localFileSystem: boolean
  workspaceFileSystem: boolean
  nativeWindowControls: boolean
  shellTools: boolean
  clipboardWrite: boolean
  desktopWindows: boolean
  globalMenuEvents: boolean
}

/**
 * `GET /api/capabilities` —— 配对时的鉴权 / 连通性探针。
 *
 * 它**不是**一个 RPC 域:能力表是宿主自己的自述(server 起不起得来、认不认这个
 * token),在拿到任何域之前就要有答案,所以它留在裸 HTTP 上。
 */
export function checkAuth(target: ServerTarget): Promise<Capabilities> {
  return httpRequest<Capabilities>(target, '/api/capabilities')
}

// ── sessions 域 ─────────────────────────────────

export type SessionListResult = GetSessionsListResponse
export type CreateSessionResult = CreateSessionResponse
/** Mirrors GetSessionMessagesPageResponse (packages/shared/ipc/chat.ts). */
export type MessagePageResult = GetSessionMessagesPageResponse

/** `sessions.list` —— 无参的域按本仓惯例递 `{}`。 */
export function listSessions(target: ServerTarget): Promise<SessionListResult> {
  return rpc<SessionListResult>(target, 'sessions', 'list', {})
}

/**
 * `sessions.create`。
 *
 * 只递 `name`:`kind`(建房)在 `http` 传输上会被处理者直接拒掉(RoomCoordinator
 * 是 in-process 的,联网宿主不跑),mobile 也没有建房的入口。
 */
export function createSession(target: ServerTarget, name: string): Promise<CreateSessionResult> {
  return rpc<CreateSessionResult>(target, 'sessions', 'create', { name })
}

/** `sessions.getMessagesPage` —— cursor=null 取最新一页。 */
export function getMessagePage(
  target: ServerTarget,
  sessionId: string,
  cursor?: string | null,
  limit = 50,
): Promise<MessagePageResult> {
  const request: GetSessionMessagesPageRequest = { sessionId, cursor: cursor ?? null, limit }
  return rpc<MessagePageResult>(target, 'sessions', 'getMessagesPage', request)
}

// ── 命令总线 / chat 域 ──────────────────────────

/** `session-command.emit` 的回执形状(= `SessionCommandEmitResult`)。 */
export interface CommandResult {
  success: boolean
  error?: string
  result?: unknown
}

/**
 * 命令词汇的**唯一权威**是 `packages/core/events/session-command-types.ts` 的
 * `SESSION_COMMAND_TYPES`。这里 `satisfies` 一下:字面量保留(值就是线上格式),
 * 但拼错一个字母、或者哪天这条命令改名,mobile 这一侧当场编译不过 —— 而不是
 * 等到真机上发出一条没人订阅的命令。
 *
 * 只 `import type`:那张表所在的文件是零 import 的叶子,类型擦除后 Metro 完全
 * 看不到它。
 */
const SEND_MESSAGE = 'command:send-message' satisfies SessionCommandType

/**
 * 发消息 = 往命令总线递一条 `command:send-message`。
 *
 * E1-a 之前这里打的是 `POST /api/sessions/:id/commands` —— 那条 REST 路由在命令
 * 入口 router 化时被删掉了,于是 mobile 的发送静默变成 404。修法不是把路由加
 * 回来,而是让 mobile 和别的宿主一样过信封:`session-command.emit` 就是那条
 * REST 路由从前转发到的**同一个**处理者。
 *
 * `channel: 'api'` 原样保留:命令整条透传,这一跳不摘字段。
 */
export function sendMessage(
  target: ServerTarget,
  sessionId: string,
  content: string,
): Promise<CommandResult> {
  return rpc<CommandResult>(target, 'session-command', 'emit', {
    sessionId,
    command: { type: SEND_MESSAGE, channel: 'api', content },
  })
}

/**
 * `chat.abortStream` —— 不带 `sessionId` 是全停,mobile 一律只停当前这条。
 *
 * `success` 的含义是**真的停下了什么**,不是「请求收到了」。
 */
export function abortStream(target: ServerTarget, sessionId: string): Promise<{ success: boolean }> {
  return rpc<{ success: boolean }>(target, 'chat', 'abortStream', { sessionId })
}
