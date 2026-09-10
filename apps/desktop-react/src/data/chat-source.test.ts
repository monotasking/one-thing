import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import type { SessionStreamPayload } from '@shared/events/envelope'
import type { PermissionInfo } from '@shared/ipc/permissions'
import { configureChatPort, type ChatPort } from './chat-port'
import { useNotifyStore } from '../services/notify-store'
import {
  ABORT_SETTLE_MS,
  chatSources,
  CHAT_SOURCE_DOCK_LIMIT,
  REFOLD_THROTTLE_MS,
  RETRY_SETTLE_MS,
  selectEngineBusy,
  useChatSource,
} from './chat-source'
import { t } from '../i18n'

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
/**
 * R2:一条**盖过章**的裸 delta(R1 的身份章)。
 *
 * 新路只认盖过章的 delta —— 没章的那种是「没走过引擎铸章机」的旁路正文,
 * 由账本负责(见 `chat-source` 的 onStream)。测试因此照真机的样子盖章。
 */
const stamped = (
  messageId: string,
  charOffset: number,
  text: string,
  over: { partIndex?: number; kind?: 'text' | 'reasoning'; placement?: 'top' | 'inline' } = {},
) => ({
  type: over.kind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
  ...(over.kind === 'reasoning' ? { reasoning: text } : { text }),
  messageId,
  ...(over.placement ? { placement: over.placement } : {}),
  stamp: {
    messageId,
    runId: 'r1',
    requestIndex: 0,
    partIndex: over.partIndex ?? 0,
    kind: over.kind ?? 'text',
    charOffset,
    gen: 0,
  },
})

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
  /** `permission.getPending` 交回去的那一份(对账口的夹具)。 */
  pending: PermissionInfo[]
  /** 对账口被问过几次 —— 「起底之后对一次账」靠它钉。 */
  pendingCalls: number
  /** 端口收到的每一次应答的载荷。**「无新字段」那条反证读的就是它。** */
  responded: { toolCallId: string; decision: string }[]
  respondResult: () => Promise<{ success: boolean; error?: string }>
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
    pending: [],
    pendingCalls: 0,
    responded: [],
    respondResult: async () => ({ success: true }),
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
      listPendingPermissions: async () => {
        h.pendingCalls += 1
        return { success: true, pending: [...h.pending] }
      },
      respondPermission: async (_sessionId, toolCallId, decision) => {
        h.responded.push({ toolCallId, decision })
        return h.respondResult()
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

/**
 * R2:这一组的名字从「活尾巴」改成「活水位」—— 机器换了,**要证的事一个字没变**:
 * 裸 delta 当场上屏、打包行到达不重影不回缩、收尾之后由账本接管。
 * 新路的实现是「每 part 取 max(账本可画长, 活水位)」,所以这几条从结构上恒成立;
 * 用例留着,是因为「结构上恒成立」这句话也得有人替屏幕验一次。
 */
describe('活水位:平滑上屏,打包行一到就清格', () => {
  it('裸 delta 当场追加到正文上(不等 2s 的打包行)', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 0, '好') as never })
    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 1, '的') as never })
    await settle()

    expect(state().messages.find((message) => message.id === 'a1')?.content).toBe('好的')
  })

  it('打包行一到,它那一截离开尾巴 —— 不重影', async () => {
    const h = harness([created(1), userMessage(2, 'm1', '你好'), runStart(3, 'r1', 'a1')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 0, '好的') as never })
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

    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 0, '好的') as never })
    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 2, ',继续') as never })
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

    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 0, '半句') as never })
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

/**
 * 重试:两道闸 + 三条清闩路(2026-09-08 事故 ef079fd7)。
 *
 * 事故的形状:一条请求 129 秒零回包,用户连点十几下重试,每一下 core 都答
 * `success`,引擎只回一条 `stream:error` —— 屏幕上零反馈。所以这里钉的是
 * 「什么时候一个字节都不发」与「发出去之后那格闩怎么落、怎么清」。
 */
describe('重试:两道闸与三条清闩路', () => {
  /** 一轮跑完了的会话 —— 引擎闲着,重试该走得通。 */
  async function idleSession() {
    const h = harness([
      created(1),
      userMessage(2, 'm1', '你好'),
      runStart(3, 'r1', 'a1'),
      chunks(4, 'r1', 'a1', ['好的']),
      runEnd(5, 'r1'),
    ])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    return h
  }

  /** 一轮**还在跑**的会话(run/start 立着、run/end 没来)。 */
  async function busySession() {
    const h = harness([created(1), userMessage(2, 'm1', '跑一个')])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    h.emitLedger(runStart(3, 'r1', 'a1'))
    await settle()
    return h
  }

  const streamError = (error: string): SessionEventEnvelope => ({
    sessionId: SESSION,
    sequence: 99,
    timestamp: T0,
    event: { type: SESSION_EVENT_TYPES.STREAM_ERROR, data: { error } } as never,
  })

  it('闸 a:引擎在跑 → 一个字节都不发,只说一句 warn', async () => {
    const h = await busySession()
    useNotifyStore.getState().clear()

    expect(state().regenerate('a1')).toBe(false)
    await settle()

    expect(h.retried).toEqual([])
    const record = useNotifyStore.getState().items.find((r) => r.source === 'chat.retry')
    expect(record?.level).toBe('warn')
    expect(record?.title).toBe(t('notify.retryBusy'))
    expect(record?.body).toBe(t('notify.retryBusyHint'))
  })

  it('闸 b:上一条还没见回音 → 第二下返回 false,命令只发出去一次且不再飞通知', async () => {
    const h = await idleSession()
    expect(state().regenerate('a1')).toBe(true)
    await settle()
    expect(state().retryPending?.messageId).toBe('a1')
    useNotifyStore.getState().clear()

    expect(state().regenerate('a1')).toBe(false)
    await settle()

    expect(h.retried).toEqual(['a1'])
    // 钮那边已经禁灰了,这道闸只挡命令 —— 再飞一条 toast 就是噪音。
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('清闩路 ①:账本开了新一轮(活牌从无到有)→ 闩当场清掉', async () => {
    const h = await idleSession()
    state().regenerate('a1')
    await settle()
    expect(state().retryPending).toBeDefined()

    h.emitLedger(runStart(6, 'r2', 'a2'))
    await settle()

    expect(selectEngineBusy(state())).toBe(true)
    expect(state().retryPending).toBeUndefined()
  })

  it('清闩路 ②:闩在时收到 stream:error → 那条就是回音,error 档带上引擎那句话', async () => {
    const h = await idleSession()
    state().regenerate('a1')
    await settle()
    useNotifyStore.getState().clear()

    h.emitEvent(streamError('Message not found'))
    await settle()

    expect(state().retryPending).toBeUndefined()
    const record = useNotifyStore.getState().items.find((r) => r.source === 'chat.retry')
    expect(record?.level).toBe('error')
    expect(record?.title).toBe(t('notify.retryRejected'))
    expect(record?.body).toBe('Message not found')

    // 回音已经到了,那只保险丝不许再响一次。
    useNotifyStore.getState().clear()
    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_MS + 20))
    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('闩不在时的 stream:error 一字不改:不飞通知(账本上那条 run 自己会说)', async () => {
    const h = await idleSession()
    useNotifyStore.getState().clear()

    h.emitEvent(streamError('provider 超时'))
    await settle()

    expect(useNotifyStore.getState().items).toEqual([])
  })

  it('清闩路 ③:过了宽限两条回音都没来 → 清闩 + 一句 warn,**不重发**', async () => {
    const h = await idleSession()
    state().regenerate('a1')
    await settle()
    useNotifyStore.getState().clear()
    expect(useNotifyStore.getState().items).toEqual([])

    await new Promise((resolve) => setTimeout(resolve, RETRY_SETTLE_MS + 20))

    expect(state().retryPending).toBeUndefined()
    const record = useNotifyStore.getState().items.find((r) => r.source === 'chat.retry')
    expect(record?.level).toBe('warn')
    expect(record?.title).toBe(t('notify.retryStuck'))
    expect(record?.body).toBe(t('notify.retryStuckHint'))
    // 只说不做:超时不许再送一条命令上账本。
    expect(h.retried).toEqual(['a1'])
  })

  it('闩清掉之后重试重新走得通(闸 b 不是一次性的门)', async () => {
    const h = await idleSession()
    state().regenerate('a1')
    await settle()
    h.emitEvent(streamError('Message not found'))
    await settle()

    expect(state().regenerate('a1')).toBe(true)
    await settle()
    expect(h.retried).toEqual(['a1', 'a1'])
  })
})


/**
 * C2-b:**工具进度活流**在两条车道之前分流。
 *
 * 要证的只有一件事:一条 `tool-progress` chunk 从推送口进来,最后盖在**账本那次
 * 调用**上(而不是新画一张卡、也不是被 messageId 闸 / R2 的身份章闸吃掉)。
 */
describe('工具进度活流(C2-b)', () => {
  const partEnd = (seq: number, runId: string, messageId: string, callId: string): Ledger => ({
    seq,
    time: T0,
    type: 'assistant/part-end',
    data: {
      runId,
      requestIndex: 0,
      messageId,
      partIndex: 0,
      kind: 'tool-input',
      toolCallId: callId,
      toolName: 'bash',
      len: 22,
      hash: 'h',
    },
  })

  const toolCall = (seq: number, runId: string, messageId: string, callId: string): Ledger => ({
    seq,
    time: T0,
    type: 'tool/call',
    data: { callId, name: 'bash', argumentsRaw: '{"command":"seq 1 20"}', messageId, runId },
  })

  const callOf = (messageId: string) =>
    (state().messages.find(m => m.id === messageId)?.toolCalls ?? [])[0] as
      | { id: string; progress?: { outputTail?: string; ratio?: number } }
      | undefined

  const ledger = (): Ledger[] => [
    created(1),
    userMessage(2, 'm1', '跑一下'),
    runStart(3, 'r1', 'a1'),
    partEnd(4, 'r1', 'a1', 'c1'),
    toolCall(5, 'r1', 'a1', 'c1'),
  ]

  it('一条进度盖到账本那次调用上(**不带身份章**也照样收 —— 它不是正文)', async () => {
    const h = harness(ledger())
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({
      sessionId: SESSION,
      chunk: {
        type: 'tool-progress',
        toolCallId: 'c1',
        messageId: 'a1',
        outputTail: '18\n19\n20',
        ratio: 0.95,
      } as never,
    })
    await settle()

    expect(callOf('a1')?.progress).toEqual({ outputTail: '18\n19\n20', ratio: 0.95 })
  })

  it('快照:后一条整条替换前一条', async () => {
    const h = harness(ledger())
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    for (const tail of ['1\n2', '9\n10', '19\n20']) {
      h.emitStream({
        sessionId: SESSION,
        chunk: { type: 'tool-progress', toolCallId: 'c1', messageId: 'a1', outputTail: tail } as never,
      })
    }
    await settle()
    expect(callOf('a1')?.progress?.outputTail).toBe('19\n20')
  })

  it('没有 messageId 的一条被闸吃掉(合批器直送那一支负责盖上它)', async () => {
    const h = harness(ledger())
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({
      sessionId: SESSION,
      chunk: { type: 'tool-progress', toolCallId: 'c1', outputTail: 'x' } as never,
    })
    await settle()
    expect(callOf('a1')?.progress).toBeUndefined()
  })

  it('这一轮收尾:进度随尾巴 / 水位一起丢(重开会话只见结局)', async () => {
    const h = harness(ledger())
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()

    h.emitStream({
      sessionId: SESSION,
      chunk: { type: 'tool-progress', toolCallId: 'c1', messageId: 'a1', outputTail: '20' } as never,
    })
    await settle()
    expect(callOf('a1')?.progress?.outputTail).toBe('20')

    h.emitEvent({
      sessionId: SESSION,
      sequence: 9,
      timestamp: T0,
      event: { type: SESSION_EVENT_TYPES.STREAM_COMPLETE, messageId: 'a1', data: {} } as never,
    })
    await settle()
    expect(callOf('a1')?.progress).toBeUndefined()
  })
})

/**
 * **活性与「模型又吐了一段」是两格事实**(2026-09-09 用户裁定:工具进度计入活性)。
 *
 * 事故:真店 fe5261d9 那一轮模型不到 1 秒就发了工具调用,bash 跑了 7 秒、卡片一直
 * 在刷输出,读数行却说「已 7.0s 没有新内容」—— 活性只认三种文字 delta。
 *
 * 这一组钉的正是分家之后的三件事:工具那几类事实推得动 `lastActivityAt`、推不动
 * `lastDeltaAt`;不属于活 run 的账本行两格都推不动。
 */
describe('活性读数:工具进度算活着,但不算「模型又吐了一段」', () => {
  const toolCall = (seq: number, runId: string, messageId: string, callId: string): Ledger => ({
    seq,
    time: T0,
    type: 'tool/call',
    data: { callId, name: 'bash', argumentsRaw: '{"command":"seq 1 20"}', messageId, runId },
  })

  const annotate = (seq: number, runId: string, callId: string): Ledger => ({
    seq,
    time: T0,
    type: 'tool/annotate',
    // **只有 callId + runId,没有 messageId** —— 这正是活性的判据必须用 runId 的原因。
    data: { callId, runId, title: '跑着' },
  })

  /** 一轮**还在跑**的对话:run/start 有、run/end 没有,所以 `activeRun` 立着。 */
  const ledger = (): Ledger[] => [
    created(1),
    userMessage(2, 'm1', '跑一下'),
    runStart(3, 'r1', 'a1'),
    toolCall(4, 'r1', 'a1', 'c1'),
  ]

  /**
   * 墙钟由我们说了算 —— 两格记的都是 `Date.now()`,真跑的话同一毫秒里两次调用会
   * 记出相同的数,「推动了没有」就断不出来。只 stub `Date.now`:`settle()` 那 20ms
   * 走的是真的 setTimeout,不受影响。
   */
  let clock = T0
  const tick = (ms: number) => {
    clock += ms
  }

  beforeEach(() => {
    clock = T0
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 先喂一条裸 delta,把 `lastDeltaAt` 立起来(否则「没被推动」无从断起)。 */
  async function withFirstDelta(h: Harness) {
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 0, '好') as never })
    await settle()
    const at = state().lastDeltaAt
    expect(at).toBe(T0)
    return at as number
  }

  it('工具进度到了:活性推到此刻,而「吐字」那一格一动不动', async () => {
    const h = harness(ledger())
    const deltaAt = await withFirstDelta(h)

    tick(7_000)
    h.emitStream({
      sessionId: SESSION,
      chunk: { type: 'tool-progress', toolCallId: 'c1', messageId: 'a1', outputTail: '19\n20' } as never,
    })
    await settle()

    expect(state().lastActivityAt).toBe(deltaAt + 7_000)
    expect(state().lastDeltaAt).toBe(deltaAt)
  })

  it('账本 `tool/annotate`(活 run):同上 —— 它只带 callId + runId,按 messageId 认会整类漏掉', async () => {
    const h = harness(ledger())
    const deltaAt = await withFirstDelta(h)

    tick(3_000)
    h.emitLedger(annotate(5, 'r1', 'c1'))
    await settle()

    expect(state().lastActivityAt).toBe(deltaAt + 3_000)
    expect(state().lastDeltaAt).toBe(deltaAt)
  })

  it('不是活 run 的那一条账本行:两格都不动(别人那一轮的回声不算这一轮活着)', async () => {
    const h = harness(ledger())
    const deltaAt = await withFirstDelta(h)

    tick(3_000)
    h.emitLedger(annotate(5, 'r-other', 'c1'))
    await settle()

    expect(state().lastActivityAt).toBe(deltaAt)
    expect(state().lastDeltaAt).toBe(deltaAt)
  })

  it('`tool:input-start` 也算活着(它比账本上的 tool/call 早几百毫秒)', async () => {
    const h = harness(ledger())
    const deltaAt = await withFirstDelta(h)

    tick(500)
    h.emitEvent({
      sessionId: SESSION,
      sequence: 5,
      timestamp: T0,
      event: {
        type: SESSION_EVENT_TYPES.TOOL_INPUT_START,
        messageId: 'a1',
        toolCallId: 'c2',
        toolName: 'bash',
      } as never,
    })
    await settle()

    expect(state().lastActivityAt).toBe(deltaAt + 500)
    expect(state().lastDeltaAt).toBe(deltaAt)
  })

  it('裸 delta 两格一起推(它既是 delta 也是一次活动)', async () => {
    const h = harness(ledger())
    const deltaAt = await withFirstDelta(h)

    tick(1_000)
    h.emitStream({ sessionId: SESSION, chunk: stamped('a1', 1, '的') as never })
    await settle()

    expect(state().lastDeltaAt).toBe(deltaAt + 1_000)
    expect(state().lastActivityAt).toBe(deltaAt + 1_000)
  })
})

/**
 * **W5-a:一条会话一台机器 + 一张注册表。**
 *
 * 上面那一整篇钉的是「一台机器折得对不对」;这一组钉的是**多台同时活着**时那三件
 * 从前不存在的事:分发给谁、活多久、哪些数是各数各的。
 *
 * 为什么它们值得单独一组:W5-a 之前这只文件是模块级单例,两处
 * `envelope.sessionId !== get().sessionId` 的过滤就是「只能有一条」这件事在代码里的
 * 形状 —— 把过滤删掉而分发没接上,屏幕上就是 A 的字画到 B 的回复里。
 */
describe('多开:一条会话一台机器,注册表按会话分发', () => {
  const A = 'multi-a'
  const B = 'multi-b'

  const createdIn = (seq: number, sessionId: string): Ledger => ({
    seq,
    time: T0,
    type: 'session/created',
    data: { sessionId },
  })

  interface MultiHarness {
    port: ChatPort
    /** 此刻挂着几对推送订阅 —— 「全进程只有一对」与「退订退干净了」都靠它。 */
    subs: () => number
    /**
     * 这条会话被拉过几次全量账本。**「不重载」这条法只能靠数它** ——
     * 量时间会把一台慢机器判成回归、把一次真重载判成通过(检索面分页那条
     * 「反证要数指令次数不量位移」的同一条纪律)。
     */
    loads: (sessionId: string) => number
    emitLedger(sessionId: string, record: Ledger): void
    emitStream(payload: SessionStreamPayload): void
  }

  /** 两条会话共用**一条**推送面(真机上就是同一条 SSE),分发归注册表。 */
  function multiHarness(ledgers: Record<string, Ledger[]>): MultiHarness {
    const eventSubs: ((envelope: SessionEventEnvelope) => void)[] = []
    const streamSubs: ((payload: SessionStreamPayload) => void)[] = []
    const loadCounts = new Map<string, number>()
    return {
      subs: () => eventSubs.length + streamSubs.length,
      loads: (sessionId) => loadCounts.get(sessionId) ?? 0,
      port: {
        ready: async () => undefined,
        listRaw: async (sessionId) => {
          loadCounts.set(sessionId, (loadCounts.get(sessionId) ?? 0) + 1)
          return { events: [...(ledgers[sessionId] ?? [])] as never }
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
        sendMessage: async () => ({ success: true }),
        listPendingPermissions: async () => ({ success: true, pending: [] }),
        respondPermission: async () => ({ success: true }),
        abort: async () => ({ success: true }),
        retryMessage: async () => ({ success: true }),
      },
      emitLedger: (sessionId, record) =>
        eventSubs.forEach((fn) =>
          fn({
            sessionId,
            sequence: record.seq,
            timestamp: T0,
            event: { type: SESSION_EVENT_TYPES.SESSION_LEDGER_EVENT, record } as never,
          }),
        ),
      emitStream: (payload) => streamSubs.forEach((fn) => fn(payload)),
    }
  }

  const bothOpen = async (h: MultiHarness) => {
    configureChatPort(h.port)
    chatSources.acquire(A)
    chatSources.acquire(B)
    await settle()
  }

  const contentOf = (sessionId: string, messageId: string) =>
    chatSources.get(sessionId)?.getState().messages.find((message) => message.id === messageId)
      ?.content

  it('两台同时收流:A 的 delta 只进 A 的折,B 那棵树一个字都不动', async () => {
    const h = multiHarness({
      [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问'), runStart(3, 'r1', 'a1')],
      [B]: [createdIn(1, B), userMessage(2, 'ub', '乙问'), runStart(3, 'r1', 'b1')],
    })
    await bothOpen(h)
    expect(chatSources.get(A)!.getState().status).toBe('ready')
    expect(chatSources.get(B)!.getState().status).toBe('ready')

    h.emitStream({ sessionId: A, chunk: stamped('a1', 0, '甲答') as never })
    h.emitStream({ sessionId: B, chunk: stamped('b1', 0, '乙答') as never })
    // 账本活事件同理:两条会话共用一条推送面,seq 各数各的。
    h.emitLedger(A, userMessage(4, 'ua2', '甲再问'))
    await settle()

    expect(contentOf(A, 'a1')).toBe('甲答')
    expect(contentOf(B, 'b1')).toBe('乙答')
    // 反面:任何一边都没有对面的字(过滤删掉而分发没接上就是这里红)。
    expect(contentOf(A, 'b1')).toBeUndefined()
    expect(contentOf(B, 'a1')).toBeUndefined()
    const idsOf = (sessionId: string) =>
      chatSources.get(sessionId)!.getState().messages.map((message) => message.id)
    expect(idsOf(A)).toEqual(['ua', 'a1', 'ua2'])
    expect(idsOf(B)).toEqual(['ub', 'b1'])
  })

  it('推送订阅全进程只有一对 —— 第二台机器不再退订重订', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A)], [B]: [createdIn(1, B)] })
    await bothOpen(h)
    // 事件一条、流一条,不多不少;从前每次 open 都退一对订一对。
    expect(h.subs()).toBe(2)
  })

  /**
   * **C1 · §5.1 的第一条**:归零之后那台机器**不拆**,进停靠池。
   *
   * 本批之前这只用例的名字是「归还到零:那台机器拆掉,注册表不再把事件分发给
   * 它」——它钉的正是用户报的那条病(「切走再切回来还要 load」)的机制。
   * 现在钉反过来的那一句:离册了,但还活着、还在收件人表上。
   */
  it('归还到零:那台机器进停靠池 —— 不拆,而且照样收流', async () => {
    const h = multiHarness({
      [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问'), runStart(3, 'r1', 'a1')],
      [B]: [createdIn(1, B), userMessage(2, 'ub', '乙问'), runStart(3, 'r1', 'b1')],
    })
    await bothOpen(h)
    expect(chatSources.ownedIds()).toContain(A)

    chatSources.release(A)
    // 收走排在下一拍(微任务)——「同一次提交里先卸后挂」在那之前就把引用加回来了。
    expect(chatSources.dockedIds()).not.toContain(A)
    await Promise.resolve()
    // 离册了(没人持有),但**停在池里活着**。
    expect(chatSources.ownedIds()).not.toContain(A)
    expect(chatSources.dockedIds()).toContain(A)
    expect(chatSources.get(A)).toBeDefined()

    // 停靠期间内容仍旧跟着核心走 —— 这正是「切回来的那一帧就是最新的」的前提。
    h.emitStream({ sessionId: A, chunk: stamped('a1', 0, '甲答') as never })
    h.emitStream({ sessionId: B, chunk: stamped('b1', 0, '乙答') as never })
    await settle()
    expect(contentOf(A, 'a1')).toBe('甲答')
    expect(contentOf(B, 'b1')).toBe('乙答')
  })

  /**
   * **反证 ①(拆掉停靠池即红)**:切走再切回来,`listRaw` **一发都不许多打**。
   *
   * 数的是请求次数,不是时间 —— 判据见 `MultiHarness.loads` 上的注。
   */
  it('切走再切回:命中停靠池,一发 listRaw 都不打', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问')] })
    configureChatPort(h.port)
    const first = chatSources.acquire(A)
    await settle()
    expect(h.loads(A)).toBe(1)

    // 切走:这片叶换掉了会话 ref,引用归零。
    chatSources.release(A)
    await Promise.resolve()
    expect(chatSources.dockedIds()).toContain(A)

    // 切回来:同一台机器回到在册那一头,起底那一句撞上 `if (fold) return`。
    const again = chatSources.acquire(A)
    await settle()
    expect(again).toBe(first)
    expect(h.loads(A)).toBe(1)
    expect(chatSources.dockedIds()).not.toContain(A)
    // 树也还是原来那棵(不是重新折出来的一棵一模一样的)。
    expect(again.getState().messages.map((message) => message.id)).toEqual(['ua'])
  })

  /** **上限是真的**:第 9 条停进来,最早停的那条被挤出去并**真的**拆掉。 */
  it('停靠池 LRU:超过上限时挤掉最早停的那一条', async () => {
    const ids = Array.from({ length: CHAT_SOURCE_DOCK_LIMIT + 1 }, (_, i) => `dock-${i}`)
    const h = multiHarness(Object.fromEntries(ids.map((id) => [id, [createdIn(1, id)]])))
    configureChatPort(h.port)
    for (const id of ids) chatSources.acquire(id)
    await settle()

    // 逐条切走 —— 停靠序 = 归还序。
    for (const id of ids) {
      chatSources.release(id)
      await Promise.resolve()
    }
    expect(chatSources.dockedIds()).toHaveLength(CHAT_SOURCE_DOCK_LIMIT)
    // 最早停的那条被挤了;其余原样停着。
    expect(chatSources.dockedIds()).not.toContain(ids[0])
    expect(chatSources.dockedIds()).toEqual(ids.slice(1))

    // 被挤掉的那条**真的**拆了:再取回来要重拉一次账本。
    expect(chatSources.get(ids[0])).toBeUndefined()
    chatSources.acquire(ids[0])
    await settle()
    expect(h.loads(ids[0])).toBe(2)
    // 没被挤的那条相反:取回来一发都不打。
    chatSources.acquire(ids[1])
    await settle()
    expect(h.loads(ids[1])).toBe(1)
  })

  /** **会话没了 → 立刻出池**:一台为已删会话活着的机器是真漏(见 `forget` 头上的注)。 */
  it('会话被摘掉:停靠池里那一台立刻拆掉,在册的那些一格不动', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A)], [B]: [createdIn(1, B)] })
    await bothOpen(h)
    chatSources.release(A)
    await Promise.resolve()
    expect(chatSources.dockedIds()).toContain(A)

    chatSources.forget([A, B])
    expect(chatSources.dockedIds()).not.toContain(A)
    expect(chatSources.get(A)).toBeUndefined()
    // B 还有人持有着 —— 出池那一手不碰在册的,它该由引用账收走。
    expect(chatSources.ownedIds()).toContain(B)
    expect(chatSources.get(B)).toBeDefined()
  })

  it('归还之后同一拍又被取走:机器原样留着,不拆了重建', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问')] })
    configureChatPort(h.port)
    const first = chatSources.acquire(A)
    await settle()

    chatSources.release(A)
    const again = chatSources.acquire(A)
    await Promise.resolve()
    expect(again).toBe(first)
    expect(chatSources.get(A)).toBe(first)
    // 起底也没有重来一次(状态还是那一份)。
    expect(chatSources.get(A)!.getState().messages.map((message) => message.id)).toEqual(['ua'])
  })

  /**
   * 幂等 ≠ 「第二个人立刻拿到一个 resolved 的 promise」。第二个调用者 `await` 的
   * 语义仍然是「等这一次起底办完」—— `expose.newSession` 那条路(建完会话紧接着发
   * 第一句话)就吃这一条:它等的是订阅与起底都落地。
   */
  it('第二个 open 等的是同一次起底,不是一个已经 resolved 的空 promise', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问')] })
    configureChatPort(h.port)
    // 第一次(不等它)—— 与 `acquire` 里那一句 `void source.open()` 同形。
    const source = chatSources.acquire(A)
    expect(source.getState().status).toBe('loading')

    await source.open()
    expect(source.getState().status).toBe('ready')
    expect(source.getState().messages.map((message) => message.id)).toEqual(['ua'])
  })

  it('sentTick 按实例各数各的 —— A 发一条不推 B 的跟随状态机', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A)], [B]: [createdIn(1, B)] })
    await bothOpen(h)

    expect(chatSources.get(A)!.getState().sentTick).toBe(0)
    expect(chatSources.get(B)!.getState().sentTick).toBe(0)

    chatSources.get(A)!.getState().send('甲说一句')
    expect(chatSources.get(A)!.getState().sentTick).toBe(1)
    expect(chatSources.get(B)!.getState().sentTick).toBe(0)

    chatSources.get(B)!.getState().send('乙说一句')
    chatSources.get(B)!.getState().send('乙再说一句')
    expect(chatSources.get(A)!.getState().sentTick).toBe(1)
    expect(chatSources.get(B)!.getState().sentTick).toBe(2)
  })

  it('「当前会话」是一格指针,不是第二台机器', async () => {
    const h = multiHarness({ [A]: [createdIn(1, A)], [B]: [createdIn(1, B)] })
    await bothOpen(h)

    chatSources.setCurrent(A)
    expect(chatSources.currentSessionId()).toBe(A)
    expect(useChatSource.getState().sessionId).toBe(A)
    expect(chatSources.currentSource()).toBe(chatSources.get(A))

    chatSources.setCurrent(B)
    expect(useChatSource.getState().sessionId).toBe(B)
    // 换指针不拆机器:A 还有那片叶的那一份引用。
    expect(chatSources.get(A)).toBeDefined()
  })

  /**
   * **HMR 退役**(CLAUDE.md 施工纪律,09-01 立法 —— 起因正是这只文件:热更之后
   * 旧模块的订阅与推屏环没死,两台折叠器同时活着各自推屏)。
   *
   * 两件事一起钉:①静态 —— 退役那一段确实复用注册表已有的那一口拆卸(不许写第二套);
   * ②语义 —— 那一口真的把表清空并退订(退订退不干净 = 热更后旧模块照收事件)。
   */
  it('HMR 退役复用 resetAll,并且它真的清表 + 退订', async () => {
    const source = readFileSync(resolve(__dirname, 'chat-source.ts'), 'utf8')
    // 读源文本的门先剥注释(同一条纪律:病历文本会让断言自红)。
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/import\.meta\.hot\.dispose\(\(\) => \{\s*chatSources\.resetAll\(\)/)

    const h = multiHarness({ [A]: [createdIn(1, A)], [B]: [createdIn(1, B)] })
    await bothOpen(h)
    expect(chatSources.ownedIds().length).toBeGreaterThanOrEqual(2)
    expect(h.subs()).toBe(2)

    chatSources.resetAll()
    expect(chatSources.ownedIds()).toEqual([])
    // 停靠池也归零 —— 它与在册那张表是同一次拆卸的两半,漏一半就是热更后
    // 旧模块那几台停靠着的机器照收事件(那正是 09-01 立这条法的病形)。
    expect(chatSources.dockedIds()).toEqual([])
    expect(h.subs()).toBe(0)
    expect(chatSources.currentSessionId()).toBe('')
  })
})

/* ── 审批车道(应用级许可 · 壳半边,2026-09-10)──────────────────────────── */

/**
 * 权限卡的**数据那一半**。屏幕那一半在
 * `src/content/permission/__tests__/PermissionCard.test.tsx`。
 *
 * 钉住四件事,每件都有出处:
 *  ① 活事件折进车道(反证 ②:拆掉那一支 → 「卡按 toolCallId 落位」当场红);
 *  ② 起底之后经 `permission.getPending` **对一次账**(重载之后卡还在);
 *  ③ 应答的载荷**逐字**:`{ toolCallId, decision }`,`always` 没有第五个字段;
 *  ④ 答出去之后先置「已答」,由 `permission:settled` 收尾 —— 不由那一发的应答收尾。
 */

const permissionRequest = (over: Record<string, unknown> = {}) => ({
  type: SESSION_EVENT_TYPES.PERMISSION_REQUEST,
  requestId: 'req-1',
  targetChannel: 'ipc',
  toolCallId: 'call-1',
  messageId: 'a1',
  permissionType: 'session_destructive',
  title: 'Remove session content: session:s1',
  pattern: 'session:s1',
  metadata: {},
  alwaysScope: { scheme: 'session' },
  ...over,
})

/** 权限事件骑的是会话事件那条面,不是账本行 —— 所以它自己一个 envelope。 */
const emitPermission = (h: Harness, event: Record<string, unknown>) =>
  h.emitEvent({
    sessionId: SESSION,
    sequence: 0,
    timestamp: T0,
    event: event as never,
  })

const pendingInfo = (over: Partial<PermissionInfo> = {}): PermissionInfo => ({
  id: 'req-1',
  type: 'session_destructive',
  pattern: 'session:s1',
  sessionId: SESSION,
  messageId: 'a1',
  callId: 'call-1',
  title: 'Remove session content: session:s1',
  metadata: {},
  createdAt: T0,
  alwaysScope: { scheme: 'session' },
  ...over,
})

describe('审批车道:活事件就地折,重载经 getPending 对账', () => {
  async function opened(h: Harness) {
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
  }

  it('**反证 ②**:`permission:request` 折进车道,卡按 toolCallId 落位', async () => {
    const h = harness([created(1)])
    await opened(h)
    expect(state().permissions).toEqual({})

    emitPermission(h, permissionRequest())
    await settle()

    const ask = state().permissions['call-1']
    expect(ask).toBeTruthy()
    expect(ask.permissionId).toBe('req-1')
    expect(ask.type).toBe('session_destructive')
    expect(ask.alwaysScope).toEqual({ scheme: 'session' })
    expect(ask.canRespond).toBe(true)
    expect(ask.permissionQueued).toBe(false)
  })

  it('`permission:queued` 画等待态、不给键;后到的 request 顶掉它', async () => {
    const h = harness([created(1)])
    await opened(h)

    emitPermission(h, {
      type: SESSION_EVENT_TYPES.PERMISSION_QUEUED,
      requestId: 'req-0',
      toolCallId: 'call-2',
      messageId: 'a1',
    })
    await settle()
    expect(state().permissions['call-2'].permissionQueued).toBe(true)
    expect(state().permissions['call-2'].canRespond).toBe(false)

    emitPermission(h, permissionRequest({ requestId: 'req-2', toolCallId: 'call-2' }))
    await settle()
    expect(state().permissions['call-2'].permissionQueued).toBe(false)
    expect(state().permissions['call-2'].canRespond).toBe(true)
  })

  it('`permission:settled` 把头卡与被归并的跟随者一起收走', async () => {
    const h = harness([created(1)])
    await opened(h)
    emitPermission(h, permissionRequest())
    emitPermission(h, permissionRequest({ requestId: 'req-2', toolCallId: 'call-2' }))
    await settle()
    expect(Object.keys(state().permissions).sort()).toEqual(['call-1', 'call-2'])

    emitPermission(h, {
      type: SESSION_EVENT_TYPES.PERMISSION_SETTLED,
      requestId: 'req-1',
      toolCallIds: ['call-1', 'call-2'],
      decision: 'allowed',
    })
    await settle()
    expect(state().permissions).toEqual({})
  })

  it('`permission:timeout` 按 requestId 收走', async () => {
    const h = harness([created(1)])
    await opened(h)
    emitPermission(h, permissionRequest())
    await settle()

    emitPermission(h, { type: SESSION_EVENT_TYPES.PERMISSION_TIMEOUT, requestId: 'req-1' })
    await settle()
    expect(state().permissions).toEqual({})
  })

  it('起底之后对一次账 —— 重载(壳错过那条事件)卡照样在', async () => {
    const h = harness([created(1)])
    h.pending = [pendingInfo()]
    await opened(h)

    expect(h.pendingCalls).toBe(1)
    expect(state().permissions['call-1']?.permissionId).toBe('req-1')
  })

  it('对账认得 `promptState: queued`,也丢掉交不出地址的那些', async () => {
    const h = harness([created(1)])
    h.pending = [
      pendingInfo({ promptState: 'queued' }),
      pendingInfo({ id: 'req-9', callId: undefined }),
    ]
    await opened(h)

    expect(Object.keys(state().permissions)).toEqual(['call-1'])
    expect(state().permissions['call-1'].permissionQueued).toBe(true)
    expect(state().permissions['call-1'].canRespond).toBe(false)
  })

  it('对账**拉不到就一格不动**(把「问不到」画成「没有审批」是造事实)', async () => {
    const h = harness([created(1)])
    await opened(h)
    emitPermission(h, permissionRequest())
    await settle()

    h.port.listPendingPermissions = async () => ({ success: false, error: '断了' })
    // 一次缺号 → 重折 → 对账;那一发失败,车道原样。
    h.ledger.push(userMessage(9, 'm9', '缺号'))
    h.emitLedger(userMessage(9, 'm9', '缺号'))
    await new Promise((r) => setTimeout(r, REFOLD_THROTTLE_MS + 60))
    expect(state().permissions['call-1']).toBeTruthy()
  })
})

describe('审批车道:应答', () => {
  async function withCard(h: Harness) {
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    emitPermission(h, permissionRequest())
    await settle()
  }

  it('**载荷逐字**:`{ toolCallId, decision }`,`always` 没有第五个字段', async () => {
    const h = harness([created(1)])
    await withCard(h)

    state().respondPermission('call-1', 'always')
    await settle()

    expect(h.responded).toEqual([{ toolCallId: 'call-1', decision: 'always' }])
  })

  it('答出去之后先置「已答」,连点第二下不再发', async () => {
    const h = harness([created(1)])
    await withCard(h)

    state().respondPermission('call-1', 'once')
    // 同步那一拍就该变 —— 律③的进行中反馈不许等一次往返。
    expect(state().permissions['call-1'].answered).toBe('once')
    expect(state().permissions['call-1'].canRespond).toBe(false)

    state().respondPermission('call-1', 'reject')
    await settle()
    expect(h.responded).toEqual([{ toolCallId: 'call-1', decision: 'once' }])
  })

  it('收尾归 `permission:settled`,不归那一发的应答', async () => {
    const h = harness([created(1)])
    await withCard(h)

    state().respondPermission('call-1', 'session')
    await settle()
    // 命令早就回来了,卡**还在**:核心没说结算,壳不许自己把它抹掉。
    expect(state().permissions['call-1'].answered).toBe('session')

    emitPermission(h, {
      type: SESSION_EVENT_TYPES.PERMISSION_SETTLED,
      requestId: 'req-1',
      toolCallIds: ['call-1'],
      decision: 'allowed',
    })
    await settle()
    expect(state().permissions).toEqual({})
  })

  it('命令没离开壳:那一格退回去,人还能再点一次', async () => {
    const h = harness([created(1)])
    await withCard(h)
    h.respondResult = async () => ({ success: false, error: '断了' })

    state().respondPermission('call-1', 'once')
    await settle()

    expect(state().permissions['call-1'].answered).toBeUndefined()
    expect(state().permissions['call-1'].canRespond).toBe(true)
    expect(useNotifyStore.getState().items.some((item) => item.source === 'chat.permission')).toBe(
      true,
    )
  })

  it('排队中的卡答不动(发一条打空的应答只会在核那头留一句 warn)', async () => {
    const h = harness([created(1)])
    configureChatPort(h.port)
    await state().open(SESSION)
    await settle()
    emitPermission(h, {
      type: SESSION_EVENT_TYPES.PERMISSION_QUEUED,
      requestId: 'req-0',
      toolCallId: 'call-2',
      messageId: 'a1',
    })
    await settle()

    state().respondPermission('call-2', 'once')
    await settle()
    expect(h.responded).toEqual([])
  })
})
