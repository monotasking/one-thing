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
 * 一个方法就够:命令的**分派**在总线那一侧按 `command.type` 走(那张表已经是
 * 常量键),router 再按 type 劈一遍就是把同一张表抄两份。
 */
import type { SessionCommand } from '../events/session-commands.js'
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

export type SessionCommandRoutes = {
  emit: { input: SessionCommandEmitRequest; output: SessionCommandEmitResult }
}

export const sessionCommandRouter = defineRouter<SessionCommandRoutes>('session-command', [
  'emit',
])
