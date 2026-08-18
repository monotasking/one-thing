import { createAgentAbortError } from './stream.js'
import { isAgentLoopPauseForConfirmationError } from './errors.js'

/**
 * Turn-level auto-retry policy for transient provider/stream failures.
 *
 * Transient (retryable): provider overload, rate limits, 5xx, network/socket
 * failures, premature stream termination, timeouts.
 * Fatal (not retryable): quota/billing exhaustion, auth failures, context
 * overflow (owned by the compaction layer), aborts, permission pauses.
 */

export const MAX_TURN_RETRIES = 3
export const TURN_RETRY_BASE_DELAY_MS = 2_000

/**
 * Default cap on credential rotations within one run (see
 * `AgentLoopOptions.rotateCredential`). Rotation is orthogonal to the retry
 * schedule above: it does not consume a backoff slot and needs no delay,
 * because the next attempt uses a *different* credential.
 */
export const MAX_CREDENTIAL_ROTATIONS = 3

export function turnRetryDelayMs(attempt: number): number {
  // attempt is 1-based: 2s / 4s / 8s
  return TURN_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
}

const FATAL_PATTERNS: RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /billing/i,
  /quota[_\s-]?exceeded/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /authentication/i,
  /context[_\s-]?length[_\s-]?exceeded/i,
  /maximum context length/i,
  /context is still too large/i,
  /prompt is too long/i,
]

const RETRYABLE_PATTERNS: RegExp[] = [
  /overloaded/i,
  /rate[_\s-]?limit/i,
  /too many requests/i,
  /fetch failed/i,
  /network/i,
  /socket/i,
  /econnreset|econnrefused|etimedout|enotfound|epipe|eai_again|econnaborted/i,
  /timed?[_\s-]?out/i,
  /\bterminated\b/i,
  /premature/i,
  /unexpected end of/i,
  /stream (?:was )?(?:interrupted|closed|failed)/i,
  /server[_\s-]?error/i,
  /service[_\s-]?unavailable/i,
  /bad gateway/i,
  /gateway[_\s-]?timeout/i,
]

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  for (const key of ['statusCode', 'status']) {
    const value = record[key]
    if (typeof value === 'number') return value
  }
  return undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    return `${error.message} ${cause instanceof Error ? cause.message : ''}`
  }
  return String(error)
}

export function isRetryableAgentError(error: unknown): boolean {
  if (!error) return false
  if (error instanceof Error && error.name === 'AbortError') return false
  if (isAgentLoopPauseForConfirmationError(error)) return false

  const text = errorText(error)
  if (FATAL_PATTERNS.some(pattern => pattern.test(text))) return false

  // Providers may pre-classify (e.g. codex API errors carry isRetryable).
  if (typeof error === 'object' && typeof (error as Record<string, unknown>).isRetryable === 'boolean') {
    return (error as Record<string, unknown>).isRetryable as boolean
  }

  const status = errorStatus(error)
  if (status !== undefined) return RETRYABLE_STATUS.has(status)

  const statusInText = text.match(/\b(4\d\d|5\d\d)\b/)
  if (statusInText) return RETRYABLE_STATUS.has(Number(statusInText[1]))

  return RETRYABLE_PATTERNS.some(pattern => pattern.test(text))
}

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAgentAbortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(createAgentAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
