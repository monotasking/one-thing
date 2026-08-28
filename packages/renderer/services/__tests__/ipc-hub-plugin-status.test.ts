// @vitest-environment happy-dom
/**
 * R6 端到端:`content:part` 从 eventBus 一路到 `message.contentParts`。
 *
 * 这条链的中间有一段一直没有被任何用例覆盖,而 R6 的验收主体恰恰死在那里:
 * 会话事件到 ipc-hub 时**不带 messageId**,chatStore 只能回落到
 * `activeStreams.get(sessionId)`;没有正在跑的流就解析不出目标消息,chunk 进
 * 待发队列,一行也渲染不出来 —— 而队列里的东西会在**下一次** stream:start 时
 * flush 到一条毫不相干的新消息上。
 *
 * 所以这里断言的是两件事:
 *  - 流内的状态**真的落到了那条消息上**(不是"事件发出去了"就算数);
 *  - 没有流时它不会诈尸到下一条消息上。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionEventCallback = (envelope: { sessionId: string; event: Record<string, unknown> }) => void

const SESSION = 'session-1'

function statusPart(overrides: Record<string, unknown> = {}) {
  return { type: 'plugin-status', pluginId: 'log-monitor', id: 'scan', label: 'Scanning 1/40', ...overrides }
}

describe('IPC hub → plugin status reaches the message', () => {
  let sessionEvent: SessionEventCallback | undefined

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    sessionEvent = undefined
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => { sessionEvent = callback; return vi.fn() }),
        onSessionStream: vi.fn(() => vi.fn()),
        onPluginNotification: vi.fn(() => vi.fn()),
        getPlugins: vi.fn(async () => ({ success: true, plugins: [] })),
      },
    })
  })

  async function setup() {
    // 旧路用例(U2-a §17.8.7):它驱动手写拼装管道并对着 sessionMessages 断言;
    // 新路上未结算状态行走 overlay 车道(见 fold-tree.test.ts)。开关必须在
    // `vi.resetModules()` 之后按 —— 模块换了实例,状态也换了。
    const { setFoldTreeEnabled } = await import('@/stores/fold-tree')
    setFoldTreeEnabled(false)
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const store = useChatStore()
    initializeIPCHub()
    return { store }
  }

  /** 落一条 assistant 消息并开一条真流,让 activeStreams 里有这条会话。 */
  function startStream(messageId = 'm1') {
    sessionEvent?.({
      sessionId: SESSION,
      event: {
        type: 'message:assistant-created',
        message: {
          id: messageId,
          role: 'assistant',
          content: '',
          timestamp: 0,
          isStreaming: true,
          contentParts: [],
        },
      },
    })
    sessionEvent?.({
      sessionId: SESSION,
      event: { type: 'stream:start', messageId, assistantMessageId: messageId, model: 'test' },
    })
  }

  function currentParts(store: any) {
    const messages = store.getSessionState(SESSION).messages.value
    return messages[messages.length - 1]?.contentParts ?? []
  }

  it('renders a status shown inside a running stream', async () => {
    const { store } = await setup()
    startStream()

    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart() } })

    expect(currentParts(store)).toContainEqual(
      expect.objectContaining({ type: 'plugin-status', pluginId: 'log-monitor', id: 'scan', label: 'Scanning 1/40' }),
    )
  })

  it('updates the same cell in place instead of stacking', async () => {
    const { store } = await setup()
    startStream()

    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart() } })
    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart({ label: 'Scanning 2/40' }) } })

    const cells = currentParts(store).filter((part: any) => part.type === 'plugin-status')
    expect(cells).toHaveLength(1)
    expect(cells[0].label).toBe('Scanning 2/40')
  })

  it('survives streamed text — the plugin is still working', async () => {
    const { store } = await setup()
    startStream()
    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart() } })

    // 模型吐正文。plugin-status 一度被归进"占位型 transient",于是第一个 token
    // 就把它弹掉,插件还在干活却没有了指示器,下一次 show 又把它推回来 ——
    // 按 delta 的频率闪烁。
    sessionEvent?.({
      sessionId: SESSION,
      event: { type: 'content:part', part: { type: 'text', content: 'answer', turnIndex: 0 } },
    })

    expect(currentParts(store).some((part: any) => part.type === 'plugin-status')).toBe(true)
  })

  it('does not resurrect on the next message when there was no stream', async () => {
    // docblock 承诺的另一半:没有流时那条 content:part 解析不出 messageId,
    // 会落进待发队列 —— 而队列会在**下一次** stream:start 时 flush 到一条毫不
    // 相干的新消息上(几小时后诈尸)。R7 之后 core 侧的 show 已经拒绝这种调用,
    // 但渲染侧的行为仍要单独钉住:即便有人绕开账本直接发,也不能诈尸。
    const { store } = await setup()

    // 没有 stream:start —— 直接来一条状态。
    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart() } })

    // 现在开一条**全新的**流(另一条消息)。
    startStream('m2')

    const parts = currentParts(store)
    expect(parts.some((part: any) => part.type === 'plugin-status'), 'a stale status must not attach to a new message').toBe(false)
  })

  it('hides a cleared cell without shifting the parts around it', async () => {
    const { store } = await setup()
    startStream()
    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart() } })
    sessionEvent?.({
      sessionId: SESSION,
      event: { type: 'content:part', part: { type: 'text', content: 'answer', turnIndex: 0 } },
    })
    const lengthBefore = currentParts(store).length

    sessionEvent?.({ sessionId: SESSION, event: { type: 'content:part', part: statusPart({ cleared: true }) } })

    // 撤下是**原地标记**,不是 splice:流式期间 contentParts 只追加,渲染层的
    // key 依赖下标稳定,中途摘一项会让后面所有正文整块重挂。
    const parts = currentParts(store)
    expect(parts).toHaveLength(lengthBefore)
    expect(parts.find((part: any) => part.type === 'plugin-status')?.cleared).toBe(true)
  })
})
