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

export type ChatLogMessageShape = CoreChatLogMessageShape

function logLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line)
  }
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
    console.warn('[Chat] dumpAssembledPrompt failed:', err)
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
  logLines(buildRequestStartLogLines(ctx))
}

/**
 * Per-row inventories (one line per history message, plus the compacted
 * `retainedMessages` list) are opt-in: on a 400-message session they were
 * ~2400 console lines through util.inspect on EVERY send — ~300ms of main
 * thread before the request even left, felt in the composer as a stall
 * (2026-08-18 dev.log). Set ONETHING_DEBUG_HISTORY_SHAPE=1 to get them back.
 */
const VERBOSE_HISTORY_SHAPE = process.env.ONETHING_DEBUG_HISTORY_SHAPE === '1'

export function logMessageBodyShape(
  label: string,
  messages: ChatLogMessageShape[],
  extra: Record<string, CoreChatLogValue> = {},
): void {
  const payload = buildMessageBodyShapePayload(messages, extra)
  if (VERBOSE_HISTORY_SHAPE) {
    console.log(`[Chat] ${label}`, payload)
    return
  }
  const { rows, retainedMessages, degradedMessageIds, droppedMessages, ...summary } = payload as typeof payload & {
    retainedMessages?: unknown[]
    degradedMessageIds?: unknown[]
    droppedMessages?: unknown[]
  }
  console.log(`[Chat] ${label}`, {
    ...summary,
    rows: `${rows.length} rows (ONETHING_DEBUG_HISTORY_SHAPE=1 to list)`,
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
  console.log(turnTimer.startTurn(turnNumber))
}

/**
 * Log turn end with usage and speed.
 */
export function logTurnEnd(turnNumber: number, usage: {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}, toolCallCount: number): void {
  console.log(turnTimer.endTurn(turnNumber, usage, toolCallCount))
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
  logLines(buildRequestEndLogLines(duration, usage, lastTurnUsage))
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
  logLines(buildContinuationMessageLogLines(turnNumber, assistantContent, toolCalls, toolResults))
}

/**
 * Log detailed tool definitions (for debugging).
 */
export function logToolsDetail(tools: Record<string, CoreToolDefinitionForLog>): void {
  logLines(buildToolsDetailLogLines(tools))
}

/**
 * Log detailed skills list (for debugging).
 */
export function logSkillsDetail(skills: SkillDefinition[]): void {
  logLines(buildSkillsDetailLogLines(skills))
}
