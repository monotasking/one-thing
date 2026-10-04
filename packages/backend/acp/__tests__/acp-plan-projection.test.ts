import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnethingTodoPlanStore, type TodoPlanChangedPayload } from '@onething/backend/todo-plan'
import { applySessionUpdate, createAcpSessionState } from '@onething/backend/acp/acp-session-state'
import type { AcpSessionState } from '@shared/contracts/acp'
import { AcpPlanProjection, renderAcpPlanItems } from '../acp-plan-projection.js'

/**
 * 计划 → 待办域 `session-ai-todo` 的投影(A2-b)。store 是临时目录上的**真** `OnethingTodoPlanStore`,
 * 状态表由真 reducer 折出来 —— 证的是「agent 推什么,待办文件就是什么」,以及身份不变一次都不写。
 */

let root: string
let store: OnethingTodoPlanStore
let changes: TodoPlanChangedPayload[]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-plan-'))
  changes = []
  store = new OnethingTodoPlanStore({ getDefaultStorePath: () => root, notifyChanged: payload => changes.push(payload) })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const SESSION = 'local-1'

function fresh(acpSessionId = 'acp-1'): AcpSessionState {
  return createAcpSessionState({ localSessionId: SESSION, agentId: 'fake', acpSessionId })
}

type Update = Parameters<typeof applySessionUpdate>[1]

function fold(state: AcpSessionState, update: Record<string, unknown>): AcpSessionState {
  return applySessionUpdate(state, update as unknown as Update)
}

const items = (statuses: Array<'pending' | 'in_progress' | 'completed'>) => ({
  sessionUpdate: 'plan_update',
  plan: {
    type: 'items',
    planId: 'p1',
    entries: [
      { content: 'Read the code', priority: 'high', status: statuses[0] },
      { content: 'Write\nthe patch', priority: 'medium', status: statuses[1] },
    ],
  },
})

function todoFile(): string | null {
  const file = store.sessionAiTodoPath(SESSION)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null
}

describe('AcpPlanProjection', () => {
  it('items: one task line per entry, statuses follow every plan_update', async () => {
    const projection = new AcpPlanProjection({ store: () => store })
    let state = fold(fresh(), items(['pending', 'pending']))
    projection.observe(state)
    await projection.idle()
    expect(todoFile()).toBe('# 计划\n\n- [ ] **Read the code**\n- [ ] Write the patch\n')

    state = fold(state, items(['completed', 'in_progress']))
    projection.observe(state)
    await projection.idle()
    expect(todoFile()).toBe('# 计划\n\n- [x] **Read the code**\n- [ ] Write the patch _(进行中)_\n')
    expect(changes.filter(change => change.scope === 'session-ai-todo' && change.sessionId === SESSION)).toHaveLength(2)
  })

  it('markdown: the whole text; file: the file body (or a pointer when unreadable)', async () => {
    const projection = new AcpPlanProjection({ store: () => store })
    projection.observe(fold(fresh(), { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'm', content: '## Steps\n\n1. do it' } }))
    await projection.idle()
    expect(todoFile()).toBe('## Steps\n\n1. do it\n')

    const planFile = path.join(root, 'PLAN.md')
    fs.writeFileSync(planFile, '# From file\n\n- [ ] a\n')
    projection.observe(fold(fresh('acp-2'), { sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'f', uri: `file://${planFile}` } }))
    await projection.idle()
    expect(todoFile()).toBe('# From file\n\n- [ ] a\n')

    projection.observe(fold(fresh('acp-3'), { sessionUpdate: 'plan_update', plan: { type: 'file', planId: 'g', uri: `file://${path.join(root, 'missing.md')}` } }))
    await projection.idle()
    expect(todoFile()).toContain('missing.md')
  })

  it('identity: an unchanged plan (other fields changing) never writes again', async () => {
    const updateDocument = vi.spyOn(store, 'updateDocument')
    const projection = new AcpPlanProjection({ store: () => store })
    let state = fold(fresh(), items(['pending', 'pending']))
    projection.observe(state)
    // 用量、命令表变了:状态表换了新对象,计划那一格还是同一只。
    state = fold(state, { sessionUpdate: 'usage_update', used: 10, size: 100 })
    projection.observe(state)
    state = fold(state, { sessionUpdate: 'available_commands_update', availableCommands: [] })
    projection.observe(state)
    // agent 把同一份计划又推一遍:reducer 按值判等,原样返回。
    state = fold(state, items(['pending', 'pending']))
    projection.observe(state)
    await projection.idle()
    expect(updateDocument).toHaveBeenCalledTimes(1)
  })

  it('plan_removed clears the AI todo; a new agent session starting empty does not', async () => {
    const projection = new AcpPlanProjection({ store: () => store })
    let state = fold(fresh(), items(['pending', 'pending']))
    projection.observe(state)
    await projection.idle()
    expect(todoFile()).not.toBeNull()

    // 换了一条 agent 会话(新开 / 恢复失败改开):新表没有计划,但那不是 agent 说删。
    projection.observe(fresh('acp-other'))
    await projection.idle()
    expect(todoFile()).not.toBeNull()

    state = fold(fresh('acp-other'), items(['completed', 'pending']))
    projection.observe(state)
    await projection.idle()
    changes = []
    state = fold(state, { sessionUpdate: 'plan_removed', planId: 'p1' })
    expect(state.plan).toBeUndefined()
    projection.observe(state)
    await projection.idle()
    expect(todoFile()).toBeNull()
    expect(changes).toEqual([{ scope: 'session-ai-todo', sessionId: SESSION }])
  })

  it('does not touch an AI todo it never wrote, and stops after dispose', async () => {
    await store.updateDocument({ scope: 'session-ai-todo', sessionId: SESSION, content: '# mine\n\n- [ ] local\n' })
    const projection = new AcpPlanProjection({ store: () => store })
    const state = fresh()
    projection.observe(state)
    projection.observe(fold(state, { sessionUpdate: 'plan_removed', planId: 'p1' }))
    await projection.idle()
    expect(todoFile()).toBe('# mine\n\n- [ ] local\n')

    projection.dispose()
    projection.observe(fold(fresh(), items(['pending', 'pending'])))
    await projection.idle()
    expect(todoFile()).toBe('# mine\n\n- [ ] local\n')
  })

  it('renders an empty entry list as nothing', () => {
    expect(renderAcpPlanItems([])).toBe('')
  })
})
