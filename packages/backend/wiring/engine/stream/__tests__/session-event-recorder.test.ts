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

const state = vi.hoisted(() => ({ sessionsDir: '', storeDir: '' }))

// 只替换两条路径(会话目录 / store 根),其余原样 —— 记录器现在会连带把
// blob store 与统计账单拉进来,那两个模块要的是 `getOnethingLogDir` 之类的真实实现。
vi.mock('@onething/runtime/storage', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/runtime/storage')>()
  return {
    ...actual,
    getOnethingSessionsDir: () => state.sessionsDir,
    getOnethingLogDir: () => path.join(state.storeDir, 'log'),
  }
})

const { flushSessionEventLog, readSessionEvents, readSessionLogEvents, resetSessionEventLogCache } =
  await import('../../../../session/event-log.js')
const { resetSessionSurfaceCache } = await import('../../../../session/event-surface.js')
const { beginSessionRun, endSessionRun, resetSessionRuns, rotateSessionRun } = await import(
  '../../../../session/runs.js'
)
const { readSessionShadowStats, resetSessionEventStatsCache } = await import('../../../../session/event-stats.js')
const { attachSessionEventRecorder, createSessionEventRecorder } = await import('../session-event-recorder.js')
const { installSessionLayerForTest } = await import('../../../../session/testing/session-layer.js')
let sessionFixture: ReturnType<typeof installSessionLayerForTest>

const SESSION_ID = 'session-under-test'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-events-store-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION_ID), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION_ID, 'meta.json'), '{}')
  resetSessionEventLogCache()
  sessionFixture = installSessionLayerForTest()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  await sessionFixture.dispose()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
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

async function runLoop(
  tool: AgentTool,
  options: { systemPrompt?: string; isToolCallHidden?: (toolCallId: string) => boolean } = {},
): Promise<void> {
  const systemPrompt = options.systemPrompt ?? 'you are a test'
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
  // S1a:一次执行(run)是 recorder 记 runId / recipe / chunks 的前提。
  const run = beginSessionRun(SESSION_ID, {
    kind: 'send',
    assistantMessageId: 'assistant-1',
    provider: 'test-provider',
    model: 'test-model',
    triggerMessageId: 'user-1',
  })
  const recorded = attachSessionEventRecorder(runtime, {
    sessionId: SESSION_ID,
    providerId: 'test-provider',
    model: 'test-model',
    systemPrompt,
    getMessageId: () => 'assistant-1',
    getHistoryInput: () => [{ id: 'user-1', role: 'user', content: 'hello' }],
    ...(options.isToolCallHidden ? { isToolCallHidden: options.isToolCallHidden } : {}),
  })
  try {
    for await (const _chunk of streamAgentLoopProviderChunks(recorded.runtime)) {
      void _chunk
    }
  } finally {
    recorded.recorder.flush()
    endSessionRun(SESSION_ID, run.runId, { outcome: 'completed' })
  }
  await flushSessionEventLog(SESSION_ID)
}

/**
 * 同一条跑法,但换一个 provider、并允许接上 Q1 批新加的两个口
 * (`resolveToolIdentity` 端口 / 引擎合成正文的回传)。
 */
async function runLoopWithProvider(
  provider: AgentProvider,
  options: {
    resolveToolIdentity?: (
      toolName: string,
      args: Record<string, unknown>,
    ) => { toolId: string; displayName: string }
    /** 在流**进行中**调一次(合成正文是引擎在消费 chunk 时产生的)。 */
    onRecorderReady?: (recorder: { recordSynthesizedText(text: string): void }) => void
    /** A11:引擎藏起来的调用 —— 端口答"这次在不在消息上"。 */
    isToolCallHidden?: (toolCallId: string) => boolean
  } = {},
): Promise<void> {
  const runtime: AgentLoopOptions = {
    provider,
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [ECHO_TOOL],
    toolPolicy: { enabled: true },
    maxTurns: 4,
    sessionId: SESSION_ID,
    messageId: 'assistant-1',
  }
  const run = beginSessionRun(SESSION_ID, {
    kind: 'send',
    assistantMessageId: 'assistant-1',
    provider: 'test-provider',
    model: 'test-model',
  })
  const recorded = attachSessionEventRecorder(runtime, {
    sessionId: SESSION_ID,
    providerId: 'test-provider',
    model: 'test-model',
    systemPrompt: 'you are a test',
    getMessageId: () => 'assistant-1',
    ...(options.resolveToolIdentity ? { resolveToolIdentity: options.resolveToolIdentity } : {}),
    ...(options.isToolCallHidden ? { isToolCallHidden: options.isToolCallHidden } : {}),
  })
  let notified = false
  try {
    for await (const chunk of streamAgentLoopProviderChunks(recorded.runtime)) {
      // 引擎合成的正文是在**消费 chunk 的那一刻**产生的(applyProviderData 就在
      // 那条路上),所以这里也在同一个位置回传。
      if (!notified && chunk.type === 'text') {
        notified = true
        options.onRecorderReady?.(recorded.recorder)
      }
    }
  } finally {
    recorded.recorder.flush()
    endSessionRun(SESSION_ID, run.runId, { outcome: 'completed' })
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

    const events = await readSessionLogEvents(SESSION_ID)
    expect(events.map(event => event.type)).toEqual([
      'run/start',
      // 目录在信封之前:header 引用的 toolsHash 落盘时已经有对应的目录了。
      'request/tools',
      'request/header',
      'request/recipe',
      'request/start',
      'assistant/first-token',
      // 工具在正文之前落账:`tool/call` 必须在工具执行**之前**(铁律 2),
      // 而这个 provider 不发 tool-input 流,所以正文那一段直到请求结束
      // (turn-end 的那道闸)才收齐。
      'tool/call',
      'tool/result',
      // 正文的唯一来源:一批 delta 打包成一行,part 收齐再记一条不带正文的
      // part-end。
      'assistant/chunks',
      'assistant/part-end',
      'request/response',
      'request/end',
      'request/recipe',
      'request/start',
      'assistant/first-token',
      'assistant/chunks',
      'assistant/part-end',
      'request/response',
      'request/end',
      'run/end',
    ])

    expect(callWasOnDiskBeforeExecution).toBe(true)
    // seq 连续,从 1 起,一个不漏。
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))

    // 同一个 runId 贯穿整次执行。
    const runIds = new Set(
      events
        .map(event => (event.data as { runId?: string }).runId)
        .filter((id): id is string => Boolean(id)),
    )
    expect(runIds.size).toBe(1)

    // 时刻单调,而且没有任何一条事件带 duration/status。
    for (let index = 1; index < events.length; index++) {
      expect(events[index].time).toBeGreaterThanOrEqual(events[index - 1].time)
    }
    for (const event of events) {
      expect(Object.keys(event.data)).not.toContain('duration')
      expect(Object.keys(event.data)).not.toContain('durationMs')
      if (event.type !== 'session/compacted') {
        expect(Object.keys(event.data)).not.toContain('status')
      }
    }
  })

  it('folds the packed deltas back into the exact text the model produced', async () => {
    await runLoop(ECHO_TOOL)

    const events = await readSessionLogEvents(SESSION_ID)
    const chunks = events.filter(event => event.type === 'assistant/chunks')
    // 两轮各一段正文。每一批的 dt/text 等长 —— 那是"无损"的定义。
    expect(chunks).toHaveLength(2)
    for (const chunk of chunks) {
      if (chunk.type !== 'assistant/chunks') continue
      expect(chunk.data.dt).toHaveLength(chunk.data.text.length)
      expect(chunk.data.dt[0]).toBe(0)
    }
    const folded = chunks
      .map(chunk => (chunk.type === 'assistant/chunks' ? chunk.data.text.join('') : ''))
      .join('')
    expect(folded).toBe('let me lookall done')

    // part-end 不带正文,只带 len + hash。
    const partEnds = events.filter(event => event.type === 'assistant/part-end')
    expect(partEnds).toHaveLength(2)
    for (const partEnd of partEnds) {
      if (partEnd.type !== 'assistant/part-end') continue
      expect(Object.keys(partEnd.data)).not.toContain('text')
      expect(partEnd.data.hash).toMatch(/^[0-9a-f]{16}$/)
    }
    expect(
      partEnds.map(event => (event.type === 'assistant/part-end' ? event.data.len : 0)),
    ).toEqual(['let me look'.length, 'all done'.length])
  })

  it('records the recipe by message identity + fingerprint, never the body', async () => {
    await runLoop(ECHO_TOOL)

    const recipe = (await readSessionLogEvents(SESSION_ID)).find(
      event => event.type === 'request/recipe',
    )
    expect(recipe?.type === 'request/recipe' && recipe.data.messages).toEqual([
      { messageId: 'user-1', contentHash: expect.stringMatching(/^[0-9a-f]{16}$/) },
    ])
    expect(recipe?.type === 'request/recipe' && Object.keys(recipe.data)).not.toContain('content')
  })

  it('records the response envelope without a second copy of the text', async () => {
    await runLoop(ECHO_TOOL)

    const responses = (await readSessionLogEvents(SESSION_ID)).filter(
      event => event.type === 'request/response',
    )
    expect(responses).toHaveLength(2)
    const first = responses[0]
    expect(first.type === 'request/response' && first.data).toMatchObject({
      requestIndex: 1,
      messageId: 'assistant-1',
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      toolCallIds: ['call-1'],
    })
    expect(first.type === 'request/response' && first.data.parts).toEqual([
      { partIndex: 0, kind: 'text', len: 'let me look'.length, hash: expect.any(String) },
    ])
    for (const key of ['text', 'content', 'reasoning']) {
      expect(first.type === 'request/response' && Object.keys(first.data)).not.toContain(key)
    }
  })

  it('carries the full tool result in the event, and the preview beside it', async () => {
    await runLoop({
      ...ECHO_TOOL,
      async execute() {
        return { content: 'x'.repeat(1200) }
      },
    })

    const result = (await readSessionLogEvents(SESSION_ID)).find(
      event => event.type === 'tool/result',
    )
    expect(result?.type === 'tool/result' && result.data.resultPreview).toHaveLength(501)
    expect(result?.type === 'tool/result' && result.data.result).toEqual({ text: 'x'.repeat(1200) })
  })

  it('spills a >64KB tool result into a blob and leaves only the reference', async () => {
    const big = 'y'.repeat(70 * 1024)
    await runLoop({
      ...ECHO_TOOL,
      async execute() {
        return { content: big }
      },
    })

    const result = (await readSessionLogEvents(SESSION_ID)).find(
      event => event.type === 'tool/result',
    )
    const payload = result?.type === 'tool/result' ? result.data.result : undefined
    expect(payload && 'blob' in payload).toBe(true)
    if (payload && 'blob' in payload) {
      expect(payload.blob.bytes).toBe(Buffer.byteLength(big, 'utf8'))
      const onDisk = fs.readFileSync(
        path.join(state.sessionsDir, SESSION_ID, 'blobs', payload.blob.hash),
        'utf8',
      )
      expect(onDisk).toBe(big)
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
    await runLoop(ECHO_TOOL, { systemPrompt: 'you are a test' })
    await runLoop(ECHO_TOOL, { systemPrompt: 'you are a test — now with a fresh variable block' })

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

    const events = await readSessionLogEvents(SESSION_ID)
    expect(events.filter(event => event.type === 'request/tools')).toHaveLength(1)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
    // seq 跨重启继续单调递增,没有回头。
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1))
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

  /**
   * §10.12 第 6 类:**失败的调用没有结局对象**,标题只剩过程中那条 `annotate`
   * 记得住。引擎当场拿它盖掉 step 标题(`applyAgentLoopToolMetadata`),所以
   * 账本上也必须有 —— 否则投影只能退回派生标题("Tool: read: …")。
   */
  it('carries the tool self-reported title onto a failed result', async () => {
    await runLoop({
      name: 'echo',
      description: 'Echo the input back',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(_args, context) {
        context?.onMetadata?.({ title: 'Reading a.md' })
        // 收尾只带 metadata 的那条不该把标题清空(与 `IpcProjector` 同规则)。
        context?.onMetadata?.({ metadata: { phase: 'done' } })
        return { content: '', error: 'Offset 330 is beyond end of file', data: { success: false, error: 'Offset 330 is beyond end of file' } }
      },
    })

    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data).toMatchObject({
      callId: 'call-1',
      isError: true,
      reportedTitle: 'Reading a.md',
    })
    const data = result?.type === 'tool/result' ? result.data.resultData : undefined
    expect(data && 'text' in data ? JSON.parse(data.text) : undefined).toEqual({
      success: false,
      error: 'Offset 330 is beyond end of file',
    })
  })

  /**
   * §13.17:edit/write 的结构化 diff 藏在 `tool-metadata`(diff/diffHunks/path/…),
   * 结局正文派生不出。采集点把它抄进 `tool/result.changes`(≤64KB 行内)。
   */
  it('collects edit changes from tool-metadata into tool/result.changes', async () => {
    await runLoop({
      name: 'echo',
      description: 'Edit a file',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(_args, context) {
        context?.onMetadata?.({
          title: 'Editing a.ts',
          metadata: {
            diff: '@@ -1 +1 @@\n-old\n+new',
            diffHunks: [{
              oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
              lines: [{ op: 'del', text: 'old' }, { op: 'add', text: 'new' }],
            }],
            path: 'a.ts',
            additions: 1,
            deletions: 1,
          },
        })
        return { content: 'ok', data: { success: true } }
      },
    })

    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    const changes = result?.type === 'tool/result' ? result.data.changes : undefined
    expect(changes && 'text' in changes ? JSON.parse(changes.text) : undefined).toMatchObject({
      diff: '@@ -1 +1 @@\n-old\n+new',
      filePath: 'a.ts',
      additions: 1,
      deletions: 1,
      hunks: [{
        oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{ op: 'del', text: 'old' }, { op: 'add', text: 'new' }],
      }],
    })
    // originalContent 从不进这条链。
    expect(changes && 'text' in changes ? JSON.parse(changes.text).originalContent : undefined).toBeUndefined()
  })

  /**
   * §13.17 体积纪律:序列化超 64KB 的 changes 走 blob(与 resultData 同一条线);
   * blob 引用检查靠 verify 的 collectBlobHashes 递归识别(事件里的 BlobRef)。
   */
  it('spills an oversized changes payload to a blob', async () => {
    const bigDiff = 'x'.repeat(70_000)
    await runLoop({
      name: 'echo',
      description: 'Edit a big file',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
      async execute(_args, context) {
        context?.onMetadata?.({ metadata: { diff: bigDiff, path: 'big.ts', additions: 1, deletions: 0 } })
        return { content: 'ok', data: { success: true } }
      },
    })
    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    const changes = result?.type === 'tool/result' ? result.data.changes : undefined
    expect(changes && 'blob' in changes).toBe(true)
    if (changes && 'blob' in changes) {
      expect(fs.existsSync(path.join(state.sessionsDir, SESSION_ID, 'blobs', changes.blob.hash))).toBe(true)
    }
  })

  /**
   * §10.12 第 5 类:steering 换的是助手消息、不是执行。账本上两条 run,
   * 新的那条必须把被接手的 runId 带上,否则投影只能按"每条 run 从第 1 轮数起"
   * 猜 —— 回合号、推理落点、usage 三样全错。
   */
  it('stamps continuesRunId when a steer rotates the run', async () => {
    const first = beginSessionRun(SESSION_ID, { kind: 'send', assistantMessageId: 'assistant-1' })
    const second = rotateSessionRun(SESSION_ID, { kind: 'steer', assistantMessageId: 'assistant-2' })
    endSessionRun(SESSION_ID, second.runId, { outcome: 'completed' })
    await flushSessionEventLog(SESSION_ID)

    const starts = (await readSessionLogEvents(SESSION_ID)).filter(event => event.type === 'run/start')
    expect(starts).toHaveLength(2)
    expect(starts[0].type === 'run/start' && starts[0].data.continuesRunId).toBeUndefined()
    expect(starts[1].type === 'run/start' && starts[1].data.continuesRunId).toBe(first.runId)
  })

  /**
   * A1(§13.1):**provider-data 是一格 part,而且是一条分段边界**。
   *
   * 引擎的 `appendOrderedPart` 只合并相邻同类,一块 Claude 思考签名夹在两段正文
   * 之间就把它们切成两格。采集点从前没有这个词汇(`provider-data` 那一支只嗅了
   * responseId/model 就 return),于是两段正文攒进同一个 partIndex —— 投影出来
   * 的 contentParts 永远比事实少一格。
   */
  it('A1: a provider-data event opens its own part and cuts the text run', async () => {
    const provider: AgentProvider = {
      ...testProvider(),
      async *streamTurn(): AsyncIterable<AgentTurnStreamEvent> {
        yield { type: 'text-delta', turn: 1, delta: 'before' }
        yield {
          type: 'provider-data',
          turn: 1,
          providerData: { provider: 'anthropic', type: 'thinking-signature', signature: 'sig-abc' },
        }
        yield { type: 'text-delta', turn: 1, delta: 'after' }
        yield { type: 'finish', turn: 1, finishReason: 'stop' }
      },
    }
    await runLoopWithProvider(provider)

    const events = await readSessionLogEvents(SESSION_ID)
    const parts = events.filter(event => event.type === 'assistant/part-end')
    expect(parts.map(event => event.type === 'assistant/part-end' && event.data.kind))
      .toEqual(['text', 'provider-data', 'text'])
    // partIndex 单调:provider-data 占了中间那一号,两段正文因此各自成段。
    expect(parts.map(event => event.type === 'assistant/part-end' && event.data.partIndex))
      .toEqual([0, 1, 2])
    const payload = parts[1].type === 'assistant/part-end' ? parts[1].data.providerData : undefined
    expect(payload && 'text' in payload && JSON.parse(payload.text)).toEqual({
      provider: 'anthropic', type: 'thinking-signature', signature: 'sig-abc',
    })
    // 正文照旧只有两段 delta,分别落在两个 partIndex 上。
    const chunks = events.filter(event => event.type === 'assistant/chunks')
    expect(chunks.map(event => event.type === 'assistant/chunks' && event.data.partIndex)).toEqual([0, 2])
  })

  /**
   * A6+A7(§13.1):工具身份归一进账本。原始名照旧记(它是 wire 上的事实),
   * 归一后的两格与消息上那两格同源 —— 判定点只有一个,由宿主注入。
   */
  it('A6+A7: tool/call carries the resolved identity beside the raw name', async () => {
    const provider: AgentProvider = {
      ...testProvider(),
      async *streamTurn(request): AsyncIterable<AgentTurnStreamEvent> {
        if (request.turn === 1) {
          yield {
            type: 'tool-call-done',
            turn: 1,
            toolCall: { id: 'call-1', name: 'echo', arguments: '{"text":"hi"}' },
          }
          yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
          return
        }
        yield { type: 'text-delta', turn: 2, delta: 'done' }
        yield { type: 'finish', turn: 2, finishReason: 'stop' }
      },
    }
    await runLoopWithProvider(provider, {
      resolveToolIdentity: (toolName, args) => {
        expect(toolName).toBe('echo')
        // 引擎那一份会看参数(`findMCPToolIdByShortName`),所以端口也拿得到。
        expect(args).toEqual({ text: 'hi' })
        return { toolId: 'mcp__docs__echo', displayName: 'docs' }
      },
    })

    const call = (await readSessionLogEvents(SESSION_ID)).find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && call.data).toMatchObject({
      name: 'echo',
      resolvedToolId: 'mcp__docs__echo',
      displayName: 'docs',
    })
  })

  /** 不注入端口 = 老形状:只有原始名,投影退回它(§10.16 的成对交付另一半)。 */
  it('A6+A7: without the resolver the event keeps exactly the old shape', async () => {
    await runLoop(ECHO_TOOL)

    const call = (await readSessionLogEvents(SESSION_ID)).find(event => event.type === 'tool/call')
    const data = call?.type === 'tool/call' ? call.data : undefined
    expect(data?.name).toBe('echo')
    expect(data && 'resolvedToolId' in data).toBe(false)
    expect(data && 'displayName' in data).toBe(false)
  })

  /**
   * A14(§13.1):codex 内联生图那段 markdown 是**引擎合成的** —— provider 流里
   * 没有对应的 text-delta,所以采集点只能由宿主告知。走的是与 text-delta 同一条
   * `deltaInto('text')`,于是它与前后正文的合并规则天然一致。
   */
  it('A14: engine-synthesized text lands in assistant/chunks like any other delta', async () => {
    const provider: AgentProvider = {
      ...testProvider(),
      async *streamTurn(): AsyncIterable<AgentTurnStreamEvent> {
        yield { type: 'text-delta', turn: 1, delta: 'here: ' }
        yield { type: 'finish', turn: 1, finishReason: 'stop' }
      },
    }
    await runLoopWithProvider(provider, {
      onRecorderReady: recorder => recorder.recordSynthesizedText('![img](media://x.png)'),
    })

    const chunks = (await readSessionLogEvents(SESSION_ID))
      .filter(event => event.type === 'assistant/chunks')
    const text = chunks
      .flatMap(event => (event.type === 'assistant/chunks' ? event.data.text : []))
      .join('')
    // 修复前这段 markdown 在账本上**根本不存在**,`content` 的 fold 因此永远短一截。
    expect(text).toBe('here: ![img](media://x.png)')
  })

  /**
   * A11(§13.1):**引擎藏起来的调用**。可见性的判定点在引擎(处理器的
   * `rememberVisibility`),记录器只**问**;老文件没有这一格 = 可见。
   */
  it('A11: tool/call carries hidden when the engine kept the call off the message', async () => {
    await runLoop(ECHO_TOOL, { isToolCallHidden: () => true })
    const hidden = (await readSessionLogEvents(SESSION_ID)).find(event => event.type === 'tool/call')
    expect(hidden?.type === 'tool/call' && hidden.data.hidden).toBe(true)
  })

  it('A11: without the port the event keeps exactly the old shape', async () => {
    await runLoop(ECHO_TOOL)
    const call = (await readSessionLogEvents(SESSION_ID)).find(event => event.type === 'tool/call')
    const data = call?.type === 'tool/call' ? call.data : undefined
    expect(data && 'hidden' in data).toBe(false)
  })

  /**
   * F13(§13.2):**开不出段就丢账**从前是三个静默的 `return undefined`。
   * 现在它至少是账单上的一个数(`sessions:shadow-report` 打印它)。
   */
  it('F13: a part that cannot be opened is counted instead of vanishing silently', async () => {
    const before = readSessionShadowStats().droppedParts
    // 没有活跃 run = 分不到 partIndex(收尾之后迟到的那一段就是这个处境)。
    resetSessionRuns()
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => 'assistant-1',
    })
    recorder.handle({ type: 'turn-start', turn: 1 } as never)
    recorder.handle({ type: 'text-delta', turn: 1, delta: 'lost' } as never)
    expect(readSessionShadowStats().droppedParts).toBeGreaterThan(before)
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
  /**
   * §13.8 第一类:**收场那一刻记下引擎写在消息上的取消结局**。
   *
   * 中止时工具永远不会报 `tool-result` —— 账本上只剩 `tool/call`,而消息上
   * 引擎写着执行途中已经落下的结局与工具自报的标题(真机 `sleep 20` /
   * `提问已取消` 那两条)。采集点交的是**引擎写下的那一份**,记录器只负责
   * "哪几次调用还没有结局"与那条自报标题(与正常那条路同源)。
   */
  it('§13.8-1: records what the engine wrote onto a call that never reported a result', async () => {
    const run = beginSessionRun(SESSION_ID, { kind: 'send', assistantMessageId: 'assistant-1' })
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => 'assistant-1',
    })
    const toolCall = { id: 'call-1', name: 'bash', arguments: '{"command":"sleep 20"}' }
    recorder.handle({ type: 'turn-start', turn: 1 } as never)
    recorder.handle({ type: 'tool-call-done', turn: 1, toolCall } as never)
    recorder.handle({ type: 'tool-metadata', turn: 1, toolCall, update: { title: 'sleep 20' } } as never)

    expect(recorder.recordCancelledToolResults([{ callId: 'call-1', result: '{"content":[]}' }])).toBe(1)
    endSessionRun(SESSION_ID, run.runId, { outcome: 'aborted' })
    await flushSessionEventLog(SESSION_ID)

    const result = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data).toMatchObject({
      callId: 'call-1',
      cancelled: true,
      // 收场判死不是"工具失败" —— 那句话由 run 的收场方式派生,不写在这里。
      isError: false,
      reportedTitle: 'sleep 20',
      result: { text: '{"content":[]}' },
    })
    // 因果引用照旧:它指向自己那条 `tool/call`。
    const call = (await readSessionEvents(SESSION_ID)).find(event => event.type === 'tool/call')
    expect(result?.type === 'tool/result' && result.data.sourceSeq).toBe(call?.seq)
  })

  it('§13.8-1: a call that already reported a result is never rewritten', async () => {
    await runLoop(ECHO_TOOL)
    const before = (await readSessionEvents(SESSION_ID)).filter(event => event.type === 'tool/result').length
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => 'assistant-1',
    })
    expect(recorder.recordCancelledToolResults([{ callId: 'call-1', result: 'late' }])).toBe(0)
    await flushSessionEventLog(SESSION_ID)
    const after = (await readSessionEvents(SESSION_ID)).filter(event => event.type === 'tool/result').length
    expect(after).toBe(before)
  })

  /**
   * §16.9(F2-c):**工具自报结局拿到自己的产地**。
   *
   * 从前这两格只攒在记录器的内存表里,等 `tool/result` 落账时顺带写出去 ——
   * 而 §15.6 的退出竞速里那条 `tool/result` 永远不会来(收尾链挂在异步上,
   * 进程先走了),两格于是永久消失。现在工具每说一次,账本记一条 `tool/annotate`。
   */
  it('§16.9: every annotate lands as its own tool/annotate (title + self-reported result)', async () => {
    const run = beginSessionRun(SESSION_ID, { kind: 'send', assistantMessageId: 'assistant-1' })
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => 'assistant-1',
    })
    const toolCall = { id: 'call-1', name: 'ask_user', arguments: '{}' }
    recorder.handle({ type: 'turn-start', turn: 1 } as never)
    recorder.handle({ type: 'tool-call-done', turn: 1, toolCall } as never)
    recorder.handle({
      type: 'tool-metadata',
      turn: 1,
      toolCall,
      update: { title: '提问已取消', metadata: { interaction: 'ask_user', outcome: 'aborted' } },
    } as never)
    // 退出竞速:`tool/result` 这条永远不会来。
    endSessionRun(SESSION_ID, run.runId, { outcome: 'aborted' })
    await flushSessionEventLog(SESSION_ID)

    const annotate = (await readSessionLogEvents(SESSION_ID)).find(event => event.type === 'tool/annotate')
    expect(annotate?.type === 'tool/annotate' && annotate.data).toMatchObject({
      callId: 'call-1',
      runId: run.runId,
      title: '提问已取消',
      // 正文过的是引擎那把 `resultTextFromToolMetadata`,不是采集点自己写的规则。
      result: { text: JSON.stringify({ interaction: 'ask_user', outcome: 'aborted' }) },
    })
  })

  it('§16.9: 逐字相同的 metadata 不再重写 result 那一格(标题照旧每条都写)', async () => {
    const run = beginSessionRun(SESSION_ID, { kind: 'send', assistantMessageId: 'assistant-1' })
    const recorder = createSessionEventRecorder({
      sessionId: SESSION_ID,
      providerId: 'test-provider',
      model: 'test-model',
      getMessageId: () => 'assistant-1',
    })
    const toolCall = { id: 'call-1', name: 'edit', arguments: '{}' }
    recorder.handle({ type: 'turn-start', turn: 1 } as never)
    recorder.handle({ type: 'tool-call-done', turn: 1, toolCall } as never)
    const metadata = { path: '/a.ts', diff: '@@ -1 +1 @@', additions: 1, deletions: 0 }
    // edit 收尾那两条:同一份 metadata,只差一个标题。
    recorder.handle({ type: 'tool-metadata', turn: 1, toolCall, update: { metadata } } as never)
    recorder.handle({ type: 'tool-metadata', turn: 1, toolCall, update: { title: 'Edited a.ts', metadata } } as never)
    endSessionRun(SESSION_ID, run.runId, { outcome: 'aborted' })
    await flushSessionEventLog(SESSION_ID)

    const annotates = (await readSessionLogEvents(SESSION_ID)).filter(event => event.type === 'tool/annotate')
    expect(annotates).toHaveLength(2)
    expect(annotates[0].type === 'tool/annotate' && annotates[0].data.result).toEqual({
      text: JSON.stringify(metadata),
    })
    expect(annotates[0].type === 'tool/annotate' && annotates[0].data.title).toBeUndefined()
    // 第二条只补标题 —— 正文一字不差,不再抄一份(diff 可以有上百 KB)。
    expect(annotates[1].type === 'tool/annotate' && annotates[1].data.title).toBe('Edited a.ts')
    expect(annotates[1].type === 'tool/annotate' && annotates[1].data.result).toBeUndefined()
  })

  /**
   * §13.9:**外部执行器的形状** —— 一次请求,里面好几个回合。
   *
   * Claude Code SDK 连接器把一整段多轮会话装进一次 `streamTurn`:工具由它自己
   * 执行(`externallyExecuted`),工具结果到齐后发一条 `finish(tool_calls)` 当轮
   * 分界,runner **当场转发**(`agent-loop/runner.ts` 那段 2026-08-11 的注释)。
   * 这里跑的是**真的** agent-loop + 真的记录器,provider 说的就是那套话。
   */
  function externalRoundBoundaryProvider(): AgentProvider {
    const toolCall = {
      id: 'call-1',
      name: 'echo',
      arguments: '{"text":"hi"}',
      externallyExecuted: true,
    }
    return {
      ...testProvider(),
      async *streamTurn(): AsyncIterable<AgentTurnStreamEvent> {
        yield { type: 'text-delta', turn: 1, delta: '先算一下' }
        yield { type: 'tool-call-start', turn: 1, toolCallId: toolCall.id, toolName: toolCall.name }
        yield { type: 'tool-call-done', turn: 1, toolCall }
        yield { type: 'tool-result', turn: 1, toolCall, result: { content: 'echoed hi' } }
        // 轮分界:不带 usage(SDK 只在最后那条 result 消息里报总量)。
        yield { type: 'finish', turn: 1, finishReason: 'tool_calls' }
        yield { type: 'text-delta', turn: 1, delta: '答案是 391' }
        yield {
          type: 'finish',
          turn: 1,
          finishReason: 'stop',
          usage: { inputTokens: 4, outputTokens: 93, totalTokens: 97 },
        }
      },
    }
  }

  it('§13.9: an inner round boundary cuts the part and advances the recorded turn', async () => {
    await runLoopWithProvider(externalRoundBoundaryProvider())

    const events = await readSessionLogEvents(SESSION_ID)
    // 账本上**只有一次请求** —— 分界不是 turn-start。
    expect(events.filter(event => event.type === 'request/start')).toHaveLength(1)

    const textParts = events.filter(
      event => event.type === 'assistant/part-end' && event.data.kind === 'text',
    )
    // 分界前后各自成段(不收段的话两段正文会折进同一个 partIndex),
    // 回合号跟着引擎走:1 → 2。
    expect(textParts.map(event => event.type === 'assistant/part-end' && event.data.turnIndex))
      .toEqual([1, 2])
    expect(new Set(textParts.map(
      event => event.type === 'assistant/part-end' && event.data.partIndex,
    )).size).toBe(2)

    const call = events.find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && call.data.turnIndex).toBe(1)

    // 用量归属:带 usage 的是**最后**那条 finish —— 那时回合号已经是 2。
    const response = events.find(event => event.type === 'request/response')
    expect(response?.type === 'request/response' && response.data.usageTurnIndex).toBe(2)
    expect(response?.type === 'request/response' && response.data.usage?.outputTokens).toBe(93)
  })

  /** 普通 provider(一次请求一条 finish):两格新词汇照旧是 1,一个字节不变。 */
  it('§13.9: an ordinary two-request loop stamps the turn the request already implied', async () => {
    await runLoop(ECHO_TOOL)

    const events = await readSessionLogEvents(SESSION_ID)
    const call = events.find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' && call.data.turnIndex).toBe(1)
    const responses = events.filter(event => event.type === 'request/response')
    expect(responses.map(event => event.type === 'request/response' && event.data.usageTurnIndex))
      .toEqual([1, 2])
    const parts = events.filter(event => event.type === 'assistant/part-end')
    expect(parts.map(event => event.type === 'assistant/part-end' && event.data.turnIndex))
      .toEqual([1, 2])
  })
})
