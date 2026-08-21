import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORE_LOG_MONITOR_DEFAULT_FLUSH_INTERVAL_MS,
  CORE_LOG_MONITOR_DEFAULT_MAX_BUFFER,
  CORE_LOG_MONITOR_DEFAULT_RETENTION_DAYS,
  CORE_LOG_MONITOR_TRACKED_EVENTS,
  CoreLogMonitorBuffer,
  CoreLogMonitorDiskWriter,
  countLogEventTypes,
  createLogEntry,
  createCoreLogMonitorFileDiskAdapters,
  duplicateLogDiskLine,
  ensureCoreLogMonitorDirectory,
  formatLogErrorsNotification,
  formatLogMonitorDate,
  formatLogSearchOutput,
  formatLogStatsNotification,
  getLogMonitorFileDate,
  getLogMonitorFileName,
  getRecentLogErrors,
  logEntryDiskLine,
  normalizeLogTailCount,
  planLogMonitorCleanup,
  registerCoreLogMonitorPlugin,
  shouldDeleteLogMonitorFile,
  shouldNotifyLogEntry,
  summarizeLogEvent,
} from '@onething/core/plugins'

describe('core log-monitor helpers', () => {
  it('plans log file naming and retention cleanup in core', () => {
    expect(CORE_LOG_MONITOR_DEFAULT_MAX_BUFFER).toBe(500)
    expect(CORE_LOG_MONITOR_DEFAULT_FLUSH_INTERVAL_MS).toBe(1000)
    expect(CORE_LOG_MONITOR_DEFAULT_RETENTION_DAYS).toBe(7)

    const date = new Date(2026, 5, 24, 13, 30, 0)
    expect(formatLogMonitorDate(date)).toBe('2026-06-24')
    expect(getLogMonitorFileName(date)).toBe('agent-2026-06-24.log')
    expect(getLogMonitorFileDate('agent-2026-06-24.log')).toBe('2026-06-24')
    expect(getLogMonitorFileDate('other.log')).toBeNull()

    const now = new Date('2026-06-24T00:00:00Z').getTime()
    expect(shouldDeleteLogMonitorFile('agent-2026-06-16.log', { now, retentionDays: 7 })).toBe(true)
    expect(shouldDeleteLogMonitorFile('agent-2026-06-17.log', { now, retentionDays: 7 })).toBe(false)
    expect(planLogMonitorCleanup([
      'agent-2026-06-15.log',
      'agent-2026-06-17.log',
      'agent-2026-06-01.txt',
      'notes.log',
    ], { now, retentionDays: 7 })).toEqual(['agent-2026-06-15.log'])
  })

  it('summarizes known event types without plugin state', () => {
    expect(summarizeLogEvent('stream:start', { model: 'deepseek-chat' }))
      .toBe('Stream start (model: deepseek-chat)')
    expect(summarizeLogEvent('stream:complete', { data: { usage: { totalTokens: 42 } } }))
      .toBe('Stream complete (42 tokens)')
    expect(summarizeLogEvent('tool_execution_end', { isError: true, toolName: 'bash' }))
      .toBe('ERROR Tool done: bash')
    expect(summarizeLogEvent('messages:replaced', { messages: [1, 2] }))
      .toBe('Messages replaced (2 total)')
  })

  it('creates log entries and JSON disk lines', () => {
    const entry = createLogEntry('stream:error', {
      sessionId: 'session-abcdef',
      sequence: 7,
      timestamp: 1000,
      event: { type: 'stream:error', data: { error: 'boom' } },
    })

    expect(entry.summary).toBe('Stream error: boom')
    expect(shouldNotifyLogEntry(entry)).toBe(true)
    expect(JSON.parse(logEntryDiskLine(entry))).toEqual({
      t: 1000,
      type: 'stream:error',
      session: 'session-',
      summary: 'Stream error: boom',
      seq: 7,
    })
    expect(JSON.parse(duplicateLogDiskLine({ ...entry, duplicates: 50 }))).toMatchObject({
      dup: 50,
    })
  })

  it('searches, formats, and counts log entries', () => {
    const logs = [
      { eventType: 'stream:start', timestamp: 1, sessionId: 's1', sequence: 1, summary: 'Stream start (model: a)' },
      { eventType: 'tool_execution_end', timestamp: 2, sessionId: 's1', sequence: 2, summary: 'ERROR Tool done: bash' },
      { eventType: 'tool_execution_end', timestamp: 3, sessionId: 's1', sequence: 3, summary: 'OK Tool done: read' },
    ]

    expect(formatLogSearchOutput(logs, {
      query: 'tool',
      limit: 1,
      formatTime: timestamp => `t${timestamp}`,
    })).toMatchObject({
      title: 'Logs: 1 results',
      metadata: { totalHits: 2, shown: 1, bufferSize: 3 },
    })
    expect(getRecentLogErrors(logs)).toEqual([logs[1]])
    expect(countLogEventTypes(logs)).toEqual([
      ['tool_execution_end', 2],
      ['stream:start', 1],
    ])
    expect(normalizeLogTailCount('200')).toBe(100)
    expect(normalizeLogTailCount('bad')).toBe(15)
    expect(formatLogErrorsNotification(logs, {
      formatTime: timestamp => `t${timestamp}`,
    })).toEqual({
      message: 't2 ERROR Tool done: bash',
      level: 'warn',
    })
    expect(formatLogErrorsNotification([])).toEqual({
      message: 'No errors found.',
      level: 'info',
    })
    expect(formatLogStatsNotification({
      size: 3,
      eventCounts: countLogEventTypes(logs),
      isBackpressure: true,
      droppedCount: 4,
    })).toBe([
      '3 events in buffer | disk backpressure, 4 writes dropped',
      '  tool_execution_end: 2',
      '  stream:start: 1',
    ].join('\n'))
  })

  it('keeps log-monitor buffer state and high-frequency duplicate folding in core', () => {
    expect(CORE_LOG_MONITOR_TRACKED_EVENTS).toContain('stream:start')
    expect(CORE_LOG_MONITOR_TRACKED_EVENTS).toContain('messages:replaced')

    const buffer = new CoreLogMonitorBuffer({ maxBuffer: 2 })
    const first = buffer.push('stream:start', {
      sessionId: 'session-1',
      sequence: 1,
      timestamp: 100,
      event: { type: 'stream:start', model: 'deepseek-chat' },
    })
    const second = buffer.push('tool_execution_end', {
      sessionId: 'session-1',
      sequence: 2,
      timestamp: 200,
      event: { type: 'tool_execution_end', toolName: 'bash', isError: true },
    })
    buffer.push('stream:complete', {
      sessionId: 'session-1',
      sequence: 3,
      timestamp: 300,
      event: { type: 'stream:complete', data: { usage: { totalTokens: 3 } } },
    })

    expect(first).toMatchObject({
      stored: true,
      duplicate: false,
      notify: false,
    })
    expect(second.notify).toBe(true)
    expect(buffer.entries.map(entry => entry.eventType)).toEqual(['tool_execution_end', 'stream:complete'])
    expect(buffer.eventCounts()).toEqual([
      ['tool_execution_end', 1],
      ['stream:complete', 1],
    ])
    expect(buffer.clear()).toBe(2)
    expect(buffer.size).toBe(0)
  })

  it('emits duplicate disk lines every 50 high-frequency repeats', () => {
    const buffer = new CoreLogMonitorBuffer()
    const initial = buffer.push('content:part', {
      sessionId: 'session-1',
      sequence: 1,
      timestamp: 1,
      event: { type: 'content:part', content: 'a' },
    })

    expect(initial.stored).toBe(true)
    expect(initial.diskLines).toHaveLength(1)

    let last = initial
    for (let i = 0; i < 49; i++) {
      last = buffer.push('content:part', {
        sessionId: 'session-1',
        sequence: i + 2,
        timestamp: i + 2,
        event: { type: 'content:part', content: 'a' },
      })
    }

    expect(last).toMatchObject({
      duplicate: true,
      stored: false,
      diskLines: [],
    })

    const fiftieth = buffer.push('content:part', {
      sessionId: 'session-1',
      sequence: 51,
      timestamp: 51,
      event: { type: 'content:part', content: 'a' },
    })

    expect(fiftieth.duplicate).toBe(true)
    expect(fiftieth.diskLines).toHaveLength(1)
    expect(JSON.parse(fiftieth.diskLines[0])).toMatchObject({
      type: 'content:part',
      dup: 50,
    })
    expect(buffer.entries).toHaveLength(1)
    expect(buffer.entries[0].duplicates).toBe(50)
  })

  it('registers the log-monitor plugin surface through a core factory', async () => {
    const handlers = new Map<string, (envelope: any) => void>()
    const commands = new Map<string, { handler(args: string, ctx: { notify(message: string, level?: string): void }): Promise<void> }>()
    const notifications: Array<{ message: string; level?: string }> = []
    let registeredTool: any

    const runtime = registerCoreLogMonitorPlugin({
      on(eventType, handler) {
        handlers.set(eventType, handler)
      },
      registerTool(tool) {
        registeredTool = tool
      },
      registerCommand(name, options) {
        commands.set(name, options)
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level })
        },
      },
    }, {
      searchToolParameters: { type: 'object' },
      maxBuffer: 10,
      diskWriterOptions: {
        flushIntervalMs: 100000,
        adapters: {
          createWriteStream: () => ({
            destroyed: false,
            write: () => true,
            end: () => {},
            onDrain: () => {},
          }),
          listFiles: () => [],
          deleteFile: () => {},
        },
      },
    })

    expect(handlers.has('stream:error')).toBe(true)
    expect(registeredTool.name).toBe('search_agent_logs')
    expect(commands.has('/log-tail')).toBe(true)
    expect(commands.has('/log-clear')).toBe(true)

    handlers.get('stream:error')?.({
      sessionId: 's1',
      sequence: 1,
      timestamp: 100,
      event: { type: 'stream:error', data: { error: 'boom' } },
    })

    expect(runtime.buffer.entries).toHaveLength(1)
    expect(runtime.diskWriter.pendingLineCount).toBe(1)
    expect(notifications).toEqual([
      { message: '[AgentLog] Stream error: boom', level: 'error' },
    ])

    const metadataCalls: unknown[] = []
    const result = await registeredTool.execute({
      query: 'boom',
    }, {
      metadata(input: unknown) {
        metadataCalls.push(input)
      },
    })
    expect(metadataCalls).toEqual([{ title: 'Searching logs...' }])
    expect(result.title).toBe('Logs: 1 results')

    await commands.get('/log-tail')?.handler('5', {
      notify(message, level) {
        notifications.push({ message, level })
      },
    })
    expect(notifications[notifications.length - 1]?.message).toContain('Last 1 events:')

    await commands.get('/log-clear')?.handler('', {
      notify(message, level) {
        notifications.push({ message, level })
      },
    })
    expect(runtime.buffer.size).toBe(0)
  })

  it('runs disk writer rotation, flushing, cleanup, and backpressure in core', () => {
    const writes: Array<{ fileName: string; content: string }> = []
    const ended: string[] = []
    const deleted: string[] = []
    const drainHandlers: Array<() => void> = []
    let writeOk = true
    let currentDate = new Date('2026-06-24T10:00:00Z')

    const writer = new CoreLogMonitorDiskWriter({
      flushIntervalMs: 100000,
      cleanupChance: 1,
      now: () => currentDate,
      random: () => 0,
      adapters: {
        createWriteStream: fileName => ({
          destroyed: false,
          write: content => {
            writes.push({ fileName, content })
            return writeOk
          },
          end: () => {
            ended.push(fileName)
          },
          onDrain: handler => {
            drainHandlers.push(handler)
          },
        }),
        listFiles: () => ['agent-2026-06-15.log', 'agent-2026-06-23.log', 'notes.txt'],
        deleteFile: fileName => {
          deleted.push(fileName)
        },
      },
    })

    writer.rotateIfNeeded()
    expect(writer.currentFileName).toBe('agent-2026-06-24.log')

    writer.push('line 1')
    writer.push('line 2')
    expect(writer.pendingLineCount).toBe(2)
    writer.flush()
    expect(writes).toEqual([{
      fileName: 'agent-2026-06-24.log',
      content: 'line 1\nline 2\n',
    }])
    expect(deleted).toEqual(['agent-2026-06-15.log'])

    currentDate = new Date('2026-06-25T01:00:00Z')
    writer.rotateIfNeeded()
    expect(ended).toContain('agent-2026-06-24.log')
    expect(writer.currentFileName).toBe('agent-2026-06-25.log')

    writeOk = false
    writer.push('line 3')
    writer.flush()
    expect(writer.isBackpressure).toBe(true)
    expect(writer.push('line 4')).toBe(false)
    expect(writer.droppedCount).toBe(1)

    drainHandlers.at(-1)?.()
    expect(writer.isBackpressure).toBe(false)
    writer.close()
    expect(ended).toContain('agent-2026-06-25.log')
  })

  it('creates file-system disk adapters in core without main-process wiring', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-monitor-'))
    try {
      const messages: string[] = []
      ensureCoreLogMonitorDirectory(logDir)
      const adapters = createCoreLogMonitorFileDiskAdapters(logDir, {
        log: message => messages.push(message),
      })
      const stream = adapters.createWriteStream('agent-2026-06-24.log')
      stream.write('line 1\n')
      stream.end()
      const targetPath = path.join(logDir, 'agent-2026-06-24.log')
      for (let attempt = 0; attempt < 20 && !fs.existsSync(targetPath); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }

      expect(adapters.listFiles()).toContain('agent-2026-06-24.log')
      expect(messages).toEqual([])
      adapters.deleteFile('agent-2026-06-24.log')
      expect(adapters.listFiles()).not.toContain('agent-2026-06-24.log')
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })
})
