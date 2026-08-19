import { LevelFilter } from './level.js'
import { normalizeError } from './error.js'
import {
  LOG_LEVEL_VALUE,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type LogFields,
  type LogSource,
  type Logger,
} from './types.js'

export interface LoggerRootOptions {
  /** `ONETHING_LOG` 形状的 spec;不给 = `info`。 */
  level?: string
  sinks?: LogSink[]
  /** 记录默认落哪个进程面。 */
  src?: LogSource
  /** 所有记录都带上的字段(宿主级上下文,如 pid)。 */
  baseFields?: Record<string, unknown>
  /** sink 自己炸了不能反过来炸调用方 —— 报给宿主,记录照丢。 */
  onSinkError?: (error: unknown, sink: LogSink) => void
  now?: () => number
}

/**
 * 生产者与 sink 的解耦点(P5):logger 只造 `LogRecord`,root 负责过滤 + 扇出。
 */
export class LoggerRoot {
  private readonly filter: LevelFilter
  private sinks: LogSink[]
  /**
   * 记录默认落哪个进程面。**可变**:根 logger 在模块求值时就存在(那时还不知道
   * 自己是谁),宿主的 `configureLogging({src})` 才把它钉下来 —— 所以子 logger
   * 在**写入时**读它,而不是构造时快照。
   */
  private srcValue?: LogSource
  private readonly baseFields?: Record<string, unknown>
  private readonly onSinkError?: (error: unknown, sink: LogSink) => void
  private readonly now: () => number
  private readonly loggers = new Map<string, Logger>()

  constructor(options: LoggerRootOptions = {}) {
    this.filter = new LevelFilter(options.level)
    this.sinks = [...(options.sinks ?? [])]
    this.srcValue = options.src
    this.baseFields = options.baseFields
    this.onSinkError = options.onSinkError
    this.now = options.now ?? Date.now
  }

  get levelSpec(): string {
    return this.filter.spec
  }

  get src(): LogSource | undefined {
    return this.srcValue
  }

  setSrc(src: LogSource | undefined): void {
    this.srcValue = src
  }

  setLevelSpec(spec: string | null | undefined): void {
    this.filter.setSpec(spec)
  }

  getSinks(): LogSink[] {
    return [...this.sinks]
  }

  addSink(sink: LogSink): () => void {
    this.sinks.push(sink)
    return () => this.removeSink(sink)
  }

  removeSink(sink: LogSink): void {
    const at = this.sinks.indexOf(sink)
    if (at >= 0) this.sinks.splice(at, 1)
  }

  setSinks(sinks: LogSink[]): void {
    this.sinks = [...sinks]
  }

  clearSinks(): void {
    this.sinks = []
  }

  isEnabled(ns: string, level: LogLevel): boolean {
    return this.filter.isEnabled(ns, level)
  }

  /** 直接投递一条已经成形的记录(renderer 桥 / LegacyConsoleSink 用)。 */
  emit(record: LogRecord): void {
    if (!this.filter.isEnabled(record.ns, record.level)) return
    const final: LogRecord = this.baseFields
      ? { ...record, fields: { ...this.baseFields, ...record.fields } }
      : record
    for (const sink of this.sinks) {
      if (sink.minLevel && LOG_LEVEL_VALUE[final.level] < LOG_LEVEL_VALUE[sink.minLevel]) continue
      try {
        sink.write(final)
      } catch (error) {
        this.onSinkError?.(error, sink)
      }
    }
  }

  logger(ns: string): Logger {
    const existing = this.loggers.get(ns)
    if (existing) return existing
    const logger = new RootBoundLogger(this, ns, undefined, this.now)
    this.loggers.set(ns, logger)
    return logger
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.flush?.()
      } catch (error) {
        this.onSinkError?.(error, sink)
      }
    }
  }

  async close(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.close?.()
      } catch (error) {
        this.onSinkError?.(error, sink)
      }
    }
  }
}

class RootBoundLogger implements Logger {
  constructor(
    private readonly root: LoggerRoot,
    readonly ns: string,
    private readonly boundFields: Record<string, unknown> | undefined,
    private readonly now: () => number,
  ) {}

  isLevelEnabled(level: LogLevel): boolean {
    return this.root.isEnabled(this.ns, level)
  }

  child(fields: Record<string, unknown>): Logger {
    return new RootBoundLogger(
      this.root,
      this.ns,
      { ...this.boundFields, ...fields },
      this.now,
    )
  }

  trace(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('trace', msg, fields, err)
  }

  debug(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('debug', msg, fields, err)
  }

  info(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('info', msg, fields, err)
  }

  warn(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('warn', msg, fields, err)
  }

  error(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('error', msg, fields, err)
  }

  fatal(msg: string, fields?: LogFields, err?: unknown): void {
    this.write('fatal', msg, fields, err)
  }

  private write(level: LogLevel, msg: string, fields?: LogFields, err?: unknown): void {
    if (!this.root.isEnabled(this.ns, level)) return
    // 第二个参数直接给了 Error 是最自然的写法,别让它变成一个叫 "0" 的字段。
    let effectiveFields: Record<string, unknown> | undefined = fields instanceof Error ? undefined : fields
    let effectiveError = err
    if (fields instanceof Error) {
      effectiveError = effectiveError ?? fields
      effectiveFields = undefined
    }
    const merged = this.boundFields || effectiveFields
      ? { ...this.boundFields, ...effectiveFields }
      : undefined
    const record: LogRecord = {
      time: this.now(),
      level,
      ns: this.ns,
      msg,
    }
    if (merged && Object.keys(merged).length > 0) record.fields = merged
    const normalized = normalizeError(effectiveError)
    if (normalized) record.err = normalized
    const src = this.root.src
    if (src) record.src = src
    this.root.emit(record)
  }
}

/** §3 L0 的入口形状:`createLogger(root, ns)`。 */
export function createLogger(root: LoggerRoot, ns: string): Logger {
  return root.logger(ns)
}
