import { describe, expect, it } from 'vitest'
import type { AgentTurnRequest, AgentTurnStreamEvent } from '@onething/backend/agent-loop'
import { createAgentProviderFromRuntime } from '../../../provider.js'

/**
 * grok-effort 线型的钳法 —— 走 **grok 自家的 provider**。
 *
 * 从前这几条住在 `provider/__tests__/thinking-wire.test.ts`,用通用的
 * `createOpenAICompatibleAgentProvider` 配 `reasoningStyle: 'grok-effort'`。P4(拍板 #14)
 * 之后 effort 的档位表来自各家账本(`grok-manifest.ts` 的 `profile.efforts`),通用构造出来的
 * provider 没有 grok 的账本可查,`turn.profile.reasoningProfile` 是空的,钳法一个字都跑不到 ——
 * 那条用例红了两个多星期。这里经工厂按 providerId 建 grok 的 provider,账本解析器随之而来;
 * 同时 `provider:gate` 的规矩也顺了:grok 的名字只住 `vendors/grok/`。
 */

function sseResponse(): Response {
  const body = [
    'data: {"id":"x","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    'data: [DONE]',
    '',
  ].join('\n\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(events: AsyncIterable<AgentTurnStreamEvent>): Promise<void> {
  try {
    for await (const _ of events) { /* request capture already happened */ }
  } catch {
    // Mocked SSE bodies may terminate abruptly; request capture already happened.
  }
}

/** grok 走的是 Responses 线:effort 嵌在 `reasoning.effort`,不是 chat-completions 的顶层 `reasoning_effort`。 */
function effortOf(body: Record<string, unknown>): unknown {
  const reasoning = body.reasoning as { effort?: unknown } | undefined
  return reasoning?.effort
}

async function grokBody(request: Partial<AgentTurnRequest>): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined
  const provider = createAgentProviderFromRuntime('grok', { apiKey: 'test' }, {
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse()
    },
  })
  if (!provider?.streamTurn) throw new Error('grok provider missing streamTurn')
  await collect(provider.streamTurn({
    turn: 0,
    model: 'grok-4.5',
    messages: [{ role: 'user', content: 'hi' }],
    ...request,
  } as AgentTurnRequest))
  if (!captured) throw new Error('fetch was not called')
  return captured
}

describe('grok-effort wire', () => {
  it('clamps reasoning.effort to the model-supported range', async () => {
    const grok45 = await grokBody({ model: 'grok-4.5', thinking: 'enabled', reasoningEffort: 'xhigh' })
    expect(effortOf(grok45)).toBe('high')

    const multiAgent = await grokBody({ model: 'grok-4.20-multi-agent', thinking: 'enabled', reasoningEffort: 'xhigh' })
    expect(effortOf(multiAgent)).toBe('xhigh')

    // 4.5 关不掉推理:`disabled` 落到它自述的最低档,不是不发。
    const off = await grokBody({ model: 'grok-4.5', thinking: 'disabled' })
    expect(effortOf(off)).toBe('low')
  })
})
