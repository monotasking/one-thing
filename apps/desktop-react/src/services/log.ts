/**
 * 迷你日志中枢 —— 零依赖,一份环形缓冲,一个门面。
 *
 * 规矩只有一条:**产品代码里不许裸 `console.*`**(eslint `no-console` 是 error,
 * 全仓只有本文件与 `scripts/` 豁免)。要说话就 `getLogger('ns')`。
 *
 * 为什么要个中枢而不是直接 console:
 *  · console 的话说完就没了 —— 崩溃现场想回看前 200 条,只能靠人当时正好开着 devtools;
 *  · 环形缓冲让 `window.__log.dump()` 随时能把现场倒出来(崩溃捕获就吃这一口,
 *    见 `services/crash.ts`);
 *  · ns 前缀让「谁说的」变成结构化字段,而不是每处自己拼一个字符串。
 *
 * 它**不是** packages/core/logging 那一套(级别过滤 / 多 sink / 落盘 / 分文件)。
 * 这块壳现在只需要"看得见 + 倒得出",所以刻意停在这个尺寸;真要接主进程账本,
 * 换的是 `sink`,不是每个调用点。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogRecord = {
  /** epoch 毫秒。 */
  ts: number
  ns: string
  level: LogLevel
  msg: string
  /** 参数的**短样**:序列化过、逐个截断过 —— 环缓冲不许被一个大对象撑爆。 */
  args: string[]
}

export type Logger = Record<LogLevel, (msg: string, ...args: unknown[]) => void>

/** 环缓冲容量。200 条 ≈ 一次崩溃前后的完整现场,又不至于把内存吃住。 */
export const LOG_RING_CAPACITY = 200

/** 单个参数序列化后的上限。超了截断并补 `…`,不丢这条记录。 */
const ARG_MAX_CHARS = 400

const ring: LogRecord[] = []

/** 开发态(vite dev / vitest)才把话同时说给 console;生产窗口里只进环。 */
const mirrorToConsole = Boolean(
  typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV,
)

/** 序列化一个参数。Error 留住 name/message/stack 首行,循环引用不炸。 */
function sample(value: unknown): string {
  let text: string
  if (value instanceof Error) {
    const head = (value.stack ?? '').split('\n')[1]?.trim() ?? ''
    text = `${value.name}: ${value.message}${head ? ` @ ${head}` : ''}`
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length > ARG_MAX_CHARS ? `${text.slice(0, ARG_MAX_CHARS)}…` : text
}

/**
 * 直接往环里写一条。给**日志之外的生产者**用(崩溃捕获、性能探针),
 * 它们有自己的 ns 与时刻,不该被 getLogger 的调用点语义套住。
 */
export function record(level: LogLevel, ns: string, msg: string, args: unknown[] = []): void {
  const entry: LogRecord = { ts: Date.now(), ns, level, msg, args: args.map(sample) }
  ring.push(entry)
  if (ring.length > LOG_RING_CAPACITY) ring.splice(0, ring.length - LOG_RING_CAPACITY)
  if (mirrorToConsole) {
     
    const sink = level === 'debug' ? console.debug : console[level]
    sink(`[${ns}]`, msg, ...args)
  }
}

export function getLogger(ns: string): Logger {
  return {
    debug: (msg, ...args) => record('debug', ns, msg, args),
    info: (msg, ...args) => record('info', ns, msg, args),
    warn: (msg, ...args) => record('warn', ns, msg, args),
    error: (msg, ...args) => record('error', ns, msg, args),
  }
}

/** 环缓冲的只读快照(最旧在前)。测试与 dump 共用这一个口。 */
export function dumpLog(): LogRecord[] {
  return ring.slice()
}

/** 只给测试用。产品代码没有清空日志的正当理由。 */
export function __resetLogForTests(): void {
  ring.length = 0
}

declare global {
  interface Window {
    __log?: { dump: () => LogRecord[] }
  }
}

/** 崩溃现场口。挂一次,幂等 —— HMR 重跑模块不该丢掉已有的口。 */
export function installLogDumpHook(): void {
  if (typeof window === 'undefined') return
  window.__log = { dump: dumpLog }
}

installLogDumpHook()
