import { safeStringify } from './error.js'
import type { LogLevel, LogRecord, LogSink } from './types.js'

/** JSONL 一行(文件 sink 与 renderer 桥共用同一套序列化)。 */
export function formatJsonLine(record: LogRecord): string {
  return `${safeStringify(record)}\n`
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  fatal: 'FATAL',
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function pad3(value: number): string {
  return value < 10 ? `00${value}` : value < 100 ? `0${value}` : String(value)
}

function clockOf(time: number): string {
  const date = new Date(time)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}`
}

/** 终端渲染:`12:03:41.220 INFO  engine.stream stream finished {"ms":812}` */
export function formatPretty(record: LogRecord): string {
  const parts = [clockOf(record.time), LEVEL_LABEL[record.level], record.ns, record.msg]
  let line = parts.join(' ')
  if (record.fields && Object.keys(record.fields).length > 0) {
    line += ` ${safeStringify(record.fields)}`
  }
  if (record.err) {
    // 栈通常已经以 `Name: message` 开头 —— 别把同一行打两遍。
    const head = `${record.err.name}: ${record.err.message}`
    if (record.err.stack?.startsWith(head)) line += `\n${indent(record.err.stack)}`
    else {
      line += `\n  ${head}`
      if (record.err.stack) line += `\n${indent(record.err.stack)}`
    }
    let cause = record.err.cause
    while (cause) {
      line += `\n  caused by ${cause.name}: ${cause.message}`
      cause = cause.cause
    }
  }
  return line
}

function indent(text: string): string {
  return text.split('\n').map(line => `    ${line}`).join('\n')
}

export interface ConsoleLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface ConsoleSinkOptions {
  format?: 'pretty' | 'json'
  minLevel?: LogLevel
  /** 注入点:装配层会把**原始** console(劫持之前的那份)传进来,避免自喂。 */
  target?: ConsoleLike
}

export class ConsoleSink implements LogSink {
  readonly minLevel?: LogLevel
  private readonly format: 'pretty' | 'json'
  private readonly target: ConsoleLike

  constructor(options: ConsoleSinkOptions = {}) {
    this.format = options.format ?? 'pretty'
    this.minLevel = options.minLevel
    this.target = options.target ?? (globalThis.console as unknown as ConsoleLike)
  }

  write(record: LogRecord): void {
    const line = this.format === 'json' ? formatJsonLine(record).trimEnd() : formatPretty(record)
    if (record.level === 'error' || record.level === 'fatal') this.target.error(line)
    else if (record.level === 'warn') this.target.warn(line)
    else if (record.level === 'trace' || record.level === 'debug') this.target.debug(line)
    else this.target.info(line)
  }
}

/** 崩溃现场:最近 n 条留在内存里,`dump()` 随时取。 */
export class MemoryRingSink implements LogSink {
  private readonly buffer: LogRecord[]
  private next = 0
  private filled = false

  constructor(private readonly capacity = 200) {
    this.buffer = new Array<LogRecord>(Math.max(1, capacity))
  }

  write(record: LogRecord): void {
    this.buffer[this.next] = record
    this.next = (this.next + 1) % this.buffer.length
    if (this.next === 0) this.filled = true
  }

  /** 从旧到新。 */
  dump(): LogRecord[] {
    if (!this.filled) return this.buffer.slice(0, this.next)
    return [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)]
  }

  get size(): number {
    return this.filled ? this.buffer.length : this.next
  }

  clear(): void {
    this.next = 0
    this.filled = false
  }
}

/**
 * 文件 sink 的**接口**。实现住在装配层(`@onething/backend/logging/jsonl-file-sink.ts`)
 * —— core 不碰 fs。
 */
export interface JsonlFileSink extends LogSink {
  getActivePath(): string
  flush(): Promise<void>
  flushSync(): void
  close(): Promise<void>
}
