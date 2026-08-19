/**
 * Chat Logger Module
 * Provides structured, detailed logging for chat requests and responses.
 *
 * Main owns the side effects (console and debug file writes); packages/core
 * owns the reusable log formatting and message-shape analysis.
 */

import type { SkillDefinition } from '@shared/ipc.js'
import {
  buildAssembledPromptDump,
  buildContinuationMessageLogLines,
  buildMessageBodyShapePayload,
  buildRequestEndLogLines,
  buildRequestStartLogLines,
  buildSkillsDetailLogLines,
  buildToolsDetailLogLines,
  CoreChatTurnTimer,
  type CoreChatLogMessageShape,
  type CoreChatLogValue,
  type CoreToolDefinitionForLog,
} from '@onething/core/engine'
import { writeTextFile } from '@onething/core/storage'
import { getLastSystemPromptDebugPath } from '../../stores/paths.js'
import { getLogger } from '../../logging/index.js'

const log = getLogger('engine.stream.chat')


export type ChatLogMessageShape = CoreChatLogMessageShape

/** 历史形状是自成一格的命名空间 —— 它的逐行铺开单独可开(见下)。 */
const historyLog = getLogger('engine.history')

/**
 * 旧口径是"一行一条 console" —— 那是渲染,不是记录。这里折成**一条**结构化记录,
 * 人眼那一侧交给 `bun run log:tail` 的 pretty renderer。
 */
function logLines(msg: string, lines: string[]): void {
  log.debug(msg, { lines })
}

/**
 * Dump the fully assembled system prompt to a debug file so the exact text sent
 * to the provider is always inspectable without per-source tracking. Overwrites
 * each request; the header records which session/provider produced it.
 */
export function dumpAssembledPrompt(ctx: {
  sessionId: string
  providerId: string
  model: string
  systemPrompt: string
}): void {
  try {
    writeTextFile(getLastSystemPromptDebugPath(), buildAssembledPromptDump({
      ...ctx,
      nowIso: new Date().toISOString(),
    }))
  } catch (err) {
    log.warn('dump assembled prompt failed', { sessionId: ctx.sessionId, providerId: ctx.providerId }, err)
  }
}

/**
 * Log request start with structured format.
 */
export function logRequestStart(ctx: {
  provider: string
  model: string
  systemPromptLength: number
  systemPrompt: string
  messages: Array<{ role: string; content: CoreChatLogValue }>
  tools: Record<string, CoreChatLogValue>
  skills: SkillDefinition[]
  hasTools: boolean
}): void {
  logLines('chat request start', buildRequestStartLogLines(ctx))
}

/**
 * Per-row inventories (one line per history message, plus the compacted
 * `retainedMessages` list) are opt-in: on a 400-message session they were
 * ~2400 console lines through util.inspect on EVERY send — ~300ms of main
 * thread before the request even left, felt in the composer as a stall
 * (2026-08-18 dev.log). 现在由等级过滤决定:摘要 = `engine.history` 的 debug,
 * 逐行铺开 = 同命名空间的 **trace**(所以"全域 debug"的诊断模式不会把那 300ms
 * 请回来)。旧开关 `ONETHING_DEBUG_HISTORY_SHAPE=1` 保留为 `engine.history=trace`
 * 的废弃别名(app/logging/legacy-debug-env.ts,L5 删)。
 */

export function logMessageBodyShape(
  label: string,
  messages: ChatLogMessageShape[],
  extra: Record<string, CoreChatLogValue> = {},
): void {
  if (!historyLog.isLevelEnabled('debug')) return
  const payload = buildMessageBodyShapePayload(messages, extra)
  if (historyLog.isLevelEnabled('trace')) {
    historyLog.trace('message body shape', { label, ...payload })
    return
  }
  const { rows, retainedMessages, degradedMessageIds, droppedMessages, ...summary } = payload as typeof payload & {
    retainedMessages?: unknown[]
    degradedMessageIds?: unknown[]
    droppedMessages?: unknown[]
  }
  historyLog.debug('message body shape', {
    label,
    ...summary,
    rows: rows.length,
    ...(retainedMessages ? { retainedMessages: retainedMessages.length } : {}),
    ...(degradedMessageIds ? { degradedMessageIds: degradedMessageIds.length } : {}),
    ...(droppedMessages ? { droppedMessages: droppedMessages.length } : {}),
  })
}

const turnTimer = new CoreChatTurnTimer()

/**
 * Log turn start within a stream.
 */
export function logTurnStart(turnNumber: number): void {
  log.debug('turn start', { turnNumber, line: turnTimer.startTurn(turnNumber) })
}

/**
 * Log turn end with usage and speed.
 */
export function logTurnEnd(turnNumber: number, usage: {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}, toolCallCount: number): void {
  log.debug('turn end', {
    turnNumber,
    toolCallCount,
    ...usage,
    line: turnTimer.endTurn(turnNumber, usage, toolCallCount),
  })
}

/**
 * Log request end with total stats and speed.
 * @param lastTurnUsage - Optional: last turn's usage for context window size display
 */
export function logRequestEnd(
  duration: number,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
  lastTurnUsage?: { inputTokens: number; outputTokens: number },
): void {
  logLines('chat request end', buildRequestEndLogLines(duration, usage, lastTurnUsage))
}

/**
 * Log continuation messages being sent for next turn.
 * Shows what tool calls were made and their results.
 */
export function logContinuationMessages(
  turnNumber: number,
  assistantContent: string,
  toolCalls: Array<{
    toolCallId: string
    toolName: string
    args: object
  }>,
  toolResults: Array<{
    toolCallId: string
    toolName: string
    result: CoreChatLogValue
  }>,
): void {
  logLines('continuation messages', buildContinuationMessageLogLines(turnNumber, assistantContent, toolCalls, toolResults))
}

/**
 * Log detailed tool definitions (for debugging).
 */
export function logToolsDetail(tools: Record<string, CoreToolDefinitionForLog>): void {
  logLines('tool definitions', buildToolsDetailLogLines(tools))
}

/**
 * Log detailed skills list (for debugging).
 */
export function logSkillsDetail(skills: SkillDefinition[]): void {
  logLines('skill definitions', buildSkillsDetailLogLines(skills))
}
