import {
  runAgentLoop,
  type AgentProvider,
  type AgentStreamEvent,
  type AgentTool,
} from '../packages/backend/agent-loop/loop-primitives.ts'

const events: AgentStreamEvent[] = []
let toolCallCount = 0

const provider: AgentProvider = {
  id: 'core-agent-loop-mock',
  capabilities: {
    capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    supportsTools: true,
  },
  async *streamTurn(request) {
    const hasToolResult = request.messages.some(message => message.role === 'tool')

    if (!hasToolResult) {
      const toolCall = {
        id: 'call-time-1',
        name: 'get_current_time',
        arguments: '{}',
      }
      yield {
        type: 'tool-call-start',
        turn: request.turn,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      }
      yield {
        type: 'tool-call-delta',
        turn: request.turn,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        argumentsDelta: '{}',
      }
      yield {
        type: 'tool-call-done',
        turn: request.turn,
        toolCall,
      }
      yield {
        type: 'finish',
        turn: request.turn,
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      }
      return
    }

    yield {
      type: 'text-delta',
      turn: request.turn,
      delta: '现在时间是工具返回的时间。',
    }
    yield {
      type: 'finish',
      turn: request.turn,
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    }
  },
}

const tools: AgentTool[] = [{
  name: 'get_current_time',
  description: 'Return the current date and time.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, context) {
    toolCallCount++
    return {
      content: `tool:${context.toolCallId}:2026-06-24T15:38:00.000Z`,
    }
  },
}]

const result = await runAgentLoop({
  provider,
  model: 'mock-model',
  messages: [{ role: 'user', content: '现在几点？' }],
  tools,
  sessionId: 'core-agent-loop-test',
  messageId: 'assistant-core-agent-loop-test',
  onEvent(event) {
    events.push(event)
  },
})

assert(toolCallCount === 1, `expected 1 tool call, got ${toolCallCount}`)
assert(result.turns === 2, `expected 2 turns, got ${result.turns}`)
assert(result.text === '现在时间是工具返回的时间。', `unexpected final text: ${result.text}`)
assert(result.toolResults.length === 1, `expected 1 tool result, got ${result.toolResults.length}`)
assert(events.some(event => event.type === 'tool-result'), 'expected tool-result event')
assert(events.some(event => event.type === 'text-delta'), 'expected text-delta event')

console.log('[agent-loop-core-test] ok')
console.log(`[agent-loop-core-test] turns=${result.turns} toolCallCount=${toolCallCount}`)
console.log(`[agent-loop-core-test] final=${result.text}`)

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
