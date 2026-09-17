/**
 * 模型作曲器(宠物 P4,正本 §11.2 第三行):端口全是假的 —— 从不建真 provider、从不发请求。
 *
 * 钉:① 没配小模型答 `null`,warn 只记一次;② 一次调用的参数(一轮、无工具、关思考、带提示词);
 * ③ 用量记账;④ 脏回复 / `{"say": null}` 答 `null`;⑤ 超时答 `null`,不挂住。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentLoopOptions } from '@onething/core/agent-loop'
import { HEIDOU, type Moment } from '@onething/runtime/pets'
import type { AppSettings } from '@shared/ipc.js'
import { collectLogRecordsForTests } from '../../logging/index.js'
import { ModelMomentComposer, type ModelMomentComposerPorts } from '../model-composer.js'

const MOMENT: Moment = { scheme: 'music', event: 'skipStreak', weight: 'high', gist: '用户连着跳过了好几首', payload: { count: 3 }, at: 1 }
const UTILITY = { provider: { id: 'deepseek' }, providerId: 'deepseek', model: 'deepseek-v4-flash' }

function composer(ports: Partial<ModelMomentComposerPorts>, timeoutMs?: number) {
  return new ModelMomentComposer({
    ports: {
      settings: () => ({}) as AppSettings,
      now: () => new Date(2026, 8, 18, 2, 14).getTime(),
      bill: () => () => {},
      ...ports,
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  })
}

describe('ModelMomentComposer', () => {
  it('① answers null without a tool-call model, and warns only once', async () => {
    const runLoop = vi.fn()
    const c = composer({ createProvider: async () => undefined, runLoop })
    const logs = collectLogRecordsForTests()
    try {
      expect(await c.compose({ pet: HEIDOU, moment: MOMENT, memory: [] })).toBeNull()
      expect(await c.compose({ pet: HEIDOU, moment: MOMENT, memory: [] })).toBeNull()
    } finally {
      logs.stop()
    }
    expect(runLoop).not.toHaveBeenCalled()
    const warns = logs.records.filter(record => record.level === 'warn' && record.ns === 'pets.composer')
    expect(warns).toHaveLength(1)
  })

  it('② ③ runs one tool-less, thinking-off turn with the moment prompt, bills it, and returns the parsed line', async () => {
    const bill = vi.fn()
    const runLoop = vi.fn(async (_options: AgentLoopOptions) => ({
      text: '```json\n{"say": "又跳了?换个口味吧。"}\n```',
      usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 },
    }))
    const c = composer({
      createProvider: async () => UTILITY as never,
      runLoop,
      bill: (providerId, model) => usage => bill(providerId, model, usage),
    })
    expect(await c.compose({ pet: HEIDOU, moment: MOMENT, memory: [] })).toBe('又跳了?换个口味吧。')
    const options = runLoop.mock.calls[0]![0]
    expect(options).toMatchObject({ model: 'deepseek-v4-flash', maxTurns: 1, tools: [], thinking: 'disabled' })
    expect(options.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('你是黑豆') })
    expect(options.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('2026-09-18 星期五 02:14') })
    expect(options.messages[1]!.content).toContain('用户连着跳过了好几首')
    expect(bill).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash', { inputTokens: 200, outputTokens: 20, totalTokens: 220 })
  })

  it('④ answers null for an explicit silence or an unparseable reply', async () => {
    for (const text of ['{"say": null}', '好的,我想想']) {
      const c = composer({ createProvider: async () => UTILITY as never, runLoop: async () => ({ text }) })
      expect(await c.compose({ pet: HEIDOU, moment: MOMENT, memory: [] })).toBeNull()
    }
  })

  it('⑤ gives up at the timeout even when the provider never answers', async () => {
    const c = composer({
      createProvider: async () => UTILITY as never,
      runLoop: options => new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }, 20)
    const started = Date.now()
    expect(await c.compose({ pet: HEIDOU, moment: MOMENT, memory: [] })).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
