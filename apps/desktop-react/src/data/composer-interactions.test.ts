import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InteractionGetPendingResponse, InteractionRequest } from '@shared/ipc/interaction'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { composerStoreFor, resetComposerStore } from '../composer/store'
import { bindComposerInteractions, interactionAnswers } from './composer-interactions'
import type { InteractionPort } from './interaction-port'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); resetComposerStore(); vi.useRealTimers() })
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
const request = (id = 'ask-1', sessionId = 'A'): InteractionRequest => ({
  id, sessionId, toolCallId: `call-${id}`, origin: 'host-tool', createdAt: Date.now(), deadlineAt: Date.now() + 60_000,
  questions: [{ id: 'q1', header: '选择', question: '怎么做？', options: [{ label: '方案 A' }, { label: '方案 B' }], allowFreeText: true }],
})
function harness(initial: InteractionRequest[] = []) {
  let event: ((event: SessionEventEnvelope) => void) | undefined
  let reconnect: (() => void) | undefined
  const port = {
    getPending: vi.fn<InteractionPort['getPending']>().mockResolvedValue({ success: true, pending: initial }),
    respond: vi.fn<InteractionPort['respond']>().mockResolvedValue({ success: true }),
    onEvent: vi.fn((callback: (envelope: SessionEventEnvelope) => void) => { event = callback; return () => { event = undefined } }),
    onReconnect: vi.fn((callback: () => void) => { reconnect = callback; return () => { reconnect = undefined } }),
  }
  const store = composerStoreFor('A')
  const stop = bindComposerInteractions('A', store, port)
  cleanups.push(stop)
  return { port, store, stop, reconnect: () => reconnect?.(),
    emit: (value: unknown, sessionId = 'A') => event?.({ sessionId, event: value } as SessionEventEnvelope),
    requested: (req: InteractionRequest) => event?.({ sessionId: req.sessionId, event: { type: 'interaction:requested', request: req } } as SessionEventEnvelope),
  }
}

describe('ask_user 与真实交互协议连接', () => {
  it('冷载恢复待答问题,逐题 ID 回答原工具,然后关闭', async () => {
    const req = request()
    const h = harness([req])
    await flush()
    expect(h.store.getState().mode).toBe('ask')
    h.store.getState().answerAsk(1)
    await h.store.getState().submitAsk([])
    expect(h.port.respond).toHaveBeenCalledExactlyOnceWith({ sessionId: 'A', interactionId: 'ask-1', toolCallId: 'call-ask-1', answers: { q1: { selected: ['方案 B'] } } })
    expect(h.store.getState().mode).toBe('write')
  })

  it('同名标题不串答案,保留多选与自由文本结构', () => {
    const req = request()
    req.questions = [
      { ...req.questions[0], id: 'single' },
      { ...req.questions[0], id: 'multi', multiSelect: true },
      { ...req.questions[0], id: 'free', options: [] },
    ]
    expect(interactionAnswers(req, ['方案 B', [0, 1], '我的方案'])).toEqual({
      single: { selected: ['方案 B'] }, multi: { selected: ['方案 A', '方案 B'] }, free: { selected: [], freeText: '我的方案' },
    })
  })

  it('只接受本会话请求;拒绝通过 decline 返回原请求,下一题排队呈现', async () => {
    const h = harness()
    await flush()
    h.requested(request('foreign', 'B'))
    expect(h.store.getState().askSpec).toBeNull()
    h.requested(request())
    h.requested(request('ask-2'))
    await h.store.getState().rejectAsk()
    expect(h.port.respond).toHaveBeenCalledExactlyOnceWith({ sessionId: 'A', interactionId: 'ask-1', toolCallId: 'call-ask-1', decline: true })
    expect(h.store.getState().askSpec?.interaction?.id).toBe('ask-2')
  })

  it('提交防连点,失败保留选择,可以重试', async () => {
    const h = harness([request()])
    await flush()
    let reject!: (error: Error) => void
    h.port.respond.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    h.store.getState().answerAsk(0)
    const sending = h.store.getState().submitAsk([])
    h.store.getState().submitAsk([])
    h.store.getState().rejectAsk()
    expect(h.port.respond).toHaveBeenCalledTimes(1)
    reject(new Error('网络暂时不可用'))
    await sending
    expect(h.store.getState().askAnswers).toEqual(['方案 A'])
    expect(h.store.getState().askError).toBe('网络暂时不可用')
    expect(h.store.getState().askSubmitting).toBe(false)
    await h.store.getState().submitAsk([])
    expect(h.store.getState().askSpec).toBeNull()
  })

  it('停止/其他窗口应答使请求结算,旧提交完成不得关闭下一份表单', async () => {
    const h = harness([request()])
    await flush()
    let finish!: (value: { success: boolean }) => void
    h.port.respond.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    h.store.getState().answerAsk(0)
    const sending = h.store.getState().submitAsk([])
    h.emit({ type: 'interaction:settled', answer: { id: 'ask-1', outcome: 'aborted', answers: {} } })
    expect(h.store.getState().askSpec).toBeNull()
    h.requested(request('ask-2'))
    finish({ success: true })
    await sending
    expect(h.store.getState().askSpec?.interaction?.id).toBe('ask-2')
  })

  it('旧 getPending 不能复活已结算问题,也不能吞掉查询期间的新问题', async () => {
    const h = harness()
    await flush()
    let finish!: (value: InteractionGetPendingResponse) => void
    h.port.getPending.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    h.reconnect()
    h.requested(request())
    h.emit({ type: 'interaction:settled', answer: { id: 'ask-1', outcome: 'aborted', answers: {} } })
    h.requested(request('ask-2'))
    finish({ success: true, pending: [request()] })
    await flush()
    expect(h.store.getState().askSpec?.interaction?.id).toBe('ask-2')
  })

  it('重连恢复漏收的问题,同一个请求保留草稿;失效请求被清除', async () => {
    const h = harness()
    await flush()
    h.port.getPending.mockResolvedValue({ success: true, pending: [request()] })
    h.reconnect()
    await flush()
    h.store.getState().setAskCustom('还没提交')
    h.reconnect()
    await flush()
    expect(h.store.getState().askAnswers).toEqual(['还没提交'])
    h.port.getPending.mockResolvedValue({ success: true, pending: [] })
    h.reconnect()
    await flush()
    expect(h.store.getState().askSpec).toBeNull()
  })

  it('超时关闭,卸载取消订阅且迟到查询不再更新组件', async () => {
    vi.useFakeTimers()
    const h = harness([request()])
    await flush()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(h.store.getState().askSpec).toBeNull()
    let finish!: (value: InteractionGetPendingResponse) => void
    h.port.getPending.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    h.reconnect()
    h.stop()
    finish({ success: true, pending: [request('late')] })
    await flush()
    h.requested(request('after-unmount'))
    expect(h.store.getState().askSpec).toBeNull()
  })
})
