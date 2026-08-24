import {
  getAIToolName,
  toJsonValue,
  type AgentProviderData,
  type JsonObject,
  type JsonValue,
} from '@onething/core'
import {
  buildHistoryMessages as buildCoreHistoryMessages,
  buildMessageContent as buildCoreMessageContent,
  buildResumeHistoryAfterToolConfirmation as buildCoreResumeHistoryAfterToolConfirmation,
  filterHistoryForNonToolAPI as filterCoreHistoryForNonToolAPI,
  type BuildMessageContentOptions,
  type CoreAIMessageContent,
  type CoreBuildHistoryMessagesOptions,
  type CoreCompactedHistoryLogDetails,
  type CoreHistoryChatMessage,
  type CoreHistoryContentPart,
  type CoreMessageContentSource,
  type CoreResumeAssistantMessage,
} from '@onething/core/engine'
import {
  toolFailureResultForAI,
} from '@onething/core/tools'
import { providerDataFromOnethingContentPart } from '../agent-loop/providers/provider-data.js'

export type OnethingHistoryAIMessageContent = CoreAIMessageContent

export interface OnethingHistorySessionSummary {
  id?: string
  summary?: string
  summaryUpToMessageId?: string
}

export type OnethingHistoryMessage =
  | { role: 'user'; content: OnethingHistoryAIMessageContent }
  | {
      role: 'assistant'
      content: OnethingHistoryAIMessageContent
      reasoningContent?: string
      providerData?: AgentProviderData[]
      toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonObject }>
    }
  | {
      role: 'tool'
      content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; result: JsonValue }>
    }

export interface BuildOnethingHistoryMessagesOptions {
  onImageAttachment?: BuildMessageContentOptions['onImageAttachment']
  /**
   * Last touch on a message's **built** content (string or parts). The app
   * layer applies the persisted turn-context delta here — after the parts are
   * built, so the placement rule is the same one the first-build attach uses on
   * the request (`TurnContextLedger.applyTo`).
   */
  finalizeContent?: (
    content: OnethingHistoryAIMessageContent,
    message: CoreMessageContentSource,
  ) => OnethingHistoryAIMessageContent
  onCompactedHistory?: (details: CoreCompactedHistoryLogDetails) => void
  onMissingSummaryAnchor?: (details: { sessionId?: string; summaryUpToMessageId: string }) => void
}

export function buildOnethingMessageContent(
  message: CoreMessageContentSource,
  options: Pick<BuildOnethingHistoryMessagesOptions, 'onImageAttachment' | 'finalizeContent'> = {},
): OnethingHistoryAIMessageContent {
  const buildMessageContentOptions: BuildMessageContentOptions = {
    onImageAttachment: options.onImageAttachment,
  };
  const content = buildCoreMessageContent(message, buildMessageContentOptions)
  return options.finalizeContent ? options.finalizeContent(content, message) : content
}

/**
 * 这条产品线的历史构造**配方**(注入给 core builder 的那一份)。
 *
 * 单独导出是为了让 S1b 的历史影子断言拿**同一份**去物化事件投影 ——
 * `projectModelHistory` 与真实请求必须走同一个 `buildMessageContent` /
 * `getAIToolName` / `failureResultForAI` / `providerDataFromContentPart`,
 * 否则那道断言比的是两种构造法而不是两个来源。
 */
export function onethingHistoryBuildRecipe<TMessage extends CoreHistoryChatMessage>(
  options: BuildOnethingHistoryMessagesOptions = {},
): Required<Pick<
  CoreBuildHistoryMessagesOptions<OnethingHistoryAIMessageContent, TMessage>,
  'buildMessageContent' | 'getAIToolName' | 'failureResultForAI' | 'providerDataFromContentPart'
>> {
  return {
    buildMessageContent: (message: TMessage) =>
      buildOnethingMessageContent(message as unknown as CoreMessageContentSource, options),
    getAIToolName,
    failureResultForAI: toolCall => toJsonValue(toolFailureResultForAI(toolCall)) ?? null,
    providerDataFromContentPart: (part: CoreHistoryContentPart) => providerDataFromOnethingContentPart(part),
  }
}

export function buildOnethingHistoryMessages<TMessage extends CoreHistoryChatMessage>(
  messages: TMessage[],
  session?: OnethingHistorySessionSummary,
  options: BuildOnethingHistoryMessagesOptions = {},
): OnethingHistoryMessage[] {
  const buildHistoryMessagesOptions: CoreBuildHistoryMessagesOptions<CoreAIMessageContent, TMessage> = {
    ...onethingHistoryBuildRecipe<TMessage>(options),
    onCompactedHistory: options.onCompactedHistory,
    onMissingSummaryAnchor: options.onMissingSummaryAnchor,
  };
  return buildCoreHistoryMessages(messages, session, buildHistoryMessagesOptions) as OnethingHistoryMessage[]
}

export function filterOnethingHistoryForNonToolAPI(
  messages: OnethingHistoryMessage[],
): Array<{ role: 'user' | 'assistant'; content: OnethingHistoryAIMessageContent; reasoningContent?: string }> {
  return filterCoreHistoryForNonToolAPI<OnethingHistoryAIMessageContent>(messages)
}

export function buildOnethingResumeHistoryAfterToolConfirmation(
  historyWithoutCurrent: OnethingHistoryMessage[],
  assistantMessage: CoreResumeAssistantMessage,
): OnethingHistoryMessage[] {
  return buildCoreResumeHistoryAfterToolConfirmation(
    historyWithoutCurrent,
    assistantMessage,
  ) as OnethingHistoryMessage[]
}
