/**
 * 日志内核的形状(docs/design/logging-system-2026-08.md §2.1)。
 *
 * 零依赖、零 node import —— 这一层只定义"记录长什么样"和"谁能接收它",
 * 落盘 / 轮转 / 目录治理全部住在装配层(`@onething/app/logging`)。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

/** 记录来自哪个进程面。`console` = 尚未迁移的裸 console 流量(迁移期临时)。 */
export type LogSource =
  | 'main'
  | 'renderer'
  | 'server'
  | 'daemon'
  | 'gateway'
  | 'console'
  | 'process'

export interface NormalizedLogError {
  name: string
  message: string
  stack?: string
  cause?: NormalizedLogError
}

export interface LogRecord {
  /** epoch ms */
  time: number
  level: LogLevel
  /** 点分命名空间,层级前缀即过滤单位:`engine.stream`、`server.http`。 */
  ns: string
  /** 固定短句,变量进 `fields` —— 这样才可 grep、可聚合。 */
  msg: string
  fields?: Record<string, unknown>
  err?: NormalizedLogError
  src?: LogSource
}

export interface LogSink {
  write(record: LogRecord): void
  /** 该 sink 自己的下限(在根过滤之后再收一道),不给 = 不额外收。 */
  minLevel?: LogLevel
  flush?(): void | Promise<void>
  close?(): void | Promise<void>
}

/**
 * 第二个参数允许直接给 `Error` —— `log.error('load failed', error)` 是最自然的
 * 写法,实现会把它认成 `err` 而不是一个叫 "0" 的字段。
 */
export type LogFields = Record<string, unknown> | Error

export interface Logger {
  readonly ns: string
  trace(msg: string, fields?: LogFields, err?: unknown): void
  debug(msg: string, fields?: LogFields, err?: unknown): void
  info(msg: string, fields?: LogFields, err?: unknown): void
  warn(msg: string, fields?: LogFields, err?: unknown): void
  error(msg: string, fields?: LogFields, err?: unknown): void
  fatal(msg: string, fields?: LogFields, err?: unknown): void
  /** 绑定上下文一次,后续行自动带(P3):`log.child({ sessionId })`。 */
  child(fields: Record<string, unknown>): Logger
  isLevelEnabled(level: LogLevel): boolean
}

export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal']

export const LOG_LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVEL_VALUE, value)
}
