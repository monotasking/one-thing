/**
 * R-b(§13.6)采集点 + 翻译器守卫(§13.6 第 9 条)。
 *
 * 用例按**可观察的后果**写:生图那一轮记完账之后,投影出来的那条消息与引擎
 * 写进 `messages.jsonl` 的那一份逐字节相同 —— `content` 与 `contentParts` 两格。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeChatMessages } from '@onething/core/session'

const state = vi.hoisted(() => ({ storeDir: '', sessionsDir: '', run: undefined as undefined | { runId: string; requestIndex?: number; partCounter: number } }))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

/**
 * `runs.ts` 身后挂着影子断言与整棵 store 树(它要在 run 收尾时排一次比对),
 * 而这组用例要的只是"这条会话现在跑着一次执行" —— 替身只答那两句话。
 */
vi.mock('../runs.js', () => ({
  currentSessionRun: () => state.run,
  nextSessionRunPartIndex: () => {
    if (!state.run) return undefined
    const index = state.run.partCounter
    state.run.partCounter = index + 1
    return index
  },
}))

const { flushSessionEventLog, resetSessionEventLogCache } =
  await import('../event-log.js')
const { writeSessionEvent } = await import('../event-writer.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { getLiveSessionProjection, resetSessionProjectionCache } = await import('../projection-cache.js')
const { resetSessionPrepareCache } = await import('../prepare.js')
const { inlineDataUrlsToBlobs, recordSynthesizedAssistantText } = await import('../assistant-parts.js')
const { sessionProjectionOptions, resetSessionProjectionIssueCache } = await import('../projection-blobs.js')
const { assertContentPartIsCarriable, describeUncarriableContentPart, resetContentPartGuardWarnings } =
  await import('../content-part-guard.js')
const { setSessionFreezeEnabled } = await import('../freeze.js')

const SESSION = 'imaged'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-synth-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  resetSessionEventLogCache()
  resetSessionEventStatsCache()
  resetSessionSurfaceCache()
  resetSessionProjectionCache()
  resetSessionPrepareCache()
  state.run = undefined
  resetSessionProjectionIssueCache()
  resetContentPartGuardWarnings()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

const DATA_URL = `data:image/png;base64,${'A'.repeat(4000)}`
const MARKDOWN = `**优化后的提示词:** a cat\n\n![Generated Image|mediaId:m1](${DATA_URL})`

describe('R-b:生图正文进账本', () => {
  it('replaces the inline data URL with a blob placeholder and reads it back byte-for-byte', () => {
    const stored = inlineDataUrlsToBlobs(SESSION, MARKDOWN)
    expect(stored).not.toContain('base64,AAAA')
    expect(stored).toMatch(/onething-blob:\/\/[0-9a-f]+/)
    // 短的 data URL 不动(换成占位符反而多一次文件读)。
    const small = 'inline data:image/png;base64,AAAA here'
    expect(inlineDataUrlsToBlobs(SESSION, small)).toBe(small)
  })

  it('projects the image turn exactly as the message carries it', async () => {
    writeSessionEvent(SESSION, 'user/message', {
      message: { id: 'u1', role: 'user', content: 'draw a cat', timestamp: 1 },
    } as never, { surfaceOp: 'append' })
    writeSessionEvent(SESSION, 'run/start', {
      runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2,
    } as never, { surfaceOp: 'append' })
    state.run = { runId: 'r1', partCounter: 0 }
    expect(recordSynthesizedAssistantText(SESSION, 'a1', MARKDOWN)).toBe(true)
    writeSessionEvent(SESSION, 'run/end', { runId: 'r1', outcome: 'completed' } as never)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache()

    const messages = materializeChatMessages(
      getLiveSessionProjection(SESSION),
      sessionProjectionOptions(SESSION),
    ).messages
    // 账本那一行里**没有** base64(它进不了事件行 —— 每次 fold 都要把它读一遍)。
    const log = fs.readFileSync(path.join(state.sessionsDir, SESSION, 'events.jsonl'), 'utf8')
    expect(log).not.toContain('AAAAAAAA')
    expect(log).toContain('onething-blob://')

    const assistant = messages.find(message => message.id === 'a1')
    // 引擎写进消息的正是这两格(`updateMessageContent` + `addMessageContentPart`)。
    expect(assistant?.content).toBe(MARKDOWN)
    expect(assistant?.contentParts).toEqual([{ type: 'text', content: MARKDOWN }])
  })

  it('records nothing when there is no live run (and says so instead of pretending)', () => {
    expect(recordSynthesizedAssistantText(SESSION, 'a1', MARKDOWN)).toBe(false)
  })

  /**
   * §13.8 第二类:**失败分支**的正文。
   *
   * 引擎那条路只写 `content`(`updateMessageContent`),没有 contentPart ——
   * 真机 `web-40232e65` / `web-da46cc33` 两条不等差的正是这一格。记账的形状
   * 因此也只能有 `content` 那一格,不然投影会凭空多出一格 part。
   */
  it('records the image-failure body as content only (§13.8-2)', async () => {
    const body = '图片生成失败: fetch failed'
    writeSessionEvent(SESSION, 'user/message', {
      message: { id: 'u1', role: 'user', content: 'draw a cat', timestamp: 1 },
    } as never, { surfaceOp: 'append' })
    writeSessionEvent(SESSION, 'run/start', {
      runId: 'r1', kind: 'send', assistantMessageId: 'a1', timestamp: 2,
    } as never, { surfaceOp: 'append' })
    state.run = { runId: 'r1', partCounter: 0 }
    expect(recordSynthesizedAssistantText(SESSION, 'a1', body, { contentOnly: true })).toBe(true)
    writeSessionEvent(SESSION, 'run/end', { runId: 'r1', outcome: 'completed' } as never)
    await flushSessionEventLog(SESSION)
    resetSessionProjectionCache()

    const assistant = materializeChatMessages(
      getLiveSessionProjection(SESSION),
      sessionProjectionOptions(SESSION),
    ).messages.find(message => message.id === 'a1')
    expect(assistant?.content).toBe(body)
    expect(assistant?.contentParts).toBeUndefined()
  })
})

describe('翻译器守卫:进消息的 part 事件账本承载得了吗', () => {
  it('accepts what the ledger carries and what the judge drops', () => {
    for (const part of [
      { type: 'text', content: 'hi' },
      { type: 'reasoning', content: 'hm' },
      { type: 'provider-data', provider: 'claude' },
      { type: 'image', data: 'x' },
      { type: 'waiting' },
      { type: 'image-loading' },
      { type: 'data-steps', turnIndex: 1 },
      { type: 'plugin-status', pluginId: 'p', id: 's', label: 'x' },
    ]) {
      expect(describeUncarriableContentPart(part)).toBeUndefined()
    }
  })

  it('throws in dev on a part the ledger cannot carry, and warns in prod', () => {
    // 已结算的插件状态**要参与比较**,而账本上没有任何东西记过它。
    const settled = { type: 'plugin-status', pluginId: 'p', id: 's', label: 'x', durationMs: 12 }
    expect(describeUncarriableContentPart(settled)).toContain('plugin-status')
    expect(describeUncarriableContentPart({ type: 'tool-call', toolCalls: [] })).toContain('tool-call')

    setSessionFreezeEnabled(true)
    expect(() => assertContentPartIsCarriable(SESSION, settled)).toThrow(TypeError)
    setSessionFreezeEnabled(false)
    expect(() => assertContentPartIsCarriable(SESSION, settled)).not.toThrow()
    setSessionFreezeEnabled(true)
  })
})
