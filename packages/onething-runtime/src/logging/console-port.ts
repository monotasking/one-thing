import type { LogLevel, Logger } from '@onething/core/logging'

/**
 * `console` 形状的适配口(L4 迁移期)。
 *
 * core 里还有一批注入式的鸭子 logger 端口(`{ log?, info?, warn?, error?, debug? }`,
 * 签名是 `(...args: unknown[]) => void`),装配层从前一律喂 `console` —— 于是那些行
 * 全部落进 `LegacyConsoleSink` 的 `ns='console'`,丢了命名空间。
 *
 * 这里给的是**同形状**的替身:调用签名逐字不变(所以任何吃 `console` 的端口都能直接
 * 换),但每一行都带着调用点自己的 `ns` 进结构化管道。
 *
 * 约定:第一个字符串参数当 `msg`(顺手剥掉历史的 `[Tag] ` 前缀),其余参数里
 * 第一个 `Error` 进 `err`,剩下的进 `fields.details`。
 *
 * 这是**过渡件**:core 的 8 个 `Core*Logger` 鸭子接口统一为 `Logger` 之后
 * (area ①),调用点直接传 `getLogger(ns)`,本文件删。
 */
export interface ConsoleLikePort {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
  trace(...args: unknown[]): void
}

const TAG_PREFIX = /^\[[^\]\s]+]\s*/

function splitArgs(args: unknown[]): { msg: string; fields?: Record<string, unknown>; err?: unknown } {
  const [head, ...rest] = args
  const msg = typeof head === 'string' ? head.replace(TAG_PREFIX, '').trim() || head : 'log'
  const remainder = typeof head === 'string' ? rest : args
  const errAt = remainder.findIndex(value => value instanceof Error)
  const err = errAt >= 0 ? remainder[errAt] : undefined
  const details = errAt >= 0 ? [...remainder.slice(0, errAt), ...remainder.slice(errAt + 1)] : remainder
  const fields = details.length === 0
    ? undefined
    : details.length === 1 && isPlainRecord(details[0])
      ? (details[0] as Record<string, unknown>)
      : { details }
  return { msg, ...(fields ? { fields } : {}), ...(err !== undefined ? { err } : {}) }
}

function isPlainRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error)
}

function emit(log: Logger, level: LogLevel, args: unknown[]): void {
  const { msg, fields, err } = splitArgs(args)
  log[level](msg, fields, err)
}

/**
 * @param log 目标 logger(带命名空间)
 * @param plainLevel `console.log` / `console.info` 落哪一级。生命周期节点给 `info`,
 *   每请求/每条的形状转储给 `debug`(§8.1)。默认 `debug` —— 注入式端口绝大多数是后者。
 */
export function consolePort(log: Logger, plainLevel: LogLevel = 'debug'): ConsoleLikePort {
  return {
    log: (...args) => emit(log, plainLevel, args),
    info: (...args) => emit(log, plainLevel, args),
    debug: (...args) => emit(log, 'debug', args),
    trace: (...args) => emit(log, 'trace', args),
    warn: (...args) => emit(log, 'warn', args),
    error: (...args) => emit(log, 'error', args),
  }
}
