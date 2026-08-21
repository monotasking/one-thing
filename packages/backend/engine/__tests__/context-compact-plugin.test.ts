/**
 * N7-a —— beforeContextCompact 替换摘要的**装配层消费**验收。
 *
 * 打的是 compactSessionContext 的分支:某插件返回了替换摘要 → **跳过宿主的
 * summarizeInChunks**,直接把它写进会话摘要;无人返回(或 fail-open 回落)→
 * 宿主自压照常。协议层(第一个胜出 / 空串无效 / fail-open)在 core 那一份
 * (core/plugins lifecycle-compact.test.ts)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'

const runBeforeContextCompactHooks = vi.fn()
const generateChatResponse = vi.fn()
const summaryWrites: Array<{ summary: string; cutoff: string }> = []

vi.mock('@onething/runtime/plugins/lifecycle.wiring', () => ({
  runBeforeContextCompactHooks: (...args: unknown[]) => runBeforeContextCompactHooks(...args),
}))
vi.mock('../../wiring/providers/index.js', () => ({
  generateChatResponse: (...args: unknown[]) => generateChatResponse(...args),
}))
vi.mock('../../wiring/providers/model-registry.js', () => ({
  getModelContextLength: async () => 200_000,
  getModelMaxOutputTokens: async () => 8_192,
  getKnownModelMaxOutputTokens: async () => 8_192,
}))
vi.mock('../stream/message-helpers.js', () => ({
  buildHistoryMessages: () => [],
}))

const sessionRef: { current: ChatSession } = { current: null as unknown as ChatSession }

vi.mock('../../session/reads.js', () => ({
  // 读门面(P0.2 C1):这份 mock 与下面的 store mock 是同一个假会话
  // —— compact 的取数改走 `sessionReads.listMessages` 了。
  sessionReads: {
    listMessages: () => ({ messages: sessionRef.current?.messages ?? [], changed: false }),
    getMessage: (_sessionId: string, messageId: string) =>
      sessionRef.current?.messages.find((message: { id: string }) => message.id === messageId),
  },
}))
vi.mock('../../store.js', () => ({
  getSession: () => sessionRef.current,
  addMessage: (_sessionId: string, message: ChatMessage) => {
    sessionRef.current.messages.push(message)
  },
  updateSessionSummary: (_sessionId: string, summary: string, cutoff: string) => {
    summaryWrites.push({ summary, cutoff })
  },
  updateMessageContent: () => {},
  updateSessionContextSize: () => {},
}))

import { compactSessionContext } from '../context-compact.js'

function message(index: number, role: 'user' | 'assistant'): ChatMessage {
  return { id: `${role}-${index}`, role, content: `${role} ${index}`, timestamp: index }
}

function makeSession(): ChatSession {
  return {
    id: 's1',
    name: 'Test',
    createdAt: 0,
    updatedAt: 0,
    contextSize: 1000,
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
  configWithApiKey: { model: 'gpt-x', apiKey: 'sk' } as any,
  settings: { chat: {} } as any,
  keepRecentTurns: 2,
}

beforeEach(() => {
  runBeforeContextCompactHooks.mockReset()
  generateChatResponse.mockReset()
  generateChatResponse.mockResolvedValue('## Goal\nHOST SUMMARY')
  summaryWrites.length = 0
  sessionRef.current = makeSession()
})

afterEach(() => vi.clearAllMocks())

describe('compactSessionContext + N7-a replacement', () => {
  it('a plugin replacement summary is used and the host summarizer is skipped', async () => {
    runBeforeContextCompactHooks.mockResolvedValue({
      summary: 'TODO-highlighted structured summary',
      pluginId: 'smart-compact',
      hookId: 'compact',
    })

    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(true)
    expect(result.summary).toBe('TODO-highlighted structured summary')
    // 宿主自压被跳过 —— 一次 provider 调用都没有。
    expect(generateChatResponse).not.toHaveBeenCalled()
    expect(summaryWrites[0]?.summary).toBe('TODO-highlighted structured summary')
  })

  it('falls back to host compaction when no plugin returns a summary', async () => {
    runBeforeContextCompactHooks.mockResolvedValue(undefined)

    const result = await compactSessionContext(baseOptions)

    expect(result.success).toBe(true)
    expect(result.summary).toBe('## Goal\nHOST SUMMARY')
    // 无人替换 → 宿主的 summarizeInChunks 真的跑了。
    expect(generateChatResponse).toHaveBeenCalled()
    expect(summaryWrites[0]?.summary).toBe('## Goal\nHOST SUMMARY')
  })
})

/**
 * G3a —— "压缩即回放"的**契约钉**
 * (docs/design/plugin-knowledge-worker-capabilities-2026-08.md §2 G3)。
 *
 * memory 插件的第一版采集就靠这一条:压缩前把即将淡出工作记忆的内容整段收进
 * candidates(CLS 的 replay 机制字面落地)。它依赖的不是"钩子会被调用",而是
 * **递过去的是全文的 ChatMessage[] 本体** —— 一旦哪天有人在这里加一道"预览化"
 * (截断 content、只传 id、只传 role),采集端会安静地开始收半截内容,而且没有
 * 任何东西会红。所以这条契约必须有人守。
 *
 * 这里刻意不 mock 计划层:钉的就是"从真实的 selectCompactPlan 到钩子入参"这一段。
 */
describe('G3a compact-as-replay — the hook receives the full ChatMessage[] verbatim', () => {
  it('hands over the message objects themselves, full text, in order', async () => {
    runBeforeContextCompactHooks.mockResolvedValue(undefined)
    const session = sessionRef.current

    await compactSessionContext(baseOptions)

    expect(runBeforeContextCompactHooks).toHaveBeenCalledTimes(1)
    const ctx = runBeforeContextCompactHooks.mock.calls[0][0] as {
      sessionId: string
      providerId: string
      keepRecentTurns?: number
      messagesToSummarize: ChatMessage[]
    }

    expect(ctx.sessionId).toBe('s1')
    expect(ctx.providerId).toBe('openai')
    expect(ctx.keepRecentTurns).toBe(2)

    const handed = ctx.messagesToSummarize
    expect(Array.isArray(handed)).toBe(true)
    expect(handed.length).toBeGreaterThan(0)

    // 1. 是**本体**,不是投影:每一条都能在会话里按引用找回来。
    for (const item of handed) {
      expect(session.messages).toContain(item)
    }
    // 2. 全文,不是摘要/截断:content 与会话里那一条逐字相同,且 role/id 都在。
    for (const item of handed) {
      const source = session.messages.find(candidate => candidate.id === item.id)
      expect(item.content).toBe(source?.content)
      expect(item.role).toBe(source?.role)
    }
    // 3. 顺序即会话顺序(回放要按时间轴走)。
    expect(handed.map(item => item.id)).toEqual(
      session.messages.slice(0, handed.length).map(item => item.id),
    )
    // 4. 递的就是"将被压掉的那一段" —— 保留的近几轮不在里面。
    const keptIds = session.messages.slice(handed.length).map(item => item.id)
    expect(handed.some(item => keptIds.includes(item.id))).toBe(false)
  })

  it('a collect-only hook (returns nothing) does not disturb host compaction', async () => {
    const collected: ChatMessage[] = []
    runBeforeContextCompactHooks.mockImplementation(async (ctx: { messagesToSummarize: ChatMessage[] }) => {
      // 5s 预算内只做快照入队 —— 不调 LLM(盲点 #7)。
      collected.push(...ctx.messagesToSummarize)
      return undefined
    })

    const result = await compactSessionContext(baseOptions)

    expect(collected.length).toBeGreaterThan(0)
    expect(collected.every(item => typeof item.content === 'string' && item.content.length > 0)).toBe(true)
    expect(result.summary).toBe('## Goal\nHOST SUMMARY')
  })
})
