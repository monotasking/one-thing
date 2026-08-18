/* eslint-disable require-yield -- 「一开口就抛」正是这些桩要模拟的失败:provider
   在第一次 fetch 就拿到非 2xx,一个 chunk 都没产出。为它加一句永远到不了的 yield
   会把测试要钉的东西改掉。 */
import { describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from './runner.js'
import type {
  AgentCredentialRotation,
  AgentProvider,
  AgentStreamEvent,
  AgentTool,
} from './types.js'

/**
 * 凭证轮换挂在 turn 级重试边界上(`AgentLoopOptions.rotateCredential`)。
 * 这组测试钉住的是**边界语义**,不是任何具体的凭证池:
 *
 *  - 轮换是独立于 `isRetryableAgentError` 的重试理由(配额耗尽对同一把 key
 *    是致命的,对下一把不是);
 *  - 宿主说"不换"时,原来的重试规则一行不变;
 *  - **执行过工具的一轮不换** —— 换钥匙不会让重复执行副作用变安全;
 *  - 每次 attempt 用的都是当时最新的 provider(不换就是原来那个)。
 */

function baseProvider(
  id: string,
  streamTurn: AgentProvider['streamTurn'],
): AgentProvider {
  return {
    id,
    capabilities: {
      capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsStreaming: true,
      supportsTools: true,
    },
    streamTurn,
  } as AgentProvider
}

/** OpenAI 家族的配额耗尽:`isRetryableAgentError` 判它 fatal(FATAL_PATTERNS)。 */
function quotaError(): Error {
  return Object.assign(
    new Error('deepseek agent loop API error: 429 {"error":{"code":"insufficient_quota"}}'),
    { data: { statusCode: 429 } },
  )
}

const RUN = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
  sessionId: 'session-1',
  messageId: 'message-1',
  turnRetryDelaysMs: [0, 0, 0],
}

describe('rotateCredential —— 请求/重试边界上的换钥匙', () => {
  it('配额耗尽:换一把 key 重试成功(哪怕这个错误按老规矩是 fatal 不重试)', async () => {
    const burned = baseProvider('burned', async function* () {
      throw quotaError()
    })
    const fresh = baseProvider('fresh', async function* (request) {
      yield { type: 'text-delta', turn: request.turn, delta: 'ok' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })

    const seen: AgentStreamEvent[] = []
    const result = await runAgentLoop({
      ...RUN,
      provider: burned,
      rotateCredential: async (): Promise<AgentCredentialRotation> => ({
        provider: fresh,
        reason: '凭证 a 配额耗尽,换用「备用」重试',
      }),
      onEvent: (event) => seen.push(event),
    })

    expect(result.text).toBe('ok')
    const retries = seen.filter(event => event.type === 'auto-retry')
    expect(retries).toHaveLength(1)
    expect(retries[0].type === 'auto-retry' && retries[0].error)
      .toBe('凭证 a 配额耗尽,换用「备用」重试')
    // 换的是另一把 key,没有理由退避。
    expect(retries[0].type === 'auto-retry' && retries[0].delayMs).toBe(0)
  })

  it('宿主说不换(unknown / transient / 没有第二把):回到原来的重试规则', async () => {
    let calls = 0
    const provider = baseProvider('only', async function* () {
      calls++
      throw quotaError()
    })
    const rotate = vi.fn(async () => undefined)

    // 配额耗尽在 `isRetryableAgentError` 眼里是 fatal —— 不换就一次都不重试。
    await expect(runAgentLoop({ ...RUN, provider, rotateCredential: rotate }))
      .rejects.toThrow('insufficient_quota')
    expect(rotate).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)
  })

  it('不换钥匙时,transient 错误照旧原地重试', async () => {
    let calls = 0
    const provider = baseProvider('only', async function* (request) {
      calls++
      if (calls === 1) throw new Error('fetch failed')
      yield { type: 'text-delta', turn: request.turn, delta: 'recovered' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })

    const result = await runAgentLoop({
      ...RUN,
      provider,
      rotateCredential: async () => undefined,
    })
    expect(result.text).toBe('recovered')
    expect(calls).toBe(2)
  })

  it('**执行过工具的一轮绝不换** —— 换钥匙不会让重复执行副作用变安全', async () => {
    const tool: AgentTool = {
      name: 'write_thing',
      description: 'writes',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: 'written' }),
    }
    const provider = baseProvider('side-effecting', async function* (request) {
      yield {
        type: 'tool-call-start',
        turn: request.turn,
        toolCallId: 'call-1',
        toolName: 'write_thing',
      }
      yield {
        type: 'tool-call-done',
        turn: request.turn,
        toolCall: { id: 'call-1', name: 'write_thing', arguments: '{}' },
      }
      // 工具跑完之后流才炸 —— 这一轮已经有副作用了。
      throw quotaError()
    })
    const rotate = vi.fn(async () => ({ provider }))

    await expect(runAgentLoop({ ...RUN, provider, tools: [tool], rotateCredential: rotate }))
      .rejects.toThrow()
    expect(rotate).not.toHaveBeenCalled()
  })

  it('轮换有预算,不会让一次运行把整池走穿', async () => {
    const failing = baseProvider('failing', async function* () {
      throw quotaError()
    })
    const rotate = vi.fn(async () => ({ provider: failing }))

    await expect(runAgentLoop({
      ...RUN,
      provider: failing,
      rotateCredential: rotate,
      maxCredentialRotations: 2,
    })).rejects.toThrow('insufficient_quota')
    expect(rotate).toHaveBeenCalledTimes(2)
  })

  it('没挂钩子 = 行为与批 D 之前完全一致', async () => {
    let calls = 0
    const provider = baseProvider('only', async function* () {
      calls++
      throw quotaError()
    })
    await expect(runAgentLoop({ ...RUN, provider })).rejects.toThrow('insufficient_quota')
    expect(calls).toBe(1)
  })

  it('流已经开始产出内容之后失败,换的也是**下一次 attempt** —— 没有流中换 key 这回事', async () => {
    const providersUsed: string[] = []
    const burned = baseProvider('burned', async function* (request) {
      providersUsed.push('burned')
      yield { type: 'text-delta', turn: request.turn, delta: 'half ' }
      throw quotaError()
    })
    const fresh = baseProvider('fresh', async function* (request) {
      providersUsed.push('fresh')
      yield { type: 'text-delta', turn: request.turn, delta: 'whole' }
      yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
    })

    const result = await runAgentLoop({
      ...RUN,
      provider: burned,
      rotateCredential: async () => ({ provider: fresh }),
    })

    expect(providersUsed).toEqual(['burned', 'fresh'])
    // 失败那一轮的产出不进历史 —— 重试是整轮重来,不是接着往下写。
    expect(result.text).toBe('whole')
  })
})
