/**
 * core 的 logger 注入端口(docs/design/logging-system-2026-08.md §8.3 区 ①)。
 *
 * core **不持有 root**:没有 sink、没有等级表、没有落盘 —— 这里只有一个由装配层
 * 填进来的工厂函数。填之前每一条记录都掉进 `noopLogger`(不打 console、不缓存),
 * 填之后同一批模块级 logger 自动指向宿主的那套 sink。
 *
 * 为什么是「一个端口」而不是「十几个 setter」:core 里绝大多数写日志的地方是
 * **自由函数**(`readPluginSettingsFile`、`repairSessionTimelineMetadata` …),
 * 没有构造函数、没有 options 可以挂 logger;给每个文件发明一个
 * `setXxxLogger()` 只是把同一个全局换了十几个名字。有天然注入缝的地方
 * (`EventBus` 构造、`Permission.setLogger`)照旧走注入,注入优先于端口。
 */

import { noopLogger, toLogger, type CompatLogger } from './compat.js'
import type { LogFields, LogLevel, Logger } from './types.js'

export interface CoreLoggingPort {
  getLogger(ns: string): Logger
}

let port: CoreLoggingPort | null = null
let generation = 0

/** 装配层唯一要调的那一句。传 null 摘下(测试收尾)。 */
export function configureCoreLogging(next: CoreLoggingPort | CompatLogger | null): void {
  if (!next) {
    port = null
  } else if (typeof (next as CoreLoggingPort).getLogger === 'function') {
    port = next as CoreLoggingPort
  } else {
    const single = toLogger(next as CompatLogger)
    port = { getLogger: () => single }
  }
  generation += 1
}

export function isCoreLoggingConfigured(): boolean {
  return port !== null
}

/**
 * 模块级用法:`const log = getCoreLogger('core.plugins')`。
 * 返回的是**延迟绑定**的 logger —— core 的模块几乎都在装配之前就被求值了。
 */
export function getCoreLogger(ns: string): Logger {
  const existing = cache.get(ns)
  if (existing) return existing
  const logger = new PortBoundLogger(ns)
  cache.set(ns, logger)
  return logger
}

const cache = new Map<string, Logger>()

class PortBoundLogger implements Logger {
  private resolvedGeneration = -1
  private resolved: Logger = noopLogger

  constructor(
    readonly ns: string,
    private readonly bound?: Record<string, unknown>,
  ) {}

  private target(): Logger {
    if (this.resolvedGeneration === generation) return this.resolved
    const base = port ? port.getLogger(this.ns) : noopLogger
    this.resolved = this.bound ? base.child(this.bound) : base
    this.resolvedGeneration = generation
    return this.resolved
  }

  isLevelEnabled(level: LogLevel): boolean {
    return this.target().isLevelEnabled(level)
  }

  child(fields: Record<string, unknown>): Logger {
    return new PortBoundLogger(this.ns, { ...this.bound, ...fields })
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
