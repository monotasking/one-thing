import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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
  type CoreLogMonitorDiskStreamLike,
} from '@onething/core/plugins'

function barrier<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function testStream(options: { write?: (content: string) => boolean; end?: () => void; onDrain?: (handler: () => void) => void } = {}): CoreLogMonitorDiskStreamLike {
  const closed = barrier()
  return { closed: closed.promise, destroyed: false, write: options.write ?? (() => true),
    end: () => { options.end?.(); closed.resolve() }, onDrain: options.onDrain ?? (() => {}), onError: () => {} }
}

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
    expect(summarizeLogEvent('tool:execution-end', { isError: true, toolCallId: 'call-1' }))
      .toBe('ERROR Tool done: call-1')
    expect(summarizeLogEvent('messages:replaced', { messages: [1, 2] }))
      .toBe('Messages replaced (2 total)')
  })

  /*
   * P4-F #30:这两条以前写成下划线名(`tool_execution_start` / `tool_execution_end`),
   * 与总线上真正发出的 `tool:execution-start` / `tool:execution-end` 对不上 ——
   * 监视器于是既不跟踪也不摘要工具执行,`summarizeLogEvent` 落到 default 分支。
   * 载荷按 shared 的 `ToolExecutionStartEvent`(带 toolName)/ `ToolExecutionEndEvent`
   * (没有 toolName,只有 toolCallId + isError)对齐。
   */
  it('summarizes tool execution start/end under their real bus event names', () => {
    expect(CORE_LOG_MONITOR_TRACKED_EVENTS).toContain('tool:execution-start')
    expect(CORE_LOG_MONITOR_TRACKED_EVENTS).toContain('tool:execution-end')

    expect(summarizeLogEvent('tool:execution-start', {
      toolCallId: 'call-1',
      stepId: 'step-1',
      toolName: 'bash',
      args: {},
    })).toBe('Tool start: bash')

    expect(summarizeLogEvent('tool:execution-end', {
      toolCallId: 'call-1',
      stepId: 'step-1',
      isError: false,
    })).toBe('OK Tool done: call-1')

    const failed = createLogEntry('tool:execution-end', {
      sessionId: 'session-1',
      sequence: 3,
      timestamp: 300,
      event: { type: 'tool:execution-end', toolCallId: 'call-2', stepId: 'step-1', isError: true, error: 'boom' },
    })
    expect(failed.summary).toBe('ERROR Tool done: call-2')
    expect(shouldNotifyLogEntry(failed)).toBe(true)
    expect(getRecentLogErrors([failed])).toEqual([failed])
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
      { eventType: 'tool:execution-end', timestamp: 2, sessionId: 's1', sequence: 2, summary: 'ERROR Tool done: bash' },
      { eventType: 'tool:execution-end', timestamp: 3, sessionId: 's1', sequence: 3, summary: 'OK Tool done: read' },
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
      ['tool:execution-end', 2],
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
      '  tool:execution-end: 2',
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
    const second = buffer.push('tool:execution-end', {
      sessionId: 'session-1',
      sequence: 2,
      timestamp: 200,
      event: { type: 'tool:execution-end', toolCallId: 'call-1', stepId: 'step-1', isError: true },
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
    expect(buffer.entries.map(entry => entry.eventType)).toEqual(['tool:execution-end', 'stream:complete'])
    expect(buffer.eventCounts()).toEqual([
      ['tool:execution-end', 1],
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
          createWriteStream: () => testStream(),
          listFiles: () => [],
          deleteFile: () => {},
        },
      },
    })

    try {
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
    } finally { await runtime.diskWriter.close() }
  })

  it('runs disk writer rotation, flushing, cleanup, and backpressure in core', async () => {
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
        createWriteStream: fileName => testStream({
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
    await writer.close()
    expect(ended).toContain('agent-2026-06-25.log')
  })

  it('creates file-system disk adapters in core without main-process wiring', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-monitor-'))
    let stream: CoreLogMonitorDiskStreamLike | undefined
    try {
      const messages: string[] = []
      ensureCoreLogMonitorDirectory(logDir)
      const adapters = createCoreLogMonitorFileDiskAdapters(logDir, {
        log: message => messages.push(message),
      })
      stream = adapters.createWriteStream('agent-2026-06-24.log')
      stream.write('line 1\n')
      stream.end()
      await stream.closed
      const targetPath = path.join(logDir, 'agent-2026-06-24.log')
      expect(fs.readFileSync(targetPath, 'utf8')).toBe('line 1\n')
      expect(adapters.listFiles()).toContain('agent-2026-06-24.log')
      expect(messages).toEqual([])
      adapters.deleteFile('agent-2026-06-24.log')
      expect(adapters.listFiles()).not.toContain('agent-2026-06-24.log')
    } finally {
      stream?.end()
      await stream?.closed
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('owns a real asynchronous open failure through close and refuses later writes', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-open-error-'))
    const date = new Date(2026, 8, 7, 12)
    fs.mkdirSync(path.join(logDir, getLogMonitorFileName(date)))
    const original = fs.createWriteStream.bind(fs)
    const streams: fs.WriteStream[] = []
    const openedError = barrier<Error>()
    const observer = vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = original(...args)
      streams.push(stream)
      stream.once('error', openedError.resolve)
      return stream
    })
    const writer = new CoreLogMonitorDiskWriter({ now: () => date, adapters: createCoreLogMonitorFileDiskAdapters(logDir) })
    try {
      writer.rotateIfNeeded()
      const firstError = await openedError.promise
      expect(firstError).toMatchObject({ code: 'EISDIR' })
      expect(writer.push('must not be accepted')).toBe(false)
      const closing = writer.close()
      expect(writer.close()).toBe(closing)
      await expect(closing).rejects.toBe(firstError)
      expect(streams).toHaveLength(1)
      expect(streams[0].closed).toBe(true)
      writer.rotateIfNeeded()
      expect(writer.push('still closed')).toBe(false)
      expect(streams).toHaveLength(1)
      await expect(writer.close()).rejects.toBe(firstError)
    } finally {
      await writer.close().catch(() => {})
      observer.mockRestore()
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('waits for the real open and close when closed before its file has opened', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-pending-open-'))
    const originalOpen = fs.open.bind(fs)
    const entered = barrier()
    let openRequested = false, resumeOpen: (() => void) | undefined
    const releaseOpen = () => { openRequested = true; const resume = resumeOpen; resumeOpen = undefined; resume?.() }
    const open = vi.spyOn(fs, 'open').mockImplementation((...args: any[]) => {
      if (!String(args[0]).startsWith(logDir + path.sep)) return Reflect.apply(originalOpen, fs, args)
      const callback = args.pop()
      Reflect.apply(originalOpen, fs, [...args, (error: NodeJS.ErrnoException | null, fd: number) => {
        if (openRequested) callback(error, fd)
        else resumeOpen = () => callback(error, fd)
        entered.resolve()
      }])
    })
    const date = new Date(2026, 8, 7, 12)
    const writer = new CoreLogMonitorDiskWriter({ now: () => date, adapters: createCoreLogMonitorFileDiskAdapters(logDir) })
    let settled = false
    try {
      writer.push('accepted before first rotation')
      const closing = writer.close()
      void closing.then(() => { settled = true }, () => { settled = true })
      expect(writer.close()).toBe(closing)
      expect(writer.push('late')).toBe(false)
      await entered.promise
      expect(settled).toBe(false)
      releaseOpen()
      await closing
      expect(settled).toBe(true)
      expect(fs.readFileSync(path.join(logDir, getLogMonitorFileName(date)), 'utf8')).toBe('accepted before first rotation\n')
    } finally {
      releaseOpen()
      try { await writer.close() } finally {
        open.mockRestore()
        fs.rmSync(logDir, { recursive: true, force: true })
      }
    }
  })

  it('retains a rotated old stream until its actual close even after the current stream closes', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-rotation-close-'))
    const firstDate = new Date(2026, 8, 7, 12), secondDate = new Date(2026, 8, 8, 12)
    let date = firstDate
    const originalCreate = fs.createWriteStream.bind(fs), originalClose = fs.close.bind(fs)
    const streams: Array<{ stream: fs.WriteStream; opened: Promise<number>; closed: Promise<void> }> = []
    const create = vi.spyOn(fs, 'createWriteStream').mockImplementation((...args) => {
      const stream = originalCreate(...args)
      streams.push({ stream, opened: new Promise(resolve => stream.once('open', resolve)),
        closed: new Promise(resolve => stream.once('close', () => resolve())) })
      return stream
    })
    const entered = barrier()
    let oldFd: number | undefined, closeRequested = false, resumeClose: (() => void) | undefined
    const releaseClose = () => { closeRequested = true; const resume = resumeClose; resumeClose = undefined; resume?.() }
    const close = vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
      if (fd !== oldFd) return originalClose(fd, callback)
      if (closeRequested) { oldFd = undefined; originalClose(fd, callback) }
      else resumeClose = () => { oldFd = undefined; originalClose(fd, callback) }
      entered.resolve()
    })
    const writer = new CoreLogMonitorDiskWriter({ now: () => date, cleanupChance: 0, adapters: createCoreLogMonitorFileDiskAdapters(logDir) })
    let settled = false
    try {
      writer.push('first day'); writer.flush()
      oldFd = await streams[0].opened
      date = secondDate
      writer.rotateIfNeeded()
      await entered.promise
      writer.push('second day')
      const closing = writer.close()
      void closing.then(() => { settled = true }, () => { settled = true })
      await streams[1].closed
      expect(settled).toBe(false)
      expect(streams[0].stream.closed).toBe(false)
      expect(fs.fstatSync(oldFd!).isFile()).toBe(true)
      expect(streams[1].stream.closed).toBe(true)
      releaseClose()
      await closing
      expect(streams.every(item => item.stream.closed)).toBe(true)
      expect(fs.readFileSync(path.join(logDir, getLogMonitorFileName(firstDate)), 'utf8')).toBe('first day\n')
      expect(fs.readFileSync(path.join(logDir, getLogMonitorFileName(secondDate)), 'utf8')).toBe('second day\n')
    } finally {
      releaseClose()
      try { await writer.close() } finally {
        create.mockRestore(); close.mockRestore()
        fs.rmSync(logDir, { recursive: true, force: true })
      }
    }
  })

  it('keeps the first real error from a rotated stream after a later stream succeeds', async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-log-rotation-error-'))
    let date = new Date(2026, 8, 7, 12)
    fs.mkdirSync(path.join(logDir, getLogMonitorFileName(date)))
    const writer = new CoreLogMonitorDiskWriter({ now: () => date, adapters: createCoreLogMonitorFileDiskAdapters(logDir) })
    try {
      writer.rotateIfNeeded()
      date = new Date(2026, 8, 8, 12)
      writer.rotateIfNeeded()
      writer.push('new stream still drains')
      const closing = writer.close()
      const firstError = await closing.catch(error => error)
      expect(firstError).toMatchObject({ code: 'EISDIR' })
      expect(fs.readFileSync(path.join(logDir, getLogMonitorFileName(date)), 'utf8')).toBe('new stream still drains\n')
      await expect(writer.close()).rejects.toBe(firstError)
      expect(writer.push('no retry')).toBe(false)
    } finally {
      await writer.close().catch(() => {})
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('propagates a close failure only after every owned stream has closed', async () => {
    let date = new Date(2026, 8, 7, 12)
    const old = barrier(), current = barrier()
    let index = 0
    const writer = new CoreLogMonitorDiskWriter({ now: () => date, adapters: {
      createWriteStream: () => ({ ...testStream(), closed: index++ === 0 ? old.promise : current.promise }),
      listFiles: () => [], deleteFile: () => {},
    } })
    writer.rotateIfNeeded(); date = new Date(2026, 8, 8, 12); writer.rotateIfNeeded()
    const closing = writer.close()
    let settled = false
    void closing.then(() => { settled = true }, () => { settled = true })
    const firstError = new Error('adapter close failure')
    old.reject(firstError)
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    current.resolve()
    await expect(closing).rejects.toBe(firstError)
  })
})
