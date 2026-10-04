/**
 * logging:日志设施的入口(docs/design/logging-system-2026-08.md)。
 *
 * 它做什么:给任何模块一只 `getLogger(ns)`,定一条记录的形状(`LogRecord`)、logger 接口、sink、等级与错误归一,
 * 外加旧式 `console` 形状端口的适配器和服务商请求转储。写盘、轮转、目录管家、进程崩溃钩子与等级 spec 的接线
 * 在 `logging-configure.ts`,由宿主与装配配方在启动时调一次 `configureLogging()`。
 *
 * 对外交出四类东西:
 * 1. 取 logger 与当前 root(就写在本文件里)—— `getLogger` 是延迟绑定的那一只,跟着当前 root 走;
 *    `configureLogging()` 调 `setRuntimeLoggerRoot` 把当前 root 指到 configure 的 root,检索 Worker 则指到往宿主
 *    转发的那一只。`captureRuntimeLogs` 是测试用的抓取器。
 * 2. 日志原语 —— 记录与 logger 的类型、`LoggerRoot`、sink、等级表、错误归一,以及兼容层(`toLogger` / `CompatLogger`)
 *    与注入端口(`getCoreLogger`)。
 * 3. `console` 形状的端口适配器 `consolePort`(迁移期的过渡件)。
 * 4. 服务商请求转储(落 `log/dumps/`,开关由诊断模式拨)。
 *
 * 依赖:只依赖 `@shared/logging` 与 node 内建;`logging-console-port.ts` 对各功能的引用全是类型。
 *
 * 没有交出的:`logging-configure.ts` 的接线函数(`configureLogging` / `writeAppLog` / `getAppLogPath` / …)与它自己那只
 * `getLogger`、`logging-diagnostics.ts` 的诊断模式开关,今天仍经深层键给宿主与使用者 —— 经入口交出会把 configure
 * 连同存储层一起拖进检索 Worker;而且 configure 的 `getLogger` 与本文件这只同名不同物:那一只直接绑在 configure
 * 自己的 root 上(接线之前写进它的 400 条内存环,测试用 `collectLogRecordsForTests` 收),这一只跟着当前 root 走
 * (接线之前写进下面的 200 条兜底环,测试用 `captureRuntimeLogs` 收)。两只合不合并是一条行为裁定,
 * 2026-10-04 列给用户,没有动(决策记录 D155)。
 *
 * 取 logger 那一段的实现留在入口里而没有搬进兄弟文件:搬出去会让检索 Worker 的产物多 13 个字节
 * (打包器给每只贡献代码的文件留一行路径注释),而 Worker 字节不许变大(D156)。
 */

import {
  configureCoreLogging,
  LoggerRoot,
  MemoryRingSink,
  type LogFields,
  type LogRecord,
  type Logger,
  type LoggerRootOptions,
} from './logging-logger-primitives.js'
import { type LogLevel } from '@shared/logging/types'

// ── 1. 取 logger 与当前 root ────────────────────────────────────────────────

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
 * 接线口。`logging-configure.ts` 的 `configureLogging()` 调它一次;检索 Worker 换成转发 root 时也调它。
 * 幂等地重复调用是安全的(只换引用 + 递增 generation)。
 */
export function setRuntimeLoggerRoot(root: LoggerRoot | null | undefined): void {
  currentRoot = root ?? fallbackRoot
  generation += 1
  // 注入端口(`getCoreLogger` 背后那一格)顺带填上 —— 它同样该写进这一套 sink,不该让宿主
  // 记着调第二句(`logging-port.ts` 零依赖,这条 import 不带进任何东西)。
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

/** 取一只延迟绑定的 logger:`const log = getLogger('sessions')`。 */
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

// ── 2. 日志原语 ─────────────────────────────────────────────────────────────
export { LOG_LEVEL_VALUE } from './logging-types.js'
export type { LogRecord, LogSink, Logger, NormalizedLogError } from './logging-types.js'
export { LoggerRoot } from './logging-logger.js'
export { ConsoleSink } from './logging-sinks.js'
export { normalizeError, safeStringify } from './logging-error.js'
export { toLogger } from './logging-compat.js'
export type { CompatLogger, LegacyDuckLogger } from './logging-compat.js'
export { getCoreLogger } from './logging-port.js'

// ── 3. console 形状的端口适配器 ─────────────────────────────────────────────
// `Logger → console` 的纯适配器(P3'a-3 搬来);`logging-configure.ts` 原样转交同一个函数。
export { consolePort } from './logging-console-port.js'
export type { ConsoleLikePort } from './logging-console-port.js'

// ── 4. 服务商请求转储 ───────────────────────────────────────────────────────
// providers 归位(D24,2026-10-04)从 `providers/` 搬来:落 `log/dumps/`、归日志管家管、开关由诊断模式拨,
// 所以是日志设施。写盘前那层薄壳(`dumpProviderRequest`)仍在 provider,经它的入口交出。
export { dumpOnethingProviderRequest } from './logging-provider-request-dump.js'
export type {
  OnethingProviderRequestDumpLogger,
  OnethingProviderRequestDumpPayload,
} from './logging-provider-request-dump.js'
