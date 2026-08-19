/**
 * 工具调用「渲染即执行」的时序契约(2026-08-19)。
 *
 * OpenAI 风格的流按 index 串行发工具参数。此前 deepseek / openai-compatible
 * 只在 SSE 循环结束后统一补发 `tool-call-done`,于是 core runner(它在每个
 * done 上入队执行)只能等**整批**参数渲染完才开始跑第一个工具 —— 真机上表现为
 * "所有工具卡片都渲染完了才动"。修法:index 切换 = 上一个工具的参数已完整,
 * 当场发 done;`finish_reason` 到达 = 全部完整,当场补发;流收尾兜底保留。
 *
 * 这两条用例钉的就是**顺序**:第一个工具的 done 必须发生在第二个工具的第一个
 * delta 之前;最后一个工具的 done 必须在 finish_reason 的那一个 chunk 里发出,
 * 不等 [DONE]。(Claude 走 content_block_stop、Gemini 按 part 立发,本来就对,
 * 不在此钉。)
 */
import { describe, expect, it } from 'vitest'
import type { AgentTurnStreamEvent } from '@onething/core/agent-loop'
import { createOpenAICompatibleAgentProvider } from '../providers/openai-compatible.js'
import { createDeepSeekAgentProvider } from '../providers/deepseek.js'

function openAiToolChunk(index: number, id: string | null, name: string | null, args: string): string {
  const call: Record<string, unknown> = { index }
  if (id) call.id = id
  call.function = { ...(name ? { name } : {}), arguments: args }
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}`
}

const FINISH_CHUNK = 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'

function sseResponse(lines: string[]): Response {
  return new Response([...lines, 'data: [DONE]', ''].join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(events: AsyncIterable<AgentTurnStreamEvent>): Promise<AgentTurnStreamEvent[]> {
  const collected: AgentTurnStreamEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

const TWO_TOOL_STREAM = [
  openAiToolChunk(0, 'call_a', 'read', ''),
  openAiToolChunk(0, null, null, '{"path":'),
  openAiToolChunk(0, null, null, '"a.txt"}'),
  openAiToolChunk(1, 'call_b', 'write', ''),
  openAiToolChunk(1, null, null, '{"path":"b.txt","content":"x"}'),
  FINISH_CHUNK,
]

function indexOfEvent(events: AgentTurnStreamEvent[], predicate: (event: AgentTurnStreamEvent) => boolean): number {
  return events.findIndex(predicate)
}

for (const [label, make] of [
  ['openai-compatible', () => createOpenAICompatibleAgentProvider({
    providerId: 'grok',
    apiKey: 'k',
    defaultBaseUrl: 'https://api.x.ai/v1',
    fetchImpl: async () => sseResponse(TWO_TOOL_STREAM),
  })],
  ['deepseek', () => createDeepSeekAgentProvider({
    apiKey: 'k',
    fetchImpl: async () => sseResponse(TWO_TOOL_STREAM),
  })],
] as const) {
  describe(`${label}: tool-call-done timing`, () => {
    it('第一个工具的 done 在第二个工具的第一个 delta 之前(index 切换即完整)', async () => {
      const provider = make()
      const events = await collect(provider.streamTurn!({ turn: 1, model: 'deepseek-chat', messages: [], tools: [] } as never))

      const firstDone = indexOfEvent(events, e => e.type === 'tool-call-done' && e.toolCall.id === 'call_a')
      const secondStart = indexOfEvent(events, e => e.type === 'tool-call-start' && 'toolCallId' in e && e.toolCallId === 'call_b')
      expect(firstDone).toBeGreaterThan(-1)
      expect(secondStart).toBeGreaterThan(-1)
      expect(firstDone).toBeLessThan(secondStart)

      const done = events.find(e => e.type === 'tool-call-done' && e.toolCall.id === 'call_a')
      expect(done && done.type === 'tool-call-done' ? done.toolCall.arguments : '').toBe('{"path":"a.txt"}')
    })

    it('最后一个工具的 done 由 finish_reason 触发,且不重复发', async () => {
      const provider = make()
      const events = await collect(provider.streamTurn!({ turn: 1, model: 'deepseek-chat', messages: [], tools: [] } as never))

      const dones = events.filter(e => e.type === 'tool-call-done')
      expect(dones.map(e => (e.type === 'tool-call-done' ? e.toolCall.id : ''))).toEqual(['call_a', 'call_b'])

      const lastDone = indexOfEvent(events, e => e.type === 'tool-call-done' && e.toolCall.id === 'call_b')
      const finish = indexOfEvent(events, e => e.type === 'finish')
      expect(lastDone).toBeGreaterThan(-1)
      expect(finish).toBeGreaterThan(lastDone)
    })
  })
}
