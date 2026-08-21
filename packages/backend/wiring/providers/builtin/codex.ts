/**
 * Codex Provider Definition
 *
 * Uses ChatGPT subscription OAuth credentials against the Codex backend.
 */

import type {
  CodexProviderUsage,
  OAuthToken,
  OpenRouterModel,
} from '@shared/ipc.js'
import type { ProviderCallOptions, ProviderCallPreparationContext, ProviderDefinition } from '@onething/runtime/providers/types.wiring'
import { createBoundFetch, createRequiredAppFetch } from '../../../provider-binding/bound-fetch.js'
import { dumpProviderRequest } from '../../../provider-binding/request-dump.js'
import {
  buildOnethingCodexModelsUrl,
  buildOnethingCodexHeaders,
  buildOnethingCodexRequest,
  codexBuiltinProvider,
  codexModelInfoToOnethingOpenRouterModel,
  collectOnethingCodexGenerateResult,
  convertPromptToOnethingCodexInput,
  fetchOnethingCodexModels,
  fetchOnethingCodexUsage,
  getOnethingCodexFallbackModel,
  getOnethingCodexFallbackModels,
  isOnethingCodexResponsesUrl,
  normalizeOnethingCodexReasoningEffort,
  normalizeOnethingCodexResponsesBody,
  normalizeOnethingCodexUsagePayload,
  ONETHING_CODEX_BASE_URL,
  ONETHING_CODEX_CLIENT_VERSION,
  ONETHING_CODEX_DEFAULT_MODEL,
  ONETHING_CODEX_FALLBACK_INSTRUCTIONS,
  ONETHING_CODEX_PROVIDER_ID,
  ONETHING_CODEX_USAGE_URL,
  prepareOnethingCodexCallOptions,
  requestOnethingCodexStream,
  repairOnethingCodexRejectedBody,
  summarizeOnethingCodexErrorBody,
  summarizeOnethingCodexRequestBody,
  type OnethingCodexFinishReason,
  type OnethingCodexInputItem,
  type OnethingCodexProviderOptions,
  type OnethingCodexRawRecord,
  type OnethingCodexRawValue,
  type OnethingCodexReasoningEffort,
  type OnethingCodexRequest,
  type OnethingCodexResponsesBody,
  type OnethingCodexSseEvent,
  type OnethingCodexStreamPart,
  type OnethingCodexUsage,
} from '@onething/runtime/providers'
import { getLogger } from '../../logging/index.js'

const log = getLogger('providers.codex')


export const CODEX_PROVIDER_ID = ONETHING_CODEX_PROVIDER_ID
export const CODEX_BASE_URL = ONETHING_CODEX_BASE_URL
export const CODEX_USAGE_URL = ONETHING_CODEX_USAGE_URL
export const CODEX_DEFAULT_MODEL = ONETHING_CODEX_DEFAULT_MODEL
export const CODEX_CLIENT_VERSION = ONETHING_CODEX_CLIENT_VERSION
export const CODEX_FALLBACK_INSTRUCTIONS = ONETHING_CODEX_FALLBACK_INSTRUCTIONS

type CodexRawRecord = OnethingCodexRawRecord
type CodexRawValue = OnethingCodexRawValue

type CodexProviderOptions = OnethingCodexProviderOptions

type CodexResponsesBody = OnethingCodexResponsesBody

type CodexCallOptionValue =
  | CodexRawValue
  | CodexRawValue[]
  | CodexFunctionToolDefinition[]
  | Array<CodexFunctionToolDefinition | CodexRawRecord>
  | Record<string, string | undefined>
  | AbortSignal

type FetchFn = typeof globalThis.fetch

type CodexFinishReason = OnethingCodexFinishReason
type CodexUsage = OnethingCodexUsage

interface CodexFunctionToolDefinition {
  type: 'function'
  name: string
  description?: string
  inputSchema?: object
}

interface CodexCallOptions {
  prompt: object[]
  tools?: Array<CodexFunctionToolDefinition | { type: string; [key: string]: CodexRawValue }>
  providerOptions?: CodexProviderOptions
  headers?: Record<string, string | undefined>
  abortSignal?: AbortSignal
  maxOutputTokens?: number
  temperature?: number
  [key: string]: CodexCallOptionValue
}

interface CodexCallWarning {
  type: 'unsupported-setting'
  setting: keyof CodexCallOptions
  details?: string
}

type CodexStreamPart = OnethingCodexStreamPart
type CodexGeneratedContent = { type: string; [key: string]: CodexRawValue }
type CodexReasoningEffort = OnethingCodexReasoningEffort

interface CodexLanguageModel {
  specificationVersion: 'v2'
  provider: string
  modelId: string
  supportedUrls: Record<string, RegExp[]>
  doStream(options: CodexCallOptions): Promise<{
    stream: ReadableStream<CodexStreamPart>
    request?: { body?: CodexRawValue }
    response?: { headers?: Record<string, string> }
  }>
  doGenerate(options: CodexCallOptions): Promise<{
    content: CodexGeneratedContent[]
    finishReason: CodexFinishReason
    usage: CodexUsage
    warnings: CodexCallWarning[]
    request?: { body?: CodexRawValue }
    response?: { headers?: Record<string, string>; modelId?: string; timestamp?: Date }
  }>
}

type CodexInputItem = OnethingCodexInputItem
type CodexRequest = OnethingCodexRequest
type CodexSseEvent = OnethingCodexSseEvent

interface BuiltCodexRequest {
  body: CodexRequest
  warnings: CodexCallWarning[]
}

export function buildCodexHeaders(token: OAuthToken): Record<string, string> {
  return buildOnethingCodexHeaders(token)
}

export function normalizeCodexReasoningEffort(effort: CodexRawValue): CodexReasoningEffort {
  return normalizeOnethingCodexReasoningEffort(effort)
}

export function convertPromptToCodexInput(prompt: CodexRawValue[]): CodexInputItem[] {
  return convertPromptToOnethingCodexInput(prompt) as CodexInputItem[]
}

export function buildCodexRequest(
  modelId: string,
  options: CodexCallOptions,
): BuiltCodexRequest {
  return buildOnethingCodexRequest(modelId, options) as BuiltCodexRequest
}

function getFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url || String(input)
}

function parseJsonBody(body: BodyInit | null | undefined): CodexRawValue | null {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as CodexRawValue
    } catch {
      return null
    }
  }
  if (body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as CodexRawValue
    } catch {
      return null
    }
  }
  return null
}

export function repairCodexRejectedBody(
  body: CodexResponsesBody,
  responseBody: string,
): CodexResponsesBody | null {
  return repairOnethingCodexRejectedBody(body, responseBody)
}

export function isCodexResponsesUrl(input: string): boolean {
  return isOnethingCodexResponsesUrl(input)
}

export function normalizeCodexResponsesBody(body: CodexRawValue): CodexResponsesBody {
  return normalizeOnethingCodexResponsesBody(body)
}

export function prepareCodexCallOptions(
  options: ProviderCallOptions,
  _context: ProviderCallPreparationContext,
): ProviderCallOptions {
  return prepareOnethingCodexCallOptions(options)
}

export function createCodexFetch(baseFetch: typeof globalThis.fetch = createBoundFetch({ policy: 'streaming' })): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isCodexResponsesUrl(getFetchUrl(input))) {
      return baseFetch(input, init)
    }

    const parsedBody = parseJsonBody(init?.body)
    if (!parsedBody) {
      return baseFetch(input, init)
    }

    const normalizedBody = normalizeCodexResponsesBody(parsedBody)
    const normalizedInit = {
      ...(init ?? {}),
      body: JSON.stringify(normalizedBody),
    }
    const response = await baseFetch(input, normalizedInit)
    if (response.ok) return response

    const responseBody = await response.clone().text().catch(() => '')
    const repairedBody = repairCodexRejectedBody(normalizedBody, responseBody)
    if (!repairedBody) return response

    log.warn('retrying request after the backend rejected a parameter', {
      status: response.status,
      detail: summarizeCodexErrorBody(responseBody),
    })

    return baseFetch(input, {
      ...(init ?? {}),
      body: JSON.stringify(repairedBody),
    })
  }) as typeof globalThis.fetch
}

export function buildCodexModelsUrl(): string {
  return buildOnethingCodexModelsUrl()
}

export function getCodexFallbackModel(modelId: string = CODEX_DEFAULT_MODEL): OpenRouterModel {
  return getOnethingCodexFallbackModel(modelId) as OpenRouterModel
}

export function getCodexFallbackModels(modelIds: string[] = [CODEX_DEFAULT_MODEL]): OpenRouterModel[] {
  return getOnethingCodexFallbackModels(modelIds) as OpenRouterModel[]
}

export function codexModelInfoToOpenRouterModel(raw: CodexRawValue): OpenRouterModel | null {
  return codexModelInfoToOnethingOpenRouterModel(raw) as OpenRouterModel | null
}

export async function fetchCodexModels(token: OAuthToken): Promise<OpenRouterModel[]> {
  return fetchOnethingCodexModels(token, createRequiredAppFetch({ policy: 'default' })) as Promise<OpenRouterModel[]>
}

export function normalizeCodexUsagePayload(payload: CodexRawValue): CodexProviderUsage {
  return normalizeOnethingCodexUsagePayload(payload) as CodexProviderUsage
}

export async function fetchCodexUsage(
  token: OAuthToken,
  fetchImpl: FetchFn = createRequiredAppFetch({ policy: 'default' }),
): Promise<CodexProviderUsage> {
  return fetchOnethingCodexUsage(token, fetchImpl) as Promise<CodexProviderUsage>
}

function summarizeCodexErrorBody(body: string): string {
  return summarizeOnethingCodexErrorBody(body)
}

/**
 * 旧的 `ONETHING_DEBUG_STREAM` / `ONETHING_DEBUG_CODEX_STREAM` 开关由等级过滤取代:
 * `ONETHING_LOG=providers.codex=trace`(旧开关保留为废弃别名,见
 * `app/logging/legacy-debug-env.ts`,L5 删)。
 */
function shouldTraceCodexStream(): boolean {
  return log.isLevelEnabled('trace')
}

function previewText(value: unknown, maxLength = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function createCodexModel(
  modelId: string,
  token: OAuthToken,
  baseUrl: string,
  fetchImpl: FetchFn,
): CodexLanguageModel {
  return {
    specificationVersion: 'v2',
    provider: CODEX_PROVIDER_ID,
    modelId,
    supportedUrls: {
      'image/*': [/^https?:\/\//, /^data:image\//],
    },

    async doStream(options: CodexCallOptions) {
      const debugStream = shouldTraceCodexStream()
      const onStreamEvent = debugStream
        ? (event: CodexSseEvent): void => {
            log.trace('codex sse event', {
              type: event.type,
              deltaChars: typeof event.delta === 'string' ? event.delta.length : 0,
              deltaPreview: typeof event.delta === 'string' ? previewText(event.delta, 240) : '',
              itemType: event.item?.type,
              hasUsage: Boolean(event.response?.usage),
            })
          }
        : undefined

      return requestOnethingCodexStream({
        modelId,
        token,
        baseUrl,
        fetchImpl,
        callOptions: options,
        providerId: CODEX_PROVIDER_ID,
        onStreamEvent,
        async onRequestPrepared(context) {
          const requestDumpPath = await dumpProviderRequest({
            providerId: CODEX_PROVIDER_ID,
            model: modelId,
            mode: 'codex-http',
            metadata: {
              url: context.url,
              method: context.method,
              warningCount: context.warnings.length,
            },
            requestBody: context.body,
          })
          log.debug('sending codex /responses request', {
            ...summarizeOnethingCodexRequestBody(context.body),
            requestDumpPath,
          })
        },
      }) as Promise<{
        stream: ReadableStream<CodexStreamPart>
        request?: { body?: CodexRawValue }
        response?: { headers?: Record<string, string> }
      }>
    },

    async doGenerate(options: CodexCallOptions) {
      const streamResult = await this.doStream(options)
      return collectOnethingCodexGenerateResult(streamResult, { modelId }) as Promise<{
        content: CodexGeneratedContent[]
        finishReason: CodexFinishReason
        usage: CodexUsage
        warnings: CodexCallWarning[]
        request?: { body?: CodexRawValue }
        response?: { headers?: Record<string, string>; modelId?: string; timestamp?: Date }
      }>
    },
  }
}

const codexProvider: ProviderDefinition = {
  id: codexBuiltinProvider.id,
  info: codexBuiltinProvider.info as ProviderDefinition['info'],
  prepareCallOptions: prepareCodexCallOptions,
}

export default codexProvider
