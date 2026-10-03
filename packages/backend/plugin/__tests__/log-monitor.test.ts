import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OnethingLogMonitorPluginApi } from '../log-monitor.js'
import {
  ONETHING_LOG_MONITOR_MANIFEST,
  createOnethingLogMonitorSearchToolParameters,
  registerOnethingLogMonitorPlugin,
} from '../log-monitor.js'

function createTempLogDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onething-log-monitor-'))
}

/**
 * R3 验收:曾经硬编码的常量现在由 manifest schema 声明、经 api.settings 读取,
 * 而且**改了就生效** —— 不必 disable→enable,更不必重启。
 */
describe('runtime log-monitor plugin config', () => {
  it('reads retention/flush/notify from api.settings and honors changes immediately', async () => {
    const logDir = createTempLogDir()
    const handlers = new Map<string, (envelope: any) => void>()
    const notifications: string[] = []
    // 设置页改一次配置 = 这个快照换一份。
    let config: Record<string, unknown> = { retentionDays: 7, notifyOnErrors: true }

    const api: OnethingLogMonitorPluginApi = {
      on(eventType, handler) {
        handlers.set(eventType, handler)
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      ui: { notify: message => notifications.push(message) },
      settings: { get: () => config as never },
    }

    const deleted: string[] = []
    const runtime = registerOnethingLogMonitorPlugin(api, {
      getLogDir: () => logDir,
      logger: { log: vi.fn() },
    })

    try {
      // 用一组"今天/3 天前/10 天前"的日志文件问 diskWriter 该删哪些。
      const day = (offset: number): string => {
        const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000)
        const pad = (value: number): string => String(value).padStart(2, '0')
        return `agent-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`
      }
      const files = [day(0), day(3), day(10)]
      ;(runtime.diskWriter as unknown as {
        adapters: { listFiles(): string[]; deleteFile(name: string): void }
      }).adapters = {
        listFiles: () => files,
        deleteFile: name => deleted.push(name),
      }

      // 默认 7 天:只有 10 天前那份该走。
      runtime.diskWriter.cleanupOldLogs()
      expect(deleted).toEqual([day(10)])

      // 设置页把保留天数改成 1 —— 取值器让它下一次 cleanup 就生效。
      deleted.length = 0
      config = { retentionDays: 1, notifyOnErrors: false }
      runtime.diskWriter.cleanupOldLogs()
      expect(deleted).toEqual([day(3), day(10)])

      // notifyOnErrors=false 之后错误事件不再弹通知(同一份配置的另一个字段)。
      handlers.get('stream:error')?.({
        sessionId: 's1',
        sequence: 1,
        timestamp: 100,
        event: { type: 'stream:error', data: { error: 'boom' } },
      })
      expect(notifications).toEqual([])

      config = { retentionDays: 1, notifyOnErrors: true }
      handlers.get('stream:error')?.({
        sessionId: 's1',
        sequence: 2,
        timestamp: 200,
        event: { type: 'stream:error', data: { error: 'boom again' } },
      })
      expect(notifications).toHaveLength(1)
    } finally {
      await runtime.diskWriter.close()
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('falls back to the old hardcoded constants when nothing is configured', async () => {
    const logDir = createTempLogDir()
    const api: OnethingLogMonitorPluginApi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      ui: { notify: vi.fn() },
    }
    const runtime = registerOnethingLogMonitorPlugin(api, {
      getLogDir: () => logDir,
      logger: { log: vi.fn() },
    })
    try {
      // 没有 api.settings(旧宿主 / 未配置)也要照常跑,用的就是原来的常量。
      expect(() => runtime.diskWriter.cleanupOldLogs()).not.toThrow()
    } finally {
      await runtime.diskWriter.close()
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })
})

describe('runtime log-monitor plugin', () => {
  it('exposes the onething log monitor manifest and zod search parameters', () => {
    expect(ONETHING_LOG_MONITOR_MANIFEST).toMatchObject({
      name: 'log-monitor',
      version: '1.0.0',
    })
    expect(createOnethingLogMonitorSearchToolParameters().safeParse({
      eventType: 'stream:error',
      query: 'boom',
      limit: 10,
    }).success).toBe(true)
  })

  it('registers the log monitor plugin through runtime defaults and host log dir adapter', async () => {
    const logDir = createTempLogDir()
    const handlers = new Map<string, (envelope: any) => void>()
    const commands = new Map<string, unknown>()
    const notifications: Array<{ message: string; level?: 'info' | 'warn' | 'error' }> = []
    let dispose!: () => void | Promise<void>
    const api: OnethingLogMonitorPluginApi = {
      on(eventType, handler) {
        handlers.set(eventType, handler)
      },
      registerTool: vi.fn(),
      registerCommand(name, options) {
        commands.set(name, options)
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level })
        },
      },
      onDispose: callback => { dispose = callback },
    }

    const runtime = registerOnethingLogMonitorPlugin(api, {
      getLogDir: () => logDir,
      logger: { log: vi.fn() },
    })

    try {
      expect(api.registerTool).toHaveBeenCalledWith(expect.objectContaining({
        name: 'search_agent_logs',
      }))
      /*
       * R4b:插件不再写 `permissionGuard` —— 那个概念退役了。「插件不能自封免检」
       * 这句话现在由 `plugin_exec` 这条效果说出来(恒 ask,宿主强制),而它在
       * `app/plugins/__tests__/builtin-teardown.test.ts` 里被逐个内置插件钉住。
       */
      expect(api.registerTool).not.toHaveBeenCalledWith(
        expect.objectContaining({ permissionGuard: expect.anything() }),
      )
      expect(commands.has('/log-tail')).toBe(true)
      expect(commands.has('/log-clear')).toBe(true)
      expect(handlers.has('stream:error')).toBe(true)

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
    } finally {
      const closed = dispose()
      expect(closed).toBe(runtime.diskWriter.close())
      await closed
      const logFile = fs.readdirSync(logDir).find(file => file.startsWith('agent-'))!
      expect(fs.readFileSync(path.join(logDir, logFile), 'utf8')).toContain('Stream error: boom')
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })
})
