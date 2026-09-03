import * as undici from 'undici'
import type { Dispatcher } from 'undici'
import {
  getOnethingNetworkDispatcherCacheKey,
  normalizeOnethingProxySettings,
  shouldBypassOnethingProxy,
  validateOnethingProxyUrl,
  type OnethingProxySettings,
} from './network.js'

export type OnethingFetchFn = typeof globalThis.fetch

export type OnethingHttpPolicyName = 'default' | 'streaming' | 'webSearch' | 'auth'

export interface OnethingHttpRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  methods?: string[]
  statusCodes?: number[]
  respectRetryAfter?: boolean
}

export interface OnethingHttpPolicy {
  timeoutMs?: number
  retry?: OnethingHttpRetryOptions | false
}

export interface OnethingHttpRequestOptions {
  policy?: OnethingHttpPolicyName | OnethingHttpPolicy
  timeoutMs?: number
  retry?: OnethingHttpRetryOptions | false
  idempotent?: boolean
}

export interface OnethingAppFetchOptions extends OnethingHttpRequestOptions {
  proxy?: OnethingProxySettings
}

export type OnethingAppFetchNetworkInit = RequestInit & {
  dispatcher: Dispatcher
}

export type OnethingAppFetchNetworkFetch = (
  input: RequestInfo | URL,
  init: OnethingAppFetchNetworkInit,
) => Promise<Response>

export interface OnethingAppFetchRuntimeAdapters {
  getProxySettings?: () => OnethingProxySettings | undefined
  directFetch?: OnethingFetchFn
  networkFetch?: OnethingAppFetchNetworkFetch
  logger?: Pick<Console, 'error'>
}

export interface OnethingHttpErrorDetails {
  target: string
  method: string
  policy: string
  status?: number
  code?: string
  retryAttempts?: number
  proxy?: string
}

export class OnethingHttpError extends Error {
  readonly details: OnethingHttpErrorDetails
  readonly status?: number
  readonly code?: string

  constructor(message: string, details: OnethingHttpErrorDetails) {
    super(message)
    this.name = 'OnethingHttpError'
    this.details = details
    this.status = details.status
    this.code = details.code
  }
}

export interface OnethingHttpClient {
  fetch(input: RequestInfo | URL, init?: RequestInit, options?: OnethingHttpRequestOptions): Promise<Response>
  json<T = unknown>(input: RequestInfo | URL, init?: RequestInit, options?: OnethingHttpRequestOptions): Promise<T>
  createFetch(options?: OnethingHttpRequestOptions): OnethingFetchFn
}

type AgentOptions = NonNullable<ConstructorParameters<typeof undici.Agent>[0]>
type ProxyAgentOptions = Exclude<ConstructorParameters<typeof undici.ProxyAgent>[0], string | URL>
type ProxyTlsOptions = {
  timeout?: number | null
}
type ProxyDispatcherOptions = Omit<ProxyAgentOptions, 'uri' | 'proxyTls'> & {
  proxyTls?: ProxyTlsOptions
}
type Socks5ProxyAgentOptions = NonNullable<ConstructorParameters<typeof undici.Socks5ProxyAgent>[1]>
type Socks5ProxyAgentConstructor = typeof undici.Socks5ProxyAgent
type FetchErrorDetails = {
  code?: string
  message?: string
}
type ErrorWithCause = Error & {
  cause?: Error | FetchErrorDetails
}
type UndiciFetchInput = Parameters<typeof undici.fetch>[0]
type UndiciFetchInit = NonNullable<Parameters<typeof undici.fetch>[1]>
type ResolvedHttpRetryOptions = Required<OnethingHttpRetryOptions>
type ResolvedHttpPolicy = {
  name: string
  timeoutMs?: number
  retry: ResolvedHttpRetryOptions | false
}
type AttemptInit = {
  init?: RequestInit
  cleanup: () => void
  didTimeout: () => boolean
}

const dispatcherCache = new Map<string, Dispatcher>()

// AI streams can legitimately pause for more than Undici's 300s default while
// a reasoning model works; callers still cancel through AbortSignal.
const ONETHING_APP_FETCH_BODY_TIMEOUT_MS = 0
const DEFAULT_RETRY_STATUS_CODES = [408, 429, 500, 502, 503, 504]
const DEFAULT_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS']
const DEFAULT_HTTP_RETRY: ResolvedHttpRetryOptions = {
  maxAttempts: 1,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  methods: DEFAULT_RETRY_METHODS,
  statusCodes: DEFAULT_RETRY_STATUS_CODES,
  respectRetryAfter: true,
}
const HTTP_POLICY_PRESETS: Record<OnethingHttpPolicyName, OnethingHttpPolicy> = {
  default: {
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 2,
      methods: DEFAULT_RETRY_METHODS,
      statusCodes: DEFAULT_RETRY_STATUS_CODES,
    },
  },
  streaming: {
    retry: false,
  },
  webSearch: {
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 2,
      baseDelayMs: 300,
      maxDelayMs: 1_500,
      methods: ['GET', 'HEAD'],
      statusCodes: DEFAULT_RETRY_STATUS_CODES,
    },
  },
  auth: {
    timeoutMs: 30_000,
    retry: {
      maxAttempts: 2,
      methods: ['GET', 'HEAD', 'POST'],
      statusCodes: DEFAULT_RETRY_STATUS_CODES,
    },
  },
}

export const validateOnethingAppProxyUrl = validateOnethingProxyUrl

function getActiveProxySettings(
  override: OnethingProxySettings | undefined,
  adapters: OnethingAppFetchRuntimeAdapters,
): OnethingProxySettings | undefined {
  return normalizeOnethingProxySettings(override ?? adapters.getProxySettings?.())
}

export function shouldBypassOnethingAppProxy(input: RequestInfo | URL, bypassRules?: string): boolean {
  return shouldBypassOnethingProxy(input, bypassRules)
}

export function createOnethingDirectDispatcherOptions(): AgentOptions {
  return {
    bodyTimeout: ONETHING_APP_FETCH_BODY_TIMEOUT_MS,
  }
}

export function createOnethingProxyDispatcherOptions(
  proxy: OnethingProxySettings,
): ProxyDispatcherOptions {
  void proxy
  return {
    bodyTimeout: ONETHING_APP_FETCH_BODY_TIMEOUT_MS,
  }
}

function createSocks5ProxyAgent(
  proxy: OnethingProxySettings,
  options: ProxyDispatcherOptions,
): Dispatcher {
  const Socks5ProxyAgent: Socks5ProxyAgentConstructor = undici.Socks5ProxyAgent
  if (!Socks5ProxyAgent) {
    throw new Error('SOCKS5 proxy support is not available in this undici version.')
  }

  return new Socks5ProxyAgent(proxy.url, options as Socks5ProxyAgentOptions)
}

export function getOnethingAppDispatcher(
  proxy?: OnethingProxySettings,
): Dispatcher {
  const key = getOnethingNetworkDispatcherCacheKey(proxy)
  let dispatcher = dispatcherCache.get(key)
  if (dispatcher) return dispatcher

  if (proxy) {
    const proxyDispatcherOptions = createOnethingProxyDispatcherOptions(proxy)
    if (proxy.url.toLowerCase().startsWith('socks5:')) {
      dispatcher = createSocks5ProxyAgent(proxy, proxyDispatcherOptions)
    } else {
      dispatcher = new undici.ProxyAgent({
        uri: proxy.url,
        ...proxyDispatcherOptions,
      } as ProxyAgentOptions)
    }
  } else {
    const dispatcherOptions = createOnethingDirectDispatcherOptions()
    dispatcher = new undici.Agent(dispatcherOptions)
  }

  if (!dispatcher) throw new Error('Failed to create app network dispatcher')
  dispatcherCache.set(key, dispatcher)
  return dispatcher
}

export function clearOnethingAppDispatcherCache(): void {
  dispatcherCache.clear()
}

function fetchInputToString(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url || String(input)
}

function errorToDetails(error: Error): FetchErrorDetails {
  const withCode = error as Error & { code?: string }
  return {
    code: withCode.code,
    message: error.message,
  }
}

function errorCauseToDetails(error: Error): FetchErrorDetails | undefined {
  const cause = (error as ErrorWithCause).cause
  if (!cause || typeof cause !== 'object') {
    return undefined
  }
  if (cause instanceof Error) {
    const withCode = cause as Error & { code?: string }
    return {
      code: withCode.code,
      message: cause.message,
    }
  }
  const details = cause as FetchErrorDetails
  return {
    code: details.code,
    message: details.message,
  }
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value as number))
}

function normalizeRetryOptions(retry: OnethingHttpRetryOptions | false | undefined): ResolvedHttpRetryOptions | false {
  if (!retry) return false
  return {
    ...DEFAULT_HTTP_RETRY,
    ...retry,
    maxAttempts: clampPositiveInt(retry.maxAttempts, DEFAULT_HTTP_RETRY.maxAttempts),
    baseDelayMs: Math.max(0, retry.baseDelayMs ?? DEFAULT_HTTP_RETRY.baseDelayMs),
    maxDelayMs: Math.max(0, retry.maxDelayMs ?? DEFAULT_HTTP_RETRY.maxDelayMs),
    methods: (retry.methods?.length ? retry.methods : DEFAULT_HTTP_RETRY.methods).map(method => method.toUpperCase()),
    statusCodes: retry.statusCodes?.length ? retry.statusCodes : DEFAULT_HTTP_RETRY.statusCodes,
  }
}

export function resolveOnethingHttpPolicy(options: OnethingHttpRequestOptions = {}): ResolvedHttpPolicy {
  const policyName = typeof options.policy === 'string' ? options.policy : 'default'
  const policy = typeof options.policy === 'object' ? options.policy : HTTP_POLICY_PRESETS[policyName]
  const retry = options.retry === false || policy.retry === false
    ? false
    : normalizeRetryOptions({
      ...(policy.retry || {}),
      ...(options.retry || {}),
    })
  const timeoutMs = options.timeoutMs ?? policy.timeoutMs

  return {
    name: typeof options.policy === 'string' ? options.policy : typeof options.policy === 'object' ? 'custom' : policyName,
    timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
    retry,
  }
}

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Request timed out after ${timeoutMs}ms`)
  error.name = 'TimeoutError'
  return error
}

function signalReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason
}

function createAttemptInit(init: RequestInit | undefined, timeoutMs: number | undefined): AttemptInit {
  const sourceSignal = init?.signal ?? undefined
  if (!sourceSignal && !timeoutMs) {
    return {
      init,
      cleanup: () => undefined,
      didTimeout: () => false,
    }
  }

  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let timeoutTriggered = false

  const abortFromSource = () => {
    controller.abort(sourceSignal ? signalReason(sourceSignal) : undefined)
  }

  if (sourceSignal?.aborted) {
    abortFromSource()
  } else {
    sourceSignal?.addEventListener('abort', abortFromSource, { once: true })
  }

  if (timeoutMs) {
    timeoutId = setTimeout(() => {
      timeoutTriggered = true
      controller.abort(createTimeoutError(timeoutMs))
    }, timeoutMs)
  }

  return {
    init: {
      ...(init || {}),
      signal: controller.signal,
    },
    cleanup: () => {
      if (timeoutId) clearTimeout(timeoutId)
      sourceSignal?.removeEventListener('abort', abortFromSource)
    },
    didTimeout: () => timeoutTriggered,
  }
}

function hasNonReplayableBody(input: RequestInfo | URL, init?: RequestInit): boolean {
  const body = init?.body
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return true
  if (input instanceof Request && input.body) return true
  return false
}

function canRetryRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  method: string,
  retry: ResolvedHttpRetryOptions | false,
  idempotent: boolean | undefined,
): retry is ResolvedHttpRetryOptions {
  if (!retry || retry.maxAttempts <= 1) return false
  const methodAllowed = idempotent || retry.methods.includes(method)
  if (!methodAllowed) return false
  if (!idempotent && hasNonReplayableBody(input, init)) return false
  return true
}

function shouldRetryResponse(response: Response, retry: ResolvedHttpRetryOptions): boolean {
  return retry.statusCodes.includes(response.status)
}

function retryAfterDelayMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - Date.now())
}

function retryDelayMs(attempt: number, retry: ResolvedHttpRetryOptions, response?: Response): number {
  const retryAfterMs = response && retry.respectRetryAfter ? retryAfterDelayMs(response) : undefined
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxDelayMs)
  return Math.min(retry.baseDelayMs * 2 ** Math.max(0, attempt - 1), retry.maxDelayMs)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalReason(signal))
      return
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', abort)
      reject(signal ? signalReason(signal) : undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined)
}

async function defaultNetworkFetch(input: RequestInfo | URL, init: OnethingAppFetchNetworkInit): Promise<Response> {
  const response = await undici.fetch(input as UndiciFetchInput, init as UndiciFetchInit)
  // undici 的 Response 与 lib.dom 的 Response 类型不再「足够重叠」(2026-09-04 Vue 宿主退役后 electron 的
  // 类型不再进 node typecheck 图);运行时是同一个 WHATWG 形,经 unknown 过桥。
  return response as unknown as Response
}

async function executeOnethingFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  options: OnethingAppFetchOptions,
  adapters: OnethingAppFetchRuntimeAdapters,
): Promise<Response> {
  const method = resolveRequestMethod(input, init)
  const target = fetchInputToString(input)
  const policy = resolveOnethingHttpPolicy(options)
  const proxy = getActiveProxySettings(options.proxy, adapters)
  const activeProxy = proxy && !shouldBypassOnethingAppProxy(input, proxy.bypassRules) ? proxy : undefined
  const retry = canRetryRequest(input, init, method, policy.retry, options.idempotent)
    ? policy.retry
    : false
  const maxAttempts = retry ? retry.maxAttempts : 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptInit = createAttemptInit(init, policy.timeoutMs)

    try {
      const response = activeProxy
        ? await (adapters.networkFetch ?? defaultNetworkFetch)(input, {
          ...(attemptInit.init || {}),
          dispatcher: getOnethingAppDispatcher(activeProxy),
        } as OnethingAppFetchNetworkInit)
        : await (adapters.directFetch ?? fetch)(input, attemptInit.init)

      attemptInit.cleanup()

      if (retry && attempt < maxAttempts && shouldRetryResponse(response, retry)) {
        cancelResponseBody(response)
        await sleep(retryDelayMs(attempt, retry, response), init?.signal ?? undefined)
        continue
      }

      return response
    } catch (error) {
      attemptInit.cleanup()
      lastError = error
      if (init?.signal?.aborted && !attemptInit.didTimeout()) throw error
      if (!retry || attempt >= maxAttempts) break
      await sleep(retryDelayMs(attempt, retry), init?.signal ?? undefined)
    }
  }

  const errorDetails = lastError instanceof Error
    ? errorToDetails(lastError)
    : { message: String(lastError) }
  const causeDetails = lastError instanceof Error ? errorCauseToDetails(lastError) : undefined
  const logger = adapters.logger ?? console
  logger.error('[Network] App fetch failed:', {
    target,
    method,
    policy: policy.name,
    proxy: activeProxy?.url,
    attempts: maxAttempts,
    code: causeDetails?.code || errorDetails.code,
    message: causeDetails?.message || errorDetails.message,
  })
  throw lastError
}

function mergeHttpRequestOptions(
  base: OnethingAppFetchOptions,
  request?: OnethingHttpRequestOptions,
): OnethingAppFetchOptions {
  if (!request) return base
  return {
    ...base,
    ...request,
    proxy: base.proxy,
  }
}

/**
 * Create a fetch using onething network settings.
 * Settings are resolved at request time so cached provider instances pick up
 * proxy changes without needing to recreate SDK clients first.
 */
export function createOnethingAppHttpClient(
  options: OnethingAppFetchOptions = {},
  adapters: OnethingAppFetchRuntimeAdapters = {},
): OnethingHttpClient {
  const client: OnethingHttpClient = {
    fetch(input, init, requestOptions) {
      return executeOnethingFetch(input, init, mergeHttpRequestOptions(options, requestOptions), adapters)
    },
    async json<T = unknown>(
      input: RequestInfo | URL,
      init?: RequestInit,
      requestOptions?: OnethingHttpRequestOptions,
    ): Promise<T> {
      const response = await client.fetch(input, init, requestOptions)
      if (!response.ok) {
        throw new OnethingHttpError(`HTTP request failed with status ${response.status}`, {
          target: fetchInputToString(input),
          method: resolveRequestMethod(input, init),
          policy: resolveOnethingHttpPolicy(mergeHttpRequestOptions(options, requestOptions)).name,
          status: response.status,
        })
      }
      return await response.json() as T
    },
    createFetch(requestOptions?: OnethingHttpRequestOptions) {
      return (input: RequestInfo | URL, init?: RequestInit) => client.fetch(input, init, requestOptions)
    },
  }
  return client
}

export function createOnethingAppFetch(
  options: OnethingAppFetchOptions = {},
  adapters: OnethingAppFetchRuntimeAdapters = {},
): OnethingFetchFn {
  return createOnethingAppHttpClient(options, adapters).createFetch()
}

export function createRequiredOnethingAppFetch(
  options: OnethingAppFetchOptions = {},
  adapters: OnethingAppFetchRuntimeAdapters = {},
): OnethingFetchFn {
  return createOnethingAppFetch(options, adapters)
}

export function createOnethingBoundFetch(adapters: OnethingAppFetchRuntimeAdapters = {}): OnethingFetchFn {
  return createOnethingAppFetch({}, adapters)
}
