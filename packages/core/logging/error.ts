import type { NormalizedLogError } from './types.js'

/**
 * 错误归一(§2.1):`err` 是自己的字段,不靠 `util.inspect` 拼进 message。
 * 非 Error 值也接:字符串 / 对象 / undefined 都能给出一个稳定形状。
 */
export function normalizeError(value: unknown, depth = 0): NormalizedLogError | undefined {
  if (value === undefined || value === null) return undefined
  if (depth > 4) return { name: 'Error', message: '[cause chain truncated]' }

  if (value instanceof Error) {
    const normalized: NormalizedLogError = {
      name: value.name || 'Error',
      message: value.message,
    }
    if (typeof value.stack === 'string' && value.stack) normalized.stack = value.stack
    const cause = (value as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null) {
      const normalizedCause = normalizeError(cause, depth + 1)
      if (normalizedCause) normalized.cause = normalizedCause
    }
    return normalized
  }

  if (typeof value === 'string') {
    return { name: 'Error', message: value }
  }

  if (typeof value === 'object') {
    const candidate = value as { name?: unknown; message?: unknown; stack?: unknown; cause?: unknown }
    const message = typeof candidate.message === 'string' ? candidate.message : safeStringify(value)
    const normalized: NormalizedLogError = {
      name: typeof candidate.name === 'string' ? candidate.name : 'Error',
      message,
    }
    if (typeof candidate.stack === 'string' && candidate.stack) normalized.stack = candidate.stack
    if (candidate.cause !== undefined && candidate.cause !== null) {
      const normalizedCause = normalizeError(candidate.cause, depth + 1)
      if (normalizedCause) normalized.cause = normalizedCause
    }
    return normalized
  }

  return { name: 'Error', message: String(value) }
}

/** 结构化字段的兜底序列化:循环引用 / BigInt / 函数都不该让一条日志炸掉。 */
export function safeStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === 'bigint') return current.toString()
      if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`
      if (current instanceof Error) return normalizeError(current)
      if (current && typeof current === 'object') {
        if (seen.has(current as object)) return '[Circular]'
        seen.add(current as object)
      }
      return current
    }, space) ?? String(value)
  } catch {
    return String(value)
  }
}
