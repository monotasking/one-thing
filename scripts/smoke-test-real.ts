import { AgentEngine } from '../packages/backend/agent/agent.ts'
import {
  AllowAllPolicy,
  ToolRegistry,
  type ToolCall,
  type ToolResult,
} from '../packages/backend/tool/tool.ts'
import type { Provider } from '../packages/backend/provider/provider.ts'
import {
  createAnthropicProvider,
  createDeepSeekProvider,
} from '../packages/backend/provider/provider.ts'

type CliJsonEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; toolCallId?: string; toolName?: string; argumentsDelta?: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolCall: ToolCall; result: ToolResult }
  | { type: 'final_text'; text: string }

interface CliJsonOutput {
  schemaVersion: 1
  ok: boolean
  mode: 'once'
  provider: {
    id: string
    model?: string
  }
  sessionId: string
  prompt: string
  events: CliJsonEvent[]
  finalText: string
  toolCallCount: number
  assertions: {
    toolCallReceived: boolean
    finalTextReceived: boolean
  }
}

const args = new Set(process.argv.slice(2))
const jsonMode = args.has('--json')
const onceMode = args.has('--once') || jsonMode
const originalConsoleLog = console.log.bind(console)
const originalConsoleWarn = console.warn.bind(console)

if (jsonMode) {
  console.log = () => {}
  console.warn = () => {}
}

const prompt = '现在几点？请先调用 get_current_time 工具，再用中文回答。'
const deepseekApiKey = process.env.DEEPSEEK_API_KEY
const anthropicApiKey = process.env.ANTHROPIC_API_KEY
const provider = createProvider()
const toolRegistry = new ToolRegistry()
const sessionId = `real-smoke-${Date.now()}`
const jsonEvents: CliJsonEvent[] = []
let toolCallCount = 0
let finalText = ''

toolRegistry.register({
  name: 'get_current_time',
  description: 'Return the current date and time as an ISO-8601 string.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute() {
    const now = new Date().toISOString()
    if (!jsonMode) {
      console.log(`\n[tool:get_current_time] ${now}`)
    }
    return { content: now }
  },
})

const engine = new AgentEngine({
  provider,
  toolRegistry,
  permissionPolicy: new AllowAllPolicy(),
  maxToolIterations: 4,
})

engine.contextManager.appendMessage(sessionId, {
  role: 'system',
  content: [
    'You are a concise assistant.',
    'When the user asks for the current time, you must call the get_current_time tool before answering.',
    'After the tool result arrives, answer in Chinese and include the returned time.',
  ].join(' '),
})

engine.streamChannel.subscribe(sessionId, (chunk) => {
  if (chunk.type === 'text-delta') {
    jsonEvents.push({ type: 'text_delta', text: chunk.text })
    if (!jsonMode) {
      process.stdout.write(chunk.text)
    }
  }
  if (chunk.type === 'tool-call-delta') {
    jsonEvents.push({
      type: 'tool_call_delta',
      ...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}),
      ...(chunk.toolName ? { toolName: chunk.toolName } : {}),
      ...(chunk.argumentsDelta ? { argumentsDelta: chunk.argumentsDelta } : {}),
    })
    if (!jsonMode) {
      process.stdout.write(chunk.toolName ? `\n[tool-call-delta:${chunk.toolName}]` : '.')
    }
  }
})

engine.eventBus.onAnySessionAny((envelope) => {
  if (envelope.sessionId !== sessionId) return
  if (envelope.event.type === 'tool:call') {
    toolCallCount++
    jsonEvents.push({ type: 'tool_call', toolCall: envelope.event.toolCall })
    if (!jsonMode) {
      console.log(`\n[tool-call] ${envelope.event.toolCall.name} ${JSON.stringify(envelope.event.toolCall.args)}`)
    }
  }
  if (envelope.event.type === 'tool:result') {
    jsonEvents.push({
      type: 'tool_result',
      toolCall: envelope.event.toolCall,
      result: envelope.event.result,
    })
    if (!jsonMode) {
      console.log(`[tool-result] ${envelope.event.result.content}`)
    }
  }
}, 'real-smoke-test')

if (!jsonMode) {
  console.log(`[smoke-real] provider=${provider.id} model=${provider.model ?? '(default)'}`)
  console.log('user> 现在几点？')
  process.stdout.write('assistant> ')
}

try {
  const result = await engine.sendMessage({
    sessionId,
    content: prompt,
  })
  finalText = result.content
  jsonEvents.push({ type: 'final_text', text: finalText })

  assert(toolCallCount > 0, 'Expected at least one tool call')
  assert(finalText.trim().length > 0, 'Expected a final text response')

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(createJsonOutput(true), null, 2)}\n`)
  } else {
    console.log(`\n\n[smoke-real] final=${finalText}`)
    console.log('[smoke-real] ok')
  }
} catch (error) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ...createJsonOutput(false),
      error: error instanceof Error ? error.message : String(error),
    }, null, 2)}\n`)
  }
  throw error
} finally {
  engine.shutdown()
  if (jsonMode) {
    console.log = originalConsoleLog
    console.warn = originalConsoleWarn
  }
}

function createProvider(): Provider {
  if (deepseekApiKey) {
    return createDeepSeekProvider({
      apiKey: deepseekApiKey,
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      baseURL: process.env.DEEPSEEK_BASE_URL,
    })
  }

  if (anthropicApiKey) {
    return createAnthropicProvider({
      apiKey: anthropicApiKey,
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest',
      baseURL: process.env.ANTHROPIC_BASE_URL,
    })
  }

  throw new Error('Set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY to run scripts/smoke-test-real.ts')
}

function createJsonOutput(ok: boolean): CliJsonOutput {
  return {
    schemaVersion: 1,
    ok,
    mode: onceMode ? 'once' : 'once',
    provider: {
      id: provider.id,
      ...(provider.model ? { model: provider.model } : {}),
    },
    sessionId,
    prompt,
    events: jsonEvents,
    finalText,
    toolCallCount,
    assertions: {
      toolCallReceived: toolCallCount > 0,
      finalTextReceived: finalText.trim().length > 0,
    },
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}
