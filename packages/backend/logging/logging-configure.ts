import {
  ConsoleSink,
  LoggerRoot,
  MemoryRingSink,
  type LogRecord,
  type LogSink,
  type LogSource,
  type Logger,
  type LoggerRootOptions,
} from './logging-logger-primitives.js'
import { type LogLevel } from '@shared/logging/types'
import {
  ensureDir,
  getOnethingLogDir,
} from '@onething/backend/storage/storage'
// D191:取 logger、当前 root 与写在它上面的函数住在 `logging-runtime-root.ts`,宿主端口槽与等级解析各一只兄弟;
// 本文件不再引自家入口。
import { getLogger, getRuntimeLoggerRoot, setLogLevelSpec, setRuntimeLoggerRoot } from './logging-runtime-root.js'
import { appLoggingHostPorts, configureAppLoggingHost, type AppLoggingHostPorts } from './logging-host-ports.js'
import { resolveLevelSpec } from './logging-level-spec.js'
import { JsonlFileSink } from './logging-jsonl-file-sink.js'
import { LEGACY_CONSOLE_NS, LegacyConsoleSink } from './logging-legacy-console-sink.js'
import { installProcessCrashHooks, type ProcessCrashHooks, type UncaughtExceptionMode, type ProcessCrashHooksOptions } from './logging-crash-hooks.js'
import { LogDirJanitor } from './logging-janitor.js'
import { resolveLegacyDebugAliases } from './logging-legacy-debug-env.js'

export { JsonlFileSink, readRollingFileEnvOptions } from './logging-jsonl-file-sink.js'
export { LegacyConsoleSink, LEGACY_CONSOLE_NS, callsiteOf } from './logging-legacy-console-sink.js'
export { installProcessCrashHooks } from './logging-crash-hooks.js'
export { LogDirJanitor, LOG_DIR_POLICY, LOG_JANITOR_INTERVAL_MS } from './logging-janitor.js'
export { RollingFileLogger } from './logging-rolling-file-logger.js'
export { composeLevelSpecWithLegacyAliases, resolveLegacyDebugAliases } from './logging-legacy-debug-env.js'
// P3'a-3:`consolePort` 是纯适配器(`logging-console-port.ts`,也经入口交出)。
export { consolePort } from './logging-console-port.js'
export type { ConsoleLikePort } from './logging-console-port.js'
export type { LegacyDebugAliasSpec } from './logging-legacy-debug-env.js'
export type { AppLogLevel, AppLogRecord } from './logging-rolling-file-logger.js'
// D191 搬去兄弟文件、经入口交出的无副作用函数面;这里原样转交同一个函数,只留给仍从本文件拿它们的测试
// (`toBe` 钉得住是同一个函数)。产品代码一律从入口拿。
export { getLogLevelSpec, setLogLevelSpec, writeAppLog } from './logging-runtime-root.js'
export { configureAppLoggingHost, resetAppLoggingHost } from './logging-host-ports.js'
export type { AppLoggingHostPorts, RendererCaptureLogEntry } from './logging-host-ports.js'
export { resolveLevelSpec } from './logging-level-spec.js'

/**
 * logging 功能的**装配入口**(D191 登记:与 `<功能>-client-api.ts` 同类的第二入口,只许包根、http-server、
 * 两种第二入口与 apps 引,`client-api:gate` 管;docs/design/logging-system-2026-08.md L1)。
 *
 * 这里只留**装配期才建的状态**:root 与它的 400 条内存环、文件 sink、目录管家、崩溃钩子、console 劫持、
 * renderer 兜底采集,以及接线 API `configureLogging` / `shutdownAppLogging` / `getAppLogPath` / `getRootLogger`。
 * 它们有模块级副作用、要存储层,经主入口交出会把它们连同存储层一起拖进检索 Worker(决定文档 §3.1 实测 +2643 字节),
 * 所以单开这一扇门;无副作用的函数面(`writeAppLog`、等级、诊断模式、宿主端口槽)住在兄弟文件、经主入口交出。
 *
 * `configureLogging()` 是**唯一**的接线点:等级 spec、sink 组合、console 兜底、
 * 进程钩子、目录治理都在这里定;产品代码只见 `getLogger(ns)`。
 * `initializeAppLogging()` 保留为别名,宿主调用点不必同批改(L4 再收)。
 */

const MEMORY_RING_SIZE = 400

const memoryRing = new MemoryRingSink(MEMORY_RING_SIZE)

/**
 * 本文件装的那只 root。模块求值时就存在(只挂内存环);`configureLogging()` 第一句把入口的当前 root 指到它,
 * 从此入口的 `getLogger()` 写进这里的 sink(文件、回显、宿主额外给的)。接线之前,入口的 logger 写进入口自己的
 * 兜底环,不进这里 —— 两边在接线之前的记录今天(2026-10-04 实测)都不落文件,合并之后照旧(D161)。
 * 导入本模块**不产生任何副作用**(不建目录、不劫持 console),那是 configure 的事。
 */
const loggerRootOptions: LoggerRootOptions = {
  level: resolveLevelSpec(),
  sinks: [memoryRing],
  src: 'main',
  onSinkError: error => {
    reportInternalError(error)
  },
};
const root = new LoggerRoot(loggerRootOptions)

let internalErrorReporter: ((error: unknown) => void) | undefined

function reportInternalError(error: unknown): void {
  if (internalErrorReporter) internalErrorReporter(error)
}

export function getRootLogger(): LoggerRoot {
  return root
}

// 两只同名 `getLogger` 合成一只(D160 / D161):本文件不再有自己的实现。这里转交的就是入口那**同一个函数**,
// 只留给动态 import 本模块再取 `getLogger` 的几只测试;产品代码一律从入口拿。本文件里的
// `getLogger('process')` / `getLogger('logging')` 与句柄的 `getLogger` 用的也是它。
export { getLogger }

/** 崩溃现场:最近 400 条结构化记录(接线之后经入口 logger 写的;接线之前的在入口的兜底环里)。 */
export function dumpRecentLogRecords(): LogRecord[] {
  return memoryRing.dump()
}

export interface ConfigureLoggingOptions {
  /** `ONETHING_LOG` 形状的 spec;不给则读 env,再不给就 `info`。 */
  level?: string
  /** 额外 sink(在默认 sink 之外追加)。 */
  sinks?: LogSink[]
  hostPorts?: AppLoggingHostPorts
  /** 落盘文件名主干:桌面 `app` → `app.jsonl`,独立 server → `server`。 */
  fileBaseName?: string
  /** 落盘目录;默认 `<store>/log`。 */
  logDir?: string
  /** 传 false = 不落盘(测试 / 嵌入宿主已有一份)。 */
  file?: boolean
  /** console 兜底采集(迁移期默认开)。 */
  legacyConsole?: boolean
  /** 终端回显:server 独立进程用 pretty;桌面靠 LegacyConsoleSink 原样透传。 */
  consoleEcho?: 'pretty' | 'json' | false
  crashHooks?: boolean
  uncaughtException?: UncaughtExceptionMode
  janitor?: boolean
  src?: LogSource
}

export interface LoggingHandle {
  logDir: string
  logPath?: string
  getLogger(ns: string): Logger
  setLevelSpec(spec: string): void
  flushSync(): void
}

let initialized = false
let fileSink: JsonlFileSink | null = null
let legacyConsole: LegacyConsoleSink | null = null
let crashHooks: ProcessCrashHooks | null = null
let janitor: LogDirJanitor | null = null
let rendererConsoleCapture: { attach(): void; detach(): void } | null = null
let exitHandler: (() => void) | null = null
let activeLogDir = ''

/**
 * 幂等:嵌入式 server(桌面进程里的那只 HTTP 面)第二次调用直接拿到同一个句柄,
 * 绝不第二次劫持 console 或再开一个文件 sink。
 */
export function configureLogging(options: ConfigureLoggingOptions = {}): LoggingHandle {
  // 产品层(`@onething/backend/<功能>`)与 core 的注入端口:它们不能 import 装配层,
  // 所以由这一句把**同一个 root** 递过去(§8.3 区 ①)。放在幂等闸之前 ——
  // 第二次调用是嵌入式 server,它同样该指向这一个 root。
  setRuntimeLoggerRoot(root)
  if (initialized) return createHandle()
  initialized = true

  root.setLevelSpec(resolveLevelSpec(options.level))
  // 根 logger 在模块求值时只能假定 `main`;宿主到这一步才说出自己是谁
  // (server / daemon),从此每条记录的 `src` 都是真的。
  if (options.src) root.setSrc(options.src)

  const logDir = options.logDir ?? getOnethingLogDir()
  activeLogDir = logDir
  ensureDir(logDir)
  if (options.hostPorts) configureAppLoggingHost(options.hostPorts)
  appLoggingHostPorts().setAppLogsPath?.(logDir)

  if (options.legacyConsole !== false) {
    legacyConsole = new LegacyConsoleSink({ root, src: options.src ?? 'main' })
    // sink 自己的内部错误必须走**劫持之前**的 console,否则就是自喂循环。
    internalErrorReporter = error => legacyConsole?.getOriginalConsole().error('[Logging] internal logger error:', error)
  }

  if (options.file !== false) {
    fileSink = new JsonlFileSink({
      logDir,
      baseName: options.fileBaseName ?? 'app',
      onInternalError: reportInternalError,
    })
    fileSink.start()
    root.addSink(fileSink)
  }

  if (options.consoleEcho) {
    const echo = new ConsoleSink({
      format: options.consoleEcho,
      target: legacyConsole?.getOriginalConsole() as never,
    })
    // `ns='console'` 的记录是 `LegacyConsoleSink` 抓来的 —— 它**已经**原样透传给
    // 终端了。再回显一次就是每行打两遍(一遍原文、一遍 pretty 包装)。
    root.addSink({
      write: record => {
        if (record.ns === LEGACY_CONSOLE_NS) return
        echo.write(record)
      },
    })
  }

  for (const sink of options.sinks ?? []) root.addSink(sink)

  // console 劫持放在 sink 装好之后:装之前打的行本来就该只进内存环。
  legacyConsole?.install()

  if (options.crashHooks !== false) {
    const processCrashHooksOptions: ProcessCrashHooksOptions = {
      flushSync: () => fileSink?.flushSync(),
      uncaughtException: options.uncaughtException,
      printFatal: error => legacyConsole?.getOriginalConsole().error(error),
    };
    crashHooks = installProcessCrashHooks(getLogger('process'), processCrashHooksOptions)
  }

  if (options.janitor !== false) {
    janitor = new LogDirJanitor({ logDir, onError: reportInternalError })
    janitor.start()
  }

  attachLoggingCapture()

  exitHandler = () => {
    fileSink?.flushSync()
  }
  process.on('exit', exitHandler)

  const loggingLog = getLogger('logging')
  loggingLog.info('logging configured', {
    logDir,
    file: fileSink?.getActivePath(),
    level: root.levelSpec,
  })

  // 旧开关还有人用 —— 说一声它们已经废弃(L5 删),但不改变行为。
  const aliases = resolveLegacyDebugAliases(process.env)
  if (aliases.matched.length > 0) {
    loggingLog.warn('deprecated debug env aliases applied', {
      switches: aliases.matched,
      mappedTo: [...aliases.defaults, ...aliases.rules].join(','),
      replacement: 'ONETHING_LOG',
    })
  }

  return createHandle()
}

/** 旧名字保留为别名 —— 宿主调用点不必与本期同批改。 */
export function initializeAppLogging(): void {
  configureLogging()
}

function createHandle(): LoggingHandle {
  return {
    logDir: activeLogDir || getOnethingLogDir(),
    logPath: fileSink?.getActivePath(),
    getLogger,
    setLevelSpec: setLogLevelSpec,
    flushSync: () => fileSink?.flushSync(),
  }
}

export function getAppLogDir(): string {
  return activeLogDir || getOnethingLogDir()
}

export function getAppLogPath(): string {
  return fileSink?.getActivePath() ?? `${getAppLogDir()}/app.jsonl`
}

export async function shutdownAppLogging(): Promise<void> {
  if (!initialized) return
  detachLoggingCapture()
  crashHooks?.dispose()
  crashHooks = null
  janitor?.stop()
  janitor = null
  if (fileSink) {
    root.removeSink(fileSink)
    await fileSink.close()
    fileSink = null
  }
  if (exitHandler) {
    process.off('exit', exitHandler)
    exitHandler = null
  }
  legacyConsole?.uninstall()
  legacyConsole = null
  internalErrorReporter = undefined
  setRuntimeLoggerRoot(null)
  root.setSrc('main')
  initialized = false
}

function attachLoggingCapture(): void {
  rendererConsoleCapture = appLoggingHostPorts().createRendererConsoleCapture?.({
    log: entry => {
      root.emit({
        time: Date.now(),
        level: entry.level,
        ns: entry.ns ?? 'renderer',
        msg: entry.msg,
        src: 'renderer',
        fields: entry.source
          ? { ...entry.fields, source: entry.source }
          : entry.fields,
      })
    },
  }) ?? null
  rendererConsoleCapture?.attach()
}

function detachLoggingCapture(): void {
  rendererConsoleCapture?.detach()
  rendererConsoleCapture = null
}

/**
 * 测试用:把根 logger 上发生的记录收进一个数组。
 *
 * 迁移之后"有没有说出来"这件事不再由 console spy 见证 —— 它是一条 `LogRecord`。
 * 返回的函数解除订阅。默认把等级放到 `trace`,收完再恢复(不然 debug/trace 会被
 * 根过滤掉,而断言想看的往往正是那一档)。
 */
export function collectLogRecordsForTests(spec = 'trace'): {
  records: LogRecord[]
  messages(): string[]
  stop(): void
} {
  const records: LogRecord[] = []
  const previousSpec = root.levelSpec
  // 合并之后(D161)模块的 logger 跟着入口的当前 root 走;没接线的测试里当前 root 是兜底那只,
  // 所以收集期间把它指到本文件的 root,`stop()` 放回原样 —— 收到的记录与合并之前逐条相同。
  const previousRuntimeRoot = getRuntimeLoggerRoot()
  setRuntimeLoggerRoot(root)
  root.setLevelSpec(spec)
  const remove = root.addSink({ write: record => { records.push(record) } })
  return {
    records,
    messages: () => records.map(record => record.msg),
    stop: () => {
      remove()
      root.setLevelSpec(previousSpec)
      setRuntimeLoggerRoot(previousRuntimeRoot)
    },
  }
}

/** 测试用:把模块级单例复位。 */
export function resetLoggingForTests(): void {
  detachLoggingCapture()
  crashHooks?.dispose()
  crashHooks = null
  janitor?.stop()
  janitor = null
  if (fileSink) {
    root.removeSink(fileSink)
    fileSink = null
  }
  if (exitHandler) {
    process.off('exit', exitHandler)
    exitHandler = null
  }
  legacyConsole?.uninstall()
  legacyConsole = null
  setRuntimeLoggerRoot(null)
  root.setSinks([memoryRing])
  root.setSrc('main')
  initialized = false
  activeLogDir = ''
}
