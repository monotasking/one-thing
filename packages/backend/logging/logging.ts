/**
 * logging:日志设施的入口(docs/design/logging-system-2026-08.md)。
 *
 * 它做什么:给任何模块一只 `getLogger(ns)`,定一条记录的形状(`LogRecord`)、logger 接口、sink、等级与错误归一,
 * 外加旧式 `console` 形状端口的适配器、服务商请求转储,以及几只写在当前 root 上的无副作用函数。写盘、轮转、目录管家、
 * 进程崩溃钩子与接线在功能的**装配入口** `logging-configure.ts`(D191 登记,只许包根、http-server 与 apps 引),
 * 由宿主与装配配方在启动时调一次 `configureLogging()`。
 *
 * 对外交出五类东西:
 * 1. 取 logger 与当前 root(实现在 `logging-runtime-root.ts`)—— `getLogger` 是延迟绑定的那一只,跟着当前 root 走;
 *    `configureLogging()` 调 `setRuntimeLoggerRoot` 把当前 root 指到 configure 的 root,检索 Worker 则指到往宿主
 *    转发的那一只。`captureRuntimeLogs` 是测试用的抓取器。
 * 2. 日志原语 —— 记录与 logger 的类型、`LoggerRoot`、sink、等级表、错误归一,以及兼容层(`toLogger` / `CompatLogger`)
 *    与注入端口(`getCoreLogger`)。
 * 3. `console` 形状的端口适配器 `consolePort`(迁移期的过渡件)。
 * 4. 服务商请求转储(落 `log/dumps/`,开关由诊断模式拨)。
 * 5. 无副作用的函数面(D191 从 configure 搬出):`writeAppLog`、读改当前等级、等级 spec 的解析、诊断模式开关、
 *    宿主端口表 `logging` 那一格的槽。
 *
 * 依赖:只依赖 `@shared/logging` 与 node 内建;`logging-console-port.ts` 对各功能的引用全是类型。
 *
 * 全进程只有这一只 `getLogger`(D160 / D161 合并了 configure 那只同名的)。接线之前写的记录留在 200 条兜底环里、
 * 不落文件(`logging-configure.test.ts` 钉着)。
 *
 * 没有交出的:装配期才建的状态与接线 API(`configureLogging` / `shutdownAppLogging` / `getAppLogPath` / `getRootLogger` /
 * `collectLogRecordsForTests` / …)。它们在模块求值时就建 root、内存环,并要存储层;经本入口交出会把它们连同存储层
 * 一起拖进检索 Worker(决定文档 §3.1:+2643 字节),所以走装配入口那扇门。
 */

// ── 1. 取 logger 与当前 root(实现住在 `logging-runtime-root.ts`,D191)────────────
export {
  captureRuntimeLogs,
  dumpRuntimeLogRecords,
  getLogger,
  getRuntimeLoggerRoot,
  setRuntimeLoggerRoot,
} from './logging-runtime-root.js'

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

// ── 5. 无副作用的函数面(D191 从 `logging-configure.ts` 搬出)────────────────
// 写一条迁移期的结构化记录、读改当前等级(都写在当前 root 上,接线之后就是 configure 那只 root);
// 等级 spec 的解析;诊断模式开关;宿主端口表 `logging` 那一格的槽。
export { getLogLevelSpec, setLogLevelSpec, writeAppLog } from './logging-runtime-root.js'
export { resolveLevelSpec } from './logging-level-spec.js'
export { applyDiagnosticsMode, isDiagnosticsModeApplied, resetDiagnosticsModeForTests } from './logging-diagnostics.js'
export { configureAppLoggingHost, resetAppLoggingHost } from './logging-host-ports.js'
export type { AppLoggingHostPorts, RendererCaptureLogEntry } from './logging-host-ports.js'
