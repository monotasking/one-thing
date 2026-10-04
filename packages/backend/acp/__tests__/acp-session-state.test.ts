import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import {
  ACP_SESSION_NOTICE_LIMIT,
  applySessionUpdate,
  createAcpSessionState,
  seedAcpSessionState,
  withAcpSessionProcess,
} from '../acp-session-state.js'

/**
 * 会话状态 reducer(A0-2,§3.3):十六种 `session/update` 每种一条,外加「没变就同一只对象」
 * 与通知上限。回合那六种必须原样返回 —— 它们归回合事件流,折进状态就是一份双账。
 */

const base = () => createAcpSessionState({ localSessionId: 'local-1', agentId: 'fake', acpSessionId: 'acp-1' })
const fold = (update: SessionUpdate, now = 1000) => applySessionUpdate(base(), update, now)

describe('applySessionUpdate —— 回合六种不动状态', () => {
  const text = { type: 'text' as const, text: 'hi' }
  it('user_message_chunk', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'user_message_chunk', content: text })).toBe(state)
  })
  it('agent_message_chunk', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'agent_message_chunk', content: text })).toBe(state)
  })
  it('agent_thought_chunk', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: text })).toBe(state)
  })
  it('tool_call', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read' })).toBe(state)
  })
  it('tool_call_update', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })).toBe(state)
  })
  it('compaction_summary_chunk', () => {
    const state = base()
    expect(applySessionUpdate(state, { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: text })).toBe(state)
  })
})

describe('applySessionUpdate —— 会话状态十种', () => {
  it('available_commands_update → commands(带输入提示)', () => {
    const state = fold({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'review', description: 'Review', input: { hint: 'path' } },
        { name: 'init', description: 'Init' },
      ],
    })
    expect(state.commands).toEqual([
      { name: 'review', description: 'Review', inputHint: 'path' },
      { name: 'init', description: 'Init' },
    ])
  })

  it('current_mode_update → modes.current,保留已知的可选列表', () => {
    const seeded = seedAcpSessionState(base(), {
      modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code', description: 'Write' }] },
    })
    const state = applySessionUpdate(seeded, { sessionUpdate: 'current_mode_update', currentModeId: 'code' })
    expect(state.modes).toEqual({
      current: 'code',
      available: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code', description: 'Write' }],
    })
  })

  it('config_option_update → configOptions,select 拍平分组、boolean 也收', () => {
    const state = fold({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'a',
          options: [{ group: 'g', name: 'Group', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
        },
        { id: 'effort', name: 'Effort', type: 'select', currentValue: 'hi', options: [{ value: 'hi', name: 'High' }] },
        { id: 'fast', name: 'Fast', type: 'boolean', currentValue: true },
      ],
    })
    expect(state.configOptions).toEqual([
      {
        id: 'model', name: 'Model', category: 'model', currentValue: 'a',
        choices: [{ value: 'a', name: 'A', group: 'Group' }, { value: 'b', name: 'B', group: 'Group' }],
      },
      { id: 'effort', name: 'Effort', currentValue: 'hi', choices: [{ value: 'hi', name: 'High' }] },
      {
        id: 'fast', name: 'Fast', type: 'boolean', currentValue: 'true',
        choices: [{ value: 'true', name: 'On' }, { value: 'false', name: 'Off' }],
      },
    ])
  })

  it('session_info_update → info;null 清掉那一格', () => {
    const titled = fold({ sessionUpdate: 'session_info_update', title: 'Fix bug', updatedAt: '2026-09-25T00:00:00Z' })
    expect(titled.info).toEqual({ title: 'Fix bug', updatedAt: '2026-09-25T00:00:00Z' })
    const cleared = applySessionUpdate(titled, { sessionUpdate: 'session_info_update', title: null })
    expect(cleared.info).toEqual({ updatedAt: '2026-09-25T00:00:00Z' })
  })

  it('usage_update → usage(含 cost)', () => {
    const state = fold({ sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.12, currency: 'USD' } })
    expect(state.usage).toEqual({ used: 1200, size: 200000, cost: { amount: 0.12, currency: 'USD' } })
  })

  it('notice → notices 追加,带时刻;未知严重度落 info', () => {
    const state = fold({ sessionUpdate: 'notice', severity: 'warning', title: 'Rate limited', description: 'slow down' }, 42)
    expect(state.notices).toEqual([{ severity: 'warning', title: 'Rate limited', description: 'slow down', at: 42 }])
    const odd = applySessionUpdate(state, { sessionUpdate: 'notice', severity: 'shouting', title: 'x' }, 43)
    expect(odd.notices[1]).toEqual({ severity: 'info', title: 'x', at: 43 })
  })

  it('plan(旧式整份)→ items 形,无 id', () => {
    const state = fold({
      sessionUpdate: 'plan',
      entries: [{ content: 'step 1', priority: 'high', status: 'in_progress' }],
    })
    expect(state.plan).toEqual({ kind: 'items', entries: [{ content: 'step 1', priority: 'high', status: 'in_progress' }] })
  })

  it('plan_update → items / markdown / file 三形', () => {
    const items = fold({
      sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'p1', entries: [{ content: 'a', priority: 'low', status: 'pending' }] },
    })
    expect(items.plan).toEqual({ kind: 'items', planId: 'p1', entries: [{ content: 'a', priority: 'low', status: 'pending' }] })
    const markdown = fold({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p2', content: '# Plan' } })
    expect(markdown.plan).toEqual({ kind: 'markdown', planId: 'p2', markdown: '# Plan' })
    const file = fold({ sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'p3', uri: 'file:///tmp/plan.md' } })
    expect(file.plan).toEqual({ kind: 'file', planId: 'p3', path: '/tmp/plan.md' })
  })

  it('plan_removed → 只删 id 对得上的那份', () => {
    const withPlan = fold({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'p1', content: 'x' } })
    expect(applySessionUpdate(withPlan, { sessionUpdate: 'plan_removed', planId: 'other' })).toBe(withPlan)
    expect(applySessionUpdate(withPlan, { sessionUpdate: 'plan_removed', planId: 'p1' }).plan).toBeUndefined()
  })

  it('compaction_update → in_progress 记开始时刻,收场记 done', () => {
    const started = fold({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' }, 100)
    expect(started.compaction).toEqual({ status: 'in_progress', startedAt: 100 })
    const done = applySessionUpdate(started, { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed' }, 200)
    expect(done.compaction).toEqual({ status: 'done', startedAt: 100 })
  })
})

describe('applySessionUpdate —— 身份与上限', () => {
  it('同一份内容再推一次 → 原样返回同一只对象', () => {
    const update: SessionUpdate = { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'a', description: 'A' }] }
    const once = fold(update)
    expect(applySessionUpdate(once, update)).toBe(once)
    const usage: SessionUpdate = { sessionUpdate: 'usage_update', used: 1, size: 2 }
    const withUsage = applySessionUpdate(once, usage)
    expect(applySessionUpdate(withUsage, usage)).toBe(withUsage)
    expect(withAcpSessionProcess(withUsage, withUsage.process)).toBe(withUsage)
  })

  it(`notices 只留最近 ${ACP_SESSION_NOTICE_LIMIT} 条,新的在后`, () => {
    let state = base()
    for (let i = 0; i < ACP_SESSION_NOTICE_LIMIT + 5; i += 1) {
      state = applySessionUpdate(state, { sessionUpdate: 'notice', severity: 'info', title: `n${i}` }, i)
    }
    expect(state.notices).toHaveLength(ACP_SESSION_NOTICE_LIMIT)
    expect(state.notices[0].title).toBe('n5')
    expect(state.notices.at(-1)?.title).toBe(`n${ACP_SESSION_NOTICE_LIMIT + 4}`)
  })

  it('进程格变了才换对象', () => {
    const state = base()
    const connected = withAcpSessionProcess(state, { status: 'connected', pid: 7 })
    expect(connected).not.toBe(state)
    expect(connected.process).toEqual({ status: 'connected', pid: 7 })
  })
})
