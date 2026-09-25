/**
 * 批 4 §7.3 装配半边:`probeCustomProvider` 的三条路 —— 规则判满(零次请分析)、
 * 需要分析且分析模型答了一张表(回验通过、摘要带思考路径)、需要分析但没人可请 /
 * 答了一堆废话。fetch 与分析那一轮都换成假的。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utility-provider.js', () => ({ createUtilityProvider: vi.fn(async () => undefined) }))
vi.mock('../../../stores/settings.js', () => ({ getSpaceSettings: () => ({ ai: { providers: {} } }) }))

import { probeCustomProvider, type ProbeCustomPorts } from '../custom-probe.js'

const frame = (delta: Record<string, unknown>, finish: string | null = null, extra = {}) =>
  `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`

function relay(reasoningKey: string): ProbeCustomPorts['fetch'] {
  return async (input) => {
    if (String(input).endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'relay-a' }, { id: 'relay-b' }] }), { status: 200 })
    }
    if (String(input).endsWith('/chat/completions')) {
      return new Response(
        frame({ role: 'assistant', [reasoningKey]: 'thinking…' }) +
          frame({ content: 'Hello' }) +
          frame({}, 'stop', { usage: { prompt_tokens: 4, completion_tokens: 2 } }) +
          'data: [DONE]\n\n',
        { status: 200 },
      )
    }
    return new Response('nope', { status: 404 })
  }
}

const analyst = { provider: {} as never, providerId: 'deepseek', model: 'deepseek-chat' }

describe('probeCustomProvider', () => {
  it('规则判满:零次请分析,摘要是 OpenAI 兼容 + reasoning_content + 2 个模型', async () => {
    const ask = vi.fn()
    const result = await probeCustomProvider(
      { baseUrl: 'http://relay.test/v1' },
      { fetch: relay('reasoning_content'), analyst: async () => analyst, ask, now: () => 7 },
    )
    expect(ask).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      analyzed: false,
      spec: { version: 1, wire: 'openai-chat' },
      summary: {
        wireLabelKey: 'providers.dialect.custom-openai',
        dialect: 'custom-openai',
        reasoningPath: 'choices[0].delta.reasoning_content',
        modelCount: 2,
      },
    })
  })

  it('需要分析:分析模型答一张表,回验通过,摘要带它点名的思考路径', async () => {
    const ask = vi.fn(async (_a: unknown, prompt: string) => {
      expect(prompt).toContain('"reasoning":"thinking…"')
      return '{"version":1,"wire":"openai-chat","response":{"reasoningDeltaPath":"choices[0].delta.reasoning"},"probe":{"confidence":"high","notes":"reasoning field"}}'
    })
    const result = await probeCustomProvider(
      { baseUrl: 'http://relay.test/v1', spaceId: 'work' },
      { fetch: relay('reasoning'), analyst: async () => analyst, ask, now: () => 9 },
    )
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      analyzed: true,
      spec: { response: { reasoningDeltaPath: 'choices[0].delta.reasoning' }, probe: { at: 9, model: 'relay-a', confidence: 'high' } },
      summary: { reasoningPath: 'choices[0].delta.reasoning' },
    })
  })

  it('需要分析但没有可用的分析模型:只走规则,reasonKind no-analyst', async () => {
    const result = await probeCustomProvider(
      { baseUrl: 'http://relay.test/v1' },
      { fetch: relay('reasoning'), analyst: async () => undefined, ask: vi.fn(), now: () => 1 },
    )
    expect(result).toMatchObject({ ok: true, analyzed: false, reasonKind: 'no-analyst', spec: { wire: 'openai-chat' } })
  })

  it('分析模型答了废话:analysis-failed,不写表', async () => {
    const result = await probeCustomProvider(
      { baseUrl: 'http://relay.test/v1' },
      { fetch: relay('reasoning'), analyst: async () => analyst, ask: async () => 'I think it is OpenAI-ish.', now: () => 1 },
    )
    expect(result).toMatchObject({ ok: false, reasonKind: 'analysis-failed', analyzed: true })
    expect(result.spec).toBeUndefined()
  })

  it('答出的表回验不过:verify-failed', async () => {
    const result = await probeCustomProvider(
      { baseUrl: 'http://relay.test/v1' },
      {
        fetch: relay('reasoning'),
        analyst: async () => analyst,
        ask: async () => '{"version":1,"wire":"openai-chat","response":{"usage":{"input":"nope","output":"nope"}}}',
        now: () => 1,
      },
    )
    expect(result).toMatchObject({ ok: false, reasonKind: 'verify-failed' })
  })
})
