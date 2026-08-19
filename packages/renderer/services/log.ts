/**
 * 渲染进程的日志门面(logging L3,docs/design/logging-system-2026-08.md §2.5)。
 *
 * 在这之前 renderer 没有自己的通路:所有东西都得"顺带打一条 console",
 * 靠 Electron 的 `console-message` 捕获落盘 —— 于是 web 端零日志、
 * 多行栈一行一条记录、`[object Object]` 遍地。
 *
 * Hub 做三件事,与主进程共用**同一个内核**(`@onething/core/logging` 是零依赖、
 * 零 node import 的,浏览器里直接跑):
 *
 *  1. **内存环 200 条** —— 崩溃现场,`window.__onethingLog.dump()` 随时取;
 *  2. **dev 下 console 回显**(pretty)—— 开发时终端体验一个字不变。回显走
 *     `console.debug`(≤info)并**一律**带零宽标记 `RENDERER_LOG_ECHO_MARK`,
 *     这样 Electron 那道 warn+ 兜底(拍板 C)能把自己的回声认出来丢掉,
 *     不会同一条记录落两遍;
 *  3. **批量上行** —— 16ms 或攒够 50 条就 `logs.append(records)` 一次
 *     (desktop 走 `rpc:invoke`,web 走 `POST /api/rpc`)。
 *
 * 背压:待发队列硬上限 500 条,超了**丢最旧**并计数,下一批如实报给收方
 * (它会记一条 warn)。日志系统自己绝不能变成内存泄漏的来源。
 *
 * `fatal` 与 `beforeunload` 走"尽力而为的立即冲刷":渲染侧没有同步 IPC 出口
 * (`rpcInvoke` 是 Promise),所以这里做到的是**立刻发起**而不是**保证送达** ——
 * 如实说清楚,好过假装有同步通道。
 */
import {
  LoggerRoot,
  MemoryRingSink,
  formatPretty,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type Logger,
} from '@onething/core/logging'
import {
  MAX_LOG_RECORDS_PER_APPEND,
  RENDERER_LOG_ECHO_MARK,
  type AppendLogRecord,
  type AppendLogsRequest,
} from '@shared/ipc/logs.js'

/** 内存环容量(§2.5:200 条)。 */
export const RENDERER_LOG_RING_SIZE = 200

/** 批量窗口:一帧。 */
export const RENDERER_LOG_FLUSH_MS = 16

/** 攒够这么多就不等窗口了。 */
export const RENDERER_LOG_BATCH_SIZE = 50

/** 待发队列上限;超出丢最旧。 */
export const RENDERER_LOG_QUEUE_LIMIT = 500

/** localStorage 覆写位(§2.3)。 */
export const RENDERER_LOG_LEVEL_KEY = 'onething:log'

const DEFAULT_LEVEL_SPEC = 'info'

export type RendererLogSend = (request: AppendLogsRequest) => Promise<unknown>

export interface RendererLogHubOptions {
  /** 上行通道;不给 = 只进内存环 + 回显(测试 / SSR)。 */
  send?: RendererLogSend
  /** 是否 console 回显。默认跟随 dev。 */
  echo?: boolean
  /** 回显目标,测试可注入。 */
  console?: Pick<Console, 'debug' | 'warn' | 'error'>
  level?: string
  ringSize?: number
  batchSize?: number
  flushMs?: number
  queueLimit?: number
  now?: () => number
  /** 定时器注入(测试用假时钟)。 */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** 回显时把等级映射到 console 方法:≤info 一律 `debug`,绕开 warn+ 兜底。 */
const ECHO_METHOD: Record<LogLevel, 'debug' | 'warn' | 'error'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'debug',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
}

function readStoredLevelSpec(): string | undefined {
  try {
    return globalThis.localStorage?.getItem(RENDERER_LOG_LEVEL_KEY) ?? undefined
  } catch {
    return undefined
  }
}

function isDevBuild(): boolean {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

function toAppendRecord(record: LogRecord): AppendLogRecord {
  return {
    time: record.time,
    level: record.level,
    ns: record.ns,
    msg: record.msg,
    ...(record.fields ? { fields: record.fields } : {}),
    ...(record.err
      ? {
          err: {
            name: record.err.name,
            message: record.err.message,
            ...(record.err.stack ? { stack: record.err.stack } : {}),
          },
        }
      : {}),
  }
}

/** dev 回显 —— 一条记录一行,前缀零宽标记。 */
class EchoSink implements LogSink {
  constructor(private readonly target: Pick<Console, 'debug' | 'warn' | 'error'>) {}

  write(record: LogRecord): void {
    const line = `${RENDERER_LOG_ECHO_MARK}${formatPretty(record)}`
    try {
      this.target[ECHO_METHOD[record.level]](line)
    } catch {
      // 回显失败绝不能让业务代码炸 —— 记录已经进环、也已经排队上行了。
    }
  }
}

/** 批量上行 —— 队列 + 定时器 + 背压计数,全在这一个 sink 里。 */
class TransportSink implements LogSink {
  private readonly queue: AppendLogRecord[] = []
  private dropped = 0
  private timer: unknown = null
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly options: {
      send?: RendererLogSend
      batchSize: number
      flushMs: number
      queueLimit: number
      setTimer: (fn: () => void, ms: number) => unknown
      clearTimer: (handle: unknown) => void
    },
  ) {}

  write(record: LogRecord): void {
    if (!this.options.send) return
    this.queue.push(toAppendRecord(record))
    while (this.queue.length > this.options.queueLimit) {
      this.queue.shift()
      this.dropped += 1
    }
    // fatal 不等窗口:进程可能下一刻就没了。
    if (this.queue.length >= this.options.batchSize || record.level === 'fatal') {
      this.flush()
      return
    }
    this.schedule()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = this.options.setTimer(() => {
      this.timer = null
      this.flush()
    }, this.options.flushMs)
  }

  /** 立即发起一次上行。返回在途的 promise(测试与 `beforeunload` 用得上)。 */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.options.clearTimer(this.timer)
      this.timer = null
    }
    const send = this.options.send
    if (!send || this.queue.length === 0) {
      await this.inFlight
      return
    }

    const records = this.queue.splice(0, MAX_LOG_RECORDS_PER_APPEND)
    const dropped = this.dropped
    this.dropped = 0
    const request: AppendLogsRequest = dropped > 0 ? { records, dropped } : { records }
    // `send` **同步调用**(不裹一层 `Promise.resolve().then`):fatal 与
    // `beforeunload` 要的是"这一刻就把请求发出去",多一个微任务就可能来不及。
    // 失败就地吞掉:日志上行炸了不该变成又一条错误(那是自喂循环的开端)。
    let promise: Promise<void>
    try {
      promise = Promise.resolve(send(request)).then(() => undefined, () => undefined)
    } catch {
      promise = Promise.resolve()
    }
    this.inFlight = promise
    // 一批没排干(超过单次上限)时接着发。
    if (this.queue.length > 0) this.schedule()
    await promise
  }

  pendingCount(): number {
    return this.queue.length
  }

  droppedCount(): number {
    return this.dropped
  }
}

export interface RendererLogHub {
  getLogger(ns: string): Logger
  /** 内存环快照 —— 崩溃现场。 */
  dump(): LogRecord[]
  /** 人眼可读的一份(crash 屏的 COPY LOG 用)。 */
  dumpText(): string
  flush(): Promise<void>
  setLevelSpec(spec: string): void
  getLevelSpec(): string
  pendingCount(): number
  droppedCount(): number
}

export function createRendererLogHub(options: RendererLogHubOptions = {}): RendererLogHub {
  const ring = new MemoryRingSink(options.ringSize ?? RENDERER_LOG_RING_SIZE)
  const sinks: LogSink[] = [ring]

  const echoEnabled = options.echo ?? isDevBuild()
  if (echoEnabled) sinks.push(new EchoSink(options.console ?? console))

  const transport = new TransportSink({
    ...(options.send ? { send: options.send } : {}),
    batchSize: options.batchSize ?? RENDERER_LOG_BATCH_SIZE,
    flushMs: options.flushMs ?? RENDERER_LOG_FLUSH_MS,
    queueLimit: options.queueLimit ?? RENDERER_LOG_QUEUE_LIMIT,
    setTimer: options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
  })
  sinks.push(transport)

  const root = new LoggerRoot({
    level: options.level ?? readStoredLevelSpec() ?? DEFAULT_LEVEL_SPEC,
    sinks,
    src: 'renderer',
    ...(options.now ? { now: options.now } : {}),
  })

  return {
    getLogger: ns => root.logger(ns),
    dump: () => ring.dump(),
    dumpText: () => ring.dump().map(formatPretty).join('\n'),
    flush: () => transport.flush(),
    setLevelSpec: spec => {
      root.setLevelSpec(spec)
      try {
        globalThis.localStorage?.setItem(RENDERER_LOG_LEVEL_KEY, spec)
      } catch {
        // 无 localStorage(SSR / 隐私模式)——本次会话内仍然生效。
      }
    },
    getLevelSpec: () => root.levelSpec,
    pendingCount: () => transport.pendingCount(),
    droppedCount: () => transport.droppedCount(),
  }
}

let hub: RendererLogHub | null = null

/**
 * 传输是**惰性解析**的:`logs-client` 会摸 `platformApi`(按访问解析 electron/web
 * 两侧),模块求值时就取会把它钉死在那一刻的那一侧 —— 与 `session-events-client`
 * 同一条道理。
 */
let logsClientModule: Promise<typeof import('../platform/logs-client')> | null = null

function loadLogsClient(): Promise<typeof import('../platform/logs-client')> {
  logsClientModule ??= import('../platform/logs-client')
  return logsClientModule
}

async function sendViaPlatform(request: AppendLogsRequest): Promise<unknown> {
  const { logsApi } = await loadLogsClient()
  return logsApi.append(request)
}

export function getRendererLogHub(): RendererLogHub {
  hub ??= createRendererLogHub({ send: sendViaPlatform })
  return hub
}

/** 产品代码唯一需要的东西,与主进程 `getLogger(ns)` 同形。 */
export function getLogger(ns: string): Logger {
  return getRendererLogHub().getLogger(ns)
}

export function dumpRendererLogRecords(): LogRecord[] {
  return getRendererLogHub().dump()
}

/** 测试用:把模块级单例复位。 */
export function resetRendererLogHubForTests(replacement?: RendererLogHub | null): void {
  hub = replacement ?? null
}

/**
 * 装到 window 上:`beforeunload` 冲刷 + `__onethingLog` 现场取样口。
 * `main.ts` 只此一处调用。
 */
export function installRendererLogging(): RendererLogHub {
  const active = getRendererLogHub()
  if (typeof window === 'undefined') return active

  // 预热传输模块:`beforeunload` 那一刻再去 import() 就来不及了。
  void loadLogsClient().catch(() => undefined)

  window.addEventListener('beforeunload', () => {
    void active.flush()
  })

  const handle = {
    dump: () => active.dump(),
    text: () => active.dumpText(),
    flush: () => active.flush(),
    level: (spec?: string) => (spec ? active.setLevelSpec(spec) : active.getLevelSpec()),
  }
  ;(window as Window & { __onethingLog?: typeof handle }).__onethingLog = handle
  return active
}
