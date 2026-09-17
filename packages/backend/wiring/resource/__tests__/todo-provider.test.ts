import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResourceEventHub, ResourceRef } from '@onething/core/resource'
import type { PlanContext, RunContext } from '@onething/core/toolkit'
import { OnethingTodoPlanStore, type TodoPlanChangedPayload } from '@onething/runtime/todo-plan'
import type { TodoPlanChangeListener } from '../../todo-plan/store.js'
import { TodoResourceProvider } from '../todo-provider.js'

let root: string
let store: OnethingTodoPlanStore
let listeners: Set<TodoPlanChangeListener>
let events: Array<{ path: string; event: string; payload: unknown }>
let provider: TodoResourceProvider

const ref = (p: string): ResourceRef => ({ scheme: 'todo', path: p })
const planCtx = (kind: 'user' | 'agent'): PlanContext =>
  ({ principal: kind === 'user' ? { kind: 'user', userId: 'local-user' } : { kind: 'agent', agentId: 'a' }, invocation: { sessionId: 's' } }) as unknown as PlanContext
const runCtx = {} as RunContext
const readCtx = {} as never

async function run(op: string, target: string, params: unknown, who: 'user' | 'agent' = 'user') {
  const intent = await provider.plan(op, ref(target), params, planCtx(who))
  const result = await provider.apply(op, intent, runCtx)
  return { intent, value: JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown> }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'onething-todo-provider-'))
  listeners = new Set()
  events = []
  store = new OnethingTodoPlanStore({
    getConfiguredDirectory: () => root,
    getDefaultStorePath: () => root,
    notifyChanged: (payload: TodoPlanChangedPayload) => { for (const l of listeners) l(payload, 'app') },
  })
  provider = new TodoResourceProvider({
    store: () => store,
    onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
  })
  const hub = { emit: (r: ResourceRef, event: string, payload: unknown) => events.push({ path: r.path, event, payload }) } as unknown as ResourceEventHub
  provider.attach(hub)
})

afterEach(async () => {
  provider.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('todo resource provider', () => {
  it('reads a session plan that does not exist as exists:false', async () => {
    const doc = await provider.read('document', ref('session/s1'), {}, readCtx) as Record<string, unknown>
    expect(doc).toMatchObject({ exists: false, content: '', total: 0, done: 0 })
  })

  it('lists notes with task counts', async () => {
    await mkdir(path.join(root, 'user-notes'), { recursive: true })
    await writeFile(path.join(root, 'user-notes', 'recent.md'), '# 近期\n\n- [x] 一\n- [ ] 二\n')
    const list = await provider.read('list', ref('notes'), {}, readCtx) as { notes: Array<Record<string, unknown>> }
    expect(list.notes).toEqual([expect.objectContaining({ ref: 'todo:note/recent', title: '近期', total: 2, done: 1 })])
  })

  it('applies a line edit and lands on the right line after the AI inserted lines above it', async () => {
    const file = path.join(root, 'sessions', 's1', 'ai-todo.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# 计划\n\n- [ ] 甲\n- [ ] 乙\n')
    // AI writes two lines above 乙 without telling anyone
    await writeFile(file, '# 计划\n\n- [ ] 甲\n- [ ] AI 新加一\n- [ ] AI 新加二\n- [ ] 乙\n')
    const { value } = await run('edit', 'session/s1', { edits: [{ start: 3, expect: ['- [ ] 乙'], lines: ['- [x] 乙'] }] })
    expect(value.conflict).toBe(false)
    expect(await readFile(file, 'utf-8')).toBe('# 计划\n\n- [ ] 甲\n- [ ] AI 新加一\n- [ ] AI 新加二\n- [x] 乙\n')
    expect(events).toContainEqual({ path: 'session/s1', event: 'changed', payload: { origin: 'app' } })
  })

  it('writes nothing and reports a conflict when any edit in the batch cannot be placed', async () => {
    const file = path.join(root, 'sessions', 's1', 'ai-todo.md')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '# 计划\n\n- [ ] 甲\n')
    const { value } = await run('edit', 'session/s1', { edits: [
      { start: 2, expect: ['- [ ] 甲'], lines: ['- [x] 甲'] },
      { start: 3, expect: ['- [ ] 不存在'], lines: [] },
    ] })
    expect(value.conflict).toBe(true)
    expect(await readFile(file, 'utf-8')).toBe('# 计划\n\n- [ ] 甲\n')
  })

  it('gives the user zero effects and other principals the declared upper bound', async () => {
    await run('createPlan', 'session/s2', { text: '第一项' })
    const user = await provider.plan('edit', ref('session/s2'), { edits: [{ start: 2, expect: ['- [ ] 第一项'], lines: [] }] }, planCtx('user'))
    const agent = await provider.plan('edit', ref('session/s2'), { edits: [{ start: 2, expect: ['- [ ] 第一项'], lines: [] }] }, planCtx('agent'))
    expect(user.effects).toEqual([])
    expect(agent.effects.map(effect => effect.kind)).toEqual(['file_edit'])
  })

  it('creates, renames and deletes a note', async () => {
    const created = await run('create', 'notes', { title: 'Weekly' })
    expect(created.value.ref).toBe('todo:note/weekly')
    const renamed = await run('rename', 'note/weekly', { title: 'Monthly' })
    expect(renamed.value.ref).toBe('todo:note/monthly')
    await run('delete', 'note/monthly', {})
    const doc = await provider.read('document', ref('note/monthly'), {}, readCtx) as Record<string, unknown>
    expect(doc.exists).toBe(false)
    expect(events.map(e => `${e.path}:${e.event}`)).toEqual(expect.arrayContaining(['note/weekly:created', 'note/monthly:deleted']))
  })

  it('rejects addresses that escape the todo directory', async () => {
    await expect(provider.read('document', ref('note/../../etc'), {}, readCtx)).rejects.toThrow()
    await expect(provider.read('document', ref('session/..'), {}, readCtx)).rejects.toThrow()
  })

  it('forwards external changes with origin external', () => {
    for (const l of listeners) l({ scope: 'session-ai-todo', sessionId: 's9' }, 'external')
    for (const l of listeners) l({ scope: 'global-user' }, 'external')
    expect(events).toContainEqual({ path: 'session/s9', event: 'changed', payload: { origin: 'external' } })
    expect(events).toContainEqual({ path: 'notes', event: 'changed', payload: { origin: 'external' } })
  })
})
