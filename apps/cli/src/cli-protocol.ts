/**
 * CLI 自己的几种形状:`onething ask --json` 每行打出去的事件、几条命令的方法名,以及资源调用可选的那格主体。
 *
 * 第④步批 3 之前它们住在 `packages/shared/cli/protocol.ts`(守护进程与 CLI 之间那条 unix socket 的协议表)。
 * 守护进程退役之后只剩 CLI 一边认它们,所以搬进来;`--json` 输出的事件形状一格没改(管道那一头的人照旧读得懂)。
 */
import type { Principal } from '@shared/permission/principal'

/** CLI 认的方法名 —— 每一个在 `backend-requests.ts` 的方法表里对应一条(或两条)RPC。 */
export type CliMethod =
  | 'chat.ask'
  | 'chat.retryLast'
  | 'permission.respond'
  | 'active.list'
  | 'active.abort'
  | 'session.list'
  | 'session.new'
  | 'session.use'
  | 'session.show'
  | 'session.rename'
  | 'session.pin'
  | 'session.archive'
  | 'session.delete'
  | 'session.cwd'
  | 'session.model'
  | 'provider.list'
  | 'provider.use'
  | 'provider.enable'
  | 'provider.configure'
  | 'provider.models'
  | 'tools.list'
  | 'tools.set'
  | 'permission.mode.set'
  | 'collab.roomNew'
  | 'collab.roomList'
  | 'collab.send'
  | 'collab.board'
  | 'collab.setBudgets'
  | 'collab.roomUpdate'
  | 'collab.transcript'
  | 'resource.list'
  | 'resource.describe'
  | 'resource.read'
  | 'resource.do'

/**
 * `resource.read` / `resource.do` 上那格可选的主体(原子 K4-c)。只开 `system` 一支:`onething mcp` 那条桥替外面的
 * agent 说话,它把每次调用报成 `system:mcp:<名字>`;走 HTTP 之后经请求头 `X-Onething-Acting-System` 带过去,
 * 由后端在鉴权之后铸成主体(只能降、不能升,见 `packages/backend/http-server/http-server-principal.ts`)。
 */
export type ResourceCallPrincipal = Extract<Principal, { kind: 'system' }>

export type AskStopReason = 'end_turn' | 'max_tokens' | 'aborted' | 'error'

export interface AskResult {
  streamId: string
  sessionId: string
  stopReason: AskStopReason
}

/** `onething ask --json` 的每一行(与守护进程年代逐字同形)。 */
export type AskOutputEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; content: unknown; isError: boolean }
  | {
      type: 'permission'
      id: string
      description: string
      options: Array<'once' | 'session' | 'workdir' | 'reject'>
    }
  | { type: 'done'; stopReason: AskStopReason; usage?: unknown }
  | { type: 'error'; code: string; message: string }

export type AskStreamEvent = {
  streamId: string
  sessionId?: string
  event: AskOutputEvent
}

export interface SessionSummary {
  id: string
  name: string
  updatedAt: number
  createdAt: number
  previewText?: string
  messageCount?: number
  isPinned?: boolean
  isArchived?: boolean
  lastProvider?: string
  lastModel?: string
}
