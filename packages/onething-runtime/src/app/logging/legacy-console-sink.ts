import { formatWithOptions } from 'node:util'
import type { LoggerRoot, LogLevel, LogSource } from '@onething/core/logging'

/**
 * 迁移期的**兜底采集**(§2.6):console 劫持还在,但它现在只是众多 producer 里
 * 的一个,记录长得和别人一样 —— `ns='console'`、`fields.legacy=true`、
 * `fields.callsite` 一帧。
 *
 * 它给出的是"**尚未迁移**的日志流量":按 callsite 排序就是 L4 的迁移顺序表。
 * `console.log` 仍然映射成 info(不擅自改语义,见 §5 的风险表),但带上
 * `legacy` 标记,迁完的区可以按标记核对。
 */

type ConsoleMethod = 'debug' | 'info' | 'log' | 'warn' | 'error'
type StreamWrite = typeof process.stdout.write

const METHOD_LEVEL: Record<ConsoleMethod, LogLevel> = {
  debug: 'debug',
  info: 'info',
  log: 'info',
  warn: 'warn',
  error: 'error',
}

export const LEGACY_CONSOLE_NS = 'console'

export interface LegacyConsoleSinkOptions {
  root: LoggerRoot
  src?: LogSource
  /** 关掉 stdout/stderr 直写的采集(测试里噪音很大)。 */
  captureProcessOutput?: boolean
  console?: Console
}

export class LegacyConsoleSink {
  private readonly root: LoggerRoot
  private readonly src: LogSource
  private readonly target: Console
  private readonly captureProcessOutput: boolean
  private readonly original: Record<ConsoleMethod, (...args: unknown[]) => void>
  private readonly originalStdoutWrite: StreamWrite
  private readonly originalStderrWrite: StreamWrite

  private consolePatched = false
  private stdoutPatched = false
  private stderrPatched = false
  private writingThroughConsole = false

  constructor(options: LegacyConsoleSinkOptions) {
    this.root = options.root
    this.src = options.src ?? 'main'
    this.target = options.console ?? console
    this.captureProcessOutput = options.captureProcessOutput ?? true
    this.original = {
      debug: this.target.debug.bind(this.target),
      info: this.target.info.bind(this.target),
      log: this.target.log.bind(this.target),
      warn: this.target.warn.bind(this.target),
      error: this.target.error.bind(this.target),
    }
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout)
    this.originalStderrWrite = process.stderr.write.bind(process.stderr)
  }

  /** 劫持之前的那份 console —— sink 自己要用它,不然就是自喂循环。 */
  getOriginalConsole(): Record<ConsoleMethod, (...args: unknown[]) => void> {
    return this.original
  }

  install(): void {
    if (this.captureProcessOutput) this.patchProcessOutput()
    this.patchConsole()
  }

  uninstall(): void {
    this.restoreConsole()
    this.restoreProcessOutput()
  }

  private emit(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
    this.root.emit({
      time: Date.now(),
      level,
      ns: LEGACY_CONSOLE_NS,
      msg,
      src: this.src,
      fields,
    })
  }

  private patchConsole(): void {
    if (this.consolePatched) return
    for (const method of Object.keys(this.original) as ConsoleMethod[]) {
      this.target[method] = (...args: unknown[]) => {
        let consoleWriteError: unknown
        this.writingThroughConsole = true
        try {
          this.original[method](...args)
        } catch (error) {
          if (isBrokenOutputPipeError(error)) this.suppressBrokenOutputPipe(error)
          else consoleWriteError = error
        } finally {
          this.writingThroughConsole = false
        }
        const callsite = callsiteOf()
        this.emit(METHOD_LEVEL[method], formatConsoleArgs(args), {
          legacy: true,
          method,
          ...(callsite ? { callsite } : {}),
        })
        if (consoleWriteError) throw consoleWriteError
      }
    }
    this.consolePatched = true
  }

  private restoreConsole(): void {
    if (!this.consolePatched) return
    for (const method of Object.keys(this.original) as ConsoleMethod[]) {
      this.target[method] = this.original[method] as Console[typeof method]
    }
    this.consolePatched = false
  }

  private patchProcessOutput(): void {
    if (!this.stdoutPatched) {
      process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
        if (!this.writingThroughConsole) this.logStreamChunk('stdout', 'info', chunk)
        return this.writeOriginalStream(this.originalStdoutWrite, chunk, args)
      }) as typeof process.stdout.write
      this.stdoutPatched = true
    }
    if (!this.stderrPatched) {
      process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
        if (!this.writingThroughConsole) this.logStreamChunk('stderr', 'error', chunk)
        return this.writeOriginalStream(this.originalStderrWrite, chunk, args)
      }) as typeof process.stderr.write
      this.stderrPatched = true
    }
  }

  private restoreProcessOutput(): void {
    if (this.stdoutPatched) {
      process.stdout.write = this.originalStdoutWrite as typeof process.stdout.write
      this.stdoutPatched = false
    }
    if (this.stderrPatched) {
      process.stderr.write = this.originalStderrWrite as typeof process.stderr.write
      this.stderrPatched = false
    }
  }

  private logStreamChunk(stream: 'stdout' | 'stderr', level: LogLevel, chunk: unknown): void {
    for (const line of chunkToString(chunk).split(/\r?\n/)) {
      if (line.length === 0) continue
      this.emit(level, line, { legacy: true, stream })
    }
  }

  private writeOriginalStream(write: StreamWrite, chunk: unknown, args: unknown[]): boolean {
    try {
      return write(chunk as never, ...(args as []))
    } catch (error) {
      if (!isBrokenOutputPipeError(error)) throw error
      this.suppressBrokenOutputPipe(error)
      return false
    }
  }

  private suppressBrokenOutputPipe(error: unknown): void {
    this.root.emit({
      time: Date.now(),
      level: 'debug',
      ns: 'process',
      msg: 'Suppressed broken stdout/stderr pipe during shutdown',
      src: 'process',
      fields: error && typeof error === 'object'
        ? { code: (error as NodeJS.ErrnoException).code }
        : undefined,
    })
  }
}

function isBrokenOutputPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPIPE'
    || code === 'ERR_STREAM_DESTROYED'
    || code === 'ERR_STREAM_WRITE_AFTER_END'
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf-8')
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf-8')
  return String(chunk)
}

export function formatConsoleArgs(args: unknown[]): string {
  if (args.length === 0) return ''
  return formatWithOptions({ colors: false, depth: 8, breakLength: 160, compact: 3 }, ...args)
}

/** 一帧就够:它只是用来给"还没迁移的调用点"排序的。 */
export function callsiteOf(stack?: string): string | undefined {
  let raw = stack
  if (raw === undefined) {
    const previousLimit = Error.stackTraceLimit
    Error.stackTraceLimit = 8
    raw = new Error().stack
    Error.stackTraceLimit = previousLimit
  }
  if (!raw) return undefined
  for (const line of raw.split('\n').slice(1)) {
    const frame = line.trim()
    if (!frame.startsWith('at ')) continue
    if (frame.includes('legacy-console-sink')) continue
    if (frame.includes('node:internal')) continue
    return frame.slice(3)
  }
  return undefined
}
