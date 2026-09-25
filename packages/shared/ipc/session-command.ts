/**
 * session-command(会话命令总线的入口)域 —— 结构债 P4c 第四批。
 *
 * 文件名是 **`session-command`(单数)**,与 `@shared/events/session-commands.ts`
 * (复数,命令的**词汇表与载荷形状**)刻意错开一个字母以外的东西:那边是
 * 「有哪些命令」,这边是「命令怎么过线」。两者一份类型 —— `SessionCommand` 从
 * 那边 import 过来,这里一个字段都不重抄。
 *
 * 为什么命令总线也上 router:P4 之前它是全仓最后一条「Proxy 属性 + 手写通道」的
 * 主干路 —— 渲染层写 `platformApi.emitCommand(sessionId, …)`,F12 只能跳到
 * `renderer/types/index.ts` 那个接口声明就断了(`platformApi` 是运行时选实现的
 * `Proxy`,桌面那半在 preload、web 那半在 `POST /api/sessions/:id/commands`)。
 * 换成 router 之后,每一跳都是 TS 标识符:
 *
 *   `sessionCommands.emit`(renderer/platform/session-command-client.ts)
 *     → `sessionCommandRouter`(本文件)
 *     → `sessionCommandRpcHandlers.emit`(backend/rpc/domains/session-command.ts)
 *     → `emitCoreSessionCommandForIpc`(core/events/ipc-operations.ts)
 *     → `CoreStreamEngine` 的命令派发表(core/engine/core-stream-engine.ts)
 *     → `handleSendMessage`
 *
 * 2026-09-25 起**发送与停止各有一个具名方法**(`sendMessage` / `abort`),不再
 * 塞进 `emit` 的 `command.type` 里:读前端的人看到 `sessionCommands.sendMessage(…)`
 * 就知道这是一次「发消息」的请求,后端同名处理者就是它的实现,HTTP 日志也写得出
 * 是哪一件事。这两条仍然投进同一条命令总线(总线上还挂着 SSE 投递、插件拦截器
 * 与网关 / 插件 / 调度这些别的发送方,绕开它就是两条路进引擎),变的只是**过线
 * 那一跳有了名字**。其余命令暂时仍走 `emit`,是否跟进看这两条的样板。
 */
import type { MessageAttachment } from './chat.js'
import type { PresentedResource, SessionCommand } from '../events/session-commands.js'
import type { SessionAccessOperation } from '../contracts/session-access.js'
import { defineRouter } from './router.js'

/**
 * `emit` 的返回值 —— 与迁移前 `ElectronAPI.emitCommand` 的声明逐字同形,
 * 也就是 `emitCoreSessionCommandForIpc` 那个结果联合的结构化投影
 * (`{success:true, result}` / `{success:false, error}`)。调用点里
 * `if (!emitted?.success)` 这类判断因此一行都不用改。
 */
export interface SessionCommandEmitResult {
  success: boolean
  error?: string
  result?: unknown
}

export interface SessionCommandEmitRequest {
  sessionId: string
  /** 12 条 `SESSION_COMMAND_TYPES` 之一,整条透传 —— 这一跳不摘字段。 */
  command: SessionCommand
}

/** 往一条会话里发一句话。字段与 `SendMessageCommand` 的同名字段同义。 */
export interface SessionSendMessageRequest {
  sessionId: string
  content: string
  /** 客户端预铸的消息 id;缺席 = 引擎自己铸。 */
  messageId?: string
  attachments?: MessageAttachment[]
  presented?: PresentedResource[]
}

export interface SessionAbortRequest {
  sessionId: string
}

export type SessionCommandRoutes = {
  emit: { input: SessionCommandEmitRequest; output: SessionCommandEmitResult }
  sendMessage: { input: SessionSendMessageRequest; output: SessionCommandEmitResult }
  abort: { input: SessionAbortRequest; output: SessionCommandEmitResult }
}

export const sessionCommandRouter = defineRouter<SessionCommandRoutes, SessionAccessOperation>('session-command', [
  'emit',
  'sendMessage',
  'abort',
], {
  sendMessage: { param: 'sessionId', op: 'write' },
  abort: { param: 'sessionId', op: 'write' },
})
