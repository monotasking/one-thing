/**
 * 交互协议内核的行为守卫(claude-code-integration-v2 §4,E1)。
 *
 * 这些测试盯的是四条**不能退化**的纪律,每一条都对应 F3 那次事故的一个断面:
 *   1. 结算不依赖 UI 在场 —— 没有任何应答也要到点收场(那 2 分 11 秒的直接病因);
 *   2. 结算了就得停表 —— 留一只孤儿定时器,回合结束之后还会诈尸发一次 settled;
 *   3. 会话清理必须逐条 settle —— 漏一条,等它的那个回合永远醒不过来;
 *   4. 通道亲和 —— 从别的传输面冒批一次提问,与冒批一次审批一样危险。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  Interaction,
  type InteractionBusEvent,
} from '../index.js'

interface Harness {
  bus: {
    onAnySession: (
      eventType: string,
      handler: (envelope: { sessionId: string; event: unknown }) => void,
      label?: string,
    ) => () => void
    emit: (sessionId: string, event: InteractionBusEvent) => Promise<unknown>
  }
  emitted: Array<{ sessionId: string; event: InteractionBusEvent }>
  /** 把一条命令灌进 registry 订阅的那条通道,模拟 EventBus 的分发。 */
  dispatch: (sessionId: string, event: unknown) => void
}

function createHarness(): Harness {
  const emitted: Array<{ sessionId: string; event: InteractionBusEvent }> = []
  const handlers: Array<(envelope: { sessionId: string; event: unknown }) => void> = []
  return {
    emitted,
    bus: {
      onAnySession: (_eventType, handler) => {
        handlers.push(handler)
        return () => {
          const index = handlers.indexOf(handler)
          if (index !== -1) handlers.splice(index, 1)
        }
      },
      emit: async (sessionId, event) => {
        emitted.push({ sessionId, event })
        return undefined
      },
    },
    dispatch: (sessionId, event) => {
      for (const handler of [...handlers]) handler({ sessionId, event })
    },
  }
}

const SESSION = 'interaction-session'

const QUESTIONS = [
  {
    id: 'q1',
    header: 'Library',
    question: '用哪个日期库?',
    options: [
      { label: 'date-fns', description: '树摇友好' },
      { label: 'dayjs', description: '体积最小' },
    ],
    allowFreeText: true,
  },
]

function askOnce(overrides: Partial<Parameters<typeof Interaction.ask>[0]> = {}) {
  return Interaction.ask({
    sessionId: SESSION,
    origin: 'external-agent',
    questions: QUESTIONS,
    toolCallId: 'call-1',
    ...overrides,
  })
}

let harness: Harness

beforeEach(() => {
  vi.useFakeTimers()
  harness = createHarness()
  Interaction.initialize(harness.bus, () => 'ipc')
})

afterEach(() => {
  Interaction.clearSession(SESSION)
  Interaction.shutdown()
  vi.useRealTimers()
})

describe('Interaction registry', () => {
  it('ask → respond 往返:答案原样回到调用方,并广播 requested/settled 两条事件', async () => {
    const pending = askOnce()

    const requested = harness.emitted.at(0)?.event
    expect(requested?.type).toBe('interaction:requested')
    const request = (requested as Extract<InteractionBusEvent, { type: 'interaction:requested' }>).request
    expect(request.sessionId).toBe(SESSION)
    expect(request.origin).toBe('external-agent')
    expect(request.toolCallId).toBe('call-1')
    expect(request.targetChannel).toBe('ipc')

    const ok = Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['dayjs'], freeText: '体积优先' } },
    })
    expect(ok).toBe(true)

    const answer = await pending
    expect(answer).toEqual({
      id: request.id,
      outcome: 'answered',
      answers: { q1: { selected: ['dayjs'], freeText: '体积优先' } },
    })

    const settled = harness.emitted.at(-1)?.event
    expect(settled?.type).toBe('interaction:settled')
    expect((settled as Extract<InteractionBusEvent, { type: 'interaction:settled' }>).toolCallId)
      .toBe('call-1')
  })

  it('respond 也认 toolCallId(持久相关键,刷新之后 UI 手上只剩它)', async () => {
    const pending = askOnce()
    expect(Interaction.respond({
      sessionId: SESSION,
      toolCallId: 'call-1',
      answers: { q1: { selected: ['date-fns'] } },
    })).toBe(true)
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' })
  })

  it('deadline 到点自结算成 timeout —— 全程没有任何 UI 参与', async () => {
    const pending = askOnce({ timeoutMs: 5_000 })
    expect(Interaction.getPending(SESSION)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)

    const answer = await pending
    expect(answer.outcome).toBe('timeout')
    expect(answer.answers).toEqual({})
    expect(answer.reason).toBeTruthy()
    expect(Interaction.getPending(SESSION)).toHaveLength(0)
    expect(harness.emitted.at(-1)?.event.type).toBe('interaction:settled')
  })

  it('没接 EventBus 也照样到点结算 —— 内核自结算不依赖任何人在听', async () => {
    Interaction.shutdown()
    const pending = Interaction.ask({
      sessionId: SESSION,
      origin: 'host-tool',
      questions: QUESTIONS,
      timeoutMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' })
  })

  it('不给 deadline 也有 deadline —— 落到默认档(原则 4:每一条等待都有 deadline)', async () => {
    const pending = askOnce()
    const request = Interaction.getPending(SESSION)[0]
    expect(request.deadlineAt - request.createdAt).toBe(DEFAULT_INTERACTION_TIMEOUT_MS)

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTION_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' })
  })

  it('respond 之后定时器被取消 —— 不留孤儿表在回合结束后诈尸', async () => {
    const pending = askOnce({ timeoutMs: 5_000 })
    const request = Interaction.getPending(SESSION)[0]
    Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['dayjs'] } },
    })
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' })

    const settledCount = harness.emitted.filter(e => e.event.type === 'interaction:settled').length
    await vi.advanceTimersByTimeAsync(60_000)
    // 表若没停,这里会多出一条 timeout 的 settled。
    expect(harness.emitted.filter(e => e.event.type === 'interaction:settled')).toHaveLength(settledCount)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('decline:用户主动放弃 → declined,带可读理由给模型', async () => {
    const pending = askOnce()
    const request = Interaction.getPending(SESSION)[0]
    expect(Interaction.decline({
      sessionId: SESSION,
      interactionId: request.id,
      reason: 'pair 房里没有人类',
    })).toBe(true)
    await expect(pending).resolves.toMatchObject({
      outcome: 'declined',
      answers: {},
      reason: 'pair 房里没有人类',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearSession:全量 settle 成 aborted,表也一并清干净', async () => {
    const first = askOnce({ toolCallId: 'call-1' })
    const second = askOnce({ toolCallId: 'call-2' })
    expect(Interaction.getPending(SESSION)).toHaveLength(2)

    Interaction.clearSession(SESSION)

    await expect(first).resolves.toMatchObject({ outcome: 'aborted' })
    await expect(second).resolves.toMatchObject({ outcome: 'aborted' })
    expect(Interaction.getPending(SESSION)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearSession 对没见过的会话是 no-op', () => {
    expect(() => Interaction.clearSession('never-existed')).not.toThrow()
  })

  it('通道亲和:ask 记的是 ipc,从 telegram 来的 respond 一律拒收', async () => {
    const pending = askOnce({ timeoutMs: 5_000 })
    const request = Interaction.getPending(SESSION)[0]

    expect(Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['dayjs'] } },
      channel: 'telegram',
    })).toBe(false)
    expect(Interaction.decline({
      sessionId: SESSION,
      interactionId: request.id,
      channel: 'telegram',
    })).toBe(false)
    // 拒收 ≠ 结算:它还挂在那儿等对的通道(或者等 deadline)。
    expect(Interaction.getPending(SESSION)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toMatchObject({ outcome: 'timeout' })
  })

  it('通道亲和:ask 记的是 telegram 时,ipc 的 respond 同样被拒(对称)', async () => {
    Interaction.initialize(harness.bus, () => 'telegram')
    const pending = askOnce({ timeoutMs: 5_000 })
    const request = Interaction.getPending(SESSION)[0]
    expect(request.targetChannel).toBe('telegram')

    expect(Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: {},
    })).toBe(false)
    expect(Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['dayjs'] } },
      channel: 'telegram',
    })).toBe(true)
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' })
  })

  it('重复 respond 幂等:第二次是无害 no-op,不会二次结算', async () => {
    const pending = askOnce()
    const request = Interaction.getPending(SESSION)[0]
    expect(Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['dayjs'] } },
    })).toBe(true)
    expect(Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { q1: { selected: ['date-fns'] } },
    })).toBe(false)
    expect(Interaction.decline({ sessionId: SESSION, interactionId: request.id })).toBe(false)

    await expect(pending).resolves.toMatchObject({
      answers: { q1: { selected: ['dayjs'] } },
    })
    expect(harness.emitted.filter(e => e.event.type === 'interaction:settled')).toHaveLength(1)
  })

  it('答案表整体透传:键名写错不在内核里被悄悄 strip 成空答案', async () => {
    const pending = askOnce()
    const request = Interaction.getPending(SESSION)[0]
    Interaction.respond({
      sessionId: SESSION,
      interactionId: request.id,
      answers: { qq: { selected: ['dayjs'] } },
    })
    await expect(pending).resolves.toMatchObject({
      answers: { qq: { selected: ['dayjs'] } },
    })
  })

  it('getPending 的形状:整份 request(含 deadlineAt / targetChannel),供 UI 补水', () => {
    void askOnce()
    const pending = Interaction.getPending(SESSION)
    expect(pending).toHaveLength(1)
    expect(Object.keys(pending[0]).sort()).toEqual([
      'createdAt',
      'deadlineAt',
      'id',
      // 归位的第二档消息锚。这里**没给**,所以键在但值是 undefined —— UI 补水拿到
      // 整份 request 的形状,少一个键就是少一档归位。
      'messageId',
      'origin',
      'questions',
      'sessionId',
      'targetChannel',
      'toolCallId',
    ])
    expect(Interaction.getPending('some-other-session')).toEqual([])
  })

  it('走统一命令通道的 respond / decline 与直调同一个内核', async () => {
    const answered = askOnce({ toolCallId: 'call-a' })
    harness.dispatch(SESSION, {
      type: 'command:interaction-respond',
      toolCallId: 'call-a',
      answers: { q1: { selected: ['date-fns'] } },
      channel: 'ipc',
    })
    await expect(answered).resolves.toMatchObject({ outcome: 'answered' })

    const declined = askOnce({ toolCallId: 'call-b' })
    harness.dispatch(SESSION, {
      type: 'command:interaction-respond',
      toolCallId: 'call-b',
      decline: true,
      reason: '不想答',
      channel: 'ipc',
    })
    await expect(declined).resolves.toMatchObject({ outcome: 'declined', reason: '不想答' })
  })

  it('重复 initialize 不泄漏旧订阅:一条命令只结算一次', async () => {
    Interaction.initialize(harness.bus, () => 'ipc')
    const pending = askOnce({ toolCallId: 'call-once' })
    harness.dispatch(SESSION, {
      type: 'command:interaction-respond',
      toolCallId: 'call-once',
      answers: {},
      channel: 'ipc',
    })
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' })
    expect(harness.emitted.filter(e => e.event.type === 'interaction:settled')).toHaveLength(1)
  })
})
