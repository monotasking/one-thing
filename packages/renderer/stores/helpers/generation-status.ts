/**
 * Live generation status for the composer readout (2026-08-17).
 *
 * Two pure pieces the chat store composes:
 *   - `derivePhase(message)`: what the streaming assistant message is doing
 *     right now, read off its own state (the same facts MessageThinking and the
 *     process rail used to render "Waiting" / "Thinking" per message);
 *   - `estimateTokens(text)`: a character-based guess for "tokens received so
 *     far" — CJK ≈ 1 token per character, everything else ≈ 4 characters per
 *     token. It is a readout, not billing: the store snaps it to the real
 *     number every time a `stream:usage` turn boundary arrives.
 */
import type { ChatMessage, ContentPart } from '@shared/ipc/chat'
import { getToolRenderStatus, type ToolRenderStatus } from './tool-status'

export type GenerationPhase = 'waiting' | 'thinking' | 'responding' | 'tool' | 'approval'

export interface GenerationStatus {
  phase: GenerationPhase
  /** When this phase began (ms epoch). */
  phaseSince: number
  /** When the stream began (ms epoch). */
  startedAt: number
  /** Tool currently running / awaiting approval, when phase is tool/approval. */
  toolName?: string
  /** Best current figure for output tokens (exact after a turn boundary, estimated in between). */
  outputTokens: number
  /** True once at least one `stream:usage` snapped the figure to a real count. */
  outputTokensExact: boolean
  /** Prompt-side tokens of the last finished turn (null until one finishes). */
  inputTokens: number | null
}

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g

/** Rough token count for a chunk of model output text. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_CHAR)?.length ?? 0
  const rest = text.length - cjk
  return cjk + rest / 4
}

const LIVE_TOOL_STATUSES: ReadonlySet<ToolRenderStatus> = new Set([
  'pending', 'queued', 'streaming-input', 'received', 'awaiting-confirmation', 'executing',
])

/** The first tool still in flight, seen through the same unified status StepsPanel paints. */
function liveTool(message: Pick<ChatMessage, 'toolCalls' | 'steps'>): { name: string; approval: boolean } | null {
  const seen = new Set<string>()
  for (const step of message.steps ?? []) {
    if (step.toolCallId) seen.add(step.toolCallId)
    const status = getToolRenderStatus(step.toolCall, step)
    if (!LIVE_TOOL_STATUSES.has(status)) continue
    return { name: step.toolCall?.toolName || step.title, approval: status === 'awaiting-confirmation' }
  }
  for (const toolCall of message.toolCalls ?? []) {
    if (seen.has(toolCall.id)) continue
    const status = getToolRenderStatus(toolCall)
    if (!LIVE_TOOL_STATUSES.has(status)) continue
    return { name: toolCall.toolName, approval: status === 'awaiting-confirmation' }
  }
  return null
}

function lastMeaningfulPart(parts: ContentPart[] | undefined): ContentPart | null {
  if (!parts) return null
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.type === 'plugin-status' || part.type === 'provider-data' || part.type === 'image-loading') continue
    return part
  }
  return null
}

/**
 * Phase of a streaming assistant message. Order of precedence:
 *   a tool that is running / awaiting approval → tool / approval;
 *   otherwise the last content part says what the model is emitting
 *   (`waiting` placeholder → waiting, reasoning → thinking, text → responding);
 *   with no parts yet: top-level reasoning → thinking, else waiting.
 */
export function derivePhase(
  message: Pick<ChatMessage, 'content' | 'reasoning' | 'contentParts' | 'toolCalls' | 'steps'>,
): { phase: GenerationPhase; toolName?: string } {
  const tool = liveTool(message)
  if (tool) return { phase: tool.approval ? 'approval' : 'tool', toolName: tool.name }

  const last = lastMeaningfulPart(message.contentParts)
  if (last) {
    switch (last.type) {
      case 'waiting':
        return { phase: 'waiting' }
      case 'reasoning':
        return { phase: 'thinking' }
      case 'text':
        return last.content ? { phase: 'responding' } : { phase: 'waiting' }
      case 'tool-call':
      case 'data-steps':
        // Tool parts with nothing live left: the model is being asked to continue.
        return { phase: 'waiting' }
      default:
        break
    }
  }
  if (message.content) return { phase: 'responding' }
  if (message.reasoning) return { phase: 'thinking' }
  return { phase: 'waiting' }
}
