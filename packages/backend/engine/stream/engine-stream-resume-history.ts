import type { ChatMessage, ToolCall } from '@shared/ipc.js'
import {
  buildOnethingResumeHistoryAfterToolConfirmation,
} from '@onething/backend/session'
import type { HistoryMessage } from './engine-stream-message-helpers.js'

type ResumeAssistantMessage = Pick<ChatMessage, 'content' | 'reasoning'> & {
  toolCalls?: ToolCall[]
}

export function buildResumeHistoryAfterToolConfirmation(
  historyWithoutCurrent: HistoryMessage[],
  assistantMessage: ResumeAssistantMessage,
): HistoryMessage[] {
  return buildOnethingResumeHistoryAfterToolConfirmation(
    historyWithoutCurrent,
    assistantMessage,
  ) as HistoryMessage[]
}
