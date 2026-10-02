/**
 * Structured cancellation signal for tool execution.
 *
 * Tool failures are classified as "cancelled" or "failed" purely from the
 * error object — never from its message text. Substring probes like
 * `message.includes('aborted')` misfire whenever a tool's failure message
 * quotes file content (an edit that fails to match embeds a snippet of the
 * target file, and any file mentioning `abortSignal` would be mislabelled as
 * a user cancellation). Every explicit cancellation path throws an error
 * created here so the classification is unambiguous.
 */

export const TOOL_ABORT_ERROR_NAME = 'AbortError'

export interface ToolAbortError extends Error {
  aborted: true
}

export function createToolAbortError(message = 'Operation aborted'): ToolAbortError {
  const error = new Error(message) as ToolAbortError
  error.name = TOOL_ABORT_ERROR_NAME
  error.aborted = true
  return error
}

export function isToolAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; aborted?: unknown }
  return candidate.name === TOOL_ABORT_ERROR_NAME || candidate.aborted === true
}
