import type { JsonObject, JsonValue } from '../json.js'
import { toJsonObject } from '../json.js'

export interface CoreErrorDetails {
  message?: string
  stack?: string
  cause?: CoreErrorDetails
  responseBody?: string
  data?: CoreErrorData | string
}

interface CoreErrorData extends JsonObject {
  message?: string
  type?: string
  code?: string | number
  statusCode?: string | number
  responseBody?: string
  requestBodyValues?: JsonValue
  responseHeaders?: JsonValue
  error?: CoreNestedError | string
}

interface CoreNestedError extends JsonObject {
  message?: string
  type?: string
  code?: string | number
}

/**
 * 「这个错误码是什么意思」由服务商自己说(`docs/design/architecture-direction-2026-10.md`
 * §4 P1):core 不认识任何一家,只留一个查询口。产品层的 provider 注册表在加载时把
 * 「问遍各家的 `errorDescriptions`」接到这里;没人接 = 不加说明,只剩接口的原话。
 */
export type ProviderErrorCodeDescriber = (code: string) => string | undefined

let describeProviderErrorCode: ProviderErrorCodeDescriber | undefined

/** 返回撤销函数:只撤自己装上的那一个。 */
export function configureProviderErrorCodeDescriber(describer: ProviderErrorCodeDescriber): () => void {
  describeProviderErrorCode = describer
  return () => {
    if (describeProviderErrorCode === describer) describeProviderErrorCode = undefined
  }
}

function formatKnownProviderError(parsed: JsonObject): string | undefined {
  const nested = parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
    ? parsed.error as JsonObject
    : undefined
  const codeValue = nested?.code ?? parsed.code
  const code = typeof codeValue === 'string' || typeof codeValue === 'number'
    ? String(codeValue)
    : undefined
  if (!code) return undefined

  const description = describeProviderErrorCode?.(code)
  if (!description) return undefined

  const messageValue = nested?.message ?? parsed.message
  const message = typeof messageValue === 'string' ? messageValue.trim() : ''
  return message && !description.startsWith(message)
    ? `${message} (code: ${code}). ${description}`
    : `${description} (code: ${code})`
}

export function extractErrorDetails(error: CoreErrorDetails | undefined): string | undefined {
  if (!error) return undefined

  const data = typeof error.data === 'object' && error.data !== null ? error.data : undefined
  const bodyDetails = extractResponseBodyDetails(error.responseBody) ||
    extractResponseBodyDetails(data?.responseBody)
  if (bodyDetails) return bodyDetails

  if (error.cause) {
    return extractErrorDetails(error.cause)
  }

  if (error.data) {
    if (typeof error.data === 'string') return error.data
    const data = error.data
    const knownProviderError = formatKnownProviderError(data)
    if (knownProviderError) return knownProviderError

    if (typeof data.error === 'object' && data.error?.message) {
      const err = data.error
      let details = err.message
      if (err.type) details += ` (type: ${err.type})`
      if (err.code) details += ` (code: ${err.code})`
      return details
    }

    if (data.type === 'error' && typeof data.error === 'object') {
      const err = data.error
      return `${err.type}: ${err.message}`
    }

    if (typeof data.message === 'string') {
      return data.message
    }

    if (data.responseBody) {
      const details = extractResponseBodyDetails(data.responseBody)
      if (details) return details
    }

    if (data.requestBodyValues || data.responseHeaders || data.statusCode) {
      return data.message || `Provider API request failed${data.statusCode ? ` (${data.statusCode})` : ''}`
    }

    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return undefined
    }
  }

  return error.message || error.stack
}

export function extractResponseBodyDetails(body: string | undefined): string | undefined {
  if (typeof body !== 'string' || !body.trim()) return undefined
  try {
    const parsed = toJsonObject(JSON.parse(body) as JsonValue)
    const knownProviderError = formatKnownProviderError(parsed)
    if (knownProviderError) return knownProviderError

    const error = parsed.error
    const message = parsed.detail ||
      (error && typeof error === 'object' && !Array.isArray(error) ? error.message : undefined) ||
      parsed.message ||
      error
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // Fall back to compact text below.
  }
  const compact = body.replace(/\s+/g, ' ').trim()
  return compact || undefined
}
