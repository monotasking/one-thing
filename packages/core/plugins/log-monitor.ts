import { SESSION_EVENT_TYPES } from '../events/session-event-types.js'
import fs from 'fs'
import path from 'path'

export interface CoreLogEntry {
  eventType: string
  timestamp: number
  sessionId: string
  sequence: number
  summary: string
  duplicates?: number
}

export interface CoreLogEnvelope {
  sessionId: string
  sequence: number
  timestamp: number
  event: { type: string; [key: string]: unknown }
}

export const CORE_LOG_MONITOR_HIGH_FREQUENCY_EVENTS = new Set([
  SESSION_EVENT_TYPES.CONTENT_PART,
  SESSION_EVENT_TYPES.CONTENT_CONTINUATION,
  SESSION_EVENT_TYPES.STEP_UPDATED,
  SESSION_EVENT_TYPES.TOOL_METADATA,
  SESSION_EVENT_TYPES.REQUEST_SNAPSHOT,
])

export const CORE_LOG_MONITOR_TRACKED_EVENTS = [
  SESSION_EVENT_TYPES.STREAM_START,
  SESSION_EVENT_TYPES.STREAM_COMPLETE,
  SESSION_EVENT_TYPES.STREAM_ERROR,
  SESSION_EVENT_TYPES.STREAM_ABORTED,
  SESSION_EVENT_TYPES.TOOL_CALL,
  SESSION_EVENT_TYPES.TOOL_RESULT,
  SESSION_EVENT_TYPES.TOOL_EXECUTION_START,
  SESSION_EVENT_TYPES.TOOL_EXECUTION_END,
  SESSION_EVENT_TYPES.MESSAGE_USER_CREATED,
  SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED,
  SESSION_EVENT_TYPES.PERMISSION_REQUEST,
  SESSION_EVENT_TYPES.SKILL_ACTIVATED,
  SESSION_EVENT_TYPES.STEP_ADDED,
  SESSION_EVENT_TYPES.SESSION_RENAMED,
  SESSION_EVENT_TYPES.MESSAGES_REPLACED,
] as const

export const CORE_LOG_MONITOR_LOG_FILE_PATTERN = /^agent-(\d{4}-\d{2}-\d{2})\.log$/
export const CORE_LOG_MONITOR_DEFAULT_MAX_BUFFER = 500
export const CORE_LOG_MONITOR_DEFAULT_FLUSH_INTERVAL_MS = 1000
export const CORE_LOG_MONITOR_DEFAULT_RETENTION_DAYS = 7

export interface CoreLogMonitorBufferOptions {
  maxBuffer?: number
  highFrequencyEvents?: Set<string>
}

export interface CoreLogMonitorCleanupOptions {
  now?: number
  retentionDays?: number
}

export interface CoreLogMonitorDiskStreamLike {
  destroyed?: boolean
  /** Settles only after the underlying handle actually closes; rejects its first I/O error. */
  closed: Promise<void>
  write(content: string): boolean
  end(): void
  onDrain(handler: () => void): void
  onError(handler: (error: Error) => void): void
}

export interface CoreLogMonitorDiskWriterAdapters {
  createWriteStream(fileName: string): CoreLogMonitorDiskStreamLike
  listFiles(): string[]
  deleteFile(fileName: string): void
  log?: (message: string) => void
}

export function ensureCoreLogMonitorDirectory(logDir: string): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
}

export function createCoreLogMonitorFileDiskAdapters(
  logDir: string,
  options: { log?: (message: string) => void } = {},
): CoreLogMonitorDiskWriterAdapters {
  return {
    createWriteStream(fileName) {
      ensureCoreLogMonitorDirectory(logDir)
      const stream = fs.createWriteStream(path.join(logDir, fileName), { flags: 'a' })
      let firstError: Error | undefined
      const errorHandlers = new Set<(error: Error) => void>()
      // Own errors immediately: opening the file is asynchronous, including
      // when end() was already requested before open completed.
      stream.on('error', error => {
        firstError ??= error
        for (const handler of errorHandlers) handler(firstError)
      })
      const closed = new Promise<void>((resolve, reject) => stream.once('close', () => {
        errorHandlers.clear()
        if (firstError) reject(firstError)
        else resolve()
      }))
      return {
        closed,
        get destroyed() {
          return stream.destroyed
        },
        write: content => stream.write(content),
        end: () => stream.end(),
        onDrain: handler => {
          stream.on('drain', handler)
          stream.once('close', () => stream.off('drain', handler))
        },
        onError: handler => {
          if (firstError) handler(firstError)
          if (!stream.closed) errorHandlers.add(handler)
        },
      }
    },
    listFiles: () => {
      ensureCoreLogMonitorDirectory(logDir)
      return fs.readdirSync(logDir)
    },
    deleteFile: fileName => fs.unlinkSync(path.join(logDir, fileName)),
    log: options.log,
  }
}

/** 配置项可以是常量,也可以是**取值器** —— 后者让配置改动即时生效,不必重装插件。 */
export type CoreLogMonitorNumberOption = number | (() => number)

export interface CoreLogMonitorDiskWriterOptions {
  flushIntervalMs?: CoreLogMonitorNumberOption
  retryFlushIntervalMs?: number
  retentionDays?: CoreLogMonitorNumberOption
  cleanupChance?: number
  now?: () => Date
  random?: () => number
  adapters: CoreLogMonitorDiskWriterAdapters
}

export interface CoreLogMonitorPushResult {
  entry: CoreLogEntry
  stored: boolean
  duplicate: boolean
  diskLines: string[]
  notify: boolean
}

export interface CoreLogMonitorSearchArgs {
  eventType?: string
  query?: string
  limit?: number
}

export interface CoreLogMonitorToolContext {
  metadata(input: { title?: string; metadata?: unknown }): void
}

export interface CoreLogMonitorCommandContext {
  notify(message: string, level?: 'info' | 'warn' | 'error'): void
}

export interface CoreLogMonitorPluginApi<TToolParameters> {
  on(eventType: string, handler: (envelope: CoreLogEnvelope) => void): unknown
  registerTool(tool: {
    name: 'search_agent_logs'
    description: string
    parameters: TToolParameters
    execute(args: CoreLogMonitorSearchArgs, ctx: CoreLogMonitorToolContext): Promise<ReturnType<CoreLogMonitorBuffer['search']>>
  }): void
  registerCommand(name: string, options: {
    description: string
    handler(args: string, ctx: CoreLogMonitorCommandContext): Promise<void>
  }): void
  ui: {
    notify(message: string, level?: 'info' | 'warn' | 'error'): void
  }
  onDispose?(callback: () => void | Promise<void>): void
  /** 插件自有配置的访问面(R3);宿主注入,插件只读快照。 */
  settings?: {
    get<T = Record<string, unknown>>(): T
  }
}

export interface CoreLogMonitorPluginOptions<TToolParameters> {
  searchToolParameters: TToolParameters
  maxBuffer?: number
  trackedEvents?: readonly string[]
  diskWriter?: CoreLogMonitorDiskWriter
  diskWriterOptions?: CoreLogMonitorDiskWriterOptions
  ensureLogDir?: () => void
  /** 是否在错误事件上弹通知;取值器让配置改动即时生效。 */
  shouldNotify?: () => boolean
  logger?: {
    log?(message: string): void
  }
}

export interface CoreLogMonitorPluginRuntime {
  buffer: CoreLogMonitorBuffer
  diskWriter: CoreLogMonitorDiskWriter
}

export function formatLogMonitorDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getLogMonitorFileName(date = new Date()): string {
  return `agent-${formatLogMonitorDate(date)}.log`
}

export function getLogMonitorFileDate(fileName: string): string | null {
  return fileName.match(CORE_LOG_MONITOR_LOG_FILE_PATTERN)?.[1] ?? null
}

export function shouldDeleteLogMonitorFile(
  fileName: string,
  options: CoreLogMonitorCleanupOptions = {},
): boolean {
  const date = getLogMonitorFileDate(fileName)
  if (!date) return false
  const now = options.now ?? Date.now()
  const retentionDays = options.retentionDays ?? 7
  return now - new Date(date).getTime() > retentionDays * 86400000
}

export function planLogMonitorCleanup(
  fileNames: string[],
  options: CoreLogMonitorCleanupOptions = {},
): string[] {
  return fileNames.filter(fileName => shouldDeleteLogMonitorFile(fileName, options))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown, fallback = '?'): string {
  return typeof value === 'string' && value ? value : fallback
}

export function summarizeLogEvent(type: string, event: Record<string, unknown>): string {
  switch (type) {
    case SESSION_EVENT_TYPES.STREAM_START: return `Stream start (model: ${stringValue(event.model)})`
    case SESSION_EVENT_TYPES.STREAM_COMPLETE: return `Stream complete (${record(record(event.data).usage).totalTokens || '?'} tokens)`
    case SESSION_EVENT_TYPES.STREAM_ERROR: return `Stream error: ${stringValue(record(event.data).error, 'unknown')}`
    case SESSION_EVENT_TYPES.STREAM_ABORTED: return `Stream aborted: ${stringValue(event.reason, 'user')}`
    case SESSION_EVENT_TYPES.TOOL_CALL: return `Tool call: ${stringValue(record(event.toolCall).toolName)}`
    case SESSION_EVENT_TYPES.TOOL_RESULT: return `${record(event.toolCall).isError ? 'ERROR' : 'OK'} Tool: ${stringValue(record(event.toolCall).toolName)}`
    case SESSION_EVENT_TYPES.TOOL_EXECUTION_START: return `Tool start: ${stringValue(event.toolName)}`
    /* end 事件的载荷里没有 toolName(`ToolExecutionEndEvent` 只有 toolCallId/stepId/result/isError/error/durationMs),用 toolCallId 指认。 */
    case SESSION_EVENT_TYPES.TOOL_EXECUTION_END: return `${event.isError ? 'ERROR' : 'OK'} Tool done: ${stringValue(event.toolCallId)}`
    case SESSION_EVENT_TYPES.MESSAGE_USER_CREATED: return 'User message'
    case SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED: return `Assistant (model: ${stringValue(record(event.message).model)})`
    case SESSION_EVENT_TYPES.SKILL_ACTIVATED: return `Skill: ${stringValue(event.skillName)}`
    case SESSION_EVENT_TYPES.PERMISSION_REQUEST: return `Permission: ${stringValue(event.title)}`
    case SESSION_EVENT_TYPES.STEP_ADDED: return `Step: ${stringValue(record(event.step).title)}`
    case SESSION_EVENT_TYPES.SESSION_RENAMED: return `Session renamed: "${typeof event.name === 'string' ? event.name : ''}"`
    case SESSION_EVENT_TYPES.MESSAGES_REPLACED: return `Messages replaced (${Array.isArray(event.messages) ? event.messages.length : 0} total)`
    default: return `${type}: ${JSON.stringify(event).slice(0, 80)}`
  }
}

export function createLogEntry(eventType: string, envelope: CoreLogEnvelope): CoreLogEntry {
  return {
    eventType,
    timestamp: envelope.timestamp,
    sessionId: envelope.sessionId,
    sequence: envelope.sequence,
    summary: summarizeLogEvent(eventType, envelope.event),
  }
}

export function logEntryDiskLine(entry: CoreLogEntry): string {
  return JSON.stringify({
    t: entry.timestamp,
    type: entry.eventType,
    session: entry.sessionId.slice(0, 8),
    summary: entry.summary,
    seq: entry.sequence,
  })
}

export function duplicateLogDiskLine(entry: CoreLogEntry): string {
  return JSON.stringify({
    t: entry.timestamp,
    type: entry.eventType,
    session: entry.sessionId.slice(0, 8),
    dup: entry.duplicates,
  })
}

export function shouldNotifyLogEntry(entry: CoreLogEntry): boolean {
  return entry.eventType === SESSION_EVENT_TYPES.STREAM_ERROR ||
    (entry.eventType === SESSION_EVENT_TYPES.TOOL_EXECUTION_END && entry.summary.startsWith('ERROR'))
}

export function searchLogEntries(
  logs: CoreLogEntry[],
  options: { eventType?: string; query?: string; limit?: number },
): { filtered: CoreLogEntry[]; results: CoreLogEntry[]; limit: number } {
  let filtered = logs
  if (options.eventType) filtered = filtered.filter(entry => entry.eventType === options.eventType)
  if (options.query) {
    const query = options.query.toLowerCase()
    filtered = filtered.filter(entry => entry.summary.toLowerCase().includes(query))
  }
  const limit = Math.min(options.limit || 30, 100)
  return {
    filtered,
    results: filtered.slice(-limit),
    limit,
  }
}

export function formatLogSearchOutput(
  logs: CoreLogEntry[],
  options: { eventType?: string; query?: string; limit?: number; formatTime?: (timestamp: number) => string },
): { title: string; output: string; metadata: { totalHits: number; shown: number; bufferSize?: number } } {
  const { filtered, results } = searchLogEntries(logs, options)
  if (results.length === 0) {
    return {
      title: 'Logs: no matches',
      output: `No matching logs found. Buffer has ${logs.length} total events.`,
      metadata: { totalHits: 0, shown: 0 },
    }
  }
  const formatTime = options.formatTime || ((timestamp: number) => new Date(timestamp).toLocaleTimeString())
  return {
    title: `Logs: ${results.length} results`,
    output: `Found ${filtered.length} matching logs (showing last ${results.length}):\n\n${results.map(entry =>
      `[${formatTime(entry.timestamp)}] ${entry.summary}${entry.duplicates ? ` (x${entry.duplicates + 1})` : ''}`
    ).join('\n')}`,
    metadata: { totalHits: filtered.length, shown: results.length, bufferSize: logs.length },
  }
}

export function formatLogTail(logs: CoreLogEntry[], count: number, formatTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString()): string {
  const recent = logs.slice(-Math.min(count || 15, 100))
  return recent.map(entry => `${formatTime(entry.timestamp)} ${entry.summary}`).join('\n')
}

export function normalizeLogTailCount(value: string | number | undefined, fallback = 15, max = 100): number {
  const parsed = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback, max)
}

export function getRecentLogErrors(logs: CoreLogEntry[], limit = 15): CoreLogEntry[] {
  return logs
    .filter(entry => entry.eventType === SESSION_EVENT_TYPES.STREAM_ERROR || (entry.eventType === SESSION_EVENT_TYPES.TOOL_EXECUTION_END && entry.summary.startsWith('ERROR')))
    .slice(-limit)
}

export function formatLogErrorsNotification(
  logs: CoreLogEntry[],
  options: { limit?: number; formatTime?: (timestamp: number) => string } = {},
): { message: string; level: 'warn' | 'info' } {
  const errors = getRecentLogErrors(logs, options.limit)
  if (errors.length === 0) {
    return { message: 'No errors found.', level: 'info' }
  }
  const formatTime = options.formatTime || ((timestamp: number) => new Date(timestamp).toLocaleTimeString())
  return {
    message: errors.map(entry => `${formatTime(entry.timestamp)} ${entry.summary}`).join('\n'),
    level: 'warn',
  }
}

export function countLogEventTypes(logs: CoreLogEntry[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const entry of logs) {
    counts.set(entry.eventType, (counts.get(entry.eventType) || 0) + 1)
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
}

export function formatLogStatsNotification(input: {
  size: number
  eventCounts: Array<[string, number]>
  isBackpressure: boolean
  droppedCount: number
}): string {
  const lines = input.eventCounts.map(([type, count]) => `  ${type}: ${count}`)
  const status = input.isBackpressure
    ? `disk backpressure, ${input.droppedCount} writes dropped`
    : 'disk OK'
  return `${input.size} events in buffer | ${status}\n${lines.join('\n')}`
}

export class CoreLogMonitorBuffer {
  private readonly logs: CoreLogEntry[] = []
  private readonly lastHighFrequency = new Map<string, CoreLogEntry>()
  private readonly maxBuffer: number
  private readonly highFrequencyEvents: Set<string>

  constructor(options: CoreLogMonitorBufferOptions = {}) {
    this.maxBuffer = options.maxBuffer ?? 500
    this.highFrequencyEvents = options.highFrequencyEvents ?? CORE_LOG_MONITOR_HIGH_FREQUENCY_EVENTS
  }

  get entries(): CoreLogEntry[] {
    return this.logs
  }

  get size(): number {
    return this.logs.length
  }

  push(eventType: string, envelope: CoreLogEnvelope): CoreLogMonitorPushResult {
    const entry = createLogEntry(eventType, envelope)

    if (this.highFrequencyEvents.has(eventType)) {
      const previous = this.lastHighFrequency.get(eventType)
      if (previous) {
        previous.duplicates = (previous.duplicates || 0) + 1
        previous.timestamp = entry.timestamp
        return {
          entry: previous,
          stored: false,
          duplicate: true,
          diskLines: previous.duplicates % 50 === 0 ? [duplicateLogDiskLine(previous)] : [],
          notify: false,
        }
      }
      this.lastHighFrequency.set(eventType, entry)
    }

    this.logs.push(entry)
    if (this.logs.length > this.maxBuffer) this.logs.shift()

    return {
      entry,
      stored: true,
      duplicate: false,
      diskLines: [logEntryDiskLine(entry)],
      notify: shouldNotifyLogEntry(entry),
    }
  }

  search(options: { eventType?: string; query?: string; limit?: number; formatTime?: (timestamp: number) => string }) {
    return formatLogSearchOutput(this.logs, options)
  }

  tail(count: number, formatTime?: (timestamp: number) => string): string {
    return formatLogTail(this.logs, count, formatTime)
  }

  errors(limit = 15): CoreLogEntry[] {
    return getRecentLogErrors(this.logs, limit)
  }

  eventCounts(): Array<[string, number]> {
    return countLogEventTypes(this.logs)
  }

  clear(): number {
    const count = this.logs.length
    this.logs.length = 0
    this.lastHighFrequency.clear()
    return count
  }
}

export class CoreLogMonitorDiskWriter {
  private readonly flushIntervalMsOption: CoreLogMonitorNumberOption
  private readonly retryFlushIntervalMs: number
  private readonly retentionDaysOption: CoreLogMonitorNumberOption
  private readonly cleanupChance: number
  private readonly now: () => Date
  private readonly random: () => number
  private readonly adapters: CoreLogMonitorDiskWriterAdapters
  private readonly writeBuffer: string[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writeStream: CoreLogMonitorDiskStreamLike | null = null
  private readonly streams = new Map<CoreLogMonitorDiskStreamLike, { fileName: string; ended: boolean; closed: Promise<void> }>()
  private currentLogFileName = ''
  private backpressure = false
  private dropped = 0
  private closing = false
  private closePromise: Promise<void> | undefined
  private firstError: Error | undefined

  constructor(options: CoreLogMonitorDiskWriterOptions) {
    this.flushIntervalMsOption = options.flushIntervalMs ?? 1000
    this.retryFlushIntervalMs = options.retryFlushIntervalMs ?? 100
    this.retentionDaysOption = options.retentionDays ?? 7
    this.cleanupChance = options.cleanupChance ?? 0.05
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.adapters = options.adapters
  }

  private get flushIntervalMs(): number {
    return typeof this.flushIntervalMsOption === 'function'
      ? this.flushIntervalMsOption()
      : this.flushIntervalMsOption
  }

  private get retentionDays(): number {
    return typeof this.retentionDaysOption === 'function'
      ? this.retentionDaysOption()
      : this.retentionDaysOption
  }

  get currentFileName(): string {
    return this.currentLogFileName
  }

  get isBackpressure(): boolean {
    return this.backpressure
  }

  get droppedCount(): number {
    return this.dropped
  }

  get pendingLineCount(): number {
    return this.writeBuffer.length
  }

  rotateIfNeeded(): void {
    if (this.closing) return
    try { this.rotateStreamIfNeeded() } catch (error) { throw this.rememberFailure(error) }
  }

  private rememberFailure(error: unknown): Error {
    this.firstError ??= error instanceof Error ? error : new Error(String(error))
    this.clearFlushTimer()
    return this.firstError
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private scheduleFlush(milliseconds: number): void {
    if (this.closing || this.firstError || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try { this.flush() } catch (error) {
        // The owner reports this sticky failure from close(), rather than
        // throwing an unowned exception out of the timer callback.
        this.rememberFailure(error)
      }
    }, milliseconds)
  }

  private endStream(stream: CoreLogMonitorDiskStreamLike): void {
    const owned = this.streams.get(stream)
    if (!owned || owned.ended) return
    owned.ended = true
    try { stream.end() } catch (error) { this.rememberFailure(error) }
  }

  private rotateStreamIfNeeded(): void {
    if (this.firstError) throw this.firstError
    const nextLogFileName = getLogMonitorFileName(this.now())
    if (nextLogFileName === this.currentLogFileName && this.writeStream) return

    if (this.writeStream) this.endStream(this.writeStream)
    if (this.firstError) throw this.firstError
    const stream = this.adapters.createWriteStream(nextLogFileName)
    const owned = { fileName: nextLogFileName, ended: false, closed: Promise.resolve() }
    this.streams.set(stream, owned)
    // Retain rotated streams until real close. Observe every rejection now,
    // even if plugin disposal happens much later, and preserve the first error.
    owned.closed = stream.closed.then(() => {
      if (!owned.ended) this.rememberFailure(new Error('Log stream closed before end'))
      this.streams.delete(stream)
    }, error => {
      this.rememberFailure(error)
      this.streams.delete(stream)
    })
    stream.onError(error => { this.rememberFailure(error) })
    this.currentLogFileName = nextLogFileName
    this.writeStream = stream
    this.backpressure = false
    stream.onDrain(() => {
      if (this.writeStream === stream && !this.closing && !this.firstError) this.backpressure = false
    })
    this.adapters.log?.(`[AgentLog] Rotated to ${nextLogFileName}`)
  }

  cleanupOldLogs(): void {
    try {
      const filesToDelete = planLogMonitorCleanup(this.adapters.listFiles(), {
        now: this.now().getTime(),
        retentionDays: this.retentionDays,
      })
      for (const fileName of filesToDelete) {
        if (Array.from(this.streams.values()).some(stream => stream.fileName === fileName)) continue
        this.adapters.deleteFile(fileName)
      }
    } catch {
      // Best effort only.
    }
  }

  flush(): void {
    this.clearFlushTimer()
    if (this.closing) return
    try {
      if (this.firstError) throw this.firstError
      if (this.writeBuffer.length === 0) return
      this.writePending()
      if (this.writeBuffer.length > 0) this.scheduleFlush(this.retryFlushIntervalMs)
      if (!this.flushTimer && this.random() < this.cleanupChance) this.cleanupOldLogs()
    } catch (error) { throw this.rememberFailure(error) }
  }

  private writePending(): void {
    if (this.writeBuffer.length === 0) return
    this.rotateStreamIfNeeded()
    if (!this.writeStream || this.writeStream.destroyed) {
      throw new Error('Log stream is not writable')
    }
    const lines = this.writeBuffer.slice()
    const ok = this.writeStream.write(lines.join('\n') + '\n')
    this.writeBuffer.splice(0, lines.length)
    if (!ok) this.backpressure = true
  }

  push(line: string): boolean {
    if (this.closing || this.firstError || this.backpressure) {
      this.dropped++
      return false
    }

    this.writeBuffer.push(line)
    this.scheduleFlush(this.flushIntervalMs)
    return true
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.clearFlushTimer()
    // 先把缓冲写出去再收流:flush 间隔是 1s,直接 end() 等于把禁用前最后一秒的
    // 日志丢掉 —— 而那一秒往往正是用户要禁用它的原因。
    try { if (!this.firstError) this.writePending() } catch (error) { this.rememberFailure(error) }
    for (const stream of this.streams.keys()) this.endStream(stream)
    this.writeStream = null
    this.closePromise = Promise.all(Array.from(this.streams.values(), stream => stream.closed)).then(() => {
      if (this.firstError) throw this.firstError
    })
    return this.closePromise
  }
}

export function registerCoreLogMonitorPlugin<TToolParameters>(
  api: CoreLogMonitorPluginApi<TToolParameters>,
  options: CoreLogMonitorPluginOptions<TToolParameters>,
): CoreLogMonitorPluginRuntime {
  const maxBuffer = options.maxBuffer ?? CORE_LOG_MONITOR_DEFAULT_MAX_BUFFER
  const logBuffer = new CoreLogMonitorBuffer({ maxBuffer })
  const diskWriter = options.diskWriter ?? (() => {
    if (!options.diskWriterOptions) {
      throw new Error('Either diskWriter or diskWriterOptions is required')
    }
    return new CoreLogMonitorDiskWriter(options.diskWriterOptions)
  })()

  function push(eventType: string, envelope: CoreLogEnvelope): void {
    const result = logBuffer.push(eventType, envelope)
    for (const line of result.diskLines) {
      diskWriter.push(line)
    }

    if (result.notify && (options.shouldNotify?.() ?? true)) {
      api.ui.notify(`[AgentLog] ${result.entry.summary}`, 'error')
    }
  }

  for (const type of options.trackedEvents ?? CORE_LOG_MONITOR_TRACKED_EVENTS) {
    api.on(type, envelope => push(type, envelope))
  }

  api.registerTool({
    name: 'search_agent_logs',
    description: 'Search recent agent event logs. Use to investigate what tools ran, check for errors, or find what happened in previous turns.',
    parameters: options.searchToolParameters,
    // R4b:`permissionGuard` 已退役,这里不再写它。插件工具的权限由 `plugin_exec`
    // 这条效果说出来(恒 ask,宿主强制,见 app/plugins/api.ts)。
    async execute(args, ctx) {
      ctx.metadata({ title: `Searching logs${args.eventType ? ` for "${args.eventType}"` : ''}...` })
      return logBuffer.search({
        eventType: args.eventType,
        query: args.query,
        limit: args.limit,
      })
    },
  })

  api.registerCommand('/log-tail', {
    description: 'Show the last N log entries (default 15)',
    async handler(args, ctx) {
      const count = normalizeLogTailCount(args)
      const recent = logBuffer.entries.slice(-count)
      if (recent.length === 0) {
        ctx.notify('No logs yet.', 'info')
        return
      }
      ctx.notify(`Last ${recent.length} events:\n${logBuffer.tail(count)}`)
    },
  })

  api.registerCommand('/log-errors', {
    description: 'Show recent error events',
    async handler(_args, ctx) {
      const notification = formatLogErrorsNotification(logBuffer.entries)
      ctx.notify(notification.message, notification.level)
    },
  })

  api.registerCommand('/log-stats', {
    description: 'Show event type statistics',
    async handler(_args, ctx) {
      ctx.notify(formatLogStatsNotification({
        size: logBuffer.size,
        eventCounts: logBuffer.eventCounts(),
        isBackpressure: diskWriter.isBackpressure,
        droppedCount: diskWriter.droppedCount,
      }))
    },
  })

  api.registerCommand('/log-clear', {
    description: 'Clear in-memory log buffer',
    async handler(_args, ctx) {
      const count = logBuffer.clear()
      ctx.notify(`Cleared ${count} events from buffer.`, 'info')
    },
  })

  // 拆除测试守卫的是"注册表回到基线",但残留不止注册表:磁盘写入器持着
  // 一个 flush 定时器与一条 WriteStream,不在 dispose 里收掉,禁用之后它还在
  // 往磁盘写。
  api.onDispose?.(() => diskWriter.close())

  options.ensureLogDir?.()
  diskWriter.rotateIfNeeded()
  options.logger?.log?.(`[AgentLog] Initialized. Buffer: ${maxBuffer}.`)

  return {
    buffer: logBuffer,
    diskWriter,
  }
}
