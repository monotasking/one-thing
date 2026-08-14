/**
 * E0 集成:跑一轮含工具调用的真 agent-loop,断言 events.jsonl 的序列完整。
 *
 * 用的是 core 的真 runner + 真 bridge(只替换 provider 与工具实现),所以这里
 * 验的是采集点挂对了位置,而不是我自己复述了一遍事件顺序。最关键的一条断言在
 * 工具的 execute 里:那一刻 `tool/call` 必须**已经落盘** —— 记账在执行之前。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamAgentLoopProviderChunks } from '@onething/core/agent-loop'
import type {
  AgentLoopOptions,
  AgentProvider,
  AgentTool,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'

const state = vi.hoisted(() => ({ sessionsDir: '' }))

vi.mock('../../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
}))

const { flushSessionEventLog, readSessionEvents, resetSessionEventLogCache } = await import(
  '../../../session/event-log.js'
)
const { attachSessionEventRecorder } = await import('../session-event-recorder.js')

const SESSION_ID = 'session-under-test'

beforeEach(() => {
  state.sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-events-int-'))
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventLogCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.sessionsDir, { recursive: true, force: true })
})

/** 两轮:第一轮吐正文 + 一个工具调用,第二轮吐正文收尾。 */
function testProvider(): AgentProvider {
  return {
    id: 'test-provider',
    capabilities: {
      capabilities: ['text-output', 'tool-calls', 'streaming'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
    },
    async *streamTurn(request): AsyncIterable<AgentTurnStreamEvent> {
      if (request.turn === 1) {
        yield { type: 'text-delta', turn: 1, delta: '' }
        yield { type: 'text-delta', turn: 1, delta: 'let me look' }
        yield {
          type: 'tool-call-done',
          turn: 1,
          toolCall: { id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' },
        }
        yield {
          type: 'finish',
          turn: 1,
          finishReason: 'tool_calls',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }
        return
      }
      yield { type: 'text-delta', turn: 2, delta: 'all done' }
      yield {
        type: 'finish',
        turn: 2,
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26, cacheReadTokens: 3 },
      }
    },
  }
}

async function runLoop(tool: AgentTool, systemPrompt = 'you are a test'): Promise<void> {
  const runtime: AgentLoopOptions = {
    provider: testProvider(),
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [tool],
    toolPolicy: { enabled: true },
    maxTurns: 4,
    sessionId: SESSION_ID,
    messageId: 'assistant-1',
  }
  const recorded = attachSessionEventRecorder(runtime, {
    sessionId: SESSION_ID,
    providerId: 'test-provider',
    model: 'test-model',
    systemPrompt,
    getMessageId: () => 'assistant-1',
  })
  for await (const _chunk of streamAgentLoopProviderChunks(recorded)) {
    void _chunk
  }
  await flushSessionEventLog(SESSION_ID)
}

const ECHO_TOOL: AgentTool = {
  name: 'echo',
  description: 'Echo the input back',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  async execute() {
    return { content: 'echoed hi' }
  },
}

describe('session event recorder (agent loop integration)', () => {
  it('writes the full tools → header → start → first-token → tool → end sequence', async () => {
    /** 工具执行的那一刻,tool/call 必须已经在盘上。 */
    let callWasOnDiskBeforeExecution = false

    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        await flushSessionEventLog(SESSION_ID)
        const soFar = await readSessionEvents(SESSION_ID)
        callWasOnDiskBeforeExecution = soFar.some(
          event => event.type === 'tool/call' && event.data.callId === 'call-1',
        )
        return { content: 'echoed hi' }
      },
    })

    const events = await readSessionEvents(SESSION_ID)
    expect(events.map(event => event.type)).toEqual([
      // 目录在信封之前:header 引用的 toolsHash 落盘时已经有对应的目录了。
      'request/tools',
      'request/header',
      'request/start',
      'assistant/first-token',
      'tool/call',
      'tool/result',
      'request/end',
      'request/start',
      'assistant/first-token',
      'request/end',
    ])

    expect(callWasOnDiskBeforeExecution).toBe(true)
    expect(events.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // 时刻单调,而且没有任何一条事件带 duration/status。
    for (let index = 1; index < events.length; index++) {
      expect(events[index].time).toBeGreaterThanOrEqual(events[index - 1].time)
    }
    for (const event of events) {
      expect(Object.keys(event.data)).not.toContain('duration')
      expect(Object.keys(event.data)).not.toContain('durationMs')
      expect(Object.keys(event.data)).not.toContain('status')
    }
  })

  it('records the world the model saw, and the causal link between call and result', async () => {
    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        return { content: 'echoed hi' }
      },
    })

    const events = await readSessionEvents(SESSION_ID)
    const catalog = events.find(event => event.type === 'request/tools')
    expect(catalog?.type === 'request/tools' && catalog.data).toMatchObject({
      requestIndex: 1,
      tools: [
        {
          name: 'echo',
          description: 'Echo the input back',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ],
    })

    const header = events.find(event => event.type === 'request/header')
    expect(header?.type === 'request/header' && header.data).toMatchObject({
      requestIndex: 1,
      provider: 'test-provider',
      model: 'test-model',
      reason: 'initial',
      // 信封只引用目录的指纹 —— 那 40KB 正文在上面那条事件里,只此一份。
      toolsHash: catalog?.type === 'request/tools' ? catalog.data.toolsHash : '',
    })
    expect(header?.type === 'request/header' && Object.keys(header.data)).not.toContain('tools')

    const call = events.find(event => event.type === 'tool/call')
    const result = events.find(event => event.type === 'tool/result')
    expect(call?.type === 'tool/call' && call.data.argumentsRaw).toBe('{"text":"hi"}')
    expect(result?.type === 'tool/result' && result.data).toMatchObject({
      callId: 'call-1',
      isError: false,
      resultPreview: 'echoed hi',
      sourceSeq: call?.seq,
    })
  })

  it('writes the header once for two requests with the same envelope', async () => {
    await runLoop(ECHO_TOOL)

    const events = await readSessionEvents(SESSION_ID)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
    expect(events.filter(event => event.type === 'request/tools')).toHaveLength(1)
    expect(
      events.filter(event => event.type === 'request/start').map(event =>
        event.type === 'request/start' ? event.data.requestIndex : undefined,
      ),
    ).toEqual([1, 2])
  })

  /**
   * 这一条是本次改版的正题:system prompt 会话内会变(变量/上下文注入),
   * 工具目录不变。拆事件之前,每变一次 system 就陪葬一份没变的 40KB 目录。
   */
  it('writes only a new header when the system prompt changed but the catalog did not', async () => {
    await runLoop(ECHO_TOOL, 'you are a test')
    await runLoop(ECHO_TOOL, 'you are a test — now with a fresh variable block')

    const events = await readSessionEvents(SESSION_ID)
    expect(events.filter(event => event.type === 'request/tools')).toHaveLength(1)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(2)

    const headers = events.filter(event => event.type === 'request/header')
    expect(headers.map(event => event.type === 'request/header' && event.data.reason))
      .toEqual(['initial', 'change'])
    // 两条 header 引用的是**同一份**目录。
    const hashes = new Set(
      headers.map(event => (event.type === 'request/header' ? event.data.toolsHash : '')),
    )
    expect(hashes.size).toBe(1)
  })

  it('writes a new catalog when the tool catalog itself changed', async () => {
    await runLoop(ECHO_TOOL)
    await runLoop({ ...ECHO_TOOL, description: 'Echo the input back (v2)' })

    const catalogs = (await readSessionEvents(SESSION_ID)).filter(
      event => event.type === 'request/tools',
    )
    expect(catalogs).toHaveLength(2)
    expect(
      catalogs.map(event =>
        event.type === 'request/tools' ? event.data.tools[0]?.description : '',
      ),
    ).toEqual(['Echo the input back', 'Echo the input back (v2)'])
  })

  /**
   * 跨重启:新记录器的 `lastToolsHash` 从文件里那条 `request/tools` 的
   * `toolsHash` 字段恢复(不重算大数组),所以目录没变就不会再写一遍那 40KB。
   */
  it('recovers lastToolsHash from disk instead of rewriting the catalog', async () => {
    await runLoop(ECHO_TOOL)
    // 清进程内缓存 = 一次重启:计数器与 lastToolsHash 都只能从文件恢复。
    resetSessionEventLogCache()
    await runLoop(ECHO_TOOL)

    const events = await readSessionEvents(SESSION_ID)
    expect(events.filter(event => event.type === 'request/tools')).toHaveLength(1)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
    // seq / requestIndex 跨重启继续单调递增,没有回头。
    expect(events.map(event => event.seq)).toEqual([...events.keys()].map(index => index + 1))
  })

  it('carries stop reason and usage on request/end, and nothing derived', async () => {
    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        return { content: 'echoed hi' }
      },
    })

    const ends = (await readSessionEvents(SESSION_ID)).filter(event => event.type === 'request/end')
    expect(ends).toHaveLength(2)
    expect(ends[0].type === 'request/end' && ends[0].data).toMatchObject({
      requestIndex: 1,
      stopReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    expect(ends[1].type === 'request/end' && ends[1].data).toMatchObject({
      requestIndex: 2,
      stopReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 6, cacheReadTokens: 3 },
    })
  })

  it('records an errored tool result as a fact, not a verdict', async () => {
    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        return { content: '', error: 'boom' }
      },
    })

    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data).toMatchObject({
      callId: 'call-1',
      isError: true,
      resultPreview: 'boom',
    })
  })

  it('truncates a long result preview to 500 chars', async () => {
    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute() {
        return { content: 'x'.repeat(2000) }
      },
    })

    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    const preview = result?.type === 'tool/result' ? result.data.resultPreview : ''
    expect(preview).toHaveLength(501)
    expect(preview.endsWith('…')).toBe(true)
  })
})
