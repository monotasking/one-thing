import {
  agentContentFromHistoryContent,
  agentMessagesFromHistory,
  createAIToolName,
  type AgentContentPart,
  type AgentJsonObject,
  type AgentJsonValue,
  type AgentMessage,
  type AgentMessageContent,
  type AgentProviderData,
} from '@onething/backend/runtime/agent-loop/loop-primitives'
import { toJsonObject, type JsonObject } from '@shared/json'

export type OnethingProviderOpaqueValue = AgentJsonValue | object

export type OnethingAIMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; image: string; mediaType?: string }
      | { type: 'file'; data: string; mediaType: string; filename?: string }
    >

export type OnethingToolChatMessage =
  | {
      role: 'user' | 'system' | 'developer'
      content: OnethingAIMessageContent
    }
  | {
      role: 'assistant'
      content: OnethingAIMessageContent
      toolCalls?: Array<{
        toolCallId: string
        toolName: string
        args: AgentJsonObject
      }>
      reasoningContent?: string
      providerData?: AgentProviderData[]
    }
  | {
      role: 'tool'
      content: Array<{
        type: 'tool-result'
        toolCallId: string
        toolName: string
        result: OnethingProviderOpaqueValue
      }>
    }

export interface OnethingProviderToolParameter {
  name: string
  type: string
  description: string
  required?: boolean
  enum?: string[]
}

export interface OnethingProviderToolDefinitionInput {
  description: string
  parameters: OnethingProviderToolParameter[]
  parameterSchema?: JsonObject
}

export interface OnethingProviderToolSourceDefinition extends OnethingProviderToolDefinitionInput {
  id: string
  name: string
}

export type OnethingProviderToolDefinitionMap = Record<string, OnethingProviderToolDefinitionInput>

export type OnethingUIMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'file'; url: string; mediaType: string }
  | {
      type: `tool-${string}`
      toolCallId: string
      toolName?: string
      input?: AgentJsonObject
      state?: string
      output?: OnethingProviderOpaqueValue
      errorText?: string
    }
  | { type: string; [key: string]: unknown }

export interface OnethingUIMessage {
  role: 'system' | 'user' | 'assistant'
  parts: OnethingUIMessagePart[]
}

export function stringifyOnethingMessageContent(content: OnethingAIMessageContent): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content)
  return content
    .map((part) => {
      const record = recordFromValue(part)
      if (record.type === 'text' && typeof record.text === 'string') {
        return record.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function stringifyOnethingToolOutput(output: OnethingProviderOpaqueValue): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output)
  } catch {
    return String(output)
  }
}

export function onethingAgentContentFromAIMessageContent(content: OnethingAIMessageContent): AgentMessageContent {
  if (content == null || typeof content === 'string') return content ?? ''
  if (!Array.isArray(content)) return stringifyOnethingMessageContent(content)

  const parts: AgentContentPart[] = []
  for (const part of content) {
    const record = recordFromValue(part)
    if (record.type === 'text' && typeof record.text === 'string' && record.text) {
      parts.push({ type: 'text', text: record.text })
      continue
    }
    if (record.type === 'image' && typeof record.image === 'string' && record.image) {
      parts.push({
        type: 'image',
        image: record.image,
        ...(typeof record.mediaType === 'string' ? { mediaType: record.mediaType } : {}),
      })
      continue
    }
    if (
      part?.type === 'file' &&
      typeof part.data === 'string' &&
      typeof part.mediaType === 'string'
    ) {
      parts.push({
        type: 'file',
        data: part.data,
        mediaType: part.mediaType,
        ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
      })
    }
  }

  return parts.length > 0 ? parts : stringifyOnethingMessageContent(content)
}

export function onethingAgentMessagesFromToolChatMessages(messages: OnethingToolChatMessage[]): AgentMessage[] {
  return agentMessagesFromHistory(messages as Parameters<typeof agentMessagesFromHistory>[0])
}

export function onethingUtilityAgentMessagesFromMessages(
  messages: Array<{
    role: 'user' | 'assistant' | 'system'
    content: OnethingAIMessageContent
    reasoningContent?: string
  }>,
): AgentMessage[] {
  return messages.map((message): AgentMessage => ({
    role: message.role,
    content: onethingAgentContentFromAIMessageContent(message.content),
    ...(message.reasoningContent ? { reasoningContent: message.reasoningContent } : {}),
  }))
}

export function convertOnethingToolDefinitionsForProvider(
  toolDefinitions: OnethingProviderToolSourceDefinition[],
): OnethingProviderToolDefinitionMap {
  const result: OnethingProviderToolDefinitionMap = {}
  const usedNames = new Set<string>()

  for (const tool of toolDefinitions) {
    const providerToolName = createAIToolName(tool.id, usedNames)
    result[providerToolName] = {
      description: tool.description,
      parameters: tool.parameters,
      parameterSchema: tool.parameterSchema ? toJsonObject(tool.parameterSchema) : undefined,
    }
  }

  return result
}

export function onethingToolChatMessagesFromUIMessages(messages: OnethingUIMessage[]): OnethingToolChatMessage[] {
  const result: OnethingToolChatMessage[] = []

  for (const message of messages) {
    const content = onethingAIMessageContentFromUIParts(message.parts)

    if (message.role === 'system' || message.role === 'user') {
      result.push({ role: message.role, content })
      continue
    }

    const reasoningContent = message.parts
      .filter((part): part is Extract<OnethingUIMessagePart, { type: 'reasoning' }> => part.type === 'reasoning')
      .map(part => part.text)
      .join('')
    const toolCalls: Array<{
      toolCallId: string
      toolName: string
      args: AgentJsonObject
    }> = []
    const toolResults: Array<{
      type: 'tool-result'
      toolCallId: string
      toolName: string
      result: OnethingProviderOpaqueValue
    }> = []

    for (const part of message.parts) {
      if (!isToolUIPartForProvider(part)) continue
      const toolName = part.toolName || part.type.replace(/^tool-/, '') || 'tool'
      toolCalls.push({
        toolCallId: part.toolCallId,
        toolName,
        args: part.input ?? {},
      })
      if (part.state === 'output-available' || part.state === 'output-error') {
        toolResults.push({
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName,
          result: part.state === 'output-error'
            ? { error: part.errorText ?? 'Tool failed' }
            : part.output === undefined
              ? null
              : part.output,
        })
      }
    }

    result.push({
      role: 'assistant',
      content,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    })
    if (toolResults.length) {
      result.push({ role: 'tool', content: toolResults })
    }
  }

  return result
}

export function onethingAIMessageContentFromUIParts(parts: OnethingUIMessagePart[]): OnethingAIMessageContent {
  const text = parts
    .filter((part): part is Extract<OnethingUIMessagePart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .filter(Boolean)
    .join('\n')
  const fileParts = parts.filter((part): part is Extract<OnethingUIMessagePart, { type: 'file' }> => part.type === 'file')

  if (fileParts.length === 0) return text

  const contentParts: Exclude<OnethingAIMessageContent, string> = []
  if (text) contentParts.push({ type: 'text', text })

  for (const part of fileParts) {
    if (part.mediaType.startsWith('image/')) {
      contentParts.push({
        type: 'image',
        image: part.url,
        mediaType: part.mediaType,
      })
      continue
    }
    contentParts.push({
      type: 'file',
      data: part.url,
      mediaType: part.mediaType,
    })
  }

  return contentParts
}

function isToolUIPartForProvider(part: OnethingUIMessagePart): part is Extract<OnethingUIMessagePart, { type: `tool-${string}` }> {
  return part.type.startsWith('tool-')
}

function recordFromValue(value: OnethingProviderOpaqueValue): Record<string, OnethingProviderOpaqueValue> {
  return value && typeof value === 'object' ? value as Record<string, OnethingProviderOpaqueValue> : {}
}
