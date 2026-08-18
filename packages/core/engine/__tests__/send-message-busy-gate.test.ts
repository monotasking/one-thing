/**
 * 忙时闸门(2026-08-17):一个会话同一时刻只有一条流。
 *
 * 从前 `handleSendMessage` 不看 `activeStreams`,第二条 send-message 会
 * `registerController` 掐掉第一条("Superseded")再起一条 —— 草稿纸窗 /
 * deeplink / `chatStore.sendMessage` 这些绕过 InputBox 本地队列的直发路径,
 * 每一条都能在同一轮对话里造出多条半截回复。这里钉死三件事:
 *   1. 忙 + 纯文本 → 进 steering 队列(可撤回),**不**再开第二条流;
 *   2. 忙 + 附件 → 如实报错(steering 装不下附件),不悄悄丢文件也不开流;
 *   3. `persistOnly` 不受闸门管 —— 它本来就不开流。
 */
import { describe, expect, it, vi } from 'vitest'
import { CoreStreamEngine } from '../core-stream-engine.js'

function createEngine() {
  const emitted: Array<{ sessionId: string; event: { type: string; [key: string]: unknown } }> = []
  const messages: unknown[] = []
  const runtime = {
    store: {
      getSession: () => ({ id: 's1', messages, workingDirectory: '/repo' }),
      getSettings: () => ({}),
      addMessage: vi.fn((_sessionId: string, message: unknown) => { messages.push(message) }),
    },
    ids: { createId: (() => { let n = 0; return () => `id-${++n}` })() },
    clock: { now: () => 1000 },
    skills: { getForSession: () => [] },
    media: { ingestMessageAttachments: () => {} },
    prompts: {
      resolveReferences: (raw: string) => ({ modelContent: raw, displayContent: raw, contentParts: undefined }),
    },
  }
  const engine = new CoreStreamEngine(runtime as never)
  engine.setEventBus({
    emit: async (sessionId: string, event: { type: string }) => { emitted.push({ sessionId, event }) },
    onAnySession: () => () => {},
  } as never)
  return { engine, emitted, messages, runtime }
}

describe('handleSendMessage 忙时闸门', () => {
  it('忙 + 纯文本 → steering 队列,不开第二条流', async () => {
    const { engine, emitted, messages } = createEngine()
    engine.registerController('s1', new AbortController())
    const before = engine.getController('s1')

    await engine.handleSendMessage('s1', { content: '补一句' }, {} as never)

    // 第一条流还在,没被 Superseded。
    expect(engine.getController('s1')).toBe(before)
    expect(before?.signal.aborted).toBe(false)
    // 落盘的是一条 steered 用户消息,并广播「在队列里、可撤回」。
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '补一句', steered: true })
    expect(emitted.map(e => e.event.type)).toEqual(['message:user-created', 'steering:queued'])
    expect(engine.getSteeringQueue("s1").size).toBe(1)
  })

  it('忙 + 附件 → stream:error,不落盘、不开流', async () => {
    const { engine, emitted, messages } = createEngine()
    engine.registerController('s1', new AbortController())

    await engine.handleSendMessage('s1', { content: '看图', attachments: [{ id: 'a' }] }, {} as never)

    expect(messages).toHaveLength(0)
    expect(engine.getSteeringQueue("s1").size).toBe(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('stream:error')
  })

  it('persistOnly 不受闸门管', async () => {
    const { engine, messages } = createEngine()
    engine.registerController('s1', new AbortController())

    await engine.handleSendMessage('s1', { content: '房间来信', persistOnly: true }, {} as never)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '房间来信' })
    expect((messages[0] as { steered?: boolean }).steered).toBeUndefined()
  })
})
