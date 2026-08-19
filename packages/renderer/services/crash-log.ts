/**
 * Renderer crash log: a localStorage-backed ring buffer of every captured
 * error, plus the global hooks that feed it.
 *
 * Why: ErrorBoundary used to display only the *last* captured error, but a
 * Vue unmount crash over a broken subtree is typically a secondary error
 * that masks the primary one (e.g. the 2026-07 "reading 'exposed'" crash).
 * This log keeps the whole sequence in order and survives the crash
 * screen's "Refresh Page" (location.reload), so the root cause is still
 * readable after recovery.
 *
 * Reading it: `window.__onethingCrashLog.dump()` in DevTools, or the COPY
 * LOG button on the crash screen.
 *
 * L3(2026-08-20):每条记录改为**经 RendererLogHub 上行**,不再"顺带打一条
 * console 让 Electron 的 console-message 捞走"。那条老路是 app.log 38% 体积的
 * 来源(多行组件链栈、一行一条记录),且 web 端根本没有捞的人。
 * 现在四个捕获点一个不少,变的只是出口:`hub.error('vue error', {...}, err)`。
 * Vue warn 去重后**只发一条** `warn`,栈进 `fields.stack`。
 */
import type { App, ComponentPublicInstance } from 'vue'
import { getLogger } from './log'

export type CrashLogSource =
  | 'error-boundary'
  | 'vue-error-handler'
  | 'vue-warn'
  | 'window-error'
  | 'unhandled-rejection'

export interface CrashLogEntry {
  ts: string
  seq: number
  source: CrashLogSource
  message: string
  stack?: string
  /** Root-most first, e.g. "App > ChatContainer > PanelTree > ChatWindow". */
  componentChain?: string
  /** Vue's error info string (which hook/phase the error came from). */
  info?: string
}

const STORAGE_KEY = 'onething:crash-log:v1'
const MAX_ENTRIES = 40
const MAX_TEXT_LENGTH = 4000

function storageArea(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readEntries(): CrashLogEntry[] {
  const storage = storageArea()
  if (!storage) return []
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeEntries(entries: CrashLogEntry[]): void {
  const storage = storageArea()
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Quota/serialization failure — the console line already went out.
  }
}

function truncate(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}… [truncated]` : text
}

export function componentChainOf(instance?: ComponentPublicInstance | null): string | undefined {
  if (!instance) return undefined
  const names: string[] = []
  let current: ComponentPublicInstance | null = instance
  while (current && names.length < 40) {
    const options = current.$options as { name?: string; __name?: string } | undefined
    names.push(options?.name || options?.__name || 'Anonymous')
    current = current.$parent
  }
  return names.reverse().join(' > ')
}

function formatEntry(entry: CrashLogEntry): string {
  const lines = [`[crash-log] #${entry.seq} ${entry.source}: ${entry.message}`]
  if (entry.componentChain) lines.push(`  components: ${entry.componentChain}`)
  if (entry.info) lines.push(`  info: ${entry.info}`)
  if (entry.stack) lines.push(entry.stack)
  return lines.join('\n')
}

export interface RecordCrashOptions {
  instance?: ComponentPublicInstance | null
  info?: string
}

export function recordCrash(source: CrashLogSource, err: unknown, options: RecordCrashOptions = {}): CrashLogEntry {
  const asError = err instanceof Error ? err : null
  const entries = readEntries()
  // A warn that fires on every render (e.g. a prop warning) must not flush
  // real errors out of the ring buffer — persist each warn text only once.
  if (source === 'vue-warn') {
    const message = truncate(asError?.message || String(err))
    const existing = entries.find(e => e.source === 'vue-warn' && e.message === message)
    // 去重是**彻底的**:重复的 warn 既不进环,也不再发一条日志 —— 每次渲染都触发的
    // prop 警告曾经把日志灌成噪音墙,而第 2..n 条一个字节的新信息都没有。
    if (existing) return existing
  }
  const entry: CrashLogEntry = {
    ts: new Date().toISOString(),
    seq: (entries[entries.length - 1]?.seq ?? 0) + 1,
    source,
    message: truncate(asError?.message || String(err)),
    ...(asError?.stack ? { stack: truncate(asError.stack) } : {}),
    ...(options.instance ? { componentChain: componentChainOf(options.instance) } : {}),
    ...(options.info ? { info: options.info } : {}),
  }
  entries.push(entry)
  writeEntries(entries.slice(-MAX_ENTRIES))
  emitToHub(entry, err)
  return entry
}

/** 每个捕获点一句**固定短句**,变量全进 fields —— 可 grep、可聚合(§2.1)。 */
const CRASH_MESSAGE: Record<CrashLogSource, string> = {
  'error-boundary': 'error boundary caught',
  'vue-error-handler': 'vue error',
  'vue-warn': 'vue warn',
  'window-error': 'window error',
  'unhandled-rejection': 'unhandled rejection',
}

function emitToHub(entry: CrashLogEntry, err: unknown): void {
  try {
    const log = getLogger('crash')
    const fields: Record<string, unknown> = { source: entry.source, seq: entry.seq }
    if (entry.componentChain) fields.componentChain = entry.componentChain
    if (entry.info) fields.info = entry.info
    if (err instanceof Error) {
      log.error(CRASH_MESSAGE[entry.source], fields, err)
      return
    }
    // 非 Error(Vue warn 的字符串、reject 了一个对象)没有 `err` 可归一化,
    // 正文进 `fields.message`,栈(Vue 给的组件追踪)进 `fields.stack`。
    fields.message = entry.message
    if (entry.stack) fields.stack = entry.stack
    if (entry.source === 'vue-warn') log.warn(CRASH_MESSAGE[entry.source], fields)
    else log.error(CRASH_MESSAGE[entry.source], fields)
  } catch {
    // Never let logging make a crash worse.
  }
}

export function getCrashLogEntries(): CrashLogEntry[] {
  return readEntries()
}

export function dumpCrashLog(): string {
  const entries = readEntries()
  if (entries.length === 0) return '[crash-log] empty'
  return entries.map(entry => `${entry.ts}\n${formatEntry(entry)}`).join('\n\n')
}

export function clearCrashLog(): void {
  const storage = storageArea()
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Ignore — nothing actionable.
  }
}

/**
 * Wire the global capture points. Errors inside Vue render/lifecycle that no
 * ErrorBoundary swallows land in `app.config.errorHandler`; errors in plain
 * async callbacks (IPC/event handlers awaiting store calls) never enter Vue
 * at all and only surface as unhandled rejections — that channel is exactly
 * where a "primary" error tends to hide when the crash screen shows only a
 * secondary unmount TypeError.
 */
export function installGlobalCrashCapture(app: App): void {
  app.config.errorHandler = (err, instance, info) => {
    recordCrash('vue-error-handler', err, { instance, info })
  }
  app.config.warnHandler = (msg, instance, trace) => {
    // warnHandler replaces Vue's own console output; the re-emit now goes to
    // the hub as ONE `warn` record (dedupe + `fields.stack`), not N console lines.
    recordCrash('vue-warn', msg, {
      instance,
      ...(trace ? { info: trace.trim() } : {}),
    })
  }

  if (typeof window === 'undefined') return

  window.addEventListener('error', (event) => {
    // Benign, loops forever in some layouts — not worth ring-buffer space.
    if (typeof event.message === 'string' && event.message.includes('ResizeObserver loop')) return
    recordCrash('window-error', event.error ?? event.message, {
      info: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    recordCrash('unhandled-rejection', event.reason)
  })

  const globalHandle = {
    entries: getCrashLogEntries,
    dump: dumpCrashLog,
    clear: clearCrashLog,
  }
  ;(window as Window & { __onethingCrashLog?: typeof globalHandle }).__onethingCrashLog = globalHandle

  const prior = readEntries()
  if (prior.length > 0) {
    getLogger('crash').info('crash entries from previous runs', {
      count: prior.length,
      hint: 'window.__onethingCrashLog.dump()',
    })
  }
}
