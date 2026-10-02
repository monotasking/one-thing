import { describe, expect, it, vi } from 'vitest'

import { AbortScope } from '../abort-scope.js'
import { OutputBudget } from '../output-budget.js'
import { RunContext } from '../run-context.js'
import { InMemoryJobRegistry, makeInvocation } from './fakes.js'

function makeContext(overrides: Partial<ConstructorParameters<typeof RunContext>[0]> = {}) {
  const abort = new AbortScope()
  const context = new RunContext({
    invocation: makeInvocation({ toolId: 'bash', cwd: '/repo' }),
    abort,
    budget: new OutputBudget(),
    ...overrides,
  })
  return { context, abort }
}

describe('RunContext', () => {
  it('把 principal / cwd 从 invocation 上直接暴露出来', () => {
    const { context, abort } = makeContext()
    expect(context.principal).toEqual({ kind: 'user', userId: 'local' })
    expect(context.cwd).toBe('/repo')
    abort.dispose()
  })

  it('emit 走注入的 sink', () => {
    const emit = vi.fn()
    const { context, abort } = makeContext({ emit })
    context.emit({ type: 'progress', message: 'half way' })
    expect(emit).toHaveBeenCalledWith({ type: 'progress', message: 'half way' })
    abort.dispose()
  })

  it('dispose 之后的迟到事件被丢掉(取消后的输出不该串进下一次调用)', () => {
    const emit = vi.fn()
    const { context, abort } = makeContext({ emit })
    context.dispose()
    context.emit({ type: 'progress' })
    expect(emit).not.toHaveBeenCalled()
    abort.dispose()
  })

  it('forPlan 是窄视图:没有 emit,也没有 jobs', () => {
    const { context, abort } = makeContext()
    const planContext = context.forPlan()
    expect('emit' in planContext).toBe(false)
    expect('jobs' in planContext).toBe(false)
    expect(planContext.invocation.toolId).toBe('bash')
    expect(typeof planContext.now()).toBe('number')
    abort.dispose()
  })

  it('jobs 是绑定视图:归属由系统填,工具说不了话', async () => {
    const registry = new InMemoryJobRegistry()
    const { context, abort } = makeContext({ jobs: registry })
    const job = await context.jobs.spawn({ label: 'dev server', command: 'bun run dev' })
    expect(job.owner).toEqual({ sessionId: 'session-1', toolCallId: 'call-1' })
    expect(context.jobs.list().map(item => item.id)).toEqual([job.id])
    expect(context.jobs.get(job.id)).toBe(job)
    abort.dispose()
  })

  it('别的会话生出来的 job 对这次调用不存在(句柄不是能力凭证)', () => {
    const registry = new InMemoryJobRegistry()
    const foreign = registry.spawn({ owner: { sessionId: 'other', toolCallId: 'x' } })
    const { context, abort } = makeContext({ jobs: registry })
    expect(context.jobs.get(foreign.id)).toBeUndefined()
    expect(context.jobs.list()).toEqual([])
    abort.dispose()
  })

  it('没绑 JobRegistry 时 spawn 报一句人话', async () => {
    const { context, abort } = makeContext()
    await expect(context.jobs.spawn({ label: 'x' })).rejects.toThrow(/No JobRegistry port/)
    abort.dispose()
  })

  it('now() 走注入的时钟', () => {
    const { context, abort } = makeContext({ clock: { now: () => 42 } })
    expect(context.now()).toBe(42)
    abort.dispose()
  })
})
