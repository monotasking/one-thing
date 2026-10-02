/**
 * 标题生成是**发后不管**(工单 4 A1,回 HEAD 形状)。
 *
 * 2026-09-06/07 那轮重构把 `handleSendMessage` 里的
 * `this.generateAndApplySessionTitle(...).catch(...)` 改成了 `await`。后果是
 * 用户可感知的:新会话的第一条消息,要等**标题模型**这一次独立的网络调用跑完
 * 才轮到主模型开口 —— 慢的 provider 上就是「发出去之后干等好几秒一个字不出」。
 *
 * 这里钉死的不是「标题对不对」,而是**主路不等它**:让标题那条路上的鉴权
 * 永远不 resolve(模拟一次挂住的标题请求),主路仍然要跑到底并把结果发出来。
 */
import { describe, expect, it, vi } from 'vitest'
import { CoreStreamEngine } from '../core-stream-engine.js'

function createEngine() {
  const emitted: Array<{ sessionId: string; event: { type: string; [key: string]: unknown } }> = []
  const messages: unknown[] = []
  // 标题那条路走 settings 直算(`resolveToolCallModel`),主路走
  // `getEffectiveConfig` —— 两条路的 providerId 故意不同,好让 `resolveAuth`
  // 只在标题那一侧挂住。
  const settings = {
    ai: { provider: 'title-model', providers: { 'title-model': { model: 'tiny' } } },
  }
  let titleAuthCalls = 0
  const runtime = {
    store: {
      getSession: () => ({ id: 's1', name: '', messages, workingDirectory: '/repo' }),
      listMessages: () => messages,
      getMessage: (_sessionId: string, messageId: string) =>
        messages.find((message) => (message as { id?: string }).id === messageId),
      getSettings: () => settings,
      addMessage: vi.fn((_sessionId: string, message: unknown) => { messages.push(message); return message }),
      renameSession: vi.fn(),
    },
    ids: { createId: (() => { let n = 0; return () => `id-${++n}` })() },
    clock: { now: () => 1000 },
    skills: { getForSession: () => [] },
    media: { ingestMessageAttachments: () => {} },
    prompts: {
      resolveReferences: (raw: string) => ({ modelContent: raw, displayContent: raw, contentParts: undefined }),
    },
    provider: {
      isSupported: () => true,
      requiresOAuth: () => false,
      getEffectiveConfig: () => ({ providerId: 'main-model', providerConfig: {}, model: 'big' }),
      // 标题路的鉴权永远挂住;主路的鉴权立刻答「没配」。
      resolveAuth: (providerId: string) => {
        if (providerId === 'title-model') {
          titleAuthCalls += 1
          return new Promise(() => {})
        }
        return Promise.resolve(null)
      },
    },
    streams: {},
  }
  const engine = new CoreStreamEngine(runtime as never)
  engine.setEventBus({
    emit: async (sessionId: string, event: { type: string }) => { emitted.push({ sessionId, event }) },
    onAnySession: () => () => {},
  } as never)
  return { engine, emitted, messages, titleAuthCalls: () => titleAuthCalls }
}

describe('首条消息的标题生成', () => {
  it('主路不等标题模型:标题请求还挂着,回复路已经跑完并发出结果', async () => {
    const { engine, emitted, messages, titleAuthCalls } = createEngine()

    await engine.handleSendMessage('s1', { content: '第一句' }, {} as never)

    // 标题那条路确实被走了(而且还挂在鉴权上,永远不会 resolve)。
    expect(titleAuthCalls()).toBe(1)
    // 主路没有被它拖住:用户消息入库,并且主路的解析结果已经发出来了。
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '第一句' })
    expect(emitted.map(e => e.event.type)).toEqual(['message:user-created', 'stream:error'])
  })
})
