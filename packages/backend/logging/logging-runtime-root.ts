/**
 * 延迟绑定的 logger 与「当前 root」(docs/design/logging-system-2026-08.md §8.3 区 ①),外加写在当前 root 上的
 * 几只无副作用函数(D191,2026-10-04 从入口文件 `logging.ts` 整段搬来,入口原样转交)。
 *
 * 这只文件持有一个可替换的当前 root,交出 `getLogger(ns)`:
 *
 * - `logging-configure.ts` 的 `configureLogging()` 第一句调 `setRuntimeLoggerRoot(root)`,
 *   从此经这里取的 logger 与 configure 自己的 root 写进同一套 sink(同一个文件、同一个内存环、同一份等级 spec);
 *   检索 Worker 则把当前 root 换成往宿主转发的那一只(`search-index-worker-logging.ts`)。
 * - 在那之前(以及单测里没人接线时),兜底 root 只挂一个 200 条的内存环:记录不丢、也不
 *   打到 console 上污染测试输出;`dumpRuntimeLogRecords()` 可以捞回来。
 *
 * `getLogger()` 返回的是**延迟绑定**的 logger:模块顶层 `const log = getLogger('sessions')` 在 root 被替换之后
 * 照样写进新 root —— 绝大多数模块都在接线之前就被求值了,快照式绑定会让它们永远写进旧 root。
 * 全进程只有这一只 `getLogger`(D160 / D161 把 configure 那只同名的合了进来)。
 *
 * 写在当前 root 上的三只函数 `writeAppLog` / `setLogLevelSpec` / `getLogLevelSpec`(D191 从 configure 搬来):
 * 接线之后当前 root 就是 configure 那只,行为与搬家前逐字相同;接线之前它们落在 / 改的是兜底 root
 * (搬家前是 configure 那只尚未接线的 root,两只环在接线前都不落文件,`configureLogging` 一进来又会盖掉等级)。
 * `writeAppLog` 的 `src` 照旧写死 `main`:换成 `getLogger` 会让守护进程里的记录变成 `src: 'daemon'`。
 *
 * 为什么单独一只文件:入口要交出诊断模式开关(`logging-diagnostics.ts`),而它要 `getLogger` 与 `setLogLevelSpec`;
 * 这两只若还声明在入口里,入口一交出诊断模式就成 `logging.ts → logging-diagnostics.ts → logging.ts` 的环(与 event 的
 * `event-current.ts` 同一个药方)。代价:检索 Worker 里打包器给贡献代码的文件留的那一行路径注释从 `logging.ts` 变成
 * 本文件,13 个字节,代码零增量(决定文档 §3.5 实测;D156 当年因此没搬)。
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
import type { AppLogLevel } from './logging-rolling-file-logger.js'

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

// ── 写在当前 root 上的无副作用函数(D191 从 configure 搬来)────────────────────

/**
 * 迁移期的结构化入口(channel/* 与权限策略的调用点)。`source` 直接当命名空间用 —— 它们本来就写的是
 * `channel.identity` 这种点分名。`src` 恒为 `main`(见文件头)。
 */
export function writeAppLog(
  level: AppLogLevel,
  source: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  currentRoot.emit({
    time: Date.now(),
    level,
    ns: source,
    msg: message,
    src: 'main',
    ...(metadata && Object.keys(metadata).length > 0 ? { fields: metadata } : {}),
  })
}

/** 运行时改等级(诊断模式 / `log:level` 之类的入口都走它)。 */
export function setLogLevelSpec(spec: string): void {
  currentRoot.setLevelSpec(spec)
}

export function getLogLevelSpec(): string {
  return currentRoot.levelSpec
}
