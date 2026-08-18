/**
 * 尺子⑤ —— 用一个假的 RunContext 单测任何工具:不起引擎、不起 store、不起 Electron。
 *
 * 这条测试同时是给 R1 家族基类作者看的范本:一个工具的全生命周期(plan → 授权 →
 * apply → 事件流 → 预算 → outcome)在这里被完整断言,端口全是内存实现,总共几十行。
 */

import { describe, expect, it } from 'vitest'

import { makeEffect } from '../effects.js'
import { Intent } from '../intent.js'
import { jobSnapshot } from '../job.js'
import { Outcome } from '../outcome.js'
import { textResult } from '../result.js'
import { ToolRunner } from '../runner.js'
import {
  allowAuthorizer,
  InMemoryJobRegistry,
  makeInvocation,
  passthroughValidator,
  RecordingObserver,
  ScriptedTool,
} from './fakes.js'

describe('一次调用的一生(全内存端口)', () => {
  it('事件按顺序流出,结果被预算收尾,结局是 ok', async () => {
    const observer = new RecordingObserver()
    const jobs = new InMemoryJobRegistry()
    const spilled: string[] = []

    const tool = new ScriptedTool({
      id: 'bash',
      effects: ['bash'],
      budget: { maxLines: 3 },
      plan: async (input, ctx) => {
        // plan 阶段能看见坐标与沙箱,但拿不到 emit / jobs。
        expect(ctx.invocation.callId).toBe('call-1')
        return Intent.of({
          effects: [makeEffect('bash', ['bun run dev'])],
          preview: { title: 'Run bash command: bun run dev' },
          payload: { command: String((input as { command?: string }).command) },
        })
      },
      apply: async (intent, ctx) => {
        ctx.emit({ type: 'step', phase: 'start', id: 'spawn', title: 'spawn' })
        ctx.emit({ type: 'progress', message: 'booting', ratio: 0.5 })
        ctx.emit({ type: 'partial', result: textResult('line 1') })
        const job = await ctx.jobs.spawn({ label: 'dev server', command: (intent.payload as { command: string }).command })
        ctx.emit({ type: 'spawned', job: jobSnapshot(job) })
        ctx.emit({ type: 'annotate', title: 'dev server', details: { pid: 1234 } })
        ctx.emit({ type: 'step', phase: 'end', id: 'spawn' })
        return textResult(['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n'))
      },
    })

    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer,
      validator: passthroughValidator,
      jobs,
      spill: request => {
        spilled.push(request.text)
        return '/tmp/bash-call-1.log'
      },
      clock: { now: () => 1_000 },
      session: invocation => ({ id: invocation.sessionId, kind: 'chat', workspaceRoot: '/repo' }),
    })

    const outcome = await runner.run(
      tool,
      makeInvocation({ toolId: 'bash', input: { command: 'bun run dev' } }),
    )

    expect(observer.toolEventTypes()).toEqual(['step', 'progress', 'partial', 'spawned', 'annotate', 'step'])
    expect(observer.events.every(entry => entry.invocation.callId === 'call-1')).toBe(true)

    // Runner 自己的三条证词:计划 → 结论 → 结局,顺序固定。
    expect(observer.lifecyclePhases()).toEqual(['planned', 'decided', 'finished'])
    const planned = observer.events[0]?.event
    expect(planned).toMatchObject({ type: 'lifecycle', phase: 'planned' })
    if (planned?.type === 'lifecycle' && planned.phase === 'planned') {
      // 审计要能回答"打算做什么":效果与预览都在这条里。
      expect(planned.intent.effects.map(effect => effect.kind)).toEqual(['bash'])
      expect(planned.intent.preview?.title).toContain('bun run dev')
    }
    // planned 在任何工具事件之前,finished 在最后。
    expect(observer.types()[0]).toBe('lifecycle')
    expect(observer.types().at(-1)).toBe('lifecycle')

    expect(jobs.jobs).toHaveLength(1)
    expect(jobs.jobs[0]?.owner).toEqual({ sessionId: 'session-1', toolCallId: 'call-1' })

    expect(outcome.kind).toBe('ok')
    const text = Outcome.toModelText(outcome)
    expect(text.startsWith('line 1\nline 2\nline 3')).toBe(true)
    expect(text).toContain('spill="/tmp/bash-call-1.log"')
    expect(spilled).toHaveLength(1)
  })

  it('工具能看见会话快照,但改不了它', async () => {
    let seenRoot: string | undefined
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        seenRoot = ctx.session?.workspaceRoot
        return textResult('ok')
      },
    })
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer: new RecordingObserver(),
      validator: passthroughValidator,
      session: () => ({ id: 'session-1', workspaceRoot: '/repo' }),
    })
    await runner.run(tool, makeInvocation())
    expect(seenRoot).toBe('/repo')
  })

  it('调用结束之后工具还想 emit —— 事件被丢掉', async () => {
    const observer = new RecordingObserver()
    let leak: (() => void) | undefined
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        leak = () => ctx.emit({ type: 'progress', message: 'too late' })
        return textResult('ok')
      },
    })
    const runner = new ToolRunner({ authorizer: allowAuthorizer, observer, validator: passthroughValidator })
    await runner.run(tool, makeInvocation())
    expect(observer.toolEventTypes()).toEqual([])
    leak?.()
    expect(observer.toolEventTypes()).toEqual([])
  })

  it('工具伪造不了生命周期事件(审计不能是自证清白的材料)', async () => {
    const observer = new RecordingObserver()
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        // 插件/MCP 送进来的工具不受 TS 约束,所以运行时也要挡一次。
        ;(ctx.emit as (event: unknown) => void)({ type: 'lifecycle', phase: 'decided', decision: { kind: 'allow' } })
        ctx.emit({ type: 'progress', message: 'real event' })
        return textResult('ok')
      },
    })
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer,
      validator: passthroughValidator,
    })
    await runner.run(tool, makeInvocation())
    expect(observer.toolEventTypes()).toEqual(['progress'])
    // 仍然只有 Runner 发的那三条。
    expect(observer.lifecyclePhases()).toEqual(['planned', 'decided', 'finished'])
  })

  it('finished 带的是最终结局:拦截器改写过的那一个', async () => {
    const observer = new RecordingObserver()
    const tool = new ScriptedTool({ apply: async () => textResult('raw') })
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer,
      validator: passthroughValidator,
      interceptor: {
        beforePlan: () => ({}),
        afterApply: () => Outcome.ok(textResult('rewritten')),
      },
    })
    await runner.run(tool, makeInvocation())
    const finished = observer.events.at(-1)?.event
    expect(finished?.type).toBe('lifecycle')
    if (finished?.type === 'lifecycle' && finished.phase === 'finished') {
      expect(Outcome.toModelText(finished.outcome)).toBe('rewritten')
    }
  })

  it('观察者自己炸了不改变结局(它是旁观者,不是参与者)', async () => {
    const tool = new ScriptedTool({ apply: async () => textResult('ok') })
    const runner = new ToolRunner({
      authorizer: allowAuthorizer,
      observer: { on() { throw new Error('projector exploded') } },
      validator: passthroughValidator,
    })
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome.kind).toBe('ok')
  })
})
