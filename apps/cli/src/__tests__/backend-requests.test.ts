/**
 * CLI 的方法表(`backend-requests.ts`,第④步批 3):每个方法落到哪条 RPC、两步组合按什么次序、一轮流式回答
 * 怎么从事件流折成 `onething ask` 的输出。
 *
 * 后端是一组内存传输上的替身处理者(`@onething/backend-client` 的 `createMemoryTransport`)—— 这里问的是「CLI
 * 发了哪几发、按什么次序、折出了什么」,不是后端对不对(那一半由 `gate:cli-http` 在真后端上证)。
 * 反证:把 `session.new` 里那句 `sessions.switch` 删掉,第二条红;把流事件里 `sessionId` 的过滤删掉,第三条红。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryTransport, type MemoryTransport } from '@onething/backend-client'
import type { RpcRequest } from '@shared/ipc/rpc.js'
import { createBackendRequester } from '../backend-requests.js'
import type { AskStreamEvent } from '../cli-protocol.js'

type Handlers = Record<string, (payload: unknown) => unknown>

/** 一组共用处理者的内存传输;`calls` 按次序记下每一发,`broadcast` 往每一只的事件流里推。 */
function fakeBackend(handlers: Handlers) {
  const calls: RpcRequest[] = []
  const transports: MemoryTransport[] = []
  const wrapped: Record<string, (payload: unknown, request: RpcRequest) => unknown> = {}
  for (const [key, handler] of Object.entries(handlers)) {
    wrapped[key] = (payload, request) => { calls.push(request); return handler(payload) }
  }
  const requester = createBackendRequester(() => {
    const transport = createMemoryTransport({ handlers: wrapped })
    transports.push(transport)
    return transport
  })
  const broadcast = (name: string, data: unknown) => { for (const transport of transports) transport.emit({ name, data }) }
  return { requester, calls, broadcast, names: () => calls.map(call => `${call.domain}.${call.method}`) }
}

const SESSION = { id: 's1', name: 'CLI Chat', messages: [], createdAt: 1, updatedAt: 2 }

describe('CLI 方法表 → RPC', () => {
  it('session.list 投影成摘要行', async () => {
    const backend = fakeBackend({
      'sessions.list': () => ({ success: true, sessions: [{ ...SESSION, messageCount: 3, kind: 'chat' }] }),
    })
    const rows = await backend.requester.request<Array<Record<string, unknown>>>('session.list')
    expect(rows).toEqual([expect.objectContaining({ id: 's1', name: 'CLI Chat', messageCount: 3 })])
    expect(rows[0]).not.toHaveProperty('kind')
  })

  it('session.new = sessions.create 再 sessions.switch(建完就是当前会话,与守护进程同一条)', async () => {
    const backend = fakeBackend({
      'sessions.create': () => ({ success: true, session: SESSION }),
      'sessions.switch': () => ({ success: true, session: SESSION }),
    })
    const session = await backend.requester.request<{ id: string }>('session.new', { name: 'CLI Chat' })
    expect(session.id).toBe('s1')
    expect(backend.names()).toEqual(['sessions.create', 'sessions.switch'])
  })

  it('provider.use = 读设置 → 改一格 → 存回去;没开的服务商当场拒、不写', async () => {
    const stored = {
      ai: { provider: 'a', providers: { a: { enabled: true, model: 'm1' }, b: { enabled: false, model: '' } } },
      tools: { tools: {} },
    }
    let saved: unknown
    const backend = fakeBackend({
      'settings.getSettings': () => ({ success: true, settings: structuredClone(stored) }),
      'settings.saveSettings': payload => { saved = payload; return { success: true, settings: payload } },
    })
    await expect(backend.requester.request('provider.use', { providerId: 'b' })).rejects.toThrow(/not enabled/)
    expect(saved).toBeUndefined()
    const summary = await backend.requester.request('provider.use', { providerId: 'a', model: 'm2' })
    expect(summary).toMatchObject({ id: 'a', model: 'm2', isDefault: true })
    expect((saved as typeof stored).ai.providers.a.model).toBe('m2')
  })

  it('active.list 的 streamId 就是会话 id,active.abort 按它停', async () => {
    const backend = fakeBackend({
      'chat.getActiveStreams': () => ({ success: true, sessionIds: ['s1'] }),
      'chat.abortStream': payload => ({ success: (payload as { sessionId: string }).sessionId === 's1' }),
    })
    expect(await backend.requester.request('active.list')).toEqual([{ streamId: 's1', sessionId: 's1', status: 'running' }])
    expect(await backend.requester.request('active.abort', { streamId: 's1' })).toEqual({ aborted: true })
  })

  it('chat.ask:先接事件流再发命令(带 channel cli),只折这条会话的事件,收场就返回', async () => {
    const events: AskStreamEvent[] = []
    let sent: Record<string, unknown> | undefined
    const backend = fakeBackend({
      'sessions.get': () => ({ success: true, session: SESSION }),
      'session-command.emit': payload => {
        sent = (payload as { command: Record<string, unknown> }).command
        queueMicrotask(() => {
          backend.broadcast('session:stream', { sessionId: 'other', chunk: { type: 'text-delta', text: 'NOT MINE' } })
          backend.broadcast('session:stream', { sessionId: 's1', chunk: { type: 'text-delta', text: 'hello ' } })
          backend.broadcast('session:stream', { sessionId: 's1', chunk: { type: 'text-delta', text: 'world' } })
          backend.broadcast('session:event', {
            sessionId: 's1', sequence: 1, timestamp: 1,
            event: { type: 'permission:request', requestId: 'p1', targetChannel: 'cli', title: 'Run ls' },
          })
          backend.broadcast('session:event', { sessionId: 's1', sequence: 2, timestamp: 2, event: { type: 'stream:complete', data: {} } })
        })
        return { success: true }
      },
    })
    const result = await backend.requester.request<{ stopReason: string }>('chat.ask', { prompt: 'hi', sessionId: 's1' }, event => {
      events.push(event)
    })
    expect(result.stopReason).toBe('end_turn')
    expect(sent).toMatchObject({ type: 'command:send-message', channel: 'cli', content: 'hi' })
    expect(events.map(event => event.event)).toEqual([
      { type: 'text_delta', text: 'hello ' },
      { type: 'text_delta', text: 'world' },
      { type: 'permission', id: 'p1', description: 'Run ls', options: ['once', 'session', 'workdir', 'reject'] },
      { type: 'done', stopReason: 'end_turn', usage: undefined },
    ])
  })

  it('chat.ask:后端不收这条消息就当场收场并说为什么', async () => {
    const events: AskStreamEvent[] = []
    const backend = fakeBackend({
      'sessions.get': () => ({ success: true, session: SESSION }),
      'session-command.emit': () => ({ success: false, error: 'A response is still running' }),
    })
    await expect(backend.requester.request('chat.ask', { prompt: 'hi', sessionId: 's1' }, event => { events.push(event) }))
      .rejects.toThrow(/still running/)
    expect(events.at(-1)?.event).toMatchObject({ type: 'error', code: 'STREAM_START_FAILED' })
  })

  it('permission.respond 走会话命令,带 channel cli', async () => {
    let sent: Record<string, unknown> | undefined
    const backend = fakeBackend({
      'session-command.emit': payload => { sent = payload as Record<string, unknown>; return { success: true } },
    })
    await backend.requester.request('permission.respond', { sessionId: 's1', requestId: 'p1', decision: 'once' })
    expect(sent).toEqual({
      sessionId: 's1',
      command: { type: 'command:permission-respond', channel: 'cli', requestId: 'p1', decision: 'once' },
    })
  })
})
