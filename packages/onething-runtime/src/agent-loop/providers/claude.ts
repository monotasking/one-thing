import { collectAgentTurnFromStream } from '@onething/core/agent-loop'
import { agentToolMessageContentToText } from '@onething/core/agent-loop'
import { undeliverableAttachmentText } from '@onething/core/agent-loop'
import { mergeAdjacentSameRoleMessages } from './message-merge.js'
import { readJsonSseData } from './sse.js'
import { withProviderRetryAfter } from '../provider-error-classification.js'
import {
  ONETHING_CLAUDE_THINKING_BUDGETS,
  onethingClaudeModelFamily,
  type OnethingClaudeModelFamily,
} from '../../providers/model-capability.js'
import type {
  AgentContentPart,
  AgentFinishReason,
  AgentJsonObject,
  AgentJsonValue,
  AgentMessage,
  AgentMessageContent,
  AgentModelCapabilities,
  AgentProvider,
  AgentProviderData,
  AgentReasoningEffort,
  AgentTool,
  AgentToolChoice,
  AgentTurn,
  AgentTurnRequest,
  AgentTurnStreamEvent,
  AgentUsage,
} from '@onething/core/agent-loop'
import type { AgentProviderRequestDumper } from './request-dump.js'

type FetchFn = typeof globalThis.fetch

export interface ClaudeAgentProviderOptions {
  providerId?: string
  apiKey?: string
  baseUrl?: string
  capabilities?: AgentModelCapabilities
  fetchImpl?: FetchFn
  headers?: Record<string, string>
  omitApiKeyHeader?: boolean
  systemHeader?: string
  /**
   * Set explicit prompt-cache breakpoints (cache_control: ephemeral) on the
   * system prompt and the conversation tail. Opt-in: enabled for the official
   * Anthropic endpoints; left off for third-party anthropic-compatible
   * endpoints that may reject the field.
   */
  promptCaching?: boolean
  requestDumper?: AgentProviderRequestDumper
}

type ClaudeCacheControl = { type: 'ephemeral' }

type ClaudeTextBlock = { type: 'text'; text: string; cache_control?: ClaudeCacheControl }

type ClaudeImageBlock = {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
  cache_control?: ClaudeCacheControl
}

type ClaudeToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: AgentJsonValue
  cache_control?: ClaudeCacheControl
}

type ClaudeDocumentBlock = {
  type: 'document'
  source: { type: 'base64'; media_type: string; data: string }
  cache_control?: ClaudeCacheControl
}

type ClaudeThinkingBlock = { type: 'thinking'; thinking: string; signature: string }

type ClaudeRedactedThinkingBlock = { type: 'redacted_thinking'; data: string }

type ClaudeToolResultContentBlock = ClaudeTextBlock | ClaudeImageBlock

type ClaudeToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | ClaudeToolResultContentBlock[]
  is_error?: boolean
  cache_control?: ClaudeCacheControl
}

type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeDocumentBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | ClaudeRedactedThinkingBlock

type ClaudeMessage =
  | { role: 'user'; content: string | ClaudeContentBlock[] }
  | { role: 'assistant'; content: string | ClaudeContentBlock[] }

interface ClaudeTool {
  name: string
  description?: string
  input_schema: AgentJsonObject
  cache_control?: ClaudeCacheControl
}

interface ClaudeStreamEvent {
  type?: string
  index?: number
  content_block?: {
    type?: string
    id?: string
    name?: string
    input?: AgentJsonValue
    text?: string
    data?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: ClaudeUsage
  message?: {
    usage?: ClaudeUsage
  }
  error?: {
    message?: string
    type?: string
  }
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface ToolUseAccumulator {
  id: string
  name: string
  arguments: string
  started: boolean
}

const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
const CLAUDE_VERSION = '2023-06-01'

const CLAUDE_CAPABILITIES: AgentModelCapabilities = {
  capabilities: [
    'text-input',
    'vision-input',
    'file-input',
    'text-output',
    'streaming',
    'tool-calls',
    'structured-tool-results',
    'reasoning',
  ],
  inputModalities: ['text', 'image', 'file'],
  outputModalities: ['text'],
  toolResultModalities: ['text', 'image'],
  supportsTools: true,
  supportsStructuredToolResults: true,
  supportsReasoning: true,
  supportsStreaming: true,
  // tool_choice: { type: 'any' }
  supportsForcedToolUse: true,
}

function textFromContent(content: AgentMessageContent): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is Extract<AgentContentPart, { type: 'text' }> => part.type === 'text')
    .map(part => part.text)
    .filter(Boolean)
    .join('\n')
}

function parseDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/)
  if (!match) return undefined
  return { mediaType: match[1], data: match[2] }
}

function imageSourceFromData(data: string, mediaType?: string): ClaudeImageBlock {
  if (data.startsWith('http://') || data.startsWith('https://')) {
    return { type: 'image', source: { type: 'url', url: data } }
  }
  const parsed = parseDataUrl(data)
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: parsed?.mediaType ?? mediaType ?? 'image/png',
      data: parsed?.data ?? data,
    },
  }
}

function userContentBlocks(content: AgentMessageContent): string | ClaudeContentBlock[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const blocks: ClaudeContentBlock[] = []
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      blocks.push(imageSourceFromData(part.image, part.mediaType))
      continue
    }
    if (part.type === 'file') {
      if (part.mediaType.startsWith('image/')) {
        blocks.push(imageSourceFromData(part.data, part.mediaType))
        continue
      }
      const pdf = documentSourceFromData(part.data, part.mediaType)
      if (pdf) {
        blocks.push(pdf)
        continue
      }
      // Text files are inlined as text parts upstream; whatever binary is
      // left has no Claude-native form — say so instead of dropping it.
      blocks.push({ type: 'text', text: undeliverableAttachmentText(part) })
    }
  }
  return blocks.length > 0 ? blocks : ''
}

function documentSourceFromData(data: string, mediaType: string): ClaudeDocumentBlock | undefined {
  const parsed = parseDataUrl(data)
  const resolvedMediaType = (parsed?.mediaType ?? mediaType).split(';')[0]?.trim().toLowerCase()
  if (resolvedMediaType !== 'application/pdf') return undefined
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: parsed?.data ?? data,
    },
  }
}

function parseToolArguments(args: string): AgentJsonValue {
  const trimmed = args.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed) as AgentJsonValue
  } catch {
    return {}
  }
}

function toolResultContentBlocks(content: AgentMessageContent): string | ClaudeToolResultContentBlock[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const blocks: ClaudeToolResultContentBlock[] = []
  let hasRichContent = false

  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text })
      continue
    }

    if (part.type === 'image') {
      blocks.push(imageSourceFromData(part.image, part.mediaType))
      hasRichContent = true
      continue
    }

    if (part.type === 'file' && part.mediaType.startsWith('image/')) {
      blocks.push(imageSourceFromData(part.data, part.mediaType))
      hasRichContent = true
      continue
    }

    const text = agentToolMessageContentToText([part])
    if (text) blocks.push({ type: 'text', text })
  }

  return hasRichContent ? blocks : agentToolMessageContentToText(content)
}

/**
 * Thinking blocks captured from earlier turns, replayed verbatim. Anthropic
 * requires the assistant message that carried a tool_use to keep its thinking
 * block (with signature) when the conversation is sent back, mirroring the
 * codex encrypted-reasoning round-trip.
 */
function claudeThinkingReplayBlocks(message: AgentMessage): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = []
  for (const data of message.providerData ?? []) {
    if (data.provider !== 'claude') continue
    if (data.type === 'thinking' && typeof data.signature === 'string' && data.signature) {
      blocks.push({
        type: 'thinking',
        thinking: typeof data.thinking === 'string' ? data.thinking : '',
        signature: data.signature,
      })
      continue
    }
    if (data.type === 'redacted-thinking' && typeof data.data === 'string' && data.data) {
      blocks.push({ type: 'redacted_thinking', data: data.data })
    }
  }
  return blocks
}

function buildClaudeMessages(
  messages: AgentMessage[],
  options?: { includeThinking?: boolean },
): { system?: string; messages: ClaudeMessage[] } {
  const system: string[] = []
  const result: ClaudeMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textFromContent(message.content).trim()
      if (text) system.push(text)
      continue
    }

    if (message.role === 'tool') {
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: toolResultContentBlocks(message.content),
          // Without is_error a failed tool reads to the model as a successful
          // result whose text merely describes a problem.
          ...(message.isError === true && { is_error: true }),
        }],
      })
      continue
    }

    if (message.role === 'assistant') {
      const blocks: ClaudeContentBlock[] = []
      const text = textFromContent(message.content)
      if (text) blocks.push({ type: 'text', text })
      for (const toolCall of message.toolCalls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: parseToolArguments(toolCall.arguments),
        })
      }
      // Thinking blocks lead the message, but never alone — an assistant
      // message consisting solely of thinking is rejected by the API.
      if (options?.includeThinking && blocks.length > 0) {
        blocks.unshift(...claudeThinkingReplayBlocks(message))
      }
      result.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : '',
      })
      continue
    }

    result.push({
      role: 'user',
      content: userContentBlocks(message.content),
    })
  }

  return {
    ...(system.length > 0 ? { system: system.join('\n\n') } : {}),
    messages: result,
  }
}

function toClaudeTools(tools: AgentTool[] | undefined): ClaudeTool[] | undefined {
  if (!tools?.length) return undefined
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
}

type ClaudeToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

function toClaudeToolChoice(choice: AgentToolChoice | undefined): ClaudeToolChoice | undefined {
  if (!choice || choice === 'auto') return { type: 'auto' }
  if (choice === 'none') return undefined
  // Anthropic spells "must use a tool, any tool" as `any`.
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.function.name }
}

function mapClaudeStopReason(reason: string | null | undefined): AgentFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return reason ? 'unknown' : 'unknown'
  }
}

function usageFromAnthropic(
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): AgentUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  }
}

function systemBody(options: ClaudeAgentProviderOptions, system: string | undefined): string | ClaudeTextBlock[] | undefined {
  if (!options.systemHeader) return system
  if (!system || system === options.systemHeader) return options.systemHeader
  return [
    { type: 'text', text: options.systemHeader },
    { type: 'text', text: system },
  ]
}

function claudeEffort(
  effort: AgentReasoningEffort | undefined,
  family: OnethingClaudeModelFamily,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (effort === 'minimal') return 'low'
  if (effort === 'xhigh') return family.supportsXhigh ? 'xhigh' : 'high'
  if (effort === 'low' || effort === 'medium' || effort === 'max') return effort
  return 'high'
}

function toolCallDoneEvent(
  turn: number,
  entry: ToolUseAccumulator,
): Extract<AgentTurnStreamEvent, { type: 'tool-call-done' }> {
  return {
    type: 'tool-call-done',
    turn,
    toolCall: {
      id: entry.id,
      name: entry.name,
      arguments: entry.arguments || '{}',
    },
  }
}

interface ThinkingAccumulator {
  thinking: string
  signature: string
}

function thinkingProviderData(entry: ThinkingAccumulator): AgentProviderData {
  return {
    provider: 'claude',
    type: 'thinking',
    thinking: entry.thinking,
    signature: entry.signature,
  }
}

async function* streamClaudeResponse(
  response: Response,
  turn: number,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
  const toolUses = new Map<number, ToolUseAccumulator>()
  const thinkingBlocks = new Map<number, ThinkingAccumulator>()
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let finishReason: AgentFinishReason = 'unknown'

  const applyUsage = (usage: ClaudeUsage | undefined): void => {
    if (!usage) return
    inputTokens = usage.input_tokens ?? inputTokens
    outputTokens = usage.output_tokens ?? outputTokens
    cacheReadTokens = usage.cache_read_input_tokens ?? cacheReadTokens
    cacheWriteTokens = usage.cache_creation_input_tokens ?? cacheWriteTokens
  }

  for await (const event of readJsonSseData<ClaudeStreamEvent>(response, {
    sourceName: 'Claude agent loop',
    invalidMessage: 'invalid stream event',
  })) {
    if (event.type === 'error' || event.error) {
      throw new Error(`Claude agent loop error: ${event.error?.message ?? 'unknown error'}`)
    }

    applyUsage(event.message?.usage)
    applyUsage(event.usage)

    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
      thinkingBlocks.set(event.index ?? 0, { thinking: '', signature: '' })
      continue
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking') {
      const data = event.content_block.data
      if (typeof data === 'string' && data) {
        yield {
          type: 'provider-data',
          turn,
          providerData: { provider: 'claude', type: 'redacted-thinking', data },
        }
      }
      continue
    }

    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const index = event.index ?? toolUses.size
      const input = event.content_block.input && typeof event.content_block.input === 'object'
        ? JSON.stringify(event.content_block.input)
        : ''
      const entry: ToolUseAccumulator = {
        id: event.content_block.id ?? `tool-${turn}-${index}`,
        name: event.content_block.name ?? '',
        arguments: input === '{}' ? '' : input,
        started: true,
      }
      toolUses.set(index, entry)
      yield {
        type: 'tool-call-start',
        turn,
        toolCallId: entry.id,
        toolName: entry.name,
      }
      if (entry.arguments) {
        yield {
          type: 'tool-call-delta',
          turn,
          toolCallId: entry.id,
          toolName: entry.name,
          argumentsDelta: entry.arguments,
        }
      }
      continue
    }

    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        yield { type: 'text-delta', turn, delta: event.delta.text }
        continue
      }
      if (event.delta?.type === 'thinking_delta' && event.delta.thinking) {
        const entry = thinkingBlocks.get(event.index ?? 0)
        if (entry) entry.thinking += event.delta.thinking
        yield { type: 'reasoning-delta', turn, delta: event.delta.thinking }
        continue
      }
      if (event.delta?.type === 'signature_delta' && event.delta.signature) {
        const entry = thinkingBlocks.get(event.index ?? 0)
        if (entry) entry.signature += event.delta.signature
        continue
      }
      if (event.delta?.type === 'input_json_delta') {
        const index = event.index ?? 0
        const entry = toolUses.get(index)
        const partial = event.delta.partial_json ?? ''
        if (entry && partial) {
          entry.arguments += partial
          yield {
            type: 'tool-call-delta',
            turn,
            toolCallId: entry.id,
            toolName: entry.name,
            argumentsDelta: partial,
          }
        }
      }
      continue
    }

    if (event.type === 'content_block_stop') {
      const index = event.index ?? -1
      const thinkingEntry = thinkingBlocks.get(index)
      if (thinkingEntry) {
        // Signed blocks are replayed verbatim on later turns; unsigned ones
        // (third-party anthropic-compatible endpoints) have nothing the API
        // would verify, so skip them.
        if (thinkingEntry.signature) {
          yield { type: 'provider-data', turn, providerData: thinkingProviderData(thinkingEntry) }
        }
        thinkingBlocks.delete(index)
        continue
      }
      const entry = toolUses.get(index)
      if (entry?.started) {
        yield toolCallDoneEvent(turn, entry)
        toolUses.delete(index)
      }
      continue
    }

    if (event.type === 'message_delta') {
      finishReason = mapClaudeStopReason(event.delta?.stop_reason)
      applyUsage(event.usage)
    }
  }

  for (const [, entry] of [...toolUses.entries()].sort(([a], [b]) => a - b)) {
    yield toolCallDoneEvent(turn, entry)
  }

  yield {
    type: 'finish',
    turn,
    finishReason,
    usage: usageFromAnthropic(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
  }
}

/**
 * Explicit prompt-cache breakpoints (Anthropic caches nothing without them):
 * 1. end of system — caches the tools + system prefix, invalidated only when
 *    the system prompt itself changes;
 * 2. end of the conversation — the next turn extends the history, so its
 *    prefix matches this position and reuses the cached conversation.
 * Anthropic matches against the ~20 most recent breakpoint positions, so the
 * sliding tail breakpoint keeps hitting across consecutive turns.
 */
function applyPromptCacheBreakpoints(body: {
  system?: string | ClaudeTextBlock[]
  tools?: ClaudeTool[]
  messages: ClaudeMessage[]
}): void {
  if (body.system) {
    const blocks: ClaudeTextBlock[] = typeof body.system === 'string'
      ? [{ type: 'text', text: body.system }]
      : [...body.system]
    if (blocks.length > 0) {
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: 'ephemeral' },
      }
      body.system = blocks
    }
  } else if (body.tools?.length) {
    body.tools[body.tools.length - 1] = {
      ...body.tools[body.tools.length - 1],
      cache_control: { type: 'ephemeral' },
    }
  }

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i]
    const blocks: ClaudeContentBlock[] = typeof message.content === 'string'
      ? (message.content ? [{ type: 'text', text: message.content }] : [])
      : [...message.content]
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]
    // cache_control is not allowed on thinking blocks.
    if (last.type === 'thinking' || last.type === 'redacted_thinking') continue
    blocks[blocks.length - 1] = {
      ...last,
      cache_control: { type: 'ephemeral' },
    }
    body.messages[i] = { ...message, content: blocks }
    return
  }
}

export function createClaudeAgentProvider(options: ClaudeAgentProviderOptions): AgentProvider {
  const baseUrl = (options.baseUrl || CLAUDE_DEFAULT_BASE_URL).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const capabilities = options.capabilities ?? CLAUDE_CAPABILITIES

  interface ClaudeRequestBody {
    model: string
    messages: ClaudeMessage[]
    max_tokens?: number
    stream: true
    system?: string | ClaudeTextBlock[]
    tools?: ClaudeTool[]
    tool_choice?: ClaudeToolChoice
    temperature?: number
    thinking?:
      | { type: 'adaptive' }
      | { type: 'enabled'; budget_tokens: number }
      | { type: 'disabled' }
    output_config?: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  }

  async function* streamTurn(request: AgentTurnRequest): AsyncGenerator<AgentTurnStreamEvent, void, void> {
    const family = onethingClaudeModelFamily(request.model)
    const thinkingEnabled = request.thinking === 'enabled'
    // Anthropic 的 Messages API 同样要求 user/assistant 交替(它自己不合并):
    // 相邻同角色先合成一条(C5 —— 摘要注入不再垫伪造的 assistant 握手)。
    const converted = buildClaudeMessages(mergeAdjacentSameRoleMessages(request.messages), { includeThinking: thinkingEnabled })
    const tools = request.toolChoice === 'none' ? undefined : toClaudeTools(request.tools)
    const body: ClaudeRequestBody = {
      model: request.model,
      messages: converted.messages,
      // Anthropic requires max_tokens, but we do not invent one (2026-08-15):
      // the app-level caller fills in the model's real max when the registry
      // knows it; when it doesn't, the field is omitted and Anthropic's own
      // "max_tokens: field required" surfaces — an honest error beats a hidden
      // 4096 nobody can find in any setting.
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      stream: true,
    }

    if (thinkingEnabled) {
      const effort = claudeEffort(request.reasoningEffort, family)
      if (family.alwaysThinking) {
        // Fable/Mythos: thinking is always on and the param is rejected —
        // only the effort knob is sent.
        body.output_config = { effort }
      } else if (family.adaptive) {
        body.thinking = { type: 'adaptive' }
        body.output_config = { effort }
      } else {
        const budget = ONETHING_CLAUDE_THINKING_BUDGETS[request.reasoningEffort ?? 'high']
        body.thinking = { type: 'enabled', budget_tokens: budget }
        // budget_tokens must stay below max_tokens.
        if (body.max_tokens !== undefined && body.max_tokens <= budget) body.max_tokens = budget + 4096
      }
    } else if (request.thinking === 'disabled' && family.adaptive && !family.alwaysThinking) {
      // Sonnet 5 runs adaptive thinking when the param is omitted; an explicit
      // off must be sent. Fable rejects 'disabled', hence the guard above.
      body.thinking = { type: 'disabled' }
    }

    const system = systemBody(options, converted.system)
    if (system) body.system = system
    if (tools?.length) {
      body.tools = tools
      body.tool_choice = toClaudeToolChoice(request.toolChoice)
    }
    // Extended thinking requires default sampling, and 4.7+/Sonnet 5/Fable
    // reject temperature outright.
    if (request.temperature !== undefined && !thinkingEnabled && !family.samplingRemoved) {
      body.temperature = request.temperature
    }
    if (options.promptCaching) applyPromptCacheBreakpoints(body)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(!options.omitApiKeyHeader ? { 'x-api-key': options.apiKey ?? '' } : {}),
      'anthropic-version': CLAUDE_VERSION,
      ...options.headers,
    }

    await options.requestDumper?.({
      providerId: options.providerId ?? 'claude',
      model: request.model,
      mode: 'stream',
      metadata: {
        url: `${baseUrl}/messages`,
        method: 'POST',
        turn: request.turn,
      },
      requestBody: body,
    })

    const response = await fetchImpl(`${baseUrl}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: request.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 批 B8-2:Anthropic 429 必带 `retry-after`(秒),另有
      // `anthropic-ratelimit-*-reset`(RFC 3339)。挂成绝对时间戳,冷却按它走。
      throw withProviderRetryAfter(
        new Error(`Claude agent loop API error: ${response.status} ${text}`),
        { headers: response.headers, body: text },
      )
    }

    yield* streamClaudeResponse(response, request.turn)
  }

  /**
   * Forced tool choice is incompatible with extended thinking, and the loop
   * honours that by pairing a forced round with thinking off. Fable/Mythos
   * cannot take that half of the bargain — they always reason, and the API
   * rejects an explicit `disabled` — so for them the honest answer is that
   * they cannot be forced at all, and the loop falls back to `auto`.
   */
  const modelCapabilities = (model: string): AgentModelCapabilities =>
    onethingClaudeModelFamily(model).alwaysThinking
      ? { ...capabilities, supportsForcedToolUse: false }
      : capabilities

  return {
    id: options.providerId ?? 'claude',
    capabilities,
    getModelCapabilities: modelCapabilities,
    streamTurn,
    async runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
      return collectAgentTurnFromStream(streamTurn(request), request.onEvent)
    },
  }
}
