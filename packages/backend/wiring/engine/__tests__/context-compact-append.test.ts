/**
 * P0 追加式 compaction entry + P3 后端时限
 * (docs/design/context-compact-fix-2026-08.md §4)。
 *
 * 钉三件事:
 *
 *  1. 压缩标记**追加在 session.messages 末尾**,不再插进历史中部 —— 后端从前
 *     用 insertMessageAfter 插在切点后面,而渲染器的 handleMessageCreated 一律
 *     push 到尾部;重载一次标记就"跳位"。
 *  2. 切点语义没丢:它写进内容的 `compactedThroughMessageId`;并且模型历史
 *     **与标记位置无关**(只按 summaryUpToMessageId 切片)。
 *  3. P3:单块摘要请求超时 → 走既有失败路径,marker 改 failed。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installSessionLayerForTest } from '../../../session/testing/session-layer.js'

let storeDir: string
let sessionFixture: ReturnType<typeof installSessionLayerForTest>
beforeEach(() => {
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-test-'))
  vi.stubEnv('ONETHING_STORE_PATH', storeDir)
  sessionFixture = installSessionLayerForTest({ store: { getSessionRaw: () => sessionRef.current, readSessionTranscriptFile: () => '' } })
})
afterEach(async () => {
  await sessionFixture.dispose()
  vi.unstubAllEnvs()
  fs.rmSync(storeDir, { recursive: true, force: true })
})
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import { CONTEXT_COMPACT_CHUNK_TIMEOUT_MS } from '@onething/core/engine'
import { buildHistoryMessages } from '../stream/message-helpers.js'

const runBeforeContextCompactHooks = vi.fn()
const generateChatResponse = vi.fn()
const summaryWrites: Array<{ summary: string; cutoff: string }> = []
const contentWrites: Array<{ messageId: string; content: string }> = []

vi.mock('@onething/runtime/plugins/lifecycle.wiring', () => ({
  runBeforeContextCompactHooks: (...args: unknown[]) => runBeforeContextCompactHooks(...args),
}))
vi.mock('../../providers/index.js', () => ({
  generateChatResponse: (...args: unknown[]) => generateChatResponse(...args),
}))
// 块大小随模型窗口走(2026-08-21):窗口大 → 单块;想逼出多块就把窗口调小。
let modelContextLength = 200_000

// 注册输出上限也做成活的:2026-09-08 的夹法只有在「上限接近窗口」时才看得见。
let registeredMaxOutputTokens = 8_192

vi.mock('../../providers/model-registry.js', () => ({
  getModelContextLength: async () => modelContextLength,
  getModelMaxOutputTokens: async () => registeredMaxOutputTokens,
  getKnownModelMaxOutputTokens: async () => registeredMaxOutputTokens,
}))

const sessionRef: { current: ChatSession } = { current: null as unknown as ChatSession }
vi.mock('../../../session/commands.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../session/commands.js')>(),
  sessionCommands: {
  appendMessage: (_sessionId: string, { message }: { message: ChatMessage }) => {
    sessionRef.current.messages.push(message)
    return message
  },
} }))

vi.mock('../../../session/reads.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../session/reads.js')>(),
  // 读门面(P0.2 C1):这份 mock 与下面的 store mock 是同一个假会话
  // —— compact 的取数改走 `sessionReads.listMessages` 了。
  sessionReads: {
    listMessages: () => ({ messages: sessionRef.current?.messages ?? [], changed: false }),
    getMessage: (_sessionId: string, messageId: string) =>
      sessionRef.current?.messages.find((message: { id: string }) => message.id === messageId),
    // 2026-09-08:切块的 chars/token 比要拿 provider 真数(contextSize /
    // lastInputTokens)校准,读的也是这个门面。
    getSession: () => sessionRef.current,
  },
}))
vi.mock('../../../store.js', () => ({
  getSession: () => sessionRef.current,
  addMessage: (_sessionId: string, message: ChatMessage) => {
    sessionRef.current.messages.push(message)
  },
  updateSessionSummary: (_sessionId: string, summary: string, cutoff: string) => {
    summaryWrites.push({ summary, cutoff })
    sessionRef.current.summary = summary
    sessionRef.current.summaryUpToMessageId = cutoff
  },
  updateMessageContent: (_sessionId: string, messageId: string, content: string) => {
    contentWrites.push({ messageId, content })
    const target = sessionRef.current.messages.find(message => message.id === messageId)
    if (target) target.content = content
  },
  updateSessionContextSize: () => {},
}))

const { compactSessionContext } = await import('../context-compact.js')

function message(index: number, role: 'user' | 'assistant'): ChatMessage {
  return { id: `${role}-${index}`, role, content: `${role} ${index}`, timestamp: index }
}

function makeSession(): ChatSession {
  return {
    id: 's1',
    name: 'Test',
    createdAt: 0,
    updatedAt: 0,
    // 没有 provider 真数:chars/token 回退估算器,与 2026-09-08 校准之前
    // 逐字同行为。要走校准那条路的用例自己往 sessionRef 上写 contextSize。
    messages: [
      message(1, 'user'), message(2, 'assistant'),
      message(3, 'user'), message(4, 'assistant'),
      message(5, 'user'), message(6, 'assistant'),
      message(7, 'user'), message(8, 'assistant'),
    ],
  } as ChatSession
}

const baseOptions = {
  sessionId: 's1',
  providerId: 'openai',
  configWithApiKey: { model: 'gpt-x', apiKey: 'sk' } as never,
  settings: { chat: {} } as never,
  keepRecentTurns: 2,
}

function parseContent(content: string) {
  return JSON.parse(content) as {
    type: string
    status: string
    summary: string
    compactedMessageCount: number
    error?: string
    compactedThroughMessageId?: string
    progress?: { chunk: number; totalChunks: number }
  }
}

beforeEach(() => {
  runBeforeContextCompactHooks.mockReset()
  runBeforeContextCompactHooks.mockResolvedValue(undefined)
  generateChatResponse.mockReset()
  generateChatResponse.mockResolvedValue('## Goal\nHOST SUMMARY')
  summaryWrites.length = 0
  contentWrites.length = 0
  modelContextLength = 200_000
  registeredMaxOutputTokens = 8_192
  sessionRef.current = makeSession()
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('P0 追加式 compaction entry', () => {
  it('把标记追加到 session.messages 末尾,并把切点写进内容', async () => {
    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(true)

    const messages = sessionRef.current.messages
    const marker = messages[messages.length - 1]
    expect(marker.role).toBe('system')

    const content = parseContent(marker.content as string)
    expect(content.type).toBe('context-compact')
    expect(content.status).toBe('completed')
    // 切点 = 计划里的 cutoffMessage(保留最近 2 个用户轮 → 切在 assistant-4)。
    expect(content.compactedThroughMessageId).toBe('assistant-4')
    expect(result.compactedThroughMessageId).toBe('assistant-4')
    expect(summaryWrites[0]?.cutoff).toBe('assistant-4')

    // 标记只有一条,而且不在中部。
    expect(messages.filter(item => item.role === 'system')).toHaveLength(1)
    expect(messages.indexOf(marker)).toBe(messages.length - 1)
  })

  it('创建时的占位内容(compacting)就已经带上切点', async () => {
    const created: ChatMessage[] = []
    await compactSessionContext({
      ...baseOptions,
      onMessageCreated: async (message: ChatMessage) => {
        created.push({ ...message })
      },
    })

    expect(created).toHaveLength(1)
    const content = parseContent(created[0].content as string)
    expect(content.status).toBe('compacting')
    expect(content.compactedThroughMessageId).toBe('assistant-4')
  })

  it('buildHistoryMessages 的输出与标记在数组里的位置无关', async () => {
    await compactSessionContext(baseOptions)

    const compacted = sessionRef.current
    const marker = compacted.messages[compacted.messages.length - 1]

    // 同一份会话的两种布局:标记在尾部(P0 之后)vs 标记插在切点之后(P0 之前
    // 的旧会话)。模型历史必须逐字相同 —— 标记是纯展示物。
    const tailLayout = { ...compacted, messages: [...compacted.messages] } as ChatSession
    const withoutMarker = compacted.messages.filter(item => item !== marker)
    const cutoffIndex = withoutMarker.findIndex(item => item.id === 'assistant-4')
    const middleLayout = {
      ...compacted,
      messages: [
        ...withoutMarker.slice(0, cutoffIndex + 1),
        marker,
        ...withoutMarker.slice(cutoffIndex + 1),
      ],
    } as ChatSession

    expect(middleLayout.messages.indexOf(marker)).toBeLessThan(middleLayout.messages.length - 1)
    expect(buildHistoryMessages(middleLayout.messages, middleLayout))
      .toEqual(buildHistoryMessages(tailLayout.messages, tailLayout))
  })
})

describe('P3 后端时限与进度', () => {
  it('chunk 超时 → marker 改 failed,结果是失败(引擎据此发 compact-completed(false))', async () => {
    generateChatResponse.mockImplementation(
      (_providerId: string, _config: unknown, _messages: unknown, options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    vi.useFakeTimers()
    const pending = compactSessionContext(baseOptions)
    await vi.advanceTimersByTimeAsync(CONTEXT_COMPACT_CHUNK_TIMEOUT_MS + 1)
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')

    const marker = sessionRef.current.messages[sessionRef.current.messages.length - 1]
    const content = parseContent(marker.content as string)
    expect(content.status).toBe('failed')
    expect(content.error).toContain('timed out')
    // 失败的标记同样带切点 —— 卡片要说清"打算压到哪儿"。
    expect(content.compactedThroughMessageId).toBe('assistant-4')
  })

  it('超时可配:settings.chat.contextCompactChunkTimeoutSeconds 决定单块时限(默认 300s 不到不超时)', async () => {
    generateChatResponse.mockImplementation(
      (_providerId: string, _config: unknown, _messages: unknown, options: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

    vi.useFakeTimers()
    const settings = baseOptions.settings as { chat?: Record<string, unknown> }
    const pending = compactSessionContext({
      ...baseOptions,
      settings: { ...settings, chat: { ...settings.chat, contextCompactChunkTimeoutSeconds: 600 } } as typeof baseOptions.settings,
    })
    // 默认 300s 已过、配置的 600s 未到:仍在等。
    await vi.advanceTimersByTimeAsync(CONTEXT_COMPACT_CHUNK_TIMEOUT_MS + 1)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(300_000)
    const result = await pending
    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out after 600s')
  })

  it('单块摘要不刷进度(不多发一条 message:updated)', async () => {
    const updates: Array<{ messageId: string; content: string }> = []
    await compactSessionContext({
      ...baseOptions,
      onMessageUpdated: async (messageId: string, patch: { content?: string }) => {
        updates.push({ messageId, content: patch.content ?? '' })
      },
    })

    // 只有最终的 completed 那一次。
    expect(updates).toHaveLength(1)
    expect(parseContent(updates[0].content).status).toBe('completed')
    expect(parseContent(updates[0].content).progress).toBeUndefined()
  })

  it('200k 窗口下 120k 字符仍是单块(块大小随窗口走,不再被写死的 80k 硬切)', async () => {
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)
    const progress: Array<{ chunk: number; totalChunks: number }> = []

    const result = await compactSessionContext({ ...baseOptions, onProgress: p => { progress.push(p) } })

    expect(result.success).toBe(true)
    expect(generateChatResponse).toHaveBeenCalledTimes(1)
    expect(progress).toEqual([])
  })

  it('C6:多块摘要每步完成后 onProgress 各回调一次(N 块 + 1 次合并);单块不回调', async () => {
    const single: Array<{ chunk: number; totalChunks: number }> = []
    await compactSessionContext({ ...baseOptions, onProgress: p => { single.push(p) } })
    expect(single).toEqual([])

    // 窗口调小 → 同一份内容被切成多块。
    modelContextLength = 20_000
    generateChatResponse.mockClear()
    sessionRef.current = makeSession()
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)
    const many: Array<{ chunk: number; totalChunks: number }> = []
    await compactSessionContext({ ...baseOptions, onProgress: p => { many.push(p) } })

    expect(many.length).toBeGreaterThan(1)
    expect(many.map(p => p.chunk)).toEqual(many.map((_, index) => index + 1))
    expect(new Set(many.map(p => p.totalChunks)).size).toBe(1)
    // 最后一步 = 合并,总步数 = 块数 + 1。
    expect(many[many.length - 1].chunk).toBe(many[0].totalChunks)
    expect(generateChatResponse).toHaveBeenCalledTimes(many[0].totalChunks)
  })

  it('多块摘要每步完成后刷一次带 progress 的 compacting 内容', async () => {
    // 窗口调小,把待压内容逼成多块。
    modelContextLength = 20_000
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)

    const updates: Array<{ status: string; progress?: { chunk: number; totalChunks: number } }> = []
    await compactSessionContext({
      ...baseOptions,
      onMessageUpdated: async (_messageId: string, patch: { content?: string }) => {
        const parsed = parseContent(patch.content ?? '')
        updates.push({ status: parsed.status, progress: parsed.progress })
      },
    })

    const progressUpdates = updates.filter(update => update.status === 'compacting')
    expect(progressUpdates.length).toBeGreaterThan(0)
    const totals = progressUpdates.map(update => update.progress?.totalChunks)
    expect(new Set(totals).size).toBe(1)
    expect(progressUpdates[0].progress?.chunk).toBe(1)
    expect(progressUpdates.map(update => update.progress?.chunk))
      .toEqual(progressUpdates.map((_, index) => index + 1))
    // 最后一条一定是 completed。
    expect(updates[updates.length - 1].status).toBe('completed')
  })

  it('一块失败 → 其余在途块被批中止,错误原样冒出(不报成超时)', async () => {
    modelContextLength = 20_000
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)

    const signals: AbortSignal[] = []
    let calls = 0
    generateChatResponse.mockImplementation(
      (_providerId: string, _config: unknown, _messages: unknown, options: { abortSignal?: AbortSignal }) => {
        if (options.abortSignal) signals.push(options.abortSignal)
        calls += 1
        // 第一块直接炸,其余块挂着等批中止。
        if (calls === 1) return Promise.reject(new Error('provider exploded'))
        return new Promise((_resolve, reject) => {
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    )

    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(false)
    expect(result.error).toBe('provider exploded')
    expect(result.error).not.toContain('timed out')
    // 同批在途的其余块都被掐掉了。
    expect(signals.length).toBeGreaterThan(1)
    expect(signals.slice(1).every(signal => signal.aborted)).toBe(true)
  })
})

describe('C5 确定性文件清单', () => {
  function toolCall(toolId: string, args: Record<string, unknown>) {
    return { id: `call-${toolId}-${args.path}`, toolId, toolName: toolId, arguments: args, status: 'completed' }
  }

  it('LLM 摘要返回后,两张清单由代码附到尾部', async () => {
    const session = sessionRef.current
    ;(session.messages[1] as ChatMessage).toolCalls = [
      toolCall('read', { path: '/repo/a.ts' }),
      toolCall('edit', { path: '/repo/b.ts' }),
      // bash 跳过:命令文本里的路径不解析。
      toolCall('bash', { command: 'cat /repo/never.ts' }),
    ] as never

    const result = await compactSessionContext(baseOptions)

    expect(result.summary).toBe(
      '## Goal\nHOST SUMMARY\n\n<read-files>\n/repo/a.ts\n</read-files>\n\n<modified-files>\n/repo/b.ts\n</modified-files>',
    )
    expect(summaryWrites[0]?.summary).toBe(result.summary)
    expect(result.summary).not.toContain('/repo/never.ts')
  })

  it('没有文件操作时一个标签都不加', async () => {
    const result = await compactSessionContext(baseOptions)
    expect(result.summary).toBe('## Goal\nHOST SUMMARY')
  })

  it('UPDATE:旧清单与新提取并集去重,且传给模型的 previousSummary 已剥掉标签', async () => {
    const session = sessionRef.current
    // 上一轮压到 assistant-2,摘要尾部带着上一轮的清单。
    session.summary = '## Goal\nold\n\n<read-files>\n/repo/a.ts\n</read-files>\n\n<modified-files>\n/repo/old.ts\n</modified-files>'
    session.summaryUpToMessageId = 'assistant-2'
    ;(session.messages[3] as ChatMessage).toolCalls = [
      toolCall('read', { path: '/repo/a.ts' }),
      toolCall('read', { path: '/repo/new.ts' }),
      toolCall('write', { path: '/repo/old.ts' }),
    ] as never

    const result = await compactSessionContext(baseOptions)

    // 并集去重、保序(旧的在前)。
    expect(result.summary).toBe(
      '## Goal\nHOST SUMMARY\n\n<read-files>\n/repo/a.ts\n/repo/new.ts\n</read-files>\n\n<modified-files>\n/repo/old.ts\n</modified-files>',
    )

    // 模型看到的 previousSummary 里没有清单 —— 清单归代码管,不让模型改写。
    const sentPrompt = generateChatResponse.mock.calls[0]?.[2] as Array<{ role: string; content: string }>
    const userPrompt = sentPrompt.find(message => message.role === 'user')?.content ?? ''
    expect(userPrompt).toContain('<previous-summary>\n## Goal\nold\n</previous-summary>')
    expect(userPrompt).not.toContain('<read-files>')
    expect(userPrompt).not.toContain('<modified-files>')
  })
})

describe('空摘要闸(2026-08-15)', () => {
  // 现场:deepseek-v4-pro 把 reasoning 与正文算在同一个 max_tokens 池里,思考先把
  // 预算喝干,content 回来是空串 —— 此前照走成功路径,旧摘要被一份空摘要覆盖。
  it('宿主摘要为空 → 失败,marker failed,旧摘要与锚点原样保留', async () => {
    sessionRef.current.summary = '## Goal\nOLD SUMMARY'
    sessionRef.current.summaryUpToMessageId = 'assistant-2'
    generateChatResponse.mockResolvedValue('')

    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(false)
    expect(result.error).toContain('empty summary')
    expect(summaryWrites).toHaveLength(0)
    expect(sessionRef.current.summary).toBe('## Goal\nOLD SUMMARY')
    expect(sessionRef.current.summaryUpToMessageId).toBe('assistant-2')
    const marker = sessionRef.current.messages[sessionRef.current.messages.length - 1]
    expect(parseContent(marker.content as string).status).toBe('failed')
  })

  it('宿主摘要缺 ## Goal(格式跑偏)→ 失败,不覆盖旧摘要', async () => {
    generateChatResponse.mockResolvedValue('Here is what happened: ...')
    const result = await compactSessionContext(baseOptions)
    expect(result.success).toBe(false)
    expect(result.error).toContain('## Goal')
    expect(summaryWrites).toHaveLength(0)
  })

  it('插件替换摘要不受六节格式约束,只校非空', async () => {
    runBeforeContextCompactHooks.mockResolvedValue({
      pluginId: 'p', hookId: 'h', summary: 'plugin-shaped summary, no headings',
    })
    const ok = await compactSessionContext(baseOptions)
    expect(ok.success).toBe(true)
    expect(ok.summary).toBe('plugin-shaped summary, no headings')

    sessionRef.current = makeSession()
    runBeforeContextCompactHooks.mockResolvedValue({ pluginId: 'p', hookId: 'h', summary: '   ' })
    const empty = await compactSessionContext(baseOptions)
    expect(empty.success).toBe(false)
    expect(empty.error).toContain('empty summary')
  })

  it('provider 报 length(被 max_tokens 截断)→ 明确失败,错误说清是谁掐的,旧摘要不覆盖', async () => {
    sessionRef.current.summary = '## Goal\nOLD SUMMARY'
    sessionRef.current.summaryUpToMessageId = 'assistant-2'
    generateChatResponse.mockImplementation(
      async (_p: string, _c: unknown, _m: unknown, options: { onFinish?: (i: { finishReason?: string }) => void }) => {
        options.onFinish?.({ finishReason: 'length' })
        return '## Goal\nhalf a summ'
      },
    )
    const result = await compactSessionContext(baseOptions)
    expect(result.success).toBe(false)
    expect(result.error).toContain('truncated by max_tokens (8192')
    expect(summaryWrites).toHaveLength(0)
    expect(sessionRef.current.summary).toBe('## Goal\nOLD SUMMARY')
    const marker = sessionRef.current.messages[sessionRef.current.messages.length - 1]
    expect(parseContent(marker.content as string).status).toBe('failed')
  })

  it('有 provider 真数 → 块按真比值切,请求 max_tokens 按窗口夹(2026-09-08 事故)', async () => {
    // ① 比值:同一份 120k 字符的转录,估算器把它当 30k token(4 字/token),
    // provider 说是 300k token —— 照真数切就是多块,照估算器切是一块
    // (「200k 窗口下 120k 字符仍是单块」那条用例证的就是后者)。
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)
    sessionRef.current.contextSize = 300_000
    await compactSessionContext(baseOptions)
    expect(generateChatResponse.mock.calls.length).toBeGreaterThan(1)

    // ② 夹法:上限接近窗口时,请求的 max_tokens 不再是注册上限,而是
    // 窗口 − 这一块的输入 − 开销。事故里这个数是 384000 原样透传。
    generateChatResponse.mockClear()
    sessionRef.current = makeSession()
    registeredMaxOutputTokens = 190_000
    sessionRef.current.messages[0].content = 'x'.repeat(10_000)
    sessionRef.current.contextSize = 100_000

    await compactSessionContext(baseOptions)

    const options = generateChatResponse.mock.calls[0]?.[3] as { maxTokens?: number }
    expect(options.maxTokens).toBeGreaterThan(0)
    expect(options.maxTokens).toBeLessThan(190_000)
    // 窗口 200000 − 输入 − 开销 4000:输入至少是 provider 报的那 100k 量级。
    expect(options.maxTokens).toBeLessThan(200_000 - 100_000 - 4_000 + 1)
  })

  it('没有 provider 真数 → 回退估算器,块与 max_tokens 与从前逐字一致', async () => {
    // makeSession 不带 contextSize / lastInputTokens:这条钉的是「校准缺席」
    // 那条路 —— 120k 字符仍是单块,max_tokens 仍是注册上限原样。
    sessionRef.current.messages[0].content = 'x'.repeat(120_000)

    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(true)
    expect(generateChatResponse).toHaveBeenCalledTimes(1)
    const options = generateChatResponse.mock.calls[0]?.[3] as { maxTokens?: number }
    expect(options.maxTokens).toBe(8_192)
  })

  it('被 max_tokens 截断的文案说清这个数是怎么来的(夹的 / 注册上限)', async () => {
    generateChatResponse.mockImplementation(
      async (_p: string, _c: unknown, _m: unknown, options: { onFinish?: (i: { finishReason?: string }) => void }) => {
        options.onFinish?.({ finishReason: 'length' })
        return '## Goal\nhalf a summ'
      },
    )

    // 夹过的:文案里带窗口 / 输入 / 开销三段算式。
    registeredMaxOutputTokens = 190_000
    sessionRef.current.messages[0].content = 'x'.repeat(10_000)
    sessionRef.current.contextSize = 100_000
    const clamped = await compactSessionContext(baseOptions)
    expect(clamped.success).toBe(false)
    expect(clamped.error).toContain('clamped to window 200000')
    expect(clamped.error).toContain('overhead 4000')

    // 没夹的:文案说的是注册上限。
    registeredMaxOutputTokens = 8_192
    sessionRef.current = makeSession()
    const registered = await compactSessionContext(baseOptions)
    expect(registered.error).toContain("truncated by max_tokens (8192, the model's registered max output)")
  })

  it('摘要请求显式关思考、按 compact 记账、输出上限=模型物理上限(不设人为限制)', async () => {
    await compactSessionContext(baseOptions)
    const options = generateChatResponse.mock.calls[0]?.[3] as {
      thinking?: boolean
      onUsage?: unknown
      maxTokens?: number
    }
    expect(options.thinking).toBe(false)
    expect(typeof options.onUsage).toBe('function')
    // 上面 model-registry mock 里 getModelMaxOutputTokens = 8_192:原样透传,不是 1600/4096。
    expect(options.maxTokens).toBe(8_192)
  })
})
