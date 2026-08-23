import { toJsonObject } from '@onething/core'
import type { OnethingOpenRouterModel } from './model-registry.js'
import {
  onethingToolResultPayloadFromPart,
  onethingToolResultToCodexOutput,
} from './tool-result-content.js'
import type { OnethingOAuthToken } from '../auth/types.js'

export const ONETHING_CODEX_PROVIDER_ID = 'codex'
export const ONETHING_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const ONETHING_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const ONETHING_CODEX_DEFAULT_MODEL = 'gpt-5.3-codex'
export const ONETHING_CODEX_CLIENT_VERSION = process.env.npm_package_version || '1.1.0'
export const ONETHING_CODEX_FALLBACK_INSTRUCTIONS = 'You are Codex, a helpful AI coding assistant.'
export const ONETHING_CODEX_REASONING_INCLUDE = 'reasoning.encrypted_content'
export const ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL = 'image_generation'

const ONETHING_CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
const ONETHING_CODEX_FALLBACK_REASONING_EFFORTS: OnethingCodexReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]
const ONETHING_CODEX_RESPONSES_ALLOWED_KEYS = new Set([
  'model',
  'instructions',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'service_tier',
  'prompt_cache_key',
  'text',
  'client_metadata',
])

export type OnethingCodexRawPrimitive = string | number | boolean | null | undefined
export type OnethingCodexRawRecord = { [key: string]: OnethingCodexRawValue }
export type OnethingCodexRawValue =
  | OnethingCodexRawPrimitive
  | OnethingCodexRawRecord
  | OnethingCodexRawValue[]
  | object

export type OnethingCodexProviderOptions = {
  [key: string]: OnethingCodexRawValue
}

export type OnethingCodexResponsesBody = {
  [key: string]: OnethingCodexRawValue
}

export type OnethingCodexReasoningEffort = typeof ONETHING_CODEX_REASONING_EFFORTS[number]
export type OnethingCodexNativeToolName = typeof ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL

export interface OnethingCodexReasoningLevel {
  effort: OnethingCodexReasoningEffort
  description?: string
}

export interface OnethingCodexServiceTier {
  id: string
  name: string
  description?: string
}

export interface OnethingCodexModelProviderMetadata {
  defaultReasoningEffort: OnethingCodexReasoningEffort
  supportedReasoningEfforts: OnethingCodexReasoningLevel[]
  supportsReasoningSummaries: boolean
  serviceTiers: OnethingCodexServiceTier[]
  nativeTools: OnethingCodexNativeToolName[]
}

export interface OnethingCodexUsageWindow {
  usedPercent: number
  windowSeconds?: number
  resetAfterSeconds?: number
  resetAt?: number
}

export interface OnethingCodexUsageCredits {
  hasCredits: boolean
  unlimited: boolean
  balance?: string
}

export interface OnethingCodexUsageLimit {
  id: string
  name?: string
  primary?: OnethingCodexUsageWindow
  secondary?: OnethingCodexUsageWindow
  rateLimitReachedType?: string
}

export interface OnethingCodexProviderUsage {
  planType?: string
  credits?: OnethingCodexUsageCredits
  limits: OnethingCodexUsageLimit[]
}

export type OnethingCodexOAuthToken = Pick<
  OnethingOAuthToken,
  'accessToken' | 'accountId' | 'isFedrampAccount'
>

export type OnethingCodexFetchFn = typeof globalThis.fetch

export interface OnethingCodexFetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface OnethingCodexFunctionToolDefinition {
  type: 'function'
  name: string
  description?: string
  inputSchema?: object
}

export type OnethingCodexCallOptionValue =
  | OnethingCodexRawValue
  | OnethingCodexRawValue[]
  | OnethingCodexFunctionToolDefinition[]
  | Array<OnethingCodexFunctionToolDefinition | OnethingCodexRawRecord>
  | Record<string, string | undefined>
  | AbortSignal

export interface OnethingCodexCallOptions {
  prompt: OnethingCodexRawValue[]
  tools?: Array<OnethingCodexFunctionToolDefinition | { type: string; [key: string]: OnethingCodexRawValue }>
  providerOptions?: OnethingCodexProviderOptions
  headers?: Record<string, string | undefined>
  abortSignal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
  [key: string]: OnethingCodexCallOptionValue
}

export interface OnethingCodexCallWarning {
  type: 'unsupported-setting'
  setting: keyof OnethingCodexCallOptions
  details?: string
}

export interface OnethingCodexContentItem {
  type: 'input_text' | 'output_text' | 'input_image'
  text?: string
  image_url?: string
  detail?: 'auto'
}

export interface OnethingCodexMessageItem {
  type: 'message'
  role: 'developer' | 'user' | 'assistant'
  content: OnethingCodexContentItem[]
}

export interface OnethingCodexFunctionCallItem {
  type: 'function_call'
  name: string
  arguments: string
  call_id: string
}

export interface OnethingCodexFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | OnethingCodexContentItem[]
}

export interface OnethingCodexReasoningInputItem {
  type: 'reasoning'
  summary: unknown[]
  encrypted_content: string
}

export type OnethingCodexInputItem =
  | OnethingCodexMessageItem
  | OnethingCodexFunctionCallItem
  | OnethingCodexFunctionCallOutputItem
  | OnethingCodexReasoningInputItem

export interface OnethingCodexFunctionTool {
  type: 'function'
  name: string
  description?: string
  strict: false
  parameters: object
}

export interface OnethingCodexImageGenerationTool {
  type: typeof ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL
  output_format: 'png'
}

export type OnethingCodexTool = OnethingCodexFunctionTool | OnethingCodexImageGenerationTool

export interface OnethingCodexReasoningOptions {
  effort: OnethingCodexReasoningEffort
  summary?: 'auto' | 'concise' | 'detailed'
}

export interface OnethingCodexRequest {
  model: string
  instructions: string
  input: OnethingCodexInputItem[]
  tools: OnethingCodexTool[]
  tool_choice: 'auto'
  parallel_tool_calls: false
  reasoning?: OnethingCodexReasoningOptions
  store: false
  stream: true
  include: string[]
  service_tier?: string
  prompt_cache_key?: string
  text?: OnethingCodexRawRecord
  client_metadata?: OnethingCodexRawRecord
}

export interface BuiltOnethingCodexRequest {
  body: OnethingCodexRequest
  warnings: OnethingCodexCallWarning[]
}

export interface OnethingCodexUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  totalTokens: number | undefined
  reasoningTokens?: number | undefined
  cachedInputTokens?: number | undefined
}

export type OnethingCodexFinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'content-filter'
  | 'error'
  | 'other'
  | 'unknown'

export interface OnethingCodexSseEvent {
  type?: string
  delta?: string
  input?: string
  arguments_delta?: string
  argumentsDelta?: string
  text?: string
  summary?: OnethingCodexRawValue
  summary_text?: OnethingCodexRawValue
  summaryText?: OnethingCodexRawValue
  item_id?: string
  itemId?: string
  call_id?: string
  callId?: string
  output_index?: number
  item?: OnethingCodexRawRecord
  response?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      total_tokens?: number
      output_tokens_details?: { reasoning_tokens?: number }
      input_tokens_details?: { cached_tokens?: number }
    }
    error?: { message?: string; code?: string; type?: string }
    incomplete_details?: { reason?: string }
  }
  error?: { message?: string; code?: string; type?: string }
}

export type OnethingCodexFunctionCallSseItem = OnethingCodexRawRecord & {
  type: 'function_call' | 'custom_tool_call'
}

export type OnethingCodexImageGenerationSseItem = OnethingCodexRawRecord & {
  type: typeof ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL | 'image_generation_call'
}

export interface OnethingCodexApiError extends Error {
  statusCode: number
  responseBody: string
  responseHeaders: Record<string, string>
  isRetryable: boolean
}

export interface OnethingCodexPreparedCallOptions<TOptions extends {
  messages?: unknown
  providerOptions?: unknown
  tools?: unknown
  toolChoice?: unknown
  maxOutputTokens?: unknown
}> {
  options: TOptions
}

export function onethingCodexRecordFromValue(value: OnethingCodexRawValue): OnethingCodexRawRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as OnethingCodexRawRecord
    : {}
}

export function onethingCodexOptionalStringFromValue(value: OnethingCodexRawValue): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalOnethingCodexRecordFromValue(
  value: OnethingCodexRawValue,
): OnethingCodexRawRecord | undefined {
  const record = onethingCodexRecordFromValue(value)
  return Object.keys(record).length > 0 ? record : undefined
}

export function onethingCodexStringArrayFromValue(value: OnethingCodexRawValue): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values
    .map((item) => {
      if (typeof item === 'string') return item.trim()
      const record = onethingCodexRecordFromValue(item)
      const candidate = record.id ?? record.name ?? record.type ?? record.value
      return typeof candidate === 'string' ? candidate.trim() : ''
    })
    .filter(Boolean)
}

export function buildOnethingCodexHeaders(token: OnethingCodexOAuthToken): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    originator: 'codex_cli_rs',
    version: ONETHING_CODEX_CLIENT_VERSION,
    'User-Agent': `codex_cli_rs/${ONETHING_CODEX_CLIENT_VERSION}`,
  }

  if (token.accountId) {
    headers['ChatGPT-Account-ID'] = token.accountId
  }
  if (token.isFedrampAccount) {
    headers['X-OpenAI-Fedramp'] = 'true'
  }

  return headers
}

export function mapOnethingCodexFinishReason(reason: string | null | undefined): OnethingCodexFinishReason {
  switch (reason) {
    case 'stop':
    case 'completed':
      return 'stop'
    case 'max_output_tokens':
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
    case 'tool-calls':
      return 'tool-calls'
    case 'content_filter':
    case 'content-filter':
      return 'content-filter'
    case 'failed':
    case 'error':
      return 'error'
    default:
      return reason ? 'other' : 'unknown'
  }
}

export function isOnethingCodexUsage(value: OnethingCodexRawValue): value is OnethingCodexUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Partial<OnethingCodexUsage>
  return (
    (usage.inputTokens === undefined || typeof usage.inputTokens === 'number') &&
    (usage.outputTokens === undefined || typeof usage.outputTokens === 'number') &&
    (usage.totalTokens === undefined || typeof usage.totalTokens === 'number')
  )
}

export function onethingCodexUsageFromResponse(
  response: OnethingCodexSseEvent['response'],
): OnethingCodexUsage {
  const usage = response?.usage
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
  }
}

export function hasMeaningfulOnethingCodexUsage(usage: OnethingCodexUsage): boolean {
  return usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.cachedInputTokens !== undefined
}

export function extractOnethingCodexOutputText(item: OnethingCodexRawValue): string {
  const itemRecord = onethingCodexRecordFromValue(item)
  if (!Array.isArray(itemRecord.content)) return ''
  return itemRecord.content
    .map((content) => {
      const contentRecord = onethingCodexRecordFromValue(content)
      if (typeof contentRecord.text === 'string') return contentRecord.text
      if (typeof contentRecord.content === 'string') return contentRecord.content
      return ''
    })
    .filter(Boolean)
    .join('')
}

export function collectOnethingCodexReasoningSummaryText(value: OnethingCodexRawValue): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (!value || typeof value !== 'object') return []

  if (Array.isArray(value)) {
    return value.flatMap(collectOnethingCodexReasoningSummaryText)
  }

  const record = onethingCodexRecordFromValue(value)
  const fragments: string[] = []
  for (const key of ['text', 'summary_text', 'summaryText', 'value']) {
    const text = record[key]
    if (typeof text === 'string' && text.length > 0) {
      fragments.push(text)
    }
  }
  for (const key of ['summary', 'parts', 'items']) {
    fragments.push(...collectOnethingCodexReasoningSummaryText(record[key]))
  }
  return fragments
}

export function extractOnethingCodexReasoningSummaryText(item: OnethingCodexRawValue): string {
  const record = onethingCodexRecordFromValue(item)
  return collectOnethingCodexReasoningSummaryText([
    record.summary,
    record.text,
    record.summary_text,
    record.summaryText,
    record.reasoning_summary,
    record.reasoningSummary,
  ]).join('')
}

export function isOnethingCodexImageGenerationItem(
  item: OnethingCodexRawValue,
): item is OnethingCodexImageGenerationSseItem {
  const record = onethingCodexRecordFromValue(item)
  return record.type === ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL ||
    record.type === 'image_generation_call'
}

export function isOnethingCodexFunctionCallItem(
  item: OnethingCodexRawValue,
): item is OnethingCodexFunctionCallSseItem {
  const record = onethingCodexRecordFromValue(item)
  return record.type === 'function_call' || record.type === 'custom_tool_call'
}

export function getOnethingCodexImageGenerationCallId(
  item: OnethingCodexRawValue,
  event?: OnethingCodexSseEvent,
): string | undefined {
  const record = onethingCodexRecordFromValue(item)
  const callId = record.id ?? record.call_id ?? record.callId ?? event?.item_id ?? event?.itemId
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined
}

export function getOnethingCodexReasoningItemId(
  item: OnethingCodexRawValue,
  event: OnethingCodexSseEvent,
  fallback: string,
): string {
  const record = onethingCodexRecordFromValue(item)
  const id = record.id ?? record.item_id ?? event.item_id ?? event.itemId
  return typeof id === 'string' && id.length > 0 ? id : fallback
}

export function headersToOnethingCodexRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'set-cookie' || lower === 'cookie' || lower === 'authorization') return
    record[key] = value
  })
  return record
}

export function createOnethingCodexApiError(status: number, responseBody: string, headers: Headers): Error {
  const detail = summarizeOnethingCodexErrorBody(responseBody)
  const requestId = headers.get('x-oai-request-id')
  const message = `Codex request failed (${status})${detail ? `: ${detail}` : ''}${requestId ? ` [request-id: ${requestId}]` : ''}`
  const error: OnethingCodexApiError = Object.assign(new Error(message), {
    statusCode: status,
    responseBody,
    responseHeaders: headersToOnethingCodexRecord(headers),
    isRetryable: status >= 500 || status === 429,
  })
  return error
}

export function decodeOnethingCodexSseEventData(
  eventName: string | null,
  dataLines: string[],
): OnethingCodexSseEvent | null {
  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    if (eventName && !parsed.type) parsed.type = eventName
    return parsed
  } catch {
    return null
  }
}

export async function* parseOnethingCodexSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OnethingCodexSseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | null = null
  let dataLines: string[] = []

  const flush = function* (): Generator<OnethingCodexSseEvent> {
    const event = decodeOnethingCodexSseEventData(eventName, dataLines)
    eventName = null
    dataLines = []
    if (event) yield event
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line === '') {
          yield* flush()
          continue
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }

    if (buffer.trim()) {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
      else dataLines.push(buffer.trim())
    }
    yield* flush()
  } finally {
    reader.releaseLock()
  }
}

export function createOnethingStreamFromGenerator<T>(generator: AsyncGenerator<T>): ReadableStream<T> {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await generator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await generator.return?.(undefined)
    },
  })
}

function previewOnethingCodexText(value: unknown, maxLength = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function onethingCodexInputText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const record = onethingCodexRecordFromValue(part as OnethingCodexRawValue)
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function summarizeOnethingCodexRequestBody(
  body: OnethingCodexRequest,
): Record<string, unknown> {
  const messages = body.input.filter(item => item.type === 'message')
  const lastUser = [...messages].reverse().find(item => item.role === 'user')
  return {
    model: body.model,
    inputCount: body.input.length,
    messageCount: messages.length,
    toolCount: body.tools.length,
    stream: body.stream,
    lastUserPreview: previewOnethingCodexText(onethingCodexInputText(lastUser?.content)),
  }
}

export type OnethingCodexStreamPart = { type: string; [key: string]: OnethingCodexRawValue }

export interface OnethingCodexStreamOptions {
  modelId: string
  warnings?: OnethingCodexCallWarning[]
  providerId?: string
  now?: () => Date
  onEvent?: (event: OnethingCodexSseEvent) => void
}

export interface OnethingCodexStreamRequestContext {
  providerId: string
  modelId: string
  url: string
  method: 'POST'
  body: OnethingCodexRequest
  warnings: OnethingCodexCallWarning[]
}

export interface OnethingCodexStreamRequestOptions {
  modelId: string
  token: OnethingCodexOAuthToken
  fetchImpl: OnethingCodexFetchFn
  callOptions: OnethingCodexCallOptions
  baseUrl?: string
  providerId?: string
  now?: () => Date
  onRequestPrepared?: (context: OnethingCodexStreamRequestContext) => void | Promise<void>
  onStreamEvent?: (event: OnethingCodexSseEvent) => void
}

export interface OnethingCodexStreamRequestResult {
  stream: ReadableStream<OnethingCodexStreamPart>
  request: { body: string }
  response: { headers: Record<string, string> }
}

export type OnethingCodexGeneratedContent = { type: string; [key: string]: OnethingCodexRawValue }

export interface OnethingCodexGenerateResult {
  content: OnethingCodexGeneratedContent[]
  finishReason: OnethingCodexFinishReason
  usage: OnethingCodexUsage
  warnings: OnethingCodexCallWarning[]
  request?: { body?: OnethingCodexRawValue }
  response?: { headers?: Record<string, string>; modelId?: string; timestamp?: Date }
}

export interface OnethingCodexGenerateCollectOptions {
  modelId: string
  now?: () => Date
}

interface OnethingCodexActiveFunctionCallInput {
  itemId: string
  callId: string
  toolName: string
  streamedArgs: string
  started: boolean
}

function getOnethingCodexFunctionCallItemId(
  item: OnethingCodexRawRecord,
  event?: OnethingCodexSseEvent,
  fallback?: string,
): string | undefined {
  const id = item.id ?? item.item_id ?? item.itemId ?? event?.item_id ?? fallback
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function getOnethingCodexFunctionCallCallId(
  item: OnethingCodexRawRecord,
  event?: OnethingCodexSseEvent,
): string | undefined {
  const callId = item.call_id ?? item.callId ?? event?.call_id ?? item.id
  return typeof callId === 'string' && callId.length > 0 ? callId : undefined
}

function getOnethingCodexFunctionCallToolName(item: OnethingCodexRawRecord): string | undefined {
  const name = item.name ?? item.tool_name ?? item.toolName
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

function getOnethingCodexFunctionCallArgs(item: OnethingCodexRawRecord): string {
  if (typeof item.arguments === 'string') return item.arguments
  if (typeof item.input === 'string') return item.input
  const value = item.arguments ?? item.input ?? {}
  return JSON.stringify(value)
}

export async function* streamOnethingCodexSseEvents(
  events: AsyncIterable<OnethingCodexSseEvent> | Iterable<OnethingCodexSseEvent>,
  options: OnethingCodexStreamOptions,
): AsyncGenerator<OnethingCodexStreamPart> {
  const warnings = options.warnings ?? []
  const providerId = options.providerId ?? ONETHING_CODEX_PROVIDER_ID
  const now = options.now ?? (() => new Date())

  yield { type: 'stream-start', warnings }

  let usage: OnethingCodexUsage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  }
  let finishReason: OnethingCodexFinishReason = 'unknown'
  let textStarted = false
  let reasoningStarted = false
  let emittedTextFromDelta = false
  let responseId: string | undefined
  let responseModelId: string | undefined
  let toolCallsEmitted = false
  let activeReasoningItemId: string | undefined
  const reasoningSummaryByItem = new Map<string, string>()
  const textId = 'text-0'
  const reasoningId = 'reasoning-0'

  const closeReasoning = function* (): Generator<OnethingCodexStreamPart> {
    if (reasoningStarted) {
      yield { type: 'reasoning-end', id: reasoningId }
      reasoningStarted = false
    }
  }

  const closeText = function* (): Generator<OnethingCodexStreamPart> {
    if (textStarted) {
      yield { type: 'text-end', id: textId }
      textStarted = false
    }
  }

  const emitText = function* (delta: string): Generator<OnethingCodexStreamPart> {
    if (!delta) return
    yield* closeReasoning()
    if (!textStarted) {
      textStarted = true
      yield { type: 'text-start', id: textId }
    }
    emittedTextFromDelta = true
    yield { type: 'text-delta', id: textId, delta }
  }

  const emitReasoning = function* (
    delta: string,
    itemId: string = reasoningId,
  ): Generator<OnethingCodexStreamPart> {
    if (!delta) return
    if (textStarted) {
      yield { type: 'text-end', id: textId }
      textStarted = false
    }
    if (!reasoningStarted) {
      reasoningStarted = true
      yield { type: 'reasoning-start', id: reasoningId }
    }
    reasoningSummaryByItem.set(itemId, `${reasoningSummaryByItem.get(itemId) ?? ''}${delta}`)
    yield { type: 'reasoning-delta', id: reasoningId, delta }
  }

  const toolInputByItemId = new Map<string, OnethingCodexActiveFunctionCallInput>()
  const toolInputByCallId = new Map<string, OnethingCodexActiveFunctionCallInput>()
  const pendingToolInputDeltas = new Map<string, string>()

  const registerFunctionCallInput = (
    item: OnethingCodexRawRecord,
    event?: OnethingCodexSseEvent,
  ): OnethingCodexActiveFunctionCallInput | undefined => {
    const callId = getOnethingCodexFunctionCallCallId(item, event)
    const toolName = getOnethingCodexFunctionCallToolName(item)
    if (!callId || !toolName) return
    const itemId = getOnethingCodexFunctionCallItemId(item, event, callId) ?? callId
    const existing = toolInputByItemId.get(itemId) ?? toolInputByCallId.get(callId)
    if (existing) {
      existing.callId = callId
      existing.toolName = toolName
      toolInputByItemId.set(itemId, existing)
      toolInputByCallId.set(callId, existing)
      return existing
    }
    const state: OnethingCodexActiveFunctionCallInput = {
      itemId,
      callId,
      toolName,
      streamedArgs: '',
      started: false,
    }
    toolInputByItemId.set(itemId, state)
    toolInputByCallId.set(callId, state)
    return state
  }

  const startFunctionCallInput = function* (
    state: OnethingCodexActiveFunctionCallInput,
  ): Generator<OnethingCodexStreamPart> {
    if (state.started) return
    toolCallsEmitted = true
    yield* closeReasoning()
    yield* closeText()
    yield { type: 'tool-input-start', id: state.callId, toolName: state.toolName }
    state.started = true
  }

  const flushPendingFunctionCallDeltas = function* (
    state: OnethingCodexActiveFunctionCallInput,
  ): Generator<OnethingCodexStreamPart> {
    const keys = Array.from(new Set([state.itemId, state.callId]))
    for (const key of keys) {
      const delta = pendingToolInputDeltas.get(key)
      if (!delta) continue
      pendingToolInputDeltas.delete(key)
      yield* startFunctionCallInput(state)
      state.streamedArgs += delta
      yield { type: 'tool-input-delta', id: state.callId, delta }
    }
  }

  const registerAndStartFunctionCallInput = function* (
    item: OnethingCodexRawRecord,
    event?: OnethingCodexSseEvent,
  ): Generator<OnethingCodexStreamPart> {
    const state = registerFunctionCallInput(item, event)
    if (!state) return
    yield* startFunctionCallInput(state)
    yield* flushPendingFunctionCallDeltas(state)
  }

  const emitFunctionCallInputDelta = function* (
    event: OnethingCodexSseEvent,
  ): Generator<OnethingCodexStreamPart> {
    const delta = event.delta ?? event.input ?? event.arguments_delta ?? event.argumentsDelta ?? ''
    if (!delta) return
    const itemId = typeof event.item_id === 'string' ? event.item_id : event.itemId
    const callId = typeof event.call_id === 'string' ? event.call_id : event.callId
    const state = (itemId ? toolInputByItemId.get(itemId) : undefined) ??
      (callId ? toolInputByCallId.get(callId) : undefined)
    if (!state) {
      const key = itemId ?? callId
      if (key) pendingToolInputDeltas.set(key, `${pendingToolInputDeltas.get(key) ?? ''}${delta}`)
      return
    }
    yield* startFunctionCallInput(state)
    state.streamedArgs += delta
    yield { type: 'tool-input-delta', id: state.callId, delta }
  }

  const emitFunctionCall = function* (
    item: OnethingCodexRawRecord,
    event?: OnethingCodexSseEvent,
  ): Generator<OnethingCodexStreamPart> {
    const callId = getOnethingCodexFunctionCallCallId(item, event)
    const toolName = getOnethingCodexFunctionCallToolName(item)
    if (!callId || !toolName) return
    const state = registerFunctionCallInput(item, event)
    const args = getOnethingCodexFunctionCallArgs(item)

    if (state) {
      yield* startFunctionCallInput(state)
      yield* flushPendingFunctionCallDeltas(state)
      if (args && !state.streamedArgs) {
        state.streamedArgs = args
        yield { type: 'tool-input-delta', id: callId, delta: args }
      } else if (args && args.startsWith(state.streamedArgs) && args.length > state.streamedArgs.length) {
        const suffix = args.slice(state.streamedArgs.length)
        state.streamedArgs = args
        yield { type: 'tool-input-delta', id: callId, delta: suffix }
      }
      yield { type: 'tool-input-end', id: callId }
      toolInputByItemId.delete(state.itemId)
      toolInputByCallId.delete(state.callId)
    } else {
      toolCallsEmitted = true
      yield* closeReasoning()
      yield* closeText()
      yield { type: 'tool-input-start', id: callId, toolName }
      if (args) {
        yield { type: 'tool-input-delta', id: callId, delta: args }
      }
      yield { type: 'tool-input-end', id: callId }
    }

    yield {
      type: 'tool-call',
      toolCallId: callId,
      toolName,
      input: args,
    }
  }

  const emitImageGenerationStart = function* (
    item: OnethingCodexRawRecord,
    event?: OnethingCodexSseEvent,
  ): Generator<OnethingCodexStreamPart> {
    const callId = getOnethingCodexImageGenerationCallId(item, event)
    if (!callId) return
    const status = onethingCodexOptionalStringFromValue(item.status)
    yield* closeReasoning()
    yield* closeText()
    yield {
      type: 'raw',
      rawValue: {
        provider: providerId,
        type: 'image-generation-start',
        callId,
        status,
      },
    }
  }

  const emitImageGenerationResult = function* (
    item: OnethingCodexRawRecord,
    event?: OnethingCodexSseEvent,
  ): Generator<OnethingCodexStreamPart> {
    const callId = getOnethingCodexImageGenerationCallId(item, event)
    const result = onethingCodexOptionalStringFromValue(item.result) ?? ''
    if (!callId || !result) return
    const revisedPrompt = onethingCodexOptionalStringFromValue(item.revised_prompt) ??
      onethingCodexOptionalStringFromValue(item.revisedPrompt)
    yield* closeReasoning()
    yield* closeText()
    yield {
      type: 'raw',
      rawValue: {
        provider: providerId,
        type: 'image-generation-result',
        callId,
        status: onethingCodexOptionalStringFromValue(item.status) ?? 'completed',
        revisedPrompt,
        result,
      },
    }
  }

  for await (const event of events) {
    options.onEvent?.(event)

    if (event.error) {
      throw new Error(`Codex stream error: ${event.error.message ?? 'unknown error'}`)
    }

    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.content_part.added':
      case 'response.output_text.done':
      case 'response.reasoning_text.done':
        break

      case 'response.output_item.added': {
        if (event.item?.type === 'reasoning') {
          activeReasoningItemId = getOnethingCodexReasoningItemId(event.item, event, reasoningId)
          const summary = extractOnethingCodexReasoningSummaryText(event.item)
          if (summary && !reasoningSummaryByItem.get(activeReasoningItemId)?.trim()) {
            yield* emitReasoning(summary, activeReasoningItemId)
          }
        } else if (isOnethingCodexFunctionCallItem(event.item)) {
          yield* registerAndStartFunctionCallInput(event.item, event)
        } else if (isOnethingCodexImageGenerationItem(event.item)) {
          yield* emitImageGenerationStart(event.item, event)
        }
        break
      }

      case 'response.output_text.delta':
        yield* emitText(event.delta ?? '')
        break

      case 'response.reasoning_summary_text.delta': {
        const itemId = getOnethingCodexReasoningItemId(undefined, event, activeReasoningItemId ?? reasoningId)
        yield* emitReasoning(event.delta ?? event.text ?? '', itemId)
        break
      }

      case 'response.reasoning_summary_part.added': {
        const itemId = getOnethingCodexReasoningItemId(undefined, event, activeReasoningItemId ?? reasoningId)
        if (reasoningSummaryByItem.get(itemId)?.trim()) {
          yield* emitReasoning('\n\n', itemId)
        }
        break
      }

      case 'response.reasoning_summary_text.done': {
        const itemId = getOnethingCodexReasoningItemId(undefined, event, activeReasoningItemId ?? reasoningId)
        const summary = collectOnethingCodexReasoningSummaryText([
          event.text,
          event.summary,
          event.summary_text,
          event.summaryText,
        ]).join('')
        if (summary && !reasoningSummaryByItem.get(itemId)?.trim()) {
          yield* emitReasoning(summary, itemId)
        }
        break
      }

      case 'response.reasoning_text.delta':
        break

      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
        yield* emitFunctionCallInputDelta(event)
        break

      case 'response.output_item.done': {
        const item = event.item
        if (isOnethingCodexFunctionCallItem(item)) {
          yield* emitFunctionCall(item, event)
          finishReason = 'tool-calls'
        } else if (isOnethingCodexImageGenerationItem(item)) {
          yield* emitImageGenerationResult(item, event)
        } else if (item?.type === 'reasoning') {
          const itemId = getOnethingCodexReasoningItemId(item, event, activeReasoningItemId ?? reasoningId)
          const summary = extractOnethingCodexReasoningSummaryText(item)
          if (summary && !reasoningSummaryByItem.get(itemId)?.trim()) {
            yield* emitReasoning(summary, itemId)
          }
          if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) {
            yield {
              type: 'raw',
              rawValue: {
                provider: providerId,
                type: 'encrypted-reasoning',
                encryptedContent: item.encrypted_content,
              },
            }
          }
          if (activeReasoningItemId === itemId) {
            activeReasoningItemId = undefined
          }
        } else if (item?.type === 'message' && !emittedTextFromDelta) {
          yield* emitText(extractOnethingCodexOutputText(item))
        }
        break
      }

      case 'response.completed': {
        responseId = event.response?.id ?? responseId
        responseModelId = event.response?.model ?? responseModelId
        const nextUsage = onethingCodexUsageFromResponse(event.response)
        if (hasMeaningfulOnethingCodexUsage(nextUsage)) usage = nextUsage
        if (finishReason !== 'tool-calls') finishReason = 'stop'
        break
      }

      case 'response.incomplete':
        responseId = event.response?.id ?? responseId
        responseModelId = event.response?.model ?? responseModelId
        finishReason = mapOnethingCodexFinishReason(event.response?.incomplete_details?.reason)
        break

      case 'response.failed': {
        const message = event.response?.error?.message || 'Codex stream failed'
        throw new Error(`Codex stream error: ${message}`)
      }

      default:
        if (event.response?.usage) {
          const nextUsage = onethingCodexUsageFromResponse(event.response)
          if (hasMeaningfulOnethingCodexUsage(nextUsage)) usage = nextUsage
        }
        break
    }
  }

  yield* closeReasoning()
  yield* closeText()
  if (responseId || responseModelId) {
    yield {
      type: 'response-metadata',
      id: responseId,
      modelId: responseModelId ?? options.modelId,
      timestamp: now(),
    }
  }
  yield {
    type: 'finish',
    finishReason: toolCallsEmitted ? 'tool-calls' : finishReason,
    usage,
  }
}

export async function* streamOnethingCodexResponseBody(
  body: ReadableStream<Uint8Array>,
  options: OnethingCodexStreamOptions,
): AsyncGenerator<OnethingCodexStreamPart> {
  yield* streamOnethingCodexSseEvents(parseOnethingCodexSseStream(body), options)
}

function definedOnethingCodexHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

export async function requestOnethingCodexStream(
  options: OnethingCodexStreamRequestOptions,
): Promise<OnethingCodexStreamRequestResult> {
  const providerId = options.providerId ?? ONETHING_CODEX_PROVIDER_ID
  const baseUrl = options.baseUrl ?? ONETHING_CODEX_BASE_URL
  const url = `${baseUrl}/responses`
  const { body, warnings } = buildOnethingCodexRequest(options.modelId, options.callOptions)

  await options.onRequestPrepared?.({
    providerId,
    modelId: options.modelId,
    url,
    method: 'POST',
    body,
    warnings,
  })

  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      ...buildOnethingCodexHeaders(options.token),
      ...definedOnethingCodexHeaders(options.callOptions.headers),
    },
    body: JSON.stringify(body),
    signal: options.callOptions.abortSignal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw createOnethingCodexApiError(response.status, text, response.headers)
  }
  if (!response.body) {
    throw new Error('Codex request failed: response body is empty')
  }

  async function* processStream(): AsyncGenerator<OnethingCodexStreamPart> {
    yield* streamOnethingCodexResponseBody(response.body!, {
      modelId: options.modelId,
      warnings,
      providerId,
      now: options.now,
      onEvent: options.onStreamEvent,
    })
  }

  return {
    stream: createOnethingStreamFromGenerator(processStream()),
    request: { body: JSON.stringify(body) },
    response: { headers: headersToOnethingCodexRecord(response.headers) },
  }
}

export async function collectOnethingCodexGenerateResult(
  streamResult: {
    stream: ReadableStream<OnethingCodexStreamPart>
    request?: { body?: OnethingCodexRawValue }
    response?: { headers?: Record<string, string> }
  },
  options: OnethingCodexGenerateCollectOptions,
): Promise<OnethingCodexGenerateResult> {
  const reader = streamResult.stream.getReader()
  const content: OnethingCodexGeneratedContent[] = []
  const textById = new Map<string, string>()
  const reasoningById = new Map<string, string>()
  let finishReason: OnethingCodexFinishReason = 'unknown'
  let usage: OnethingCodexUsage = {
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      if (value.type === 'text-delta' && typeof value.id === 'string' && typeof value.delta === 'string') {
        textById.set(value.id, `${textById.get(value.id) ?? ''}${value.delta}`)
      } else if (value.type === 'reasoning-delta' && typeof value.id === 'string' && typeof value.delta === 'string') {
        reasoningById.set(value.id, `${reasoningById.get(value.id) ?? ''}${value.delta}`)
      } else if (value.type === 'tool-call') {
        content.push(value)
      } else if (value.type === 'finish') {
        finishReason = mapOnethingCodexFinishReason(typeof value.finishReason === 'string' ? value.finishReason : undefined)
        if (isOnethingCodexUsage(value.usage)) usage = value.usage
      }
    }
  } finally {
    reader.releaseLock()
  }

  for (const text of textById.values()) {
    if (text) content.unshift({ type: 'text', text })
  }
  for (const reasoning of reasoningById.values()) {
    if (reasoning) content.unshift({ type: 'reasoning', text: reasoning })
  }

  return {
    content,
    finishReason,
    usage,
    warnings: [],
    request: streamResult.request,
    response: {
      headers: streamResult.response?.headers,
      modelId: options.modelId,
      timestamp: options.now?.() ?? new Date(),
    },
  }
}

export function normalizeOnethingCodexReasoningEffort(
  effort: OnethingCodexRawValue,
): OnethingCodexReasoningEffort {
  const value = typeof effort === 'string' ? effort.toLowerCase() : ''
  if (value === 'max') return 'high'
  return ONETHING_CODEX_REASONING_EFFORTS.includes(value as OnethingCodexReasoningEffort)
    ? value as OnethingCodexReasoningEffort
    : 'medium'
}

function normalizeOnethingCodexReasoningSummary(
  summary: OnethingCodexRawValue,
): 'auto' | 'concise' | 'detailed' | undefined {
  const value = typeof summary === 'string' ? summary.toLowerCase() : ''
  return value === 'auto' || value === 'concise' || value === 'detailed'
    ? value
    : 'auto'
}

function addUnique(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value]
}

function contentToOnethingCodexInstructionText(content: OnethingCodexRawValue): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const record = onethingCodexRecordFromValue(part)
        if (record.type === 'text' && typeof record.text === 'string') return record.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : String(content)
}

function isOnethingCodexReasoningModel(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  if (lower.includes('gpt-5.2-chat') || lower.includes('gpt-5.2-instant')) return false
  return lower.startsWith('gpt-5') ||
    lower.includes('codex') ||
    /\bo[13](?:-|$)/.test(lower) ||
    lower.includes('reasoning')
}

function readOnethingCodexThinkingFlag(providerOptions: OnethingCodexProviderOptions): boolean {
  const value = providerOptions.thinking
  if (value === false || value === 'disabled' || value === 'off') return false
  return true
}

function normalizeOnethingCodexNativeTools(raw: OnethingCodexRawValue): OnethingCodexNativeToolName[] {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  const tools = new Set<OnethingCodexNativeToolName>()
  for (const value of values) {
    const normalized = normalizeOnethingCodexNativeToolName(
      typeof value === 'string' ? value : onethingCodexRecordFromValue(value).name,
    )
    if (normalized) tools.add(normalized)
  }
  return Array.from(tools)
}

function dataContentToOnethingCodexUrl(data: OnethingCodexRawValue, mediaType?: string): string | null {
  if (typeof data === 'string') {
    if (data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')) return data
    if (mediaType) return `data:${mediaType};base64,${data}`
  }
  if (data instanceof URL) return data.toString()
  if (data instanceof Uint8Array && mediaType) {
    return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
  }
  return null
}

function contentPartsToOnethingCodexContent(
  content: OnethingCodexRawValue,
  role: 'developer' | 'user' | 'assistant',
): OnethingCodexContentItem[] {
  if (typeof content === 'string') {
    return content ? [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }] : []
  }

  if (!Array.isArray(content)) return []

  const items: OnethingCodexContentItem[] = []
  for (const part of content) {
    const partRecord = onethingCodexRecordFromValue(part)
    if (partRecord.type === 'text' && typeof partRecord.text === 'string' && partRecord.text.length > 0) {
      items.push({
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: partRecord.text,
      })
      continue
    }

    if ((partRecord.type === 'file' || partRecord.type === 'image') && role !== 'assistant') {
      const mediaType = typeof partRecord.mediaType === 'string' ? partRecord.mediaType : undefined
      const imageUrl = dataContentToOnethingCodexUrl(partRecord.data ?? partRecord.image, mediaType)
      if (imageUrl && (mediaType?.startsWith('image/') || imageUrl.startsWith('data:image/') || imageUrl.startsWith('http'))) {
        items.push({ type: 'input_image', image_url: imageUrl, detail: 'auto' })
      }
    }
  }

  return items
}

function onethingCodexToolInputToString(input: OnethingCodexRawValue): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input ?? {})
}

function getOnethingCodexEncryptedReasoning(msg: OnethingCodexRawValue): string[] {
  const messageRecord = onethingCodexRecordFromValue(msg)
  const providerOptions = onethingCodexRecordFromValue(messageRecord.providerOptions)
  const codexOptions = onethingCodexRecordFromValue(providerOptions.codex)
  const raw = codexOptions.encryptedReasoning
  const values = Array.isArray(raw) ? raw : raw ? [raw] : []
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export function convertPromptToOnethingCodexInput(
  prompt: OnethingCodexRawValue[],
): OnethingCodexInputItem[] {
  const input: OnethingCodexInputItem[] = []

  for (const msg of prompt) {
    const messageRecord = onethingCodexRecordFromValue(msg)
    if (messageRecord.role === 'system' || messageRecord.role === 'developer') {
      const content = contentPartsToOnethingCodexContent(messageRecord.content, 'developer')
      if (content.length > 0) {
        input.push({ type: 'message', role: 'developer', content })
      }
      continue
    }

    if (messageRecord.role === 'user') {
      const content = contentPartsToOnethingCodexContent(messageRecord.content, 'user')
      if (content.length > 0) {
        input.push({ type: 'message', role: 'user', content })
      }
      continue
    }

    if (messageRecord.role === 'assistant') {
      for (const encryptedContent of getOnethingCodexEncryptedReasoning(msg)) {
        input.push({
          type: 'reasoning',
          summary: [],
          encrypted_content: encryptedContent,
        })
      }

      const textContent = contentPartsToOnethingCodexContent(messageRecord.content, 'assistant')
      if (textContent.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: textContent })
      }

      if (Array.isArray(messageRecord.content)) {
        for (const part of messageRecord.content) {
          const partRecord = onethingCodexRecordFromValue(part)
          if (partRecord.type === 'tool-call') {
            const name = typeof partRecord.toolName === 'string' ? partRecord.toolName : ''
            const callId = typeof partRecord.toolCallId === 'string' ? partRecord.toolCallId : ''
            if (!name || !callId) continue
            input.push({
              type: 'function_call',
              name,
              arguments: onethingCodexToolInputToString(partRecord.input),
              call_id: callId,
            })
          } else if (partRecord.type === 'tool-result') {
            const callId = typeof partRecord.toolCallId === 'string' ? partRecord.toolCallId : ''
            if (!callId) continue
            input.push({
              type: 'function_call_output',
              call_id: callId,
              output: onethingToolResultToCodexOutput(onethingToolResultPayloadFromPart(part)),
            })
          }
        }
      }
      continue
    }

    if (messageRecord.role === 'tool' && Array.isArray(messageRecord.content)) {
      for (const part of messageRecord.content) {
        const partRecord = onethingCodexRecordFromValue(part)
        if (partRecord.type === 'tool-result') {
          const callId = typeof partRecord.toolCallId === 'string' ? partRecord.toolCallId : ''
          if (!callId) continue
          input.push({
            type: 'function_call_output',
            call_id: callId,
            output: onethingToolResultToCodexOutput(onethingToolResultPayloadFromPart(part)),
          })
        }
      }
    }
  }

  return input
}

function buildOnethingCodexTools(
  tools: OnethingCodexCallOptions['tools'] | undefined,
  nativeTools: OnethingCodexNativeToolName[] = [],
): OnethingCodexTool[] {
  const codexTools: OnethingCodexTool[] = []
  const seenFunctionNames = new Set<string>()

  for (const tool of tools ?? []) {
    if (tool.type !== 'function') continue
    const functionTool = tool as OnethingCodexFunctionToolDefinition
    if (!functionTool.name || seenFunctionNames.has(functionTool.name)) continue
    seenFunctionNames.add(functionTool.name)
    codexTools.push({
      type: 'function',
      name: functionTool.name,
      description: functionTool.description,
      strict: false,
      parameters: functionTool.inputSchema ?? {},
    })
  }

  if (
    nativeTools.includes(ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL) &&
    !codexTools.some((tool) => tool.type === 'image_generation')
  ) {
    codexTools.push({
      type: 'image_generation',
      output_format: 'png',
    })
  }

  return codexTools
}

function pickOnethingCodexProviderOptions(options: OnethingCodexCallOptions): OnethingCodexProviderOptions {
  const providerOptions = onethingCodexRecordFromValue(options.providerOptions)
  return {
    ...onethingCodexRecordFromValue(providerOptions.openai),
    ...onethingCodexRecordFromValue(providerOptions.codex),
  }
}

function buildOnethingCodexReasoning(
  modelId: string,
  providerOptions: OnethingCodexProviderOptions,
): OnethingCodexReasoningOptions | undefined {
  if (!readOnethingCodexThinkingFlag(providerOptions)) {
    return undefined
  }

  if (!isOnethingCodexReasoningModel(modelId) && !providerOptions.reasoningEffort && !providerOptions.reasoningSummary) {
    return undefined
  }

  return {
    effort: normalizeOnethingCodexReasoningEffort(providerOptions.reasoningEffort),
    summary: normalizeOnethingCodexReasoningSummary(providerOptions.reasoningSummary),
  }
}

export function buildOnethingCodexRequest(
  modelId: string,
  options: OnethingCodexCallOptions,
): BuiltOnethingCodexRequest {
  const providerOptions = pickOnethingCodexProviderOptions(options)
  const instructions = contentToOnethingCodexInstructionText(providerOptions.instructions).trim() ||
    ONETHING_CODEX_FALLBACK_INSTRUCTIONS
  const tools = buildOnethingCodexTools(options.tools, normalizeOnethingCodexNativeTools(providerOptions.nativeTools))
  const include = onethingCodexStringArrayFromValue(providerOptions.include)
  const reasoning = buildOnethingCodexReasoning(modelId, providerOptions)
  const serviceTier = onethingCodexOptionalStringFromValue(providerOptions.serviceTier)
  const promptCacheKey = onethingCodexOptionalStringFromValue(providerOptions.promptCacheKey)
  const text = optionalOnethingCodexRecordFromValue(providerOptions.text)
  const clientMetadata = optionalOnethingCodexRecordFromValue(providerOptions.clientMetadata)

  const body: OnethingCodexRequest = {
    model: modelId,
    instructions,
    input: convertPromptToOnethingCodexInput(options.prompt),
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: reasoning ? addUnique(include, ONETHING_CODEX_REASONING_INCLUDE) : include,
  }

  if (reasoning) body.reasoning = reasoning
  if (serviceTier) body.service_tier = serviceTier
  if (promptCacheKey) body.prompt_cache_key = promptCacheKey
  if (text) body.text = text
  if (clientMetadata) body.client_metadata = clientMetadata

  const warnings: BuiltOnethingCodexRequest['warnings'] = []
  if (options.maxOutputTokens !== undefined) {
    warnings.push({
      type: 'unsupported-setting',
      setting: 'maxOutputTokens',
      details: 'Codex ChatGPT backend rejects max_output_tokens; omit it to match Codex CLI.',
    })
  }
  if (options.temperature !== undefined) {
    warnings.push({
      type: 'unsupported-setting',
      setting: 'temperature',
      details: 'Codex ChatGPT backend does not use temperature in the Codex CLI contract.',
    })
  }

  return { body, warnings }
}

function asNumber(value: OnethingCodexRawValue): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asString(value: OnethingCodexRawValue): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function titleCaseServiceTier(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ') || id
}

function normalizeOnethingCodexSupportedReasoningLevels(
  raw: OnethingCodexRawValue,
): OnethingCodexReasoningLevel[] {
  const record = onethingCodexRecordFromValue(raw)
  const levels =
    record.supported_reasoning_efforts ??
    record.supportedReasoningEfforts ??
    record.supported_reasoning_levels ??
    record.supportedReasoningLevels
  const values = Array.isArray(levels) && levels.length > 0
    ? levels
    : ONETHING_CODEX_FALLBACK_REASONING_EFFORTS.map((effort) => ({ effort }))

  const seen = new Set<OnethingCodexReasoningEffort>()
  const normalized: OnethingCodexReasoningLevel[] = []

  for (const level of values) {
    const levelRecord = onethingCodexRecordFromValue(level)
    const effort = normalizeOnethingCodexReasoningEffort(
      typeof level === 'string'
        ? level
        : levelRecord.effort ?? levelRecord.reasoningEffort ?? levelRecord.reasoning_effort ?? levelRecord.name ?? levelRecord.value,
    )
    if (seen.has(effort)) continue
    seen.add(effort)
    const description = onethingCodexOptionalStringFromValue(levelRecord.description)
    normalized.push(description ? { effort, description } : { effort })
  }

  return normalized
}

function normalizeOnethingCodexServiceTiers(raw: OnethingCodexRawValue): OnethingCodexServiceTier[] {
  const record = onethingCodexRecordFromValue(raw)
  const serviceTiers = record.service_tiers ?? record.serviceTiers
  const speedTiers = record.additional_speed_tiers ?? record.additionalSpeedTiers
  const values = Array.isArray(serviceTiers) && serviceTiers.length > 0
    ? serviceTiers
    : Array.isArray(speedTiers)
      ? speedTiers
      : []

  const seen = new Set<string>()
  const normalized: OnethingCodexServiceTier[] = []

  for (const tier of values) {
    const tierRecord = onethingCodexRecordFromValue(tier)
    const id = typeof tier === 'string' ? tier : tierRecord.id ?? tierRecord.value ?? tierRecord.name
    if (typeof id !== 'string') continue
    const trimmedId = id.trim()
    if (!trimmedId || seen.has(trimmedId)) continue
    seen.add(trimmedId)
    const rawName = onethingCodexOptionalStringFromValue(tierRecord.name)
    const rawDescription = onethingCodexOptionalStringFromValue(tierRecord.description)
    const name = rawName?.trim()
      ? rawName.trim()
      : titleCaseServiceTier(trimmedId)
    const description = rawDescription?.trim()
      ? rawDescription.trim()
      : undefined
    normalized.push(description ? { id: trimmedId, name, description } : { id: trimmedId, name })
  }

  return normalized
}

function getOnethingCodexRawInputModalities(raw: OnethingCodexRawValue): string[] {
  const record = onethingCodexRecordFromValue(raw)
  const modalities = onethingCodexRecordFromValue(record.modalities)
  const value = record.input_modalities ?? record.inputModalities ?? modalities.input
  const values = Array.isArray(value) ? value : ['text', 'image']
  return values
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean)
}

function normalizeOnethingCodexNativeToolName(
  value: OnethingCodexRawValue,
): OnethingCodexNativeToolName | undefined {
  return typeof value === 'string' && value.trim().toLowerCase() === ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL
    ? ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL
    : undefined
}

function normalizeOnethingCodexModelNativeTools(raw: OnethingCodexRawValue): OnethingCodexNativeToolName[] {
  const record = onethingCodexRecordFromValue(raw)
  const explicitTools = onethingCodexStringArrayFromValue(
    record.experimental_supported_tools ??
      record.experimentalSupportedTools ??
      record.supported_tools ??
      record.supportedTools ??
      record.native_tools ??
      record.nativeTools,
  )
  const tools = new Set<OnethingCodexNativeToolName>()

  for (const value of explicitTools) {
    const normalized = normalizeOnethingCodexNativeToolName(value)
    if (normalized) tools.add(normalized)
  }

  const capabilities = onethingCodexRecordFromValue(record.capabilities)
  const capability =
    capabilities.image_generation ??
    capabilities.imageGeneration ??
    record.image_generation ??
    record.imageGeneration
  if (capability === true) {
    tools.add(ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL)
  }

  if (explicitTools.length === 0 && capability !== false && getOnethingCodexRawInputModalities(raw).includes('image')) {
    tools.add(ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL)
  }

  return Array.from(tools)
}

/**
 * 一条规则,一个出口:Codex 的原生 `image_generation` 工具可用 ⇒ 该模型具备
 * image 输出。目录条目的 output_modalities 由它推导(Codex /models 从不报
 * output_modalities),能力解析器那一侧读同样的事实
 * (`model-capability.ts` 的 `codexMetadataDeclaresImageOutput`)。
 */
export function codexNativeToolsDeclareImageOutput(
  nativeTools: readonly string[] | undefined,
): boolean {
  return Array.isArray(nativeTools) &&
    nativeTools.includes(ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL)
}

function resolveOnethingCodexOutputModalities(
  outputModalities: readonly string[],
  nativeTools: readonly string[] | undefined,
): string[] {
  const resolved = outputModalities.length > 0 ? [...outputModalities] : ['text']
  if (codexNativeToolsDeclareImageOutput(nativeTools) && !resolved.includes('image')) {
    resolved.push('image')
  }
  return resolved
}

export function getOnethingCodexModelProviderMetadata(
  raw: OnethingCodexRawValue,
): { codex: OnethingCodexModelProviderMetadata } {
  const record = onethingCodexRecordFromValue(raw)
  const supportedReasoningEfforts = normalizeOnethingCodexSupportedReasoningLevels(raw)
  const defaultReasoningEffort = normalizeOnethingCodexReasoningEffort(
    record.default_reasoning_effort ??
      record.defaultReasoningEffort ??
      record.default_reasoning_level ??
      record.defaultReasoningLevel,
  )
  const supportsReasoningSummaries =
    record.supports_reasoning_summaries ?? record.supportsReasoningSummaries
  const serviceTiers = normalizeOnethingCodexServiceTiers(raw)
  const nativeTools = normalizeOnethingCodexModelNativeTools(raw)

  return {
    codex: {
      defaultReasoningEffort,
      supportedReasoningEfforts,
      supportsReasoningSummaries: supportsReasoningSummaries !== false,
      serviceTiers,
      nativeTools,
    },
  }
}

function formatOnethingCodexFallbackName(modelId: string): string {
  if (modelId === ONETHING_CODEX_DEFAULT_MODEL) return 'GPT-5.3 Codex'
  return modelId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'gpt'
      ? 'GPT'
      : part.toLowerCase() === 'codex'
        ? 'Codex'
        : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function getOnethingCodexFallbackModel(
  modelId: string = ONETHING_CODEX_DEFAULT_MODEL,
): OnethingOpenRouterModel {
  const providerMetadata = getOnethingCodexModelProviderMetadata({
    default_reasoning_level: 'medium',
    supported_reasoning_levels: ONETHING_CODEX_FALLBACK_REASONING_EFFORTS.map((effort) => ({ effort })),
    supports_reasoning_summaries: true,
  })
  return {
    id: modelId,
    name: formatOnethingCodexFallbackName(modelId),
    description: 'Codex model available with ChatGPT subscription auth',
    context_length: 192000,
    architecture: {
      modality: 'multimodal',
      input_modalities: ['text', 'image'],
      output_modalities: resolveOnethingCodexOutputModalities(['text'], providerMetadata.codex.nativeTools),
      tokenizer: 'unknown',
    },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: { context_length: 192000, max_completion_tokens: 65536, is_moderated: false },
    supported_parameters: ['tools', 'reasoning'],
    providerMetadata: toJsonObject(providerMetadata),
  }
}

export function getOnethingCodexFallbackModels(
  modelIds: string[] = [ONETHING_CODEX_DEFAULT_MODEL],
): OnethingOpenRouterModel[] {
  const ids = Array.from(new Set([...(modelIds.length > 0 ? modelIds : [ONETHING_CODEX_DEFAULT_MODEL])]))
  return ids.map((id) => getOnethingCodexFallbackModel(id))
}

export function coerceOnethingCodexModelArray(data: OnethingCodexRawValue): OnethingCodexRawValue[] {
  const record = onethingCodexRecordFromValue(data)
  if (Array.isArray(data)) return data
  if (Array.isArray(record.data)) return record.data
  if (Array.isArray(record.models)) return record.models
  if (record.models && typeof record.models === 'object' && !Array.isArray(record.models)) {
    return Object.values(record.models)
  }
  return []
}

export function codexModelInfoToOnethingOpenRouterModel(
  raw: OnethingCodexRawValue,
): OnethingOpenRouterModel | null {
  const record = onethingCodexRecordFromValue(raw)
  const limit = onethingCodexRecordFromValue(record.limit)
  const modalities = onethingCodexRecordFromValue(record.modalities)
  const id = onethingCodexOptionalStringFromValue(record.id) ??
    onethingCodexOptionalStringFromValue(record.slug) ??
    onethingCodexOptionalStringFromValue(record.model) ??
    onethingCodexOptionalStringFromValue(record.name)
  if (!id) return null
  const contextLength =
    asNumber(record.context_length) ??
    asNumber(record.contextWindow) ??
    asNumber(record.context_window) ??
    asNumber(record.max_context_window) ??
    asNumber(record.maxContextWindow) ??
    asNumber(limit.context) ??
    192000
  const maxOutput =
    asNumber(record.max_output_tokens) ??
    asNumber(record.maxOutputTokens) ??
    asNumber(limit.output) ??
    65536
  const inputModalities = getOnethingCodexRawInputModalities(raw)
  const outputModalities = onethingCodexStringArrayFromValue(record.output_modalities ?? record.outputModalities ?? modalities.output)
  const supportedParameters = new Set<string>(
    onethingCodexStringArrayFromValue(record.supported_parameters ?? record.supportedParameters),
  )
  const providerMetadata = getOnethingCodexModelProviderMetadata(raw)
  supportedParameters.add('tools')
  if (
    record.reasoning !== false &&
    ((providerMetadata.codex.supportsReasoningSummaries !== false) ||
      providerMetadata.codex.supportedReasoningEfforts.length > 0 ||
      record.default_reasoning_level ||
      record.defaultReasoningLevel)
  ) {
    supportedParameters.add('reasoning')
  }
  if (record.temperature !== false) supportedParameters.add('temperature')
  if (record.support_verbosity) supportedParameters.add('verbosity')

  return {
    id,
    name: onethingCodexOptionalStringFromValue(record.display_name) ??
      onethingCodexOptionalStringFromValue(record.displayName) ??
      onethingCodexOptionalStringFromValue(record.name) ??
      id,
    description: onethingCodexOptionalStringFromValue(record.description) ?? 'Codex model',
    context_length: contextLength,
    architecture: {
      modality: inputModalities.includes('image') ? 'multimodal' : 'text',
      input_modalities: inputModalities,
      output_modalities: resolveOnethingCodexOutputModalities(
        outputModalities,
        providerMetadata.codex.nativeTools,
      ),
      tokenizer: onethingCodexOptionalStringFromValue(record.tokenizer) ?? 'unknown',
    },
    pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
    top_provider: {
      context_length: contextLength,
      max_completion_tokens: maxOutput,
      is_moderated: false,
    },
    supported_parameters: Array.from(supportedParameters),
    last_updated: onethingCodexOptionalStringFromValue(record.last_updated) ??
      onethingCodexOptionalStringFromValue(record.lastUpdated) ??
      onethingCodexOptionalStringFromValue(record.release_date),
    providerMetadata: toJsonObject(providerMetadata),
  }
}

export function buildOnethingCodexModelsUrl(): string {
  const url = new URL(`${ONETHING_CODEX_BASE_URL}/models`)
  url.searchParams.set('client_version', ONETHING_CODEX_CLIENT_VERSION)
  return url.toString()
}

function codexFetchSignal(options: OnethingCodexFetchOptions | undefined): AbortSignal | undefined {
  if (options?.signal) return options.signal
  if (options?.timeoutMs === 0) return undefined
  return AbortSignal.timeout(options?.timeoutMs ?? 8000)
}

export function summarizeOnethingCodexErrorBody(body: string): string {
  if (!body) return ''
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.detail || parsed?.error?.message || parsed?.message || parsed?.error
    if (typeof message === 'string') return message.slice(0, 300)
  } catch {
    // Fall back to a compact text preview below.
  }
  const compact = body.replace(/\s+/g, ' ').trim()
  const title = compact.match(/<title>(.*?)<\/title>/i)?.[1]?.trim()
  const paragraph = compact.match(/<p>(?:<b>\d+\.<\/b>\s*)?(.*?)(?:<p>|$)/i)?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (title || paragraph) {
    return [title, paragraph].filter(Boolean).join(': ').slice(0, 300)
  }
  return compact.slice(0, 300)
}

export async function fetchOnethingCodexModels(
  token: OnethingCodexOAuthToken,
  fetchImpl: OnethingCodexFetchFn,
  options?: OnethingCodexFetchOptions,
): Promise<OnethingOpenRouterModel[]> {
  const response = await fetchImpl(buildOnethingCodexModelsUrl(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      ...buildOnethingCodexHeaders(token),
    },
    signal: codexFetchSignal(options),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = summarizeOnethingCodexErrorBody(body)
    throw new Error(`Codex models request failed: ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = await response.json()
  const rawModels = coerceOnethingCodexModelArray(data)
  const models = rawModels
    .map(codexModelInfoToOnethingOpenRouterModel)
    .filter((model): model is OnethingOpenRouterModel => Boolean(model))

  return models.length > 0 ? models : getOnethingCodexFallbackModels()
}

export function isOnethingCodexResponsesUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return url.hostname === 'chatgpt.com' && url.pathname.endsWith('/backend-api/codex/responses')
  } catch {
    return input.includes('/backend-api/codex/responses')
  }
}

export function normalizeOnethingCodexResponsesBody(
  body: OnethingCodexRawValue,
): OnethingCodexResponsesBody {
  const raw = onethingCodexRecordFromValue(body)
  const normalized: OnethingCodexResponsesBody = {}

  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && ONETHING_CODEX_RESPONSES_ALLOWED_KEYS.has(key)) {
      normalized[key] = value
    }
  }

  normalized.store = false

  if (typeof normalized.instructions !== 'string' || normalized.instructions.trim().length === 0) {
    normalized.instructions = ONETHING_CODEX_FALLBACK_INSTRUCTIONS
  }

  if (typeof normalized.parallel_tool_calls !== 'boolean') {
    normalized.parallel_tool_calls = false
  }

  if (normalized.tools == null) {
    normalized.tools = []
  }

  normalized.tool_choice = 'auto'

  const include = onethingCodexStringArrayFromValue(normalized.include)
  if (normalized.reasoning && typeof normalized.reasoning === 'object') {
    const reasoning = onethingCodexRecordFromValue(normalized.reasoning)
    normalized.reasoning = {
      ...reasoning,
      effort: normalizeOnethingCodexReasoningEffort(reasoning.effort),
      summary: normalizeOnethingCodexReasoningSummary(reasoning.summary),
    }
    normalized.include = addUnique(include, ONETHING_CODEX_REASONING_INCLUDE)
  } else {
    delete normalized.reasoning
    normalized.include = include.filter((value) => value !== ONETHING_CODEX_REASONING_INCLUDE)
  }

  if (normalized.include == null) {
    normalized.include = include
  }

  return normalized
}

function getOnethingCodexErrorPayload(body: string): { message?: string; param?: string } {
  try {
    const parsed = JSON.parse(body)
    const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : parsed
    return {
      message: typeof error?.message === 'string' ? error.message : typeof parsed?.detail === 'string' ? parsed.detail : undefined,
      param: typeof error?.param === 'string' ? error.param : undefined,
    }
  } catch {
    return {}
  }
}

function removeDottedOnethingCodexParam(body: OnethingCodexResponsesBody, param: string): boolean {
  const [topLevel] = param.split('.')
  if (!topLevel || !(topLevel in body)) return false
  delete body[topLevel]
  return true
}

export function repairOnethingCodexRejectedBody(
  body: OnethingCodexResponsesBody,
  responseBody: string,
): OnethingCodexResponsesBody | null {
  const { message, param } = getOnethingCodexErrorPayload(responseBody)
  if (!message && !param) return null

  const repaired = { ...body }
  let changed = false

  if (param?.startsWith('tool_choice')) {
    repaired.tool_choice = 'auto'
    changed = true
  }

  const unsupportedParam = message?.match(/Unsupported parameter:\s*['"]?([A-Za-z0-9_.$-]+)['"]?/i)?.[1]
  if (unsupportedParam) {
    changed = removeDottedOnethingCodexParam(repaired, unsupportedParam) || changed
  }

  return changed ? normalizeOnethingCodexResponsesBody(repaired) : null
}

function isOnethingCodexInstructionRole(role: OnethingCodexRawValue): boolean {
  return role === 'system' || role === 'developer'
}

export function prepareOnethingCodexCallOptions<TOptions extends {
  messages?: unknown
  providerOptions?: unknown
  tools?: unknown
  toolChoice?: unknown
  maxOutputTokens?: unknown
}>(
  options: TOptions,
): TOptions {
  const systemMessages: string[] = []

  if (Array.isArray(options.messages)) {
    const nonSystemMessages: object[] = []

    for (const message of options.messages) {
      const messageRecord = onethingCodexRecordFromValue(message as OnethingCodexRawValue)
      if (isOnethingCodexInstructionRole(messageRecord.role)) {
        const text = contentToOnethingCodexInstructionText(messageRecord.content).trim()
        if (text) systemMessages.push(text)
      } else {
        nonSystemMessages.push(message as object)
      }
    }

    options.messages = nonSystemMessages
  }

  const existingProviderOptions = onethingCodexRecordFromValue(options.providerOptions as OnethingCodexRawValue)
  const existingOpenAIOptions = onethingCodexRecordFromValue(existingProviderOptions.openai)
  const existingCodexOptions = onethingCodexRecordFromValue(existingProviderOptions.codex)
  const existingInstructions = contentToOnethingCodexInstructionText(
    existingCodexOptions.instructions ?? existingOpenAIOptions.instructions,
  ).trim()
  const instructions = [...systemMessages, existingInstructions].filter(Boolean).join('\n\n') ||
    ONETHING_CODEX_FALLBACK_INSTRUCTIONS

  options.providerOptions = {
    ...existingProviderOptions,
    codex: {
      ...existingCodexOptions,
      instructions,
    },
  }

  if (options.tools && Object.keys(options.tools).length > 0) {
    options.toolChoice = { type: 'auto' }
  } else {
    delete options.toolChoice
  }

  delete options.maxOutputTokens

  return options
}

function normalizeOnethingCodexUsageWindow(
  raw: OnethingCodexRawValue,
): OnethingCodexUsageWindow | undefined {
  const record = onethingCodexRecordFromValue(raw)
  const usedPercent = asNumber(record.used_percent ?? record.usedPercent)
  if (usedPercent === undefined) return undefined
  const window: OnethingCodexUsageWindow = { usedPercent }
  const windowSeconds = asNumber(record.limit_window_seconds ?? record.limitWindowSeconds ?? record.window_seconds ?? record.windowSeconds)
  const resetAfterSeconds = asNumber(record.reset_after_seconds ?? record.resetAfterSeconds)
  const resetAt = asNumber(record.reset_at ?? record.resetAt)
  if (windowSeconds !== undefined) window.windowSeconds = windowSeconds
  if (resetAfterSeconds !== undefined) window.resetAfterSeconds = resetAfterSeconds
  if (resetAt !== undefined) window.resetAt = resetAt
  return window
}

function normalizeOnethingCodexUsageCredits(
  raw: OnethingCodexRawValue,
): OnethingCodexUsageCredits | undefined {
  const record = onethingCodexRecordFromValue(raw)
  const hasCredits = record.has_credits ?? record.hasCredits
  const unlimited = record.unlimited
  const balance = asString(record.balance)
  if (hasCredits === undefined && unlimited === undefined && !balance) return undefined
  return {
    hasCredits: Boolean(hasCredits),
    unlimited: Boolean(unlimited),
    ...(balance ? { balance } : {}),
  }
}

function normalizeOnethingCodexRateLimitReachedType(raw: OnethingCodexRawValue): string | undefined {
  if (typeof raw === 'string') return asString(raw)
  const record = onethingCodexRecordFromValue(raw)
  return asString(record.type ?? record.kind)
}

function normalizeOnethingCodexUsageLimit(
  id: string,
  name: string | undefined,
  rawRateLimit: OnethingCodexRawValue,
  rateLimitReachedType?: string,
): OnethingCodexUsageLimit {
  const rateLimit = onethingCodexRecordFromValue(rawRateLimit)
  const primary = normalizeOnethingCodexUsageWindow(rateLimit.primary_window ?? rateLimit.primaryWindow)
  const secondary = normalizeOnethingCodexUsageWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow)
  return {
    id,
    ...(name ? { name } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(rateLimitReachedType ? { rateLimitReachedType } : {}),
  }
}

export function normalizeOnethingCodexUsagePayload(
  payload: OnethingCodexRawValue,
): OnethingCodexProviderUsage {
  const record = onethingCodexRecordFromValue(payload)
  const planType = asString(record.plan_type ?? record.planType)
  const credits = normalizeOnethingCodexUsageCredits(record.credits)
  const rateLimitReachedType = normalizeOnethingCodexRateLimitReachedType(
    record.rate_limit_reached_type ?? record.rateLimitReachedType,
  )

  const limits: OnethingCodexUsageLimit[] = [
    normalizeOnethingCodexUsageLimit('codex', undefined, record.rate_limit ?? record.rateLimit, rateLimitReachedType),
  ]

  const additional = record.additional_rate_limits ?? record.additionalRateLimits
  if (Array.isArray(additional)) {
    for (const detail of additional) {
      const detailRecord = onethingCodexRecordFromValue(detail)
      const id = asString(detailRecord.metered_feature ?? detailRecord.meteredFeature ?? detailRecord.id)
      if (!id) continue
      limits.push(normalizeOnethingCodexUsageLimit(
        id,
        asString(detailRecord.limit_name ?? detailRecord.limitName ?? detailRecord.name),
        detailRecord.rate_limit ?? detailRecord.rateLimit,
        normalizeOnethingCodexRateLimitReachedType(detailRecord.rate_limit_reached_type ?? detailRecord.rateLimitReachedType),
      ))
    }
  }

  return {
    ...(planType ? { planType } : {}),
    ...(credits ? { credits } : {}),
    limits,
  }
}

export async function fetchOnethingCodexUsage(
  token: OnethingCodexOAuthToken,
  fetchImpl: OnethingCodexFetchFn,
  options?: OnethingCodexFetchOptions,
): Promise<OnethingCodexProviderUsage> {
  const response = await fetchImpl(ONETHING_CODEX_USAGE_URL, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      ...buildOnethingCodexHeaders(token),
    },
    signal: codexFetchSignal(options),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = summarizeOnethingCodexErrorBody(body)
    throw new Error(`Codex usage request failed: ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  return normalizeOnethingCodexUsagePayload(await response.json())
}
