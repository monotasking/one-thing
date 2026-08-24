/**
 * 产品层的日志门面(docs/design/logging-system-2026-08.md §8.3 区 ①)。
 *
 * 产品层(`packages/onething-runtime/src/**`)不能 import
 * `@onething/backend` —— 依赖方向是单向的(product ← assembly ← hosts)。所以这里
 * 放一个**薄**模块:持有一个可被装配层替换的 root,导出 `getLogger(ns)`。
 *
 * - 装配层的 `configureLogging()` 调一次 `setRuntimeLoggerRoot(getRootLogger())`,
 *   从此产品层与装配层写进同一套 sink(同一个文件、同一个内存环、同一份等级 spec)。
 * - 在那之前(以及单测里没人接线时),默认 root 只挂一个内存环:记录不丢、也不
 *   打到 console 上污染测试输出;`dumpRuntimeLogRecords()` 可以捞回来。
 *
 * `getLogger()` 返回的是**延迟绑定**的 logger:模块顶层
 * `const log = getLogger('sessions')` 在 root 被替换之后照样写进新 root ——
 * 产品层的模块几乎都在装配之前就被求值了,快照式绑定会让它们永远写进旧 root。
 */

import {
  configureCoreLogging,
  LoggerRoot,
  MemoryRingSink,
  type LogFields,
  type LogLevel,
  type LogRecord,
  type Logger, type LoggerRootOptions,
} from '@onething/core/logging'

const FALLBACK_RING_SIZE = 200

function resolveEnvLevelSpec(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.ONETHING_LOG
}

const fallbackRing = new MemoryRingSink(FALLBACK_RING_SIZE)
const loggerRootOptions: LoggerRootOptions = {
  level: resolveEnvLevelSpec(),
  sinks: [fallbackRing],
};
const fallbackRoot = new LoggerRoot(loggerRootOptions)

let currentRoot: LoggerRoot = fallbackRoot
/** root 换了就让所有 DeferredLogger 重新取一次目标,避免每行都新建 child。 */
let generation = 0

/**
 * 装配层的接线口。`@onething/backend/wiring/logging` 的 `configureLogging()` 调它一次。
 * 幂等地重复调用是安全的(只换引用 + 递增 generation)。
 */
export function setRuntimeLoggerRoot(root: LoggerRoot | null | undefined): void {
  currentRoot = root ?? fallbackRoot
  generation += 1
  // core 的注入端口顺带填上 —— 它同样是「装配层给的那一套 sink」,不该让宿主
  // 记着调第二句(`@onething/core/logging` 零依赖,这条 import 不带进任何东西)。
  configureCoreLogging({ getLogger })
}

export function getRuntimeLoggerRoot(): LoggerRoot {
  return currentRoot
}

/** 未接线时兜住的那 200 条(接线后这一环就不再收新记录了)。 */
export function dumpRuntimeLogRecords(): LogRecord[] {
  return fallbackRing.dump()
}

class DeferredLogger implements Logger {
  private cachedGeneration = -1
  private cached: Logger | null = null

  constructor(
    readonly ns: string,
    private readonly bound?: Record<string, unknown>,
  ) {}

  private target(): Logger {
    if (this.cached && this.cachedGeneration === generation) return this.cached
    const base = currentRoot.logger(this.ns)
    this.cached = this.bound ? base.child(this.bound) : base
    this.cachedGeneration = generation
    return this.cached
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.target().isLevelEnabled(level)
  }

  child(fields: Record<string, unknown>): Logger {
    return new DeferredLogger(this.ns, { ...this.bound, ...fields })
  }

  trace(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().trace(msg, fields, err)
  }

  debug(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().debug(msg, fields, err)
  }

  info(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().info(msg, fields, err)
  }

  warn(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().warn(msg, fields, err)
  }

  error(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().error(msg, fields, err)
  }

  fatal(msg: string, fields?: LogFields, err?: unknown): void {
    this.target().fatal(msg, fields, err)
  }
}

const loggers = new Map<string, Logger>()

/** 产品层唯一需要的东西:`const log = getLogger('sessions')`。 */
export function getLogger(ns: string): Logger {
  const existing = loggers.get(ns)
  if (existing) return existing
  const logger = new DeferredLogger(ns)
  loggers.set(ns, logger)
  return logger
}

/**
 * 测试用的抓取器:把 root 换成一个只挂内存环的临时 root,`restore()` 放回去。
 *
 * 迁移期需要它 —— 老测试断言的是 `vi.spyOn(console, 'warn')`,而日志已经不走
 * console 了;断言的对象应该是**记录**,不是某个 sink 的副作用。
 */

export function captureRuntimeLogs(level = 'trace'): {
  records(): LogRecord[]
  ofLevel(level: LogLevel): LogRecord[]
  restore(): void
} {
  const previous = currentRoot
  const ring = new MemoryRingSink(500)
  const loggerRootOptions2: LoggerRootOptions = { level, sinks: [ring] };
  setRuntimeLoggerRoot(new LoggerRoot(loggerRootOptions2))
  return {
    records: () => ring.dump(),
    ofLevel: (wanted: LogLevel) => ring.dump().filter(record => record.level === wanted),
    restore: () => setRuntimeLoggerRoot(previous === fallbackRoot ? null : previous),
  }
}

export type { Logger, LogLevel, LogRecord } from '@onething/core/logging'

/**
 * `console` 形状的注入端口适配器(L4 迁移期的过渡件)。
 *
 * P3'a-3 从 `src/app/logging/` 搬到这里:它是 `Logger → console` 的**纯适配器**,
 * 只认识 `@onething/core/logging` 的类型,一条装配层的边都没有。留在 app 里就成了
 * 一根假脊柱 —— 任何用得上它的产品层模块都会因为这一条 import 被钉死在 `src/app`。
 * 装配层的 `@onething/backend/wiring/logging` 原样再导出,老调用点一行不改。
 */
export { consolePort } from './console-port.js'
export type { ConsoleLikePort } from './console-port.js'
