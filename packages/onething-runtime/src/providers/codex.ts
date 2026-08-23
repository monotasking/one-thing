/**
 * Codex(ChatGPT 订阅)**非请求路径**的那一半:模型列表、ChatGPT 用量拉取、
 * 原生工具元数据,以及 `prepareCallOptions`。
 *
 * `doStream` / `doGenerate` 那条自带 SSE / usage / 错误 / effort 的请求路径在
 * P1-d2 整条删除(生产零调用方 —— codex 的真实通路是
 * `agent-loop/providers/wires/openai-responses-wire.ts` 上的 `CODEX_DIALECT`,
 * 设计稿 §9 P1「第二套 codex」)。新增请求侧行为一律改那条线,不要在这里复活。
 */
import { toJsonObject } from '@onething/core'
import type { OnethingOpenRouterModel } from './model-registry.js'
import type { OnethingOAuthToken } from '../auth/types.js'

export const ONETHING_CODEX_PROVIDER_ID = 'codex'
export const ONETHING_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const ONETHING_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
export const ONETHING_CODEX_DEFAULT_MODEL = 'gpt-5.3-codex'
export const ONETHING_CODEX_CLIENT_VERSION = process.env.npm_package_version || '1.1.0'
export const ONETHING_CODEX_FALLBACK_INSTRUCTIONS = 'You are Codex, a helpful AI coding assistant.'
export const ONETHING_CODEX_NATIVE_IMAGE_GENERATION_TOOL = 'image_generation'

const ONETHING_CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
const ONETHING_CODEX_FALLBACK_REASONING_EFFORTS: OnethingCodexReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

export type OnethingCodexRawPrimitive = string | number | boolean | null | undefined
export type OnethingCodexRawRecord = { [key: string]: OnethingCodexRawValue }
export type OnethingCodexRawValue =
  | OnethingCodexRawPrimitive
  | OnethingCodexRawRecord
  | OnethingCodexRawValue[]
  | object

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

export function onethingCodexRecordFromValue(value: OnethingCodexRawValue): OnethingCodexRawRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as OnethingCodexRawRecord
    : {}
}

export function onethingCodexOptionalStringFromValue(value: OnethingCodexRawValue): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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

export function normalizeOnethingCodexReasoningEffort(
  effort: OnethingCodexRawValue,
): OnethingCodexReasoningEffort {
  const value = typeof effort === 'string' ? effort.toLowerCase() : ''
  if (value === 'max') return 'high'
  return ONETHING_CODEX_REASONING_EFFORTS.includes(value as OnethingCodexReasoningEffort)
    ? value as OnethingCodexReasoningEffort
    : 'medium'
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
