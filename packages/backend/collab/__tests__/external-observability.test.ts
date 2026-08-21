/**
 * 外部通路的观测面(claude-code-integration-v2 §6,E6)。
 *
 * 钉四件事:
 *  1. **执行会话 → 房间的翻译**:三类事件手上都只有执行会话 id,而账是按房落盘的。
 *     翻不出来(这条会话不在任何一轮 v3 回合里)= **不记账也不报错**;
 *  2. **因果引用**:三类的 `triggeredBy` 都指得回牌号,提问的后四相另指回 `open`;
 *  3. **正文永不入账**:与另外十四类同一道门;
 *  4. **不装 = 不记账**:观测是旁路,摘掉写入口之后同一条剧本不该跑出第二个结果。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CollabSchedulerLogRow } from '@onething/runtime/collab/actors'

const mocks = vi.hoisted(() => ({
  emitted: [] as Array<{ sessionId: string; event: Record<string, unknown> }>,
  handlers: new Map<string, (envelope: { sessionId: string; event: unknown }) => void>(),
  broadcasts: [] as string[],
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, event: Record<string, unknown>) => {
      mocks.emitted.push({ sessionId, event })
    },
    onAnySession: (
      eventType: string,
      handler: (envelope: { sessionId: string; event: unknown }) => void,
    ) => {
      mocks.handlers.set(eventType, handler)
      return () => { mocks.handlers.delete(eventType) }
    },
  }),
}))

vi.mock('../agent-activity.js', () => ({
  broadcastCollabAgentActivity: (agentId: string) => { mocks.broadcasts.push(agentId) },
}))

const {
  configureCollabExternalLogSink,
  installCollabExternalObservers,
  recordExternalAgentTool,
  recordExternalAgentTurn,
} = await import('../external-observability.js')
const { beginCollabV3Turn, clearCollabV3Turns } = await import('../actors/turn-context.js')

/* ── 场子 ─────────────────────────────────────────────────────────────────── */

let rows: Array<{ roomId: string; row: CollabSchedulerLogRow }> = []

/** Iris 正在 room-1 里跑一轮外部回合,牌号 L1,执行会话 exec-1。 */
function inFlightTurn(): void {
  beginCollabV3Turn({
    agentId: 'iris',
    roomSessionId: 'room-1',
    execSessionId: 'exec-1',
    leaseId: 'L1',
    epoch: 1,
    startedAt: 1_000,
  })
}

beforeEach(() => {
  rows = []
  mocks.emitted.length = 0
  mocks.broadcasts.length = 0
  mocks.handlers.clear()
  clearCollabV3Turns()
  configureCollabExternalLogSink({
    append: (roomId, row) => { rows.push({ roomId, row }) },
  })
})

/* ── external-turn ────────────────────────────────────────────────────────── */

describe('external-turn', () => {
  it('起落两相各一行,落那一相带收场与墙钟;两行都指回牌号', () => {
    inFlightTurn()
    recordExternalAgentTurn({
      localSessionId: 'exec-1', connectorId: 'claude-code-agent', phase: 'start', at: 1_000,
    })
    recordExternalAgentTurn({
      localSessionId: 'exec-1',
      connectorId: 'claude-code-agent',
      phase: 'end',
      outcome: 'aborted',
      elapsedMs: 131_000,
      at: 132_000,
    })
    expect(rows.map(entry => entry.roomId)).toEqual(['room-1', 'room-1'])
    expect(rows[0].row).toEqual({
      type: 'external-turn',
      at: 1_000,
      agentId: 'iris',
      connectorId: 'claude-code-agent',
      phase: 'start',
      triggeredBy: 'L1',
    })
    expect(rows[1].row).toMatchObject({
      phase: 'end', outcome: 'aborted', elapsedMs: 131_000, triggeredBy: 'L1',
    })
  })

  it('会话不在任何一轮 v3 回合里 → 不记账,也不报错', () => {
    recordExternalAgentTurn({
      localSessionId: 'lonely-chat', connectorId: 'claude-code-agent', phase: 'start',
    })
    expect(rows).toEqual([])
  })

  it('写入口摘掉之后一行都不写(观测是旁路)', () => {
    inFlightTurn()
    configureCollabExternalLogSink(null)
    recordExternalAgentTurn({
      localSessionId: 'exec-1', connectorId: 'claude-code-agent', phase: 'start',
    })
    expect(rows).toEqual([])
  })

  it('落盘炸了不冒泡 —— 观测绝不能变成第二个故障源', () => {
    inFlightTurn()
    configureCollabExternalLogSink({
      append: () => { throw new Error('disk full') },
    })
    expect(() => recordExternalAgentTurn({
      localSessionId: 'exec-1', connectorId: 'claude-code-agent', phase: 'start',
    })).not.toThrow()
  })
})

/* ── external-tool ────────────────────────────────────────────────────────── */

describe('external-tool', () => {
  it('宿主工具与 SDK 自带工具靠 hostTool 分开 —— 两条完全不同的路', () => {
    inFlightTurn()
    recordExternalAgentTool({
      localSessionId: 'exec-1',
      connectorId: 'claude-code-agent',
      toolName: 'send_message',
      decision: 'allow',
      hostTool: true,
      toolCallId: 'toolu_1',
      at: 2_000,
    })
    recordExternalAgentTool({
      localSessionId: 'exec-1',
      connectorId: 'claude-code-agent',
      toolName: 'Write',
      decision: 'deny',
      hostTool: false,
      at: 3_000,
    })
    expect(rows.map(entry => entry.row)).toEqual([
      {
        type: 'external-tool',
        at: 2_000,
        agentId: 'iris',
        connectorId: 'claude-code-agent',
        toolName: 'send_message',
        decision: 'allow',
        hostTool: true,
        toolCallId: 'toolu_1',
        triggeredBy: 'L1',
      },
      {
        type: 'external-tool',
        at: 3_000,
        agentId: 'iris',
        connectorId: 'claude-code-agent',
        toolName: 'Write',
        decision: 'deny',
        hostTool: false,
        triggeredBy: 'L1',
      },
    ])
  })

  it('input 一个字都不进账(保密纪律 §7)', () => {
    inFlightTurn()
    recordExternalAgentTool({
      localSessionId: 'exec-1',
      connectorId: 'claude-code-agent',
      toolName: 'Bash',
      decision: 'allow',
      hostTool: false,
    })
    expect(JSON.stringify(rows[0].row)).not.toMatch(/input|command|content/)
  })
})

/* ── interaction:总线观测 ────────────────────────────────────────────────── */

describe('interaction', () => {
  function fire(eventType: string, event: unknown, sessionId = 'exec-1'): void {
    mocks.handlers.get(eventType)?.({ sessionId, event })
  }

  it('open 记题数并指回牌号;结算那一相指回 open,且不补 origin/questionCount', () => {
    inFlightTurn()
    installCollabExternalObservers()
    fire('interaction:requested', {
      type: 'interaction:requested',
      request: {
        id: 'itx-1',
        sessionId: 'exec-1',
        origin: 'external-agent',
        toolCallId: 'toolu_9',
        questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
        deadlineAt: 0,
        createdAt: 0,
      },
    })
    fire('interaction:settled', {
      type: 'interaction:settled',
      toolCallId: 'toolu_9',
      answer: { id: 'itx-1', answers: {}, outcome: 'timeout' },
    })

    expect(rows).toHaveLength(2)
    expect(rows[0].row).toMatchObject({
      type: 'interaction',
      phase: 'open',
      interactionId: 'itx-1',
      origin: 'external-agent',
      questionCount: 3,
      agentId: 'iris',
      toolCallId: 'toolu_9',
      // 根指回牌号 —— 于是「发牌 → 提问」在文件里连得起来。
      triggeredBy: 'L1',
    })
    expect(rows[1].row).toMatchObject({
      phase: 'timeout',
      interactionId: 'itx-1',
      // 后四相指回 open 那一行(它们之间可能隔着几分钟和别人的好几行)。
      triggeredBy: 'itx-1',
    })
    // 猜出来的值就是账里的假话 —— 结算事件身上没有这两格,所以一格都不补。
    expect(rows[1].row).not.toHaveProperty('origin')
    expect(rows[1].row).not.toHaveProperty('questionCount')
  })

  it('题干一个字都不进账', () => {
    inFlightTurn()
    installCollabExternalObservers()
    fire('interaction:requested', {
      type: 'interaction:requested',
      request: {
        id: 'itx-2',
        sessionId: 'exec-1',
        origin: 'external-agent',
        questions: [{ id: 'q1', question: '暖色还是冷色?', options: [{ label: '暖' }] }],
        deadlineAt: 0,
        createdAt: 0,
      },
    })
    expect(JSON.stringify(rows[0].row)).not.toContain('暖色')
  })

  it('两条等待链都点「等你回答」那盏灯,但审批链不记账', () => {
    inFlightTurn()
    installCollabExternalObservers()
    fire('permission:request', { type: 'permission:request' })
    fire('permission:settled', { type: 'permission:settled' })
    expect(mocks.broadcasts).toEqual(['iris', 'iris'])
    expect(rows).toEqual([])
  })

  it('退订之后不再记账(与运行时同生同灭)', () => {
    inFlightTurn()
    const uninstall = installCollabExternalObservers()
    uninstall()
    expect(mocks.handlers.size).toBe(0)
  })
})
