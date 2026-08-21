/**
 * 装配层薄封装的守卫(claude-code-integration-v2 §4,E1)。
 *
 * 两件事在这里被钉住:
 *   1. `{success, …}` 信封由这一层统一给,宿主不各写各的 try/catch;
 *   2. **通道由宿主盖**,不从请求体里读 —— 让应答方自报通道,通道亲和那道闸就白设了。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Interaction } from '@onething/core/interaction'
import {
  getPendingInteractionsForIpc,
  respondInteractionForIpc,
} from '../ipc-operations.wiring.js'

const SESSION = 'app-interaction-session'

const BUS = {
  onAnySession: () => () => {},
  emit: async () => undefined,
}

const QUESTIONS = [
  {
    id: 'q1',
    question: '继续吗?',
    options: [{ label: '继续' }, { label: '停下' }],
  },
]

beforeEach(() => {
  Interaction.initialize(BUS, () => 'ipc')
})

afterEach(() => {
  Interaction.clearSession(SESSION)
  Interaction.shutdown()
})

describe('interaction 装配层 IPC 封装', () => {
  it('getPending 走 {success, pending} 信封', () => {
    void Interaction.ask({ sessionId: SESSION, origin: 'host-tool', questions: QUESTIONS })
    const response = getPendingInteractionsForIpc(SESSION)
    expect(response.success).toBe(true)
    expect(response.pending).toHaveLength(1)
    expect(response.pending?.[0].sessionId).toBe(SESSION)
    expect(getPendingInteractionsForIpc('never-existed')).toEqual({ success: true, pending: [] })
  })

  it('respond 结算 pending,答案原样落到调用方', async () => {
    const pending = Interaction.ask({
      sessionId: SESSION,
      origin: 'external-agent',
      questions: QUESTIONS,
      toolCallId: 'call-1',
    })
    expect(respondInteractionForIpc({
      sessionId: SESSION,
      toolCallId: 'call-1',
      answers: { q1: { selected: ['继续'] } },
    })).toEqual({ success: true })
    await expect(pending).resolves.toMatchObject({
      outcome: 'answered',
      answers: { q1: { selected: ['继续'] } },
    })
  })

  it('decline: true 走 declined,而不是空答案的 answered', async () => {
    const pending = Interaction.ask({
      sessionId: SESSION,
      origin: 'external-agent',
      questions: QUESTIONS,
      toolCallId: 'call-2',
    })
    expect(respondInteractionForIpc({
      sessionId: SESSION,
      toolCallId: 'call-2',
      decline: true,
      reason: '用户跳过',
    })).toEqual({ success: true })
    await expect(pending).resolves.toMatchObject({ outcome: 'declined', reason: '用户跳过' })
  })

  it('已结算的提问再收到一次应答:是常态不是错误,不炸红', () => {
    const result = respondInteractionForIpc({ sessionId: SESSION, toolCallId: 'gone', answers: {} })
    expect(result.success).toBe(false)
    expect(result.error).toContain('No pending interaction')
  })

  it('通道由宿主盖:错的通道进不来', async () => {
    Interaction.initialize(BUS, () => 'telegram')
    const pending = Interaction.ask({
      sessionId: SESSION,
      origin: 'external-agent',
      questions: QUESTIONS,
      toolCallId: 'call-3',
      timeoutMs: 60_000,
    })
    // desktop 宿主盖的是 'ipc',而这条 ask 记的是 'telegram' → 拒收。
    expect(respondInteractionForIpc({
      sessionId: SESSION,
      toolCallId: 'call-3',
      answers: {},
    }).success).toBe(false)
    // 换成对的通道就通。
    expect(respondInteractionForIpc({
      sessionId: SESSION,
      toolCallId: 'call-3',
      answers: {},
    }, 'telegram')).toEqual({ success: true })
    await expect(pending).resolves.toMatchObject({ outcome: 'answered' })
  })
})
