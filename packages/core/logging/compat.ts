/**
 * core 侧的 logger 注入面(docs/design/logging-system-2026-08.md §8.3 区 ①)。
 *
 * core 是零依赖、且**不持有全局 root** —— 所以 core 模块拿 logger 的唯一方式是
 * 通过既有的 options/ports 注入 `logger?: Logger`,缺省 `noopLogger`。
 *
 * 迁移期还得接住老形状:core 里长年散着 14 个 `Core*Logger` 鸭子接口
 * (`{ log?, warn?, error? }`,默认值直接是 `console`),而装配层的注入点分布在
 * 区 ② 的文件里。为了让两区能各自独立落地,这里定义 `CompatLogger` =
 * `Logger | LegacyDuckLogger`,`toLogger()` 把两者都收敛成 `Logger`:
 *
 * - 已经是 `Logger`(有 `child` + `isLevelEnabled`)→ 原样返回;
 * - 老鸭子 → 包一层:`trace/debug/info` → `log`,`warn` → `warn`,
 *   `error/fatal` → `error`;参数逐字照旧(`msg`, [fields], [err]),
 *   `child()` 把绑定字段并进 fields;
 * - `undefined` → `noopLogger`(**不再默认 `console`**)。
 */

import { LOG_LEVEL_VALUE, type LogFields, type LogLevel, type Logger } from './types.js'

/** 迁移期的老形状:`console` 本身就结构满足它。 */
export interface LegacyDuckLogger {
  log?(message?: unknown, ...optionalParams: unknown[]): void
  warn?(message?: unknown, ...optionalParams: unknown[]): void
  error?(message?: unknown, ...optionalParams: unknown[]): void
  info?(message?: unknown, ...optionalParams: unknown[]): void
  debug?(message?: unknown, ...optionalParams: unknown[]): void
}

/** core 模块的注入面:新老都收。 */
export type CompatLogger = Logger | LegacyDuckLogger

class NoopLogger implements Logger {
  constructor(readonly ns: string = '') {}
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  child(): Logger {
    return this
  }
  isLevelEnabled(): boolean {
    return false
  }
}

/** 缺省注入值:什么都不做,也不碰 console。 */
export const noopLogger: Logger = new NoopLogger()

export function createNoopLogger(ns = ''): Logger {
  return new NoopLogger(ns)
}

export function isLogger(value: unknown): value is Logger {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<Logger>
  return typeof candidate.child === 'function'
    && typeof candidate.isLevelEnabled === 'function'
    && typeof candidate.trace === 'function'
}

class DuckLoggerAdapter implements Logger {
  constructor(
    private readonly duck: LegacyDuckLogger,
    readonly ns: string,
    private readonly bound?: Record<string, unknown>,
  ) {}

  isLevelEnabled(): boolean {
    return true
  }

  child(fields: Record<string, unknown>): Logger {
    return new DuckLoggerAdapter(this.duck, this.ns, { ...this.bound, ...fields })
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
    const effectiveFields: Record<string, unknown> | undefined = fields instanceof Error ? undefined : fields
    let effectiveError = err
    if (fields instanceof Error) effectiveError = effectiveError ?? fields
    const merged = this.bound || effectiveFields ? { ...this.bound, ...effectiveFields } : undefined
    // 老鸭子那条路要**逐字**保持旧行为:不加 ns 前缀、`err` 原样透传(不归一化)。
    // 迁移期注入进来的既有 `console`/测试替身,收到的参数与迁移前一模一样。
    const args: unknown[] = []
    if (merged && Object.keys(merged).length > 0) args.push(merged)
    if (effectiveError !== undefined) args.push(effectiveError)
    if (LOG_LEVEL_VALUE[level] >= LOG_LEVEL_VALUE.error) {
      ;(this.duck.error ?? this.duck.log)?.call(this.duck, msg, ...args)
      return
    }
    if (level === 'warn') {
      ;(this.duck.warn ?? this.duck.log)?.call(this.duck, msg, ...args)
      return
    }
    this.duck.log?.call(this.duck, msg, ...args)
  }
}

/**
 * 把注入进来的东西(新 `Logger` / 老鸭子 / 没给)收敛成一个 `Logger`。
 * `ns` 只在老鸭子那条路上用得着(拼成 `[ns] msg` 的前缀,保住老输出的可读性)。
 */
export function toLogger(input: CompatLogger | undefined | null, ns = ''): Logger {
  if (!input) return ns ? createNoopLogger(ns) : noopLogger
  if (isLogger(input)) return input
  return new DuckLoggerAdapter(input, ns)
}
