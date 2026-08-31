import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@renderer/platform/types'
import { configureChatPort, type ChatPort } from './chat-port'
import { useNotifyStore } from '../services/notify-store'
import { ABORT_SETTLE_MS, REFOLD_THROTTLE_MS, selectEngineBusy, useChatSource } from './chat-source'

/**
 * 聊天数据源的判据 —— 全是纯逻辑,所以这里一台 core 都不起:端口换成假的,
 * 喂进去的是真词汇的账本行(与 `events.jsonl` 逐字同形)。
 *
 * 钉住的四件事:起底、增量折、缺号重折(节流)、活尾巴的接管与丢弃。
 */

const T0 = 1_700_000_000_000
const SESSION = 's1'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const created = (seq: number): Ledger => ({
  seq,
  time: T0,
  type: 'session/created',
  data: { sessionId: SESSION },
})

const userMessage = (seq: number, id: string, content: string): Ledger => ({
  seq,
  time: T0,
  type: 'user/message',
  data: { message: { id, role: 'user', content, timestamp: T0 } },
})

const runStart = (seq: number, runId: string, assistantMessageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId, timestamp: T0 },
})

/** 打包行 —— 消费侧不自己 decode,归约器里的解码器负责展开(定律二)。 */
const chunks = (seq: number, runId: string, messageId: string, text: string[]): Ledger => ({
  seq,
  time: T0,
  type: 'assistant/chunks',
  data: {
    runId,
    requestIndex: 0,
    messageId,
    partIndex: 0,
    kind: 'text',
    time0: T0,
    dt: text.map((_, index) => index),
    text,
  },
})

const runEnd = (seq: number, runId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/end',
  data: { runId, outcome: 'completed' },
})

interface Harness {
  port: ChatPort
  listRawCalls: number
  ledger: Ledger[]
  sent: string[]
  /** 端口收到的每一次 abort 的 sessionId —— 「打空的 abort 一次都不许发」靠它钉。 */
  aborted: string[]
  /** 端口收到的每一次重跑的 messageId。 */
  retried: string[]
  sendResult: () => Promise<{ success: boolean; error?: string }>
  abortResult: () => Promise<{ success: boolean; error?: string }>
  retryResult: () => Promise<{ success: boolean; error?: string }>
  emitEvent(envelope: SessionEventEnvelope): void
  emitLedger(record: Ledger): void
  emitStream(payload: SessionStreamPayload): void
}

function harness(initial: Ledger[]): Harness {
  const eventSubs: ((envelope: SessionEventEnvelope) => void)[] = []
  const streamSubs: ((payload: SessionStreamPayload) => void)[] = []
  const h: Harness = {
    listRawCalls: 0,
    ledger: [...initial],
    sent: [],
    aborted: [],
    retried: [],
    sendResult: async () => ({ success: true }),
    abortResult: async () => ({ success: true }),
    retryResult: async () => ({ success: true }),
    port: {
      ready: async () => undefined,
      listRaw: async () => {
        h.listRawCalls += 1
        return { events: [...h.ledger] as never }
      },
      readBlob: async () => ({}),
      onSessionEvent: (callback) => {
        eventSubs.push(callback)
        return () => void eventSubs.splice(eventSubs.indexOf(callback), 1)
      },
      onSessionStream: (callback) => {
        streamSubs.push(callback)
        return () => void streamSubs.splice(streamSubs.indexOf(callback), 1)
      },
      sendMessage: async (_sessionId, content) => {
        h.sent.push(content)
        return h.sendResult()
      },
      abort: async (sessionId) => {
        h.aborted.push(sessionId)
        return h.abortResult()
      },
      retryMessage: async (_sessionId, messageId) => {
        h.retried.push(messageId)
        return h.retryResult()
      },
    },
    emitEvent: (envelope) => eventSubs.forEach((fn) => fn(envelope)),
    emitLedger: (record) =>
      h.emitEvent({
        sessionId: SESSION,
        sequence: record.seq,
        timestamp: T0,
        event: { type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record } as never,
      }),
    emitStream: (payload) => streamSubs.forEach((fn) => fn(payload)),
  }
  return h
}

/** 推屏按帧合并 —— 断言前把那一帧等掉。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

const state = () => useChatSource.getState()
const ids = () => state().messages.map((message) => message.id)

beforeEach(() => {
  useChatSource.getState().reset()
})

afterEach(() => {
  useChatSource.getState().reset()
  configureChatPort(undefined)
  vi.useRealTimers()
})

describe('起底:进会话 = listRaw 全量折', () => {
  it('折出来的就是 core 归约器的输出,渲染层零拼装', async () => {
    const h = harness([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['你', '好']),
      runEnd(5, 'r1'),
    ])
    configureChatPort(h.port)

    await state().open(SESSION)
    await settle()

    expect(state().status).toBe('ready')
    expect(ids()).toEqual(['m1', 'a1'])
    expect(state().messages[1].content).toBe('你好')
    // run 收了 = 没有在跑的那一条。
    expect(state().activeMessageId).toBeUndefined()
  })

  it('空账本是一棵空树,不是错误', async () => {
    const h = harness([])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    expect(state().status).toBe('ready')
    expect(state().messages).toEqual([])
  })

  it('没有当前会话时归零,不把上一条会话的树留在屏幕上', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    expect(ids()).toEqual(['m1'])

    await state().open('')
    expect(state().status).toBe('idle')
    expect(state().messages).toEqual([])
  })
})

describe('增量:账本活事件一条一条折', () => {
  it('seq 接得上就当场折进去,不再拉 listRaw', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '第一句')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    expect(h.listRawCalls).toBe(1)

    h.emitLedger(userMessage(3, 'm2', '第二句'))
    await settle()

    expect(ids()).toEqual(['m1', 'm2'])
    expect(h.listRawCalls).toBe(1)
  })

  it('旧行是重折之后的回声,丢掉(幂等)', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '第一句')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitLedger(userMessage(2, 'm1', '第一句'))
    await settle()
    expect(ids()).toEqual(['m1'])
  })

  it('别的会话的信封一律不看', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '第一句')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitEvent({
      sessionId: 'another',
      sequence: 3,
      timestamp: T0,
      event: {
        type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT,
        record: userMessage(3, 'mX', '别人的'),
      } as never,
    })
    await settle()
    expect(ids()).toEqual(['m1'])
  })

  it('run 开着的时候 activeMessageId 指向那条助手消息', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitLedger(runStart(3, 'r1', 'a1'))
    await settle()
    expect(state().activeMessageId).toBe('a1')

    h.emitLedger(runEnd(4, 'r1'))
    await settle()
    expect(state().activeMessageId).toBeUndefined()
  })
})

describe('缺号:不补拼,整会话重折(节流合并)', () => {
  it('缺号触发一次 listRaw 重折,窗口内的多次缺号塌成一次', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '第一句')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    expect(h.listRawCalls).toBe(1)

    vi.useFakeTimers()
    // 断线重连补发时的样子:seq 4 先到,3 缺着 —— 不许拿 4 拼一棵半树。
    h.ledger.push(userMessage(3, 'm2', '第二句'), userMessage(4, 'm3', '第三句'))
    h.emitLedger(userMessage(4, 'm3', '第三句'))
    h.emitLedger(userMessage(5, 'm4', '第四句'))
    expect(h.listRawCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(REFOLD_THROTTLE_MS + 100)
    vi.useRealTimers()
    await settle()

    expect(h.listRawCalls).toBe(2)
    // 重折读的是**此刻整份账本**,缺的那条自己补上了;重折在飞时到达的 seq 5
    // **攒着不丢**(广播的事件必然已落盘,快照只是比它旧),排空回放后也在 ——
    // 从前这里丢掉它,重折一完成又缺号,3s 一轮永远追不上活流。
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
})

describe('活尾巴:平滑上屏,打包行一到就换装', () => {
  it('裸 delta 当场追加到正文上(不等 2s 的打包行)', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: '好', messageId: 'a1' } as never })
    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: '的', messageId: 'a1' } as never })
    await settle()

    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('好的')
  })

  it('打包行一到,它那一截离开尾巴 —— 不重影', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: '好的', messageId: 'a1' } as never })
    await settle()
    h.emitLedger(chunks(4, 'r1', 'a1', ['好的']))
    await settle()

    // 账本那份接管;两者逐字节相同(decode∘encode ≡ id),所以屏幕上还是「好的」。
    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('好的')
  })

  it('尾巴里已经攒着打包窗之后的 delta:打包行只带走自己那截,不整段丢 —— 不回缩', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: '好的', messageId: 'a1' } as never })
    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: ',继续', messageId: 'a1' } as never })
    await settle()
    // 打包行只装了「好的」—— 从前这里整段丢尾巴,「,继续」要等下一条打包行才回来。
    h.emitLedger(chunks(4, 'r1', 'a1', ['好的']))
    await settle()

    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('好的,继续')
  })

  it('收尾事件把尾巴丢掉(这一轮完了,尾巴不再有主)', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: { type: 'text-delta', text: '半句', messageId: 'a1' } as never })
    await settle()
    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('半句')

    h.emitEvent({
      sessionId: SESSION,
      sequence: 9,
      timestamp: T0,
      event: { type: SESSION_EVENT_TYPES.STREAM_COMPLETE, data: {} } as never,
    })
    await settle()
    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('')
  })

  it('UI 事件流那几条不进尾巴 —— 它们与账本行同形,归折叠', async () => {
    const h = harness([created(1), runStart(2, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({
      sessionId: SESSION,
      chunk: { type: 'assistant/delta', text: '不该上屏', messageId: 'a1' } as never,
    })
    await settle()
    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('')
  })
})

describe('发送:pending 立刻上屏,账本认领之后丢掉', () => {
  it('空话不发;没有当前会话也不发', async () => {
    const h = harness([])
    configureChatPort(h.port)
    expect(state().send('   ')).toBe(false)
    expect(state().send('有话')).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('发出去 = 一格 pending,账本长出那条用户消息就换装', async () => {
    const h = harness([created(1)])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    expect(state().send('真发一条')).toBe(true)
    expect(state().overlay).toHaveLength(1)
    await settle()
    expect(h.sent).toEqual(['真发一条'])

    h.emitLedger(userMessage(2, 'm1', '真发一条'))
    await settle()

    expect(ids()).toEqual(['m1'])
    expect(state().overlay).toEqual([])
  })

  it('发不出去 = 那一格转 failed 并带上后端说的那句话,重试再发一次', async () => {
    const h = harness([created(1)])
    h.sendResult = async () => ({ success: false, error: '引擎没接住' })
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    state().send('会失败的一条')
    await settle()
    const failed = state().overlay[0]
    expect(failed).toMatchObject({ kind: 'pending', status: 'failed', error: '引擎没接住' })

    h.sendResult = async () => ({ success: true })
    state().retry(failed.id)
    await settle()
    expect(h.sent).toEqual(['会失败的一条', '会失败的一条'])
    expect(state().overlay[0]).toMatchObject({ status: 'sending' })
  })

  /*
   * 08-30 通知系统批:发失败**同时**报一条 error 通知 —— 兜底,不抢气泡里那条
   * 就地重试条的活(那条一格没动,上面那个用例仍然在断言它)。
   * 它管的是另一种情形:失败的那一刻用户已经滚到别处或切走了会话。
   */
  it('发不出去还兜底报一条 error 通知(气泡里的重试条一格不动)', async () => {
    useNotifyStore.setState({ items: [] })
    const h = harness([created(1)])
    h.sendResult = async () => ({ success: false, error: '引擎没接住' })
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    state().send('会失败的一条')
    await settle()

    expect(
      useNotifyStore.getState().items.map((x) => [x.level, x.source, x.body]),
    ).toEqual([['error', 'chat.send', '引擎没接住']])
    // 那一格仍然是 failed —— 通知是**加**了一处,不是把重试条换掉了
    expect(state().overlay[0]).toMatchObject({ status: 'failed', error: '引擎没接住' })
  })

  it('本地提示进 overlay 车道,账本上永远没有它', async () => {
    const h = harness([created(1)])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    state().notice('ask-rejected')
    h.emitLedger(userMessage(2, 'm1', '别的话'))
    await settle()

    expect(state().overlay).toHaveLength(1)
    expect(state().overlay[0]).toMatchObject({ kind: 'notice', notice: 'ask-rejected' })
  })

  it('换会话把 overlay 清空 —— 那几条属于上一条会话的屏幕', async () => {
    const h = harness([created(1)])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    state().send('上一条会话的话')
    expect(state().overlay).toHaveLength(1)

    await state().open('s2')
    await settle()
    expect(state().overlay).toEqual([])
  })
})

describe('停止:忙判据只有一个产地,发出去之后壳不动屏幕', () => {
  /** 起底 + 开一轮 run —— 「引擎在跑」在账本上就是 run/start 立了牌。 */
  async function busySession() {
    const h = harness([created(1), userMessage(2, 'm1', '跑一个')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    h.emitLedger(runStart(3, 'r1', 'a1'))
    await settle()
    return h
  }

  it('run/start 立牌即忙,run/end 撤牌即闲', async () => {
    const h = await busySession()
    expect(selectEngineBusy(state())).toBe(true)

    h.emitLedger(runEnd(4, 'r1'))
    await settle()
    expect(selectEngineBusy(state())).toBe(false)
  })

  it('没在跑时按停止 = 恒等:一发打空的 abort 都不许上账本', async () => {
    const h = harness([created(1)])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    state().abort()
    await settle()
    expect(h.aborted).toEqual([])
  })

  it('在跑时按停止 → 命令带着这条会话的 id 发出去', async () => {
    const h = await busySession()
    state().abort()
    await settle()

    expect(h.aborted).toEqual([SESSION])
  })

  it('壳不做乐观收尾:命令发出去之后那棵树与那格 activeMessageId 一动不动', async () => {
    const h = await busySession()
    const before = ids()
    state().abort()
    await settle()

    expect(ids()).toEqual(before)
    expect(selectEngineBusy(state())).toBe(true)
    // 收尾归账本:run/end 一到,忙态才落下。
    h.emitLedger(runEnd(4, 'r1'))
    await settle()
    expect(selectEngineBusy(state())).toBe(false)
  })

  it('命令发不出去 = error 档(它不自动飘走,人回头还看得见)', async () => {
    const h = await busySession()
    h.abortResult = async () => ({ success: false, error: '引擎没接住' })
    useNotifyStore.getState().clear()

    state().abort()
    await settle()

    const record = useNotifyStore.getState().items.find((r) => r.source === 'chat.abort')
    expect(record?.level).toBe('error')
    expect(record?.body).toBe('引擎没接住')
  })

  it('过了宽限还没收尾 → 只说一句 warn,**不重发**', async () => {
    const h = await busySession()
    useNotifyStore.getState().clear()
    state().abort()
    await settle()
    expect(useNotifyStore.getState().items).toHaveLength(0)

    await new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_MS + 20))

    const record = useNotifyStore.getState().items.find((r) => r.source === 'chat.abort')
    expect(record?.level).toBe('warn')
    expect(h.aborted).toEqual([SESSION])
  })

  it('宽限内收尾了就一声不吭', async () => {
    const h = await busySession()
    useNotifyStore.getState().clear()
    state().abort()
    await settle()
    h.emitLedger(runEnd(4, 'r1'))
    await settle()

    await new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_MS + 20))
    expect(useNotifyStore.getState().items).toEqual([])
  })
})
