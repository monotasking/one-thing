/**
 * **设置变更走 SSE**(共享层读侧补齐 E 批)。
 *
 * 在这一批之前 `SETTINGS_CHANGED` 是桌面独有的窗间广播,`platform/web.ts` 的
 * `onSettingsChanged` 是条 `() => () => {}` 的空桩 —— 浏览器与 React 壳读的是
 * 同一本 `<store>/settings.json`,却听不见它变了,主题联动因此断在半路。
 *
 * 三条用例各钉一件事:
 *
 * 1. **它真的到得了 SSE**,而且骑的是既有的 `GET /api/events`(没有新路由);
 * 2. **载荷脱敏**。桌面回灌整份 `AppSettings`(同一台机器);SSE 那头是网络对端,
 *    所以过一遍 `sanitizeSettingsForClient` —— 与 `settings.getSettings` 在 http
 *    分叉上交出去的**逐字同一个投影**。这条用例往设置里塞一个真 apiKey,断言线上
 *    流的是哨兵而不是它;
 * 3. **单槽端口是串联的,而且 shutdown 要还原**。桌面把 HTTP 面嵌在自己进程里
 *    (`processPorts:'host'`),此时端口上已经坐着"推给窗口"那一只 —— 串联接错
 *    的后果是桌面那半静默失灵,或者关掉的 runtime 的闭包永远挂在链子上。
 */
import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import { createOnethingHttpServer } from '../http.js'
import { SERVER_REDACTED_SECRET, type OnethingServerRuntime } from '../runtime.js'
import {
  broadcastSettingsChanged,
  configureSettingsEventBroadcaster,
  getSettingsEventBroadcaster,
  type SettingsEvent,
} from '../../wiring/settings/events.js'
import { createTestServerRuntime } from './test-helpers.js'

const servers: Server[] = []
const runtimes: OnethingServerRuntime[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close()
    await once(server, 'close').catch(() => {})
  }
  for (const runtime of runtimes.splice(0)) await runtime.runtime.shutdown()
  configureSettingsEventBroadcaster(null)
})

async function listen(server: Server): Promise<Server> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
  return `http://${address.address}:${address.port}`
}

async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        }),
      ])
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
      if (predicate(text)) return text
    }
    throw new Error(`Timed out waiting for SSE payload. Received: ${text}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** 取出一帧具名 SSE 事件的 data。 */
function sseData(text: string, eventName: string): unknown {
  for (const frame of text.split('\n\n')) {
    if (!frame.includes(`event: ${eventName}`)) continue
    const dataLine = frame.split('\n').find(line => line.startsWith('data: '))
    if (dataLine) return JSON.parse(dataLine.slice('data: '.length))
  }
  throw new Error(`No "${eventName}" frame in: ${text}`)
}

function settingsWithSecret(): AppSettings {
  const settings = createDefaultSettings()
  const ai = (settings as unknown as { ai?: Record<string, unknown> }).ai
  if (ai && typeof ai === 'object') {
    ai.providers = {
      ...(ai.providers as Record<string, unknown> | undefined),
      deepseek: { apiKey: 'sk-a-real-looking-secret' },
    }
  }
  return settings
}

describe('设置变更走既有的 GET /api/events', () => {
  it('到得了 SSE,而且线上流的那份是脱敏过的', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({ runtime: serverRuntime.runtime }))

    const stream = await fetch(`${baseUrl(server)}/api/events`)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    // 连接建立之后再发 —— 订阅是在 handleEvents 里挂上的。
    await new Promise(resolve => setTimeout(resolve, 50))

    broadcastSettingsChanged(settingsWithSecret())

    const text = await readUntil(stream, value => value.includes('event: settings:changed'))
    const payload = sseData(text, 'settings:changed') as {
      ai?: { providers?: Record<string, { apiKey?: string }> }
    }
    expect(payload.ai?.providers?.deepseek?.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(JSON.stringify(payload)).not.toContain('sk-a-real-looking-secret')
  })

  it('单槽端口是串联的:宿主原来那只照收,shutdown 之后还原', async () => {
    // 桌面内嵌 HTTP 面的形态:端口上先坐着"推给窗口"那一只。
    const hostSaw: SettingsEvent[] = []
    const hostBroadcaster = (event: SettingsEvent) => {
      hostSaw.push(event)
    }
    configureSettingsEventBroadcaster(hostBroadcaster)

    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    expect(getSettingsEventBroadcaster()).not.toBe(hostBroadcaster)

    broadcastSettingsChanged(createDefaultSettings(), { excludeCallerId: 7 })
    expect(hostSaw).toHaveLength(1)
    // 排除发起窗那一格原样递给宿主 —— server 这一层不解释它(SSE 连接没有
    // webContents id 这种东西,所以它对 SSE 那侧无意义,但不能因此丢掉)。
    expect(hostSaw[0].excludeCallerId).toBe(7)

    await serverRuntime.runtime.shutdown()
    runtimes.length = 0
    expect(getSettingsEventBroadcaster()).toBe(hostBroadcaster)

    broadcastSettingsChanged(createDefaultSettings())
    expect(hostSaw).toHaveLength(2)
  })

  it('facade 上的 settings 只有订阅面 —— 读写四条仍然只走 settingsRouter', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const settings = serverRuntime.runtime.settings
    expect(typeof settings?.subscribeChanged).toBe('function')
    expect(Object.keys(settings ?? {})).toEqual(['subscribeChanged'])
  })
})
