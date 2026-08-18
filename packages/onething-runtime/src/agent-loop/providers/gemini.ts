import { collectAgentTurnFromStream } from '@onething/core/agent-loop'
import { agentToolMessageContentToText } from '@onething/core/agent-loop'
import { mergeAdjacentSameRoleMessages } from './message-merge.js'
import { readJsonSseData } from './sse.js'
import { withProviderRetryAfter } from '../provider-error-classification.js'
import {
  ONETHING_GEMINI_THINKING_BUDGETS,
  onethingGeminiThinkingLevels,
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
  AgentTool,
  AgentToolChoice,
  AgentTurn,
  AgentTurnRequest,
  AgentTurnStreamEvent,
  AgentUsage,
} from '@onething/core/agent-loop'
import type { AgentProviderRequestDumper } from './request-dump.js'

type FetchFn = typeof globalThis.fetch

export interface GeminiAgentProviderOptions {
  apiKey?: string
  baseUrl?: string
  fetchImpl?: FetchFn
  requestDumper?: AgentProviderRequestDumper
}

type GeminiPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | { functionCall: { name: string; args?: AgentJsonObject } }
  | { functionResponse: { name: string; response: AgentJsonObject } }

interface GeminiContent {
  role: 'user' | 'model' | 'function'
  parts: GeminiPart[]
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description?: string
    parameters?: AgentJsonObject
  }>
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'ANY'
    allowedFunctionNames?: string[]
  }
}

interface GeminiThinkingConfig {
  includeThoughts?: boolean
  /** Gemini 3+ knob. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high'
  /** Gemini 2.5 knob: token budget, 0 = off (flash only), -1 = dynamic. */
  thinkingBudget?: number
}

interface GeminiRequestBody {
  systemInstruction?: { parts: Array<{ text: string }> }
  contents: GeminiContent[]
  generationConfig: {
    maxOutputTokens?: number
    temperature?: number
    thinkingConfig?: GeminiThinkingConfig
  }
  tools?: GeminiTool[]
  toolConfig?: GeminiToolConfig
}

const GEMINI_LEVEL_ORDER = ['minimal', 'low', 'medium', 'high'] as const

/**
 * Clamp the abstract effort onto a level the model actually accepts
 * (gemini-3-pro only takes low/high; flash-lite-image only minimal/high):
 * prefer the requested level, else the closest supported one below it, else
 * the lowest supported.
 */
function geminiThinkingLevel(
  effort: AgentTurnRequest['reasoningEffort'],
  model: string,
): 'minimal' | 'low' | 'medium' | 'high' {
  const supported = onethingGeminiThinkingLevels(model)
  const requested = effort === 'minimal' || effort === 'low' || effort === 'medium'
    ? effort
    : 'high'
  if (supported.includes(requested)) return requested
  const requestedIndex = GEMINI_LEVEL_ORDER.indexOf(requested)
  for (let index = requestedIndex - 1; index >= 0; index--) {
    if (supported.includes(GEMINI_LEVEL_ORDER[index])) return GEMINI_LEVEL_ORDER[index]
  }
  return supported[0] ?? 'high'
}

function isGemini25Model(model: string): boolean {
  return model.toLowerCase().includes('2.5')
}

/**
 * Dynamic thinking is Gemini's default, so nothing is sent unless the user
 * chose a setting. Gemini 3+ takes thinkingLevel; 2.5 takes thinkingBudget.
 * "Off" maps to budget 0 on 2.5 flash models and the lowest level elsewhere
 * (2.5 pro and Gemini 3 pro cannot fully disable thinking).
 */
function geminiThinkingConfig(request: AgentTurnRequest): GeminiThinkingConfig | undefined {
  if (request.thinking === 'enabled') {
    const level = geminiThinkingLevel(request.reasoningEffort, request.model)
    return {
      includeThoughts: true,
      ...(isGemini25Model(request.model)
        ? { thinkingBudget: ONETHING_GEMINI_THINKING_BUDGETS[level as keyof typeof ONETHING_GEMINI_THINKING_BUDGETS] }
        : { thinkingLevel: level }),
    }
  }
  if (request.thinking === 'disabled') {
    const model = request.model.toLowerCase()
    if (isGemini25Model(model)) {
      return model.includes('flash') ? { thinkingBudget: 0 } : { thinkingBudget: ONETHING_GEMINI_THINKING_BUDGETS.minimal }
    }
    // The lowest level this model accepts stands in for "off" (Gemini 3
    // cannot fully disable thinking).
    return { thinkingLevel: onethingGeminiThinkingLevels(request.model)[0] ?? 'low' }
  }
  return undefined
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      role?: string
      parts?: Array<{
        text?: string
        thought?: boolean
        functionCall?: {
          name?: string
          args?: AgentJsonObject
        }
      }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
  error?: {
    message?: string
    status?: string
    code?: number
  }
}

interface ToolCallAccumulator {
  id: string
  name: string
  arguments: string
  started: boolean
  done: boolean
}

const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const GEMINI_CAPABILITIES: AgentModelCapabilities = {
  capabilities: [
    'text-input',
    'vision-input',
    'file-input',
    'audio-input',
    'video-input',
    'text-output',
    'streaming',
    'tool-calls',
    'reasoning',
  ],
  inputModalities: ['text', 'image', 'file', 'audio', 'video'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsReasoning: true,
  supportsStreaming: true,
  // functionCallingConfig.mode = 'ANY'
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
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(value)
  if (!match) return undefined
  return { mediaType: match[1], data: match[2] }
}

function dataPart(data: string, mediaType?: string): GeminiPart {
  if (data.startsWith('http://') || data.startsWith('https://')) {
    return { fileData: { mimeType: mediaType, fileUri: data } }
  }
  const parsed = parseDataUrl(data)
  return {
    inlineData: {
      mimeType: parsed?.mediaType ?? mediaType ?? 'application/octet-stream',
      data: parsed?.data ?? data,
    },
  }
}

function userPartsFromContent(content: AgentMessageContent): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : []
  if (!Array.isArray(content)) return []

  const parts: GeminiPart[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) parts.push({ text: part.text })
      continue
    }

    if (part.type === 'image') {
      parts.push(dataPart(part.image, part.mediaType ?? 'image/png'))
      continue
    }

    if (part.type === 'file') {
      parts.push(dataPart(part.data, part.mediaType))
      continue
    }

    if (part.type === 'audio') {
      parts.push(dataPart(part.audio, part.mediaType ?? 'audio/mpeg'))
      continue
    }

    if (part.type === 'video') {
      parts.push(dataPart(part.video, part.mediaType ?? 'video/mp4'))
    }
  }

  return parts
}

function parseToolArguments(args: string): AgentJsonObject {
  const trimmed = args.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as AgentJsonValue
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { value: parsed }
  } catch {
    return { value: trimmed }
  }
}

function toolResultResponse(content: AgentMessageContent): AgentJsonObject {
  const text = agentToolMessageContentToText(content)
  return text ? { result: text } : {}
}

function buildGeminiContents(messages: AgentMessage[]): {
  systemInstruction?: { parts: Array<{ text: string }> }
  contents: GeminiContent[]
} {
  const systemParts: Array<{ text: string }> = []
  const contents: GeminiContent[] = []
  const toolNamesByCallId = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'system') {
      const text = textFromContent(message.content).trim()
      if (text) systemParts.push({ text })
      continue
    }

    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      const text = textFromContent(message.content)
      if (text) parts.push({ text })
      for (const toolCall of message.toolCalls ?? []) {
        toolNamesByCallId.set(toolCall.id, toolCall.name)
        parts.push({
          functionCall: {
            name: toolCall.name,
            args: parseToolArguments(toolCall.arguments),
          },
        })
      }
      if (parts.length > 0) contents.push({ role: 'model', parts })
      continue
    }

    if (message.role === 'tool') {
      const name = toolNamesByCallId.get(message.toolCallId ?? '') ?? message.toolCallId ?? 'tool'
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name,
            response: toolResultResponse(message.content),
          },
        }],
      })
      continue
    }

    const parts = userPartsFromContent(message.content)
    if (parts.length > 0) contents.push({ role: 'user', parts })
  }

  return {
    ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
    contents,
  }
}

function toGeminiTools(tools: AgentTool[] | undefined): GeminiTool[] | undefined {
  if (!tools?.length) return undefined
  return [{
    functionDeclarations: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }]
}

function toGeminiToolConfig(choice: AgentToolChoice | undefined): GeminiToolConfig | undefined {
  if (!choice || choice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  if (choice === 'none') return undefined
  // Gemini's ANY mode means "must call a function"; narrowing to one name is
  // what turns it into a specific-tool choice.
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [choice.function.name],
    },
  }
}

function mapFinishReason(reason: string | undefined): AgentFinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
      // The model attempted a function call that Gemini could not parse. Report
      // tool_calls (with zero valid calls) so the runner's no-valid-call nudge
      // asks the model to re-send, instead of silently ending the run as error.
      return 'tool_calls'
    default:
      return reason ? 'unknown' : 'unknown'
  }
}

function usageFromChunk(chunk: GeminiStreamChunk): AgentUsage | undefined {
  if (!chunk.usageMetadata) return undefined
  const inputTokens = chunk.usageMetadata.promptTokenCount ?? 0
  const outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0
  const totalTokens = chunk.usageMetadata.totalTokenCount ?? inputTokens + outputTokens
  const cacheReadTokens = chunk.usageMetadata.cachedContentTokenCount
  const reasoningTokens = chunk.usageMetadata.thoughtsTokenCount
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
  }
}

function stableToolCallId(turn: number, index: number, name: string): string {
  return `gemini-${turn}-${index}-${name || 'tool'}`
}

function stringifyArgs(args: AgentJsonObject | undefined): string {
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return '{}'
  }
}

function toolCallDoneEvent(
  turn: number,
  entry: ToolCallAccumulator,
): Extract<AgentTurnStreamEvent, { type: 'tool-call-done' }> {
  return {
    type: 'tool-call-done',
    turn,
    toolCall: {
      id: entry.id,
      name: entry.name,
      arguments: entry.arguments,
    },
  }
}

async function* streamGeminiResponse(
  response: Response,
  turn: number,
): AsyncGenerator<AgentTurnStreamEvent, void, void> {
  const toolCalls = new Map<number, ToolCallAccumulator>()
  let usage: AgentUsage | undefined
  let finishReason: AgentFinishReason = 'unknown'
  let toolIndex = 0

  for await (const chunk of readJsonSseData<GeminiStreamChunk>(response, {
    sourceName: 'Gemini agent loop',
    invalidMessage: 'invalid stream chunk',
  })) {
    if (chunk.error) {
      throw new Error(`Gemini agent loop API error: ${chunk.error.message ?? chunk.error.status ?? 'unknown error'}`)
    }

    usage = usageFromChunk(chunk) ?? usage
    const candidate = chunk.candidates?.[0]
    if (candidate?.finishReason) finishReason = mapFinishReason(candidate.finishReason)

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) {
        if (part.thought) {
          yield { type: 'reasoning-delta', turn, delta: part.text }
        } else {
          yield { type: 'text-delta', turn, delta: part.text }
        }
      }

      if (part.functionCall?.name) {
        const index = toolIndex++
        const args = stringifyArgs(part.functionCall.args)
        const entry: ToolCallAccumulator = {
          id: stableToolCallId(turn, index, part.functionCall.name),
          name: part.functionCall.name,
          arguments: args,
          started: true,
          done: true,
        }
        toolCalls.set(index, entry)
        yield {
          type: 'tool-call-start',
          turn,
          toolCallId: entry.id,
          toolName: entry.name,
        }
        if (args) {
          yield {
            type: 'tool-call-delta',
            turn,
            toolCallId: entry.id,
            toolName: entry.name,
            argumentsDelta: args,
          }
        }
        yield toolCallDoneEvent(turn, entry)
      }
    }
  }

  const hasToolCalls = [...toolCalls.values()].some(entry => entry.done)
  yield {
    type: 'finish',
    turn,
    finishReason: hasToolCalls ? 'tool_calls' : finishReason,
    usage,
  }
}

export function createGeminiAgentProvider(options: GeminiAgentProviderOptions): AgentProvider {
  const baseUrl = (options.baseUrl || GEMINI_DEFAULT_BASE_URL).replace(/\/$/, '')
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  async function* streamTurn(request: AgentTurnRequest): AsyncGenerator<AgentTurnStreamEvent, void, void> {
    // Gemini 的 contents 期望 user/model 交替(相邻同角色它自己会合,但依赖
    // 对端的宽容不是接口契约):在这里先合成一条,与 DeepSeek/Claude 同规。
    const { systemInstruction, contents } = buildGeminiContents(mergeAdjacentSameRoleMessages(request.messages))
    const tools = request.toolChoice === 'none' ? undefined : toGeminiTools(request.tools)
    const thinkingConfig = geminiThinkingConfig(request)
    const body: GeminiRequestBody = {
      ...(systemInstruction ? { systemInstruction } : {}),
      contents,
      generationConfig: {
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    }

    if (tools?.length) {
      body.tools = tools
      body.toolConfig = toGeminiToolConfig(request.toolChoice)
    }

    const url = new URL(`${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent`)
    url.searchParams.set('alt', 'sse')
    if (options.apiKey) url.searchParams.set('key', options.apiKey)

    // The live URL carries `key=<apiKey>`; the dump gets a redacted copy.
    const dumpUrl = new URL(url.toString())
    if (dumpUrl.searchParams.has('key')) dumpUrl.searchParams.set('key', '[redacted]')
    await options.requestDumper?.({
      providerId: 'gemini',
      model: request.model,
      mode: 'stream',
      metadata: {
        url: dumpUrl.toString(),
        method: 'POST',
        turn: request.turn,
      },
      requestBody: body,
    })

    const response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.apiKey ? { 'x-goog-api-key': options.apiKey } : {}),
      },
      body: JSON.stringify(body),
      signal: request.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 批 B8-2:Gemini **没有 Retry-After 头** —— 它把 `RetryInfo`
      // (`retryDelay: "27s"`)放在响应体的 `error.details[]` 里。所以这里必须
      // 把 body 也喂给解析器,否则整个家族拿不到任何恢复时刻。
      throw withProviderRetryAfter(
        new Error(`Gemini agent loop API error: ${response.status} ${text}`),
        { headers: response.headers, body: text },
      )
    }

    yield* streamGeminiResponse(response, request.turn)
  }

  return {
    id: 'gemini',
    capabilities: GEMINI_CAPABILITIES,
    getModelCapabilities: () => GEMINI_CAPABILITIES,
    streamTurn,
    async runTurn(request: AgentTurnRequest): Promise<AgentTurn> {
      return collectAgentTurnFromStream(streamTurn(request), request.onEvent)
    },
  }
}
