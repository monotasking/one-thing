import {
  ConsoleSink,
  createLogger,
  LoggerRoot,
  MemoryRingSink,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type LogSource,
  type Logger,
} from '@onething/core/logging'
import { ensureDir, getLogDir } from '../stores/paths.js'
import { JsonlFileSink } from './jsonl-file-sink.js'
import { LegacyConsoleSink } from './legacy-console-sink.js'
import { installProcessCrashHooks, type ProcessCrashHooks, type UncaughtExceptionMode } from './crash-hooks.js'
import { LogDirJanitor } from './janitor.js'
import type { AppLogLevel } from './rolling-file-logger.js'

export { JsonlFileSink, readRollingFileEnvOptions } from './jsonl-file-sink.js'
export { LegacyConsoleSink, LEGACY_CONSOLE_NS, callsiteOf } from './legacy-console-sink.js'
export { installProcessCrashHooks } from './crash-hooks.js'
export { LogDirJanitor, LOG_DIR_POLICY, LOG_JANITOR_INTERVAL_MS } from './janitor.js'
export { RollingFileLogger } from './rolling-file-logger.js'
export type { AppLogLevel, AppLogRecord } from './rolling-file-logger.js'

/**
 * 装配层的日志入口(docs/design/logging-system-2026-08.md L1)。
 *
 * `configureLogging()` 是**唯一**的接线点:等级 spec、sink 组合、console 兜底、
 * 进程钩子、目录治理都在这里定;产品代码只见 `getLogger(ns)`。
 * `initializeAppLogging()` 保留为别名,宿主调用点不必同批改(L4 再收)。
 */

/**
 * 宿主注入口。Electron 把 log 目录镜像进自己的崩溃工具、并接管 renderer 的
 * console 兜底;headless 宿主两个都不给,只落主进程自己的输出。
 */
export interface AppLoggingHostPorts {
  setAppLogsPath?: (logDir: string) => void
  createRendererConsoleCapture?: (options: {
    log: (entry: RendererCaptureLogEntry) => void
  }) => { attach(): void; detach(): void }
}

/** 宿主兜底采集(Electron `console-message`)投递的形状。 */
export interface RendererCaptureLogEntry {
  level: LogLevel
  /** 不给则记 `renderer`。 */
  ns?: string
  msg: string
  fields?: Record<string, unknown>
  /** 旧口径的标签(`renderer:<wcId>`),落进 `fields.source`。 */
  source?: string
}

let hostPorts: AppLoggingHostPorts = {}

export function configureAppLoggingHost(ports: AppLoggingHostPorts): void {
  hostPorts = ports
}

const DEFAULT_LEVEL_SPEC = 'info'
const MEMORY_RING_SIZE = 400

function resolveLevelSpec(explicit?: string): string {
  return explicit ?? process.env.ONETHING_LOG ?? DEFAULT_LEVEL_SPEC
}

const memoryRing = new MemoryRingSink(MEMORY_RING_SIZE)

/**
 * 根 logger 在模块求值时就存在(只挂内存环),所以**任何时刻** `getLogger()`
 * 都能用 —— configure 之前的记录留在环里,不会丢也不会打到别处。
 * 导入本模块**不产生任何副作用**(不建目录、不劫持 console),那是 configure 的事。
 */
const root = new LoggerRoot({
  level: resolveLevelSpec(),
  sinks: [memoryRing],
  src: 'main',
  onSinkError: error => {
    reportInternalError(error)
  },
})

let internalErrorReporter: ((error: unknown) => void) | undefined

function reportInternalError(error: unknown): void {
  if (internalErrorReporter) internalErrorReporter(error)
}

export function getRootLogger(): LoggerRoot {
  return root
}

/** 产品代码唯一需要的东西。 */
export function getLogger(ns: string): Logger {
  return createLogger(root, ns)
}

/** 崩溃现场:最近 400 条结构化记录。 */
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
  if (initialized) return createHandle()
  initialized = true

  root.setLevelSpec(resolveLevelSpec(options.level))

  const logDir = options.logDir ?? getLogDir()
  activeLogDir = logDir
  ensureDir(logDir)
  hostPorts = options.hostPorts ?? hostPorts
  hostPorts.setAppLogsPath?.(logDir)

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
    root.addSink(new ConsoleSink({
      format: options.consoleEcho,
      target: legacyConsole?.getOriginalConsole() as never,
    }))
  }

  for (const sink of options.sinks ?? []) root.addSink(sink)

  // console 劫持放在 sink 装好之后:装之前打的行本来就该只进内存环。
  legacyConsole?.install()

  if (options.crashHooks !== false) {
    crashHooks = installProcessCrashHooks(getLogger('process'), {
      flushSync: () => fileSink?.flushSync(),
      uncaughtException: options.uncaughtException,
      printFatal: error => legacyConsole?.getOriginalConsole().error(error),
    })
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

  getLogger('logging').info('logging configured', {
    logDir,
    file: fileSink?.getActivePath(),
    level: root.levelSpec,
  })

  return createHandle()
}

/** 旧名字保留为别名 —— 宿主调用点不必与本期同批改。 */
export function initializeAppLogging(): void {
  configureLogging()
}

function createHandle(): LoggingHandle {
  return {
    logDir: activeLogDir || getLogDir(),
    logPath: fileSink?.getActivePath(),
    getLogger,
    setLevelSpec: setLogLevelSpec,
    flushSync: () => fileSink?.flushSync(),
  }
}

/** 运行时改等级(诊断模式 / `log:level` 之类的入口都走它)。 */
export function setLogLevelSpec(spec: string): void {
  root.setLevelSpec(spec)
}

export function getLogLevelSpec(): string {
  return root.levelSpec
}

export function getAppLogDir(): string {
  return activeLogDir || getLogDir()
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
  initialized = false
}

/**
 * 迁移期的结构化入口(channel/* 与权限策略的 8 个调用点)。
 * `source` 直接当命名空间用 —— 它们本来就写的是 `channel.identity` 这种点分名。
 */
export function writeAppLog(
  level: AppLogLevel,
  source: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  root.emit({
    time: Date.now(),
    level,
    ns: source,
    msg: message,
    src: 'main',
    ...(metadata && Object.keys(metadata).length > 0 ? { fields: metadata } : {}),
  })
}

function attachLoggingCapture(): void {
  rendererConsoleCapture = hostPorts.createRendererConsoleCapture?.({
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
  root.setSinks([memoryRing])
  initialized = false
  activeLogDir = ''
}
