import type { PermissionMode } from '../ipc/tools.js'

export type CliPlatformSupport = 'unix-socket'

export type DaemonErrorCode =
  | 'ERR_BAD_REQUEST'
  | 'ERR_DAEMON_DISCONNECTED'
  | 'ERR_DAEMON_RESTART'
  | 'ERR_LOCK_CONFLICT'
  | 'ERR_METHOD_NOT_FOUND'
  | 'ERR_NOT_FOUND'
  | 'ERR_OAUTH_REFRESH_REQUIRED'
  | 'ERR_PLATFORM_UNSUPPORTED'
  | 'ERR_TIMEOUT'
  | 'ERR_UNSUPPORTED_PLATFORM'
  | 'ERR_VALIDATION'

export interface DaemonRequest<TParams = unknown> {
  id: string
  method: DaemonMethod
  params?: TParams
}

export type DaemonResponse<TData = unknown> =
  | { id: string; type: 'result'; data?: TData }
  | { id: string; type: 'error'; error: DaemonError }

export interface DaemonEvent<TEvent = DaemonStreamEvent> {
  id: string
  type: 'event'
  event: TEvent
}

export type DaemonFrame<TData = unknown> = DaemonResponse<TData> | DaemonEvent

export interface DaemonError {
  code: DaemonErrorCode | string
  message: string
  details?: unknown
}

export type DaemonMethod =
  | 'daemon.health'
  | 'daemon.status'
  | 'daemon.shutdown'
  | 'daemon.prepareRestart'
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
  // 原子 K4-b(`docs/design/atom-2026-09.md` §4「deeplink / CLI」):四支通用方法,
  // **零个 scheme 名** —— 加一种资源不动这张表一个字,与 `resources` RPC 域同规。
  | 'resource.list'
  | 'resource.describe'
  | 'resource.read'
  | 'resource.do'

export interface AskRequest {
  prompt: string
  sessionId?: string
  yes?: boolean
  source?: string
}

export interface AskResult {
  streamId: string
  sessionId: string
  stopReason: AskStopReason
}

export type AskStopReason = 'end_turn' | 'max_tokens' | 'aborted' | 'error'

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

export type DaemonStreamEvent = {
  streamId: string
  sessionId?: string
  event: AskOutputEvent
}

export interface ActiveStreamInfo {
  streamId: string
  sessionId: string
  ownerClientId: string
  promptPreview?: string
  startedAt: number
  status: 'running' | 'aborting' | 'restarting'
}

export interface DaemonStatus {
  pid: number
  storePath: string
  socketPath: string
  logPath: string
  startedAt: number
  acceptingStreams: boolean
  activeStreams: ActiveStreamInfo[]
  platform: CliPlatformSupport
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

export interface ProviderSummary {
  id: string
  model?: string
  enabled?: boolean
  selectedModels?: string[]
  isDefault: boolean
}

export interface ToolSummary {
  id: string
  name: string
  enabled: boolean
  autoExecute: boolean
  category: 'builtin' | 'custom'
}

export interface PermissionModeSetRequest {
  mode: PermissionMode
}
