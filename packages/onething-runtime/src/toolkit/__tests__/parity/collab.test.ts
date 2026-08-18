/**
 * R3a 对拍 —— 协作四件套 `send_message` / `board` / `history` / `notebook`。
 * 旧 `tools/builtin/{say,board,history,notebook}.ts` vs 新 `toolkit/builtin/*`。
 *
 * 场子门在两个面上各测一次:
 *  - **面上**:`visibleIn(scene)` 与 `COLLAB_TOOL_VENUES` 逐格一致(chat 场子四个
 *    全摘)—— 这是模型看到的清单;
 *  - **硬调时**:拒绝文案由各自的执行器给,与旧路逐字一致(board 是工具自己的
 *    「boards exist only in…」,其余三个在适配层)。
 */

import { describe, expect, it, vi } from 'vitest'
import { createBoardTool as createLegacyBoardTool } from '../../../tools/builtin/board.js'
import { createHistoryTool as createLegacyHistoryTool } from '../../../tools/builtin/history.js'
import { createNotebookTool as createLegacyNotebookTool } from '../../../tools/builtin/notebook.js'
import { createSayTool as createLegacySayTool } from '../../../tools/builtin/say.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { COLLAB_TOOL_VENUES, type CollabVenue } from '../../../collab/tool-surface.js'
import type { CollabBoard, CollabTask } from '../../../collab/board.js'
import { BoardInputSchema, createBoardTool, type BoardToolAdapters } from '../../builtin/board.js'
import { createHistoryTool, HistoryInputSchema, type HistoryToolAdapters, type HistoryToolResult } from '../../builtin/history.js'
import { createNotebookTool, NotebookInputSchema, type NotebookToolAdapters } from '../../builtin/notebook.js'
import { createSendMessageTool, SendMessageInputSchema, type SendMessageToolAdapters } from '../../builtin/send-message.js'
import { annotationsOf, legacyContext, modelTextOf, normalizeDetails, runNewTool } from '../support.js'

const ROOM_SESSION = 'room-1'
const AGENT_SESSION = 'agent-exec-1'

function venueAdapters(kind: string | undefined, agentId = 'a1') {
  return {
    sessionKind: () => kind,
    sessionAgentId: () => agentId,
  }
}

// ── send_message ────────────────────────────────────────────────────────────

describe('parity: send_message', () => {
  function adapters(overrides: Partial<SendMessageToolAdapters> = {}): SendMessageToolAdapters {
    return {
      ...venueAdapters('room'),
      speak: async () => ({ ok: true, messageId: 'm-1' }),
      sendDm: async () => ({ ok: true, targetKind: 'agent', roomSessionId: 'dm-1', messageId: 'm-2', peerName: '小研' }),
      ...overrides,
    }
  }

  it('spec 与旧工具逐字对齐', () => {
    const legacy = createLegacySayTool(adapters())
    const tool = createSendMessageTool(adapters())
    expect(tool.spec.id).toBe(legacy.id)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(SendMessageInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
    // 四个协作工具里只有它真的把东西送出去 —— 只有它报效果(silent,不弹卡)。
    expect(tool.spec.effects).toEqual(['session_message'])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; overrides?: Partial<SendMessageToolAdapters> }> = [
    { name: '正常:发进房', args: { content: '收到' } },
    { name: '正常:私聊(有 to)', args: { content: '私下说一句', to: '小研#3f9c' } },
    { name: '边界:显式 room + mentions + replyTo', args: { content: 'x', room: 'room-2', mentions: ['a2'], replyTo: 'm-0' } },
    { name: '边界:channel=gateway 目前不接', args: { content: 'x', channel: 'gateway' } },
    { name: '边界:给了 to 却写 channel=room(矛盾)', args: { content: 'x', to: '小研', channel: 'room' } },
    { name: '错误:房冻结 / 超预算', args: { content: 'x' }, overrides: { speak: async () => ({ ok: false, error: '这间房已冻结。' }) } },
    { name: '错误:私聊没送达', args: { content: 'x', to: '小研' }, overrides: { sendDm: async () => ({ ok: false, error: '找不到这位同事。' }) } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息一致:${fixture.name}`, async () => {
      const shared = adapters(fixture.overrides)
      const { ctx } = legacyContext({ sessionId: ROOM_SESSION })
      const legacy = await createLegacySayTool(shared).execute(fixture.args as never, ctx as never)

      const run = await runNewTool(createSendMessageTool(shared), fixture.args, { sessionId: ROOM_SESSION })
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toEqual(normalizeDetails(legacy.metadata))
    })
  }

  it('错误:legacy `dm` 的降级出口 —— content 缺席时逐字给那句可操作的拒绝', async () => {
    const legacy = createLegacySayTool(adapters())
    const parsed = legacy.parameters.safeParse({ to: '小研', message: 'hi' })
    expect(parsed.success).toBe(false)
    const legacyText = legacy.formatValidationError?.(parsed.success ? (undefined as never) : parsed.error)

    const run = await runNewTool(createSendMessageTool(adapters()), { to: '小研', message: 'hi' })
    expect(run.outcome.kind).toBe('invalid')
    expect(run.outcome.kind === 'invalid' && run.outcome.message).toBe(legacyText)
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createSendMessageTool(adapters()), { content: 'x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

// ── board ───────────────────────────────────────────────────────────────────

const TASK: CollabTask = {
  id: 'task-abcdef0123',
  rev: 3,
  title: '把工具搬完',
  status: 'doing',
  createdBy: { type: 'agent', agentId: 'a1' },
  workSessionIds: [],
  rejections: 0,
  createdAt: 0,
  updatedAt: 0,
}

const BOARD: CollabBoard = { version: 1, tasks: [TASK] }

describe('parity: board', () => {
  function newAdapters(overrides: Partial<BoardToolAdapters> = {}): BoardToolAdapters {
    return {
      ...venueAdapters('room'),
      resolveLinkedRoom: () => undefined,
      resolveMember: (_room, name) => (name === '小研' ? 'a2' : null),
      agentName: id => (id === 'a1' ? '小明' : id),
      applyAction: async () => ({ board: BOARD, task: TASK }),
      ...overrides,
    }
  }

  /** 旧壳里的 `resolveContext` = 场子门 + 房间解析 + session.agentId,三合一。 */
  function legacyAdapters(venue: CollabVenue, linked?: string, overrides: Partial<BoardToolAdapters> = {}) {
    const shared = newAdapters(overrides)
    return {
      resolveContext(sessionId: string) {
        if (!COLLAB_TOOL_VENUES.board.includes(venue)) return null
        if (venue === 'room') return { roomSessionId: sessionId, actorAgentId: 'a1' }
        if (linked) return { roomSessionId: linked, actorAgentId: 'a1' }
        return null
      },
      resolveMember: shared.resolveMember,
      agentName: shared.agentName,
      applyAction: shared.applyAction,
    }
  }

  it('spec 与旧工具逐字对齐', () => {
    const legacy = createLegacyBoardTool(legacyAdapters('room'))
    const tool = createBoardTool(newAdapters())
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(BoardInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
    expect(tool.spec.effects).toEqual([])
  })

  const FIXTURES: Array<{
    name: string
    args: Record<string, unknown>
    venue: CollabVenue
    linked?: string
    overrides?: Partial<BoardToolAdapters>
  }> = [
    { name: '正常:list', args: { action: 'list' }, venue: 'room' },
    { name: '正常:start(卡进 doing → 回执带那条 note)', args: { action: 'start', title: '新活' }, venue: 'room' },
    { name: '正常:work 场子经由 linked room', args: { action: 'list' }, venue: 'work', linked: ROOM_SESSION },
    { name: '边界:assign 少了 taskId', args: { action: 'assign' }, venue: 'room' },
    { name: '边界:assign 的成员认不出来', args: { action: 'assign', taskId: 't1', assignee: '张三' }, venue: 'room' },
    { name: '边界:move 少了 status', args: { action: 'move', taskId: 't1' }, venue: 'room' },
    {
      name: '错误:store 拒绝(rev 过期)',
      args: { action: 'move', taskId: 't1', status: 'todo', expectedRev: 1 },
      venue: 'room',
      overrides: { applyAction: async () => ({ board: BOARD, error: 'stale rev' }) },
    },
    { name: '场子门:普通对话里被硬调', args: { action: 'list' }, venue: 'chat' },
    { name: '场子门:agent 场子但没有挂着房', args: { action: 'list' }, venue: 'agent' },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息一致:${fixture.name}`, async () => {
      const { ctx } = legacyContext({ sessionId: ROOM_SESSION })
      const legacy = await createLegacyBoardTool(legacyAdapters(fixture.venue, fixture.linked, fixture.overrides))
        .execute(fixture.args as never, ctx as never)

      const adapters = newAdapters({
        ...venueAdapters(fixture.venue === 'chat' ? undefined : fixture.venue),
        resolveLinkedRoom: () => fixture.linked,
        ...fixture.overrides,
      })
      const run = await runNewTool(createBoardTool(adapters), fixture.args, { sessionId: ROOM_SESSION })
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toEqual(normalizeDetails(legacy.metadata))
    })
  }

  it('错误:action 不合契约', async () => {
    const run = await runNewTool(createBoardTool(newAdapters()), { action: 'burn' })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createBoardTool(newAdapters()), { action: 'list' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

// ── history ─────────────────────────────────────────────────────────────────

describe('parity: history', () => {
  function adapters(result: HistoryToolResult): HistoryToolAdapters {
    return { ...venueAdapters('agent'), search: async () => result }
  }

  it('spec 与旧工具逐字对齐', () => {
    const shared = adapters({ ok: true, entries: [] })
    const legacy = createLegacyHistoryTool(shared)
    const tool = createHistoryTool(shared)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(HistoryInputSchema))
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.effects).toEqual([])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; result: HistoryToolResult }> = [
    {
      name: '正常:两条命中 + 还有更早',
      args: { q: '方案' },
      result: { ok: true, entries: [{ line: '<message>a</message>' }, { line: '<message>b</message>' }], total: 9, scannedRooms: 3, nextCursor: 'c1' },
    },
    { name: '边界:一间房都没有', args: {}, result: { ok: true, entries: [], noRooms: true } },
    { name: '边界:where 指到不存在的房', args: { where: '不存在' }, result: { ok: true, entries: [], unknownRoom: { available: ['大群', '小研'] } } },
    { name: '边界:带游标翻到尽头', args: { cursor: 'c1' }, result: { ok: true, entries: [], endOfRange: true, total: 12 } },
    { name: '边界:关键词没命中,退回范围内最近几条', args: { q: 'zzz' }, result: { ok: true, entries: [{ line: '<message>c</message>' }], fellBackToRange: true, scannedRooms: 2, skippedRooms: 4 } },
    { name: '错误:查不了', args: {}, result: { ok: false, error: '你不在任何房里。' } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息一致:${fixture.name}`, async () => {
      const shared = adapters(fixture.result)
      const { ctx } = legacyContext({ sessionId: AGENT_SESSION })
      const legacy = await createLegacyHistoryTool(shared).execute(fixture.args as never, ctx as never)

      const run = await runNewTool(createHistoryTool(shared), fixture.args, { sessionId: AGENT_SESSION })
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toEqual(normalizeDetails(legacy.metadata))
    })
  }

  it('边界:limit 被夹到上限 30', async () => {
    const search = vi.fn(async (_input: { limit: number }) => ({ ok: true, entries: [] }) as HistoryToolResult)
    const tool = createHistoryTool({ ...venueAdapters('agent'), search })
    await runNewTool(tool, { limit: 30 })
    expect(search.mock.calls[0]?.[0]).toMatchObject({ limit: 30 })
  })

  it('错误:limit 超出契约上限', async () => {
    const run = await runNewTool(createHistoryTool(adapters({ ok: true, entries: [] })), { limit: 999 })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createHistoryTool(adapters({ ok: true, entries: [] })), {}, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

// ── notebook ────────────────────────────────────────────────────────────────

describe('parity: notebook', () => {
  function adapters(result: Awaited<ReturnType<NotebookToolAdapters['append']>>): NotebookToolAdapters {
    return { ...venueAdapters('agent'), append: async () => result }
  }

  it('spec 与旧工具逐字对齐', () => {
    const shared = adapters({ ok: true, entry: '· x', totalChars: 10, budgetChars: 100 })
    const legacy = createLegacyNotebookTool(shared)
    const tool = createNotebookTool(shared)
    expect(tool.spec.description).toBe(legacy.description)
    expect(tool.spec.input).toEqual(zodToJsonSchema(NotebookInputSchema))
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.effects).toEqual([])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; result: Awaited<ReturnType<NotebookToolAdapters['append']>> }> = [
    { name: '正常:记下一条', args: { note: '答应了老王周四前给方案' }, result: { ok: true, entry: '[08-18] 答应了老王', totalChars: 40, budgetChars: 1500 } },
    { name: '边界:已经超预算 —— 回执要说出来', args: { note: 'x' }, result: { ok: true, entry: '[08-18] x', totalChars: 2000, budgetChars: 1500 } },
    { name: '边界:适配层没给 totalChars', args: { note: 'x' }, result: { ok: true, entry: '[08-18] x' } },
    { name: '场子门:普通对话里被硬调', args: { note: 'x' }, result: { ok: false, error: '笔记本只在群聊/私聊的回合与工作台会话里可用 —— 普通对话没有「别的房」,不需要跨房记忆。' } },
    { name: '错误:认不出身份', args: { note: 'x' }, result: { ok: false, error: '这条会话认不出是哪位同事的,笔记没有可归属的本子。' } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息一致:${fixture.name}`, async () => {
      const shared = adapters(fixture.result)
      const { ctx } = legacyContext({ sessionId: AGENT_SESSION })
      const legacy = await createLegacyNotebookTool(shared).execute(fixture.args as never, ctx as never)

      const run = await runNewTool(createNotebookTool(shared), fixture.args, { sessionId: AGENT_SESSION })
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toBe(legacy.output)
      expect(annotationsOf(run).at(-1)?.title).toBe(legacy.title)
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toEqual(normalizeDetails(legacy.metadata))
    })
  }

  it('错误:note 为空不合契约', async () => {
    const run = await runNewTool(createNotebookTool(adapters({ ok: true })), { note: '' })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createNotebookTool(adapters({ ok: true })), { note: 'x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

// ── 场子门(面上)────────────────────────────────────────────────────────────

describe('协作四件套的 visibleIn 与 COLLAB_TOOL_VENUES 逐格一致', () => {
  const noop = () => { throw new Error('adapter not used') }
  const tools = {
    send_message: createSendMessageTool({ speak: noop as never, sendDm: noop as never }),
    board: createBoardTool({
      resolveLinkedRoom: noop as never, resolveMember: noop as never,
      agentName: noop as never, applyAction: noop as never,
    }),
    history: createHistoryTool({ search: noop as never }),
    notebook: createNotebookTool({ append: noop as never }),
  }
  const venues: CollabVenue[] = ['room', 'agent', 'work', 'chat']

  for (const [id, tool] of Object.entries(tools)) {
    for (const venue of venues) {
      const expected = COLLAB_TOOL_VENUES[id as keyof typeof COLLAB_TOOL_VENUES].includes(venue)
      it(`${id} @ ${venue} → ${expected}`, () => {
        expect(tool.visibleIn({ venue })).toBe(expected)
        // 没有 venue 时从 kind 现算一次 —— 同一个归一化函数,不会分家。
        expect(tool.visibleIn({ kind: venue === 'chat' ? undefined : venue })).toBe(expected)
      })
    }
  }
})
