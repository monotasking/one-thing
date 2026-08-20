import { describe, expect, it, vi } from 'vitest'
import {
  adoptSessionCommandResult,
  applySessionCommand,
  type CoreSessionCommandMessage,
  type CoreSessionCommandSession,
} from '../commands.js'
import { CORE_INTERRUPTED_TOOL_ERROR } from '../interrupted.js'

type Message = CoreSessionCommandMessage & {
  reasoning?: string
  thinkingTime?: number
  skillUsed?: string
}
type Session = CoreSessionCommandSession<Message>

function message(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: id, timestamp: 1, ...overrides }
}

function session(messages: Message[], overrides: Partial<Session> = {}): Session {
  return { id: 's1', messages, updatedAt: 0, ...overrides }
}

const NOW = 1_700_000_000_000

describe('applySessionCommand — COW 与写计划', () => {
  it('appendMessage:追加 = message 计划 + dirtySeq 为新长度,并盖 index meta', () => {
    const before = session([message('m1'), message('m2')])
    const added = message('m3', { provider: 'claude', model: 'sonnet' })

    const result = applySessionCommand(before, { type: 'appendMessage', message: added, now: NOW })

    expect(result.changed).toBe(true)
    expect(result.writePlan).toEqual({ kind: 'message', dirtySeq: 3 })
    expect(result.lazy).toBe(false)
    expect(result.indexMetaChanged).toBe(true)
    expect(result.changedMessageIds).toEqual(['m3'])
    // COW:入参没被动过
    expect(before.messages).toHaveLength(2)
    expect(result.session).not.toBe(before)
    expect(result.session.messages).not.toBe(before.messages)
    // 未改的消息保持同一引用
    expect(result.session.messages[0]).toBe(before.messages[0])
    expect(result.session.messages[2]).toBe(added)
    expect(result.session.updatedAt).toBe(NOW)
    expect(result.session.lastProvider).toBe('claude')
    expect(result.session.lastModel).toBe('sonnet')
  })

  it('appendMessage:非 assistant 不盖 lastProvider/lastModel', () => {
    const before = session([], { lastProvider: 'old' })
    const result = applySessionCommand(before, {
      type: 'appendMessage',
      message: message('u1', { role: 'user', provider: 'claude' }),
      now: NOW,
    })
    expect(result.session.lastProvider).toBe('old')
  })

  it('upsertMessage:存在 → 就地替换(patch 计划);不存在 → 走追加计划', () => {
    const before = session([message('m1'), message('m2')])

    const replaced = applySessionCommand(before, {
      type: 'upsertMessage',
      message: message('m2', { content: 'new' }),
      now: NOW,
    })
    expect(replaced.writePlan).toEqual({ kind: 'message', dirtySeq: 2 })
    expect(replaced.indexMetaChanged).toBe(false)
    expect(replaced.meta?.inserted).toBe(false)
    expect(replaced.session.messages[0]).toBe(before.messages[0])

    const inserted = applySessionCommand(before, {
      type: 'upsertMessage',
      message: message('m9'),
      now: NOW,
    })
    expect(inserted.writePlan).toEqual({ kind: 'message', dirtySeq: 3 })
    expect(inserted.indexMetaChanged).toBe(true)
    expect(inserted.meta?.inserted).toBe(true)
  })

  it('patchMessage:index+1 的 message 计划;未命中 = 无改动', () => {
    const before = session([message('m1'), message('m2')])

    const result = applySessionCommand(before, {
      type: 'patchMessage',
      messageId: 'm2',
      patch: { isStreaming: true },
    })
    expect(result.writePlan).toEqual({ kind: 'message', dirtySeq: 2 })
    expect(result.lazy).toBe(false)
    expect(result.session.messages[1]).not.toBe(before.messages[1])
    expect(result.session.messages[1].isStreaming).toBe(true)
    expect(before.messages[1].isStreaming).toBeUndefined()

    const missing = applySessionCommand(before, {
      type: 'patchMessage',
      messageId: 'nope',
      patch: { isStreaming: true },
    })
    expect(missing.changed).toBe(false)
    expect(missing.session).toBe(before)
  })

  it('patchMessage:lazy 档与今天的四个 mutator 一致(hint 优先,缺省按键推断)', () => {
    const before = session([message('m1')])
    const lazyOf = (patch: Partial<Message>, hint?: 'stream' | 'settle') =>
      applySessionCommand(before, { type: 'patchMessage', messageId: 'm1', patch, hint }).lazy

    // 今天走 { lazy: true } 的四条
    expect(lazyOf({ content: 'x' })).toBe(true)
    expect(lazyOf({ reasoning: 'x' })).toBe(true)
    expect(lazyOf({ contentParts: [] })).toBe(true)
    expect(lazyOf({ thinkingTime: 12 })).toBe(true)
    // 今天不 lazy 的
    expect(lazyOf({ isStreaming: false })).toBe(false)
    expect(lazyOf({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).toBe(false)
    expect(lazyOf({ skillUsed: 'x' })).toBe(false)
    expect(lazyOf({ steps: [] })).toBe(false)
    // 显式 hint 永远优先
    expect(lazyOf({ isStreaming: false }, 'stream')).toBe(true)
    expect(lazyOf({ content: 'x' }, 'settle')).toBe(false)
  })

  it('appendContentPart:新 parts 数组,原消息不动', () => {
    const before = session([message('m1', { contentParts: [{ type: 'text' }] })])
    const result = applySessionCommand(before, {
      type: 'appendContentPart',
      messageId: 'm1',
      part: { type: 'image' },
    })
    expect(result.writePlan).toEqual({ kind: 'message', dirtySeq: 1 })
    expect(result.lazy).toBe(false)
    expect(result.session.messages[0].contentParts).toHaveLength(2)
    expect(before.messages[0].contentParts).toHaveLength(1)
  })

  it('upsertStep:按 toolCallId 去重合并,否则追加', () => {
    const before = session([
      message('m1', { steps: [{ id: 's1', title: 'old', toolCallId: 'c1' }] }),
    ])

    const merged = applySessionCommand(before, {
      type: 'upsertStep',
      messageId: 'm1',
      step: { id: 's1', title: 'new', toolCallId: 'c1', status: 'done' },
    })
    expect(merged.session.messages[0].steps).toHaveLength(1)
    expect(merged.session.messages[0].steps![0]).toMatchObject({ title: 'new', status: 'done' })
    expect(before.messages[0].steps![0].title).toBe('old')

    const appended = applySessionCommand(before, {
      type: 'upsertStep',
      messageId: 'm1',
      step: { id: 's2', title: 'other', toolCallId: 'c2' },
    })
    expect(appended.session.messages[0].steps).toHaveLength(2)
    expect(appended.writePlan).toEqual({ kind: 'message', dirtySeq: 1 })
  })

  it('patchStep:status 缺席 → lazy;带 status → 立即档', () => {
    const before = session([message('m1', { steps: [{ id: 's1', title: 't' }] })])

    const running = applySessionCommand(before, {
      type: 'patchStep',
      messageId: 'm1',
      stepId: 's1',
      updates: { title: 'tick' },
    })
    expect(running.lazy).toBe(true)
    expect(running.writePlan).toEqual({ kind: 'message', dirtySeq: 1 })
    expect(before.messages[0].steps![0].title).toBe('t')

    const settled = applySessionCommand(before, {
      type: 'patchStep',
      messageId: 'm1',
      stepId: 's1',
      updates: { status: 'done' },
    })
    expect(settled.lazy).toBe(false)

    const missing = applySessionCommand(before, {
      type: 'patchStep',
      messageId: 'm1',
      stepId: 'nope',
      updates: { status: 'done' },
    })
    expect(missing.changed).toBe(false)
  })

  it('patchStepsUsageByTurn:只在真的写到 step 时才算改动', () => {
    const before = session([
      message('m1', {
        steps: [
          { id: 's1', title: 'a', turnIndex: 0 },
          { id: 's2', title: 'b', turnIndex: 1 },
        ],
      }),
    ])

    const hit = applySessionCommand(before, {
      type: 'patchStepsUsageByTurn',
      messageId: 'm1',
      turnIndex: 1,
      usage: { inputTokens: 3 },
    })
    expect(hit.changed).toBe(true)
    expect(hit.meta?.updatedStepIds).toEqual(['s2'])
    expect(hit.writePlan).toEqual({ kind: 'message', dirtySeq: 1 })
    // 没命中的 step 保持同一引用
    expect(hit.session.messages[0].steps![0]).toBe(before.messages[0].steps![0])

    const miss = applySessionCommand(before, {
      type: 'patchStepsUsageByTurn',
      messageId: 'm1',
      turnIndex: 7,
      usage: {},
    })
    expect(miss.changed).toBe(false)
    expect(miss.meta?.updatedStepIds).toEqual([])
  })

  it('setToolCalls:整表写回,数组引用原样保留(引擎共享那一份)', () => {
    const before = session([message('m1')])
    const toolCalls = [{ status: 'executing' }]
    const result = applySessionCommand(before, { type: 'setToolCalls', messageId: 'm1', toolCalls })
    expect(result.writePlan).toEqual({ kind: 'message', dirtySeq: 1 })
    expect(result.session.messages[0].toolCalls).toBe(toolCalls)
    expect(before.messages[0].toolCalls).toBeUndefined()
  })

  it('truncateFrom(inclusive):structural + 扣 usage + 重算 contextSize', () => {
    const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    const before = session(
      [message('m1'), message('m2', { usage }), message('m3', { usage })],
      { totalInputTokens: 20, totalOutputTokens: 10, totalTokens: 30, contextSize: 99, lastInputTokens: 99 },
    )

    const result = applySessionCommand(before, {
      type: 'truncateFrom',
      messageId: 'm2',
      inclusive: true,
      now: NOW,
    })

    expect(result.writePlan).toEqual({ kind: 'structural' })
    expect(result.indexMetaChanged).toBe(true)
    expect(result.session.messages).toHaveLength(1)
    expect(before.messages).toHaveLength(3)
    expect(result.meta?.deletedMessages).toHaveLength(2)
    expect(result.meta?.subtractedUsage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 })
    expect(result.session.totalTokens).toBe(0)
    expect(result.session.contextSize).toBe(0)
    expect(result.session.updatedAt).toBe(NOW)
  })

  it('truncateFrom(!inclusive):保留并改写锚点,contentParts 只在显式声明时才动', () => {
    const before = session([
      message('u1', { role: 'user', contentParts: [{ type: 'text' }] }),
      message('m2'),
    ])

    const kept = applySessionCommand(before, {
      type: 'truncateFrom',
      messageId: 'u1',
      inclusive: false,
      newContent: 'edited',
      now: NOW,
    })
    expect(kept.session.messages).toHaveLength(1)
    expect(kept.session.messages[0].content).toBe('edited')
    expect(kept.session.messages[0].timestamp).toBe(NOW)
    expect(kept.session.messages[0].contentParts).toEqual([{ type: 'text' }])
    expect(before.messages[0].content).toBe('u1')

    const dropped = applySessionCommand(before, {
      type: 'truncateFrom',
      messageId: 'u1',
      inclusive: false,
      newContent: 'edited',
      hasContentParts: true,
      contentParts: null,
      now: NOW,
    })
    expect('contentParts' in dropped.session.messages[0]).toBe(false)
  })

  it('deleteMessage:structural + 补 index meta(E4);支持按内容找', () => {
    const before = session([message('m1'), message('m2'), message('m3')])

    const byId = applySessionCommand(before, { type: 'deleteMessage', messageId: 'm2', now: NOW })
    expect(byId.writePlan).toEqual({ kind: 'structural' })
    expect(byId.indexMetaChanged).toBe(true)
    expect(byId.meta?.index).toBe(1)
    expect(byId.session.messages.map(m => m.id)).toEqual(['m1', 'm3'])
    expect(before.messages).toHaveLength(3)

    const byMarker = applySessionCommand(before, {
      type: 'deleteMessage',
      matchMarker: m => m.content === 'm3',
      now: NOW,
    })
    expect(byMarker.session.messages.map(m => m.id)).toEqual(['m1', 'm2'])

    const missing = applySessionCommand(before, { type: 'deleteMessage', messageId: 'nope' })
    expect(missing.changed).toBe(false)
  })

  it('replaceAll:structural,不动 token 总账(花掉的钱不退)', () => {
    const before = session([message('m1')], { totalTokens: 42 })
    const result = applySessionCommand<Session, Message>(before, {
      type: 'replaceAll',
      messages: [],
      reason: 'clear',
      now: NOW,
    })
    expect(result.writePlan).toEqual({ kind: 'structural' })
    expect(result.indexMetaChanged).toBe(true)
    expect(result.session.messages).toEqual([])
    expect(result.session.totalTokens).toBe(42)
    expect(before.messages).toHaveLength(1)
  })
})

describe('applySessionCommand — repairOnLoad', () => {
  const staleCompact = JSON.stringify({
    type: 'context-compact',
    status: 'compacting',
    summary: '',
    compactedMessageCount: 40,
  })

  function brokenSession(): Session {
    return session(
      [
        message('u1', { role: 'user', content: 'hi' }),
        message('a1', {
          isStreaming: true,
          toolCalls: [{ status: 'executing', requiresConfirmation: true }],
          steps: [
            {
              id: 's1',
              title: 'Running: bash',
              status: 'running',
              childSteps: [{ id: 's1a', title: 'sub', status: 'pending' }],
            },
          ],
        }),
        message('sys1', { role: 'system', content: staleCompact, timestamp: 1 }),
      ],
      { summary: 'x', summaryUpToMessageId: 'gone', summaryCreatedAt: 5 },
    )
  }

  it('startup:给出逐条 patch 列表,入参一字不改', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = brokenSession()
    const result = applySessionCommand(before, { type: 'repairOnLoad', policy: 'startup', now: NOW })

    expect(result.changed).toBe(true)
    expect(result.writePlan).toEqual({ kind: 'structural' })
    expect(result.indexMetaChanged).toBe(false)
    expect(result.changedMessageIds).toEqual(['a1', 'sys1'])

    const patches = result.meta!.repairPatches!
    expect(patches.messages.map(p => p.messageId)).toEqual(['a1', 'sys1'])
    // summary 锚点不存在 → 三件套一起清掉
    expect(patches.sessionDeletes).toEqual(['summary', 'summaryUpToMessageId', 'summaryCreatedAt'])

    const repairedAssistant = result.session.messages[1]
    expect(repairedAssistant.isStreaming).toBe(false)
    expect(repairedAssistant.toolCalls![0]).toMatchObject({
      status: 'cancelled',
      requiresConfirmation: false,
    })
    // R-a(§13.6):崩溃收口以 prepare 为准 —— `cancelled` + 那一句共用常量,
    // 标题不再被改写(投影重建不出一次标题改写)。
    expect(repairedAssistant.steps![0]).toMatchObject({
      status: 'cancelled',
      error: CORE_INTERRUPTED_TOOL_ERROR,
    })
    // 标题**原样留着**:那次改写在事件账本里没有来源,投影重建不出来。
    expect(repairedAssistant.steps![0].title).toBe('Running: bash')
    expect(repairedAssistant.steps![0].childSteps![0].status).toBe('cancelled')
    expect(JSON.parse(result.session.messages[2].content as string).status).toBe('failed')
    expect('summary' in result.session).toBe(false)

    // 没被修的那条保持同一引用;入参整份原样
    expect(result.session.messages[0]).toBe(before.messages[0])
    expect(before.messages[1].isStreaming).toBe(true)
    expect(before.messages[1].steps![0].status).toBe('running')
    expect(before.summary).toBe('x')
    vi.restoreAllMocks()
  })

  it('loaded:只清 isStreaming,不碰 step/toolCall/compact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = brokenSession()
    const result = applySessionCommand(before, { type: 'repairOnLoad', policy: 'loaded', now: NOW })

    expect(result.changedMessageIds).toEqual(['a1'])
    expect(result.session.messages[1].isStreaming).toBe(false)
    expect(result.session.messages[1].steps![0].status).toBe('running')
    expect(result.session.messages[2]).toBe(before.messages[2])
    vi.restoreAllMocks()
  })

  it('干净会话:无改动、无写', () => {
    const before = session([message('m1')])
    const result = applySessionCommand(before, { type: 'repairOnLoad', policy: 'startup', now: NOW })
    expect(result.changed).toBe(false)
    expect(result.session).toBe(before)
    expect(result.meta?.repairPatches?.messages).toEqual([])
  })
})

describe('adoptSessionCommandResult', () => {
  it('保住会话容器身份,换掉消息数组与被改的消息', () => {
    const container = session([message('m1'), message('m2')])
    const original = container.messages[0]
    const result = applySessionCommand(container, {
      type: 'patchMessage',
      messageId: 'm2',
      patch: { content: 'new' },
    })

    expect(adoptSessionCommandResult(container, result)).toBe(true)
    expect(container.messages).toBe(result.session.messages)
    expect(container.messages[0]).toBe(original)
    expect(container.messages[1].content).toBe('new')
  })

  it('会话级字段的删除也会落到容器上', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const container = session([message('m1')], { summary: 'x', summaryUpToMessageId: 'gone' })
    const result = applySessionCommand(container, { type: 'repairOnLoad', policy: 'loaded' })
    adoptSessionCommandResult(container, result)
    expect('summary' in container).toBe(false)
    expect('summaryUpToMessageId' in container).toBe(false)
    vi.restoreAllMocks()
  })
})
