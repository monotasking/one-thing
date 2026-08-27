// @vitest-environment happy-dom
/**
 * **挂点这一格**(§17.8 U1-b):收尾事件真的把 ui-refold 叫起来了吗。
 *
 * 判据测试(`stores/__tests__/ui-refold.test.ts`)钉的是"比得对";这一只钉的是
 * "**比得着**" —— 生产上唯一的入口是 ipc-hub 的三条收尾分支
 * (`stream:complete` / `stream:error` / `stream:aborted`),它们断了,门再准也
 * 一次都不会跑。顺带把两道闸(采样、消息条数)与失配出口各钉一格。
 *
 * 账本从 `sessionEventsApi.list` 拉,这里用替身喂 —— 真账本的拉取路径由
 * platform 层自己的测试管,本文件只关心"叫没叫、算了几次、失配报没报"。
 */
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionEventCallback = (envelope: {
  sessionId: string
  event: Record<string, unknown>
}) => void

const listMock = vi.fn(async () => ({ events: [] as unknown[] }))

vi.mock('@/platform/session-events-client', () => ({
  sessionEventsApi: {
    // 门拉的是**全集**那条(`listRaw`),不是轨迹面板的老七类 `list`。
    listRaw: (...args: unknown[]) => listMock(...(args as [])),
  },
}))

const SESSION = 'hub-refold'

/** 一段最小账本:一条用户消息 + 一轮走完的 assistant。 */
function ledger(assistantText: string): unknown[] {
  let seq = 0
  const event = (type: string, data: unknown) => ({ seq: ++seq, time: 1000 + seq, type, data })
  return [
    event('user/message', {
      message: { id: 'u1', role: 'user', content: '在吗', timestamp: 1000 },
    }),
    event('run/start', {
      runId: 'r1',
      kind: 'send',
      assistantMessageId: 'a1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      timestamp: 1002,
      createdAssistantMessage: true,
    }),
    event('request/start', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('assistant/chunks', {
      runId: 'r1',
      requestIndex: 1,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: 1000,
      dt: [0],
      text: [assistantText],
    }),
    event('assistant/part-end', { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text' }),
    event('request/response', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('request/end', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('run/end', { runId: 'r1', outcome: 'completed' }),
  ]
}

describe('ipc-hub → ui-refold 挂点', () => {
  let eventCallback: SessionEventCallback | undefined

  beforeEach(() => {
    vi.resetModules()
    setActivePinia(createPinia())
    eventCallback = undefined
    listMock.mockReset()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        onSessionEvent: vi.fn((callback: SessionEventCallback) => {
          eventCallback = callback
          return vi.fn()
        }),
        onSessionStream: vi.fn(() => vi.fn()),
        saveUIState: vi.fn(async () => ({ success: true })),
      },
    })
  })

  /** 起 hub,顺便把手写侧摆成"与账本同形"的样子。 */
  async function boot(assistantText = '在的') {
    const { initializeIPCHub } = await import('../ipc-hub')
    const { useChatStore } = await import('@/stores/chat')
    const refold = await import('@/stores/ui-refold')
    refold.resetUiRefold()
    initializeIPCHub()
    const store = useChatStore()
    // 手写侧 = 账本折出来的那份(同形),于是"没病"的基线是 0 失配。
    store.sessionMessages.set(SESSION, refold.foldLedgerMessages(ledger(assistantText)))
    return { store, refold }
  }

  /**
   * 收尾走的是**统一事件面**(`session:event` 的三条 stream 生命周期分支),
   * 不是高频 chunk 面。判定同步、比对在宏任务里,所以等一拍。
   */
  async function settle(type: string): Promise<void> {
    eventCallback?.({ sessionId: SESSION, event: { type, data: {} } })
    await new Promise(resolve => setTimeout(resolve, 0))
    await Promise.resolve()
  }

  it('stream:complete 触发一次比对,同形 → 0 失配', async () => {
    const { refold } = await boot()
    listMock.mockResolvedValue({ events: ledger('在的') })

    await settle('stream:complete')

    expect(listMock).toHaveBeenCalledTimes(1)
    const stats = refold.getUiRefoldStats()
    expect(stats.checks).toBe(1)
    expect(stats.mismatches).toBe(0)
    expect(stats.errors).toBe(0)
  })

  it('两侧不同 → 记一条失配(出口是活的,不是永远绿)', async () => {
    const { refold } = await boot('在的')
    // 账本说的是另一句话 —— 屏幕上那份就该被判红。
    listMock.mockResolvedValue({ events: ledger('不在') })

    await settle('stream:complete')

    const stats = refold.getUiRefoldStats()
    expect(stats.checks).toBe(1)
    expect(stats.mismatches).toBe(1)
  })

  it('error / aborted 同样是收尾(三条分支都挂上了)', async () => {
    const { refold } = await boot()
    listMock.mockResolvedValue({ events: ledger('在的') })

    await settle('stream:error')
    expect(refold.getUiRefoldStats().checks).toBe(1)

    refold.resetUiRefold()
    await settle('stream:aborted')
    expect(refold.getUiRefoldStats().checks).toBe(1)
  })

  it('采样闸:首次必采,其后 N-1 次只记跳过(不拉账本)', async () => {
    const { refold } = await boot()
    listMock.mockResolvedValue({ events: ledger('在的') })

    for (let i = 0; i < refold.UI_REFOLD_EVERY; i++) await settle('stream:complete')

    const stats = refold.getUiRefoldStats()
    expect(stats.checks).toBe(1)
    expect(stats.skippedSampled).toBe(refold.UI_REFOLD_EVERY - 1)
    // 关键:跳过的那几次**一次都没拉**账本(整份拉是这道闸存在的理由)。
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('消息条数闸:超线连拉都不拉', async () => {
    const { store, refold } = await boot()
    const one = store.sessionMessages.get(SESSION)![0]
    store.sessionMessages.set(
      SESSION,
      Array.from({ length: refold.UI_REFOLD_MAX_MESSAGES + 1 }, (_, index) => ({
        ...one,
        id: `m${index}`,
      })),
    )
    listMock.mockResolvedValue({ events: ledger('在的') })

    await settle('stream:complete')

    expect(listMock).not.toHaveBeenCalled()
    expect(refold.getUiRefoldStats().skippedTooManyMessages).toBe(1)
  })

  it('账本过大:付一次学费,此后这条会话永不再采', async () => {
    const { refold } = await boot()
    const huge = Array.from(
      { length: refold.UI_REFOLD_MAX_EVENTS + 1 },
      () => ({ seq: 1, time: 1, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } }),
    )
    listMock.mockResolvedValue({ events: huge })

    await settle('stream:complete')
    expect(refold.getUiRefoldStats().skippedOversized).toBe(1)

    // 第二次:采样轮不到它也罢,轮到了也直接跳 —— 这里连采样计数都不该再走。
    for (let i = 0; i < refold.UI_REFOLD_EVERY; i++) await settle('stream:complete')
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(refold.getUiRefoldStats().checks).toBe(0)
  })

  it('字节闸:条数不超但正文巨大 —— 称一次,此后永久跳过', async () => {
    const { refold } = await boot()
    // 真机形状:条数很少、正文极大(最大那本 50.4MB 只有 258 条事件)。
    const fat = ledger('x'.repeat(refold.UI_REFOLD_MAX_BYTES + 1))
    listMock.mockResolvedValue({ events: fat })

    await settle('stream:complete')

    const stats = refold.getUiRefoldStats()
    expect(stats.skippedOversized).toBe(1)
    expect(stats.checks).toBe(0)

    // 称过一次就够了:第二轮采样直接跳,连拉都不再拉。
    for (let i = 0; i < refold.UI_REFOLD_EVERY; i++) await settle('stream:complete')
    expect(listMock).toHaveBeenCalledTimes(1)
  })

  it('账本一条都没有(legacy 会话)→ 记跳过,不当失配', async () => {
    const { refold } = await boot()
    listMock.mockResolvedValue({ events: [] })

    await settle('stream:complete')

    const stats = refold.getUiRefoldStats()
    expect(stats.skippedNoLedger).toBe(1)
    expect(stats.mismatches).toBe(0)
  })

  it('拉账本炸了 → 自吞记一次 error,收尾路径不受影响', async () => {
    const { refold } = await boot()
    listMock.mockRejectedValue(new Error('boom'))

    await settle('stream:complete')

    const stats = refold.getUiRefoldStats()
    expect(stats.errors).toBe(1)
    expect(stats.checks).toBe(0)
    expect(stats.mismatches).toBe(0)
  })
})
