/**
 * N2 —— 发送前拦截的**协议层**验收。
 *
 * 这一份打的是 core 说了算的那一半:三态归一化(含"作者写错了"的每一种)、
 * 链的次序与累积、handled 短路、fail-open(抛错 / 超时 = continue)、熔断降级
 * 跳过、重复 id 拒绝,以及 `api.interceptInput` 的声明门。
 *
 * 引擎挂点(哪些入口进链、系统内部源豁免、transform 痕迹、reply 投递)在
 * `packages/backend/engine/__tests__/stream-engine-input-intercept.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import { createCorePluginAPI } from '../api-builder.js'
import {
  CorePluginInputInterceptRegistry,
  PLUGIN_PERMISSION_INPUT_INTERCEPT,
  normalizePluginInputInterceptResult,
  type PluginInputInterceptHandler,
} from '../input-intercept.js'
import { classifyPluginScope, pluginScope, resolvePluginScopeSeverity } from '../policy.js'
import { describePluginPermission } from '../sessions.js'

function createRegistry(options: {
  timeoutMs?: number
  degraded?: Set<string>
} = {}) {
  const failures: Array<{ pluginId: string; hookId: string }> = []
  const successes: Array<{ pluginId: string; hookId: string }> = []
  const violations: Array<{ pluginId: string; reason: string }> = []
  const errors: string[] = []
  const registry = new CorePluginInputInterceptRegistry({
    timeoutMs: options.timeoutMs,
    logger: { error(message: string) { errors.push(message) } },
    onHandlerFailure({ pluginId, hookId }) { failures.push({ pluginId, hookId }) },
    onHandlerSuccess({ pluginId, hookId }) { successes.push({ pluginId, hookId }) },
    isDegraded: pluginId => Boolean(options.degraded?.has(pluginId)),
    onRegistrationViolation({ pluginId, reason }) { violations.push({ pluginId, reason }) },
  })
  return { registry, failures, successes, violations, errors }
}

const run = (
  registry: CorePluginInputInterceptRegistry,
  text: string,
  sessionId = 's1',
) => registry.run({ sessionId, text, source: 'user' })

describe('三态归一化 —— 收敛与告警是两件事', () => {
  it('void / undefined / {action:"continue"} 都是 continue,且不算写错', () => {
    for (const raw of [undefined, null, { action: 'continue' }]) {
      const result = normalizePluginInputInterceptResult(raw)
      expect(result.decision).toEqual({ action: 'continue' })
      expect(result.problem).toBeUndefined()
    }
  })

  it('transform 必须带 string text;不带就回落 continue 并说出来', () => {
    expect(normalizePluginInputInterceptResult({ action: 'transform', text: 'hi' }).decision)
      .toEqual({ action: 'transform', text: 'hi' })
    // 空串是合法的改写结果(把一句话删空是作者的自由),不是"写错了"。
    expect(normalizePluginInputInterceptResult({ action: 'transform', text: '' }).decision)
      .toEqual({ action: 'transform', text: '' })

    const broken = normalizePluginInputInterceptResult({ action: 'transform' })
    expect(broken.decision).toEqual({ action: 'continue' })
    expect(broken.problem).toContain('transform')
  })

  it('handled 的 reply 可选;非字符串被丢弃但接管仍然成立', () => {
    expect(normalizePluginInputInterceptResult({ action: 'handled' }).decision)
      .toEqual({ action: 'handled' })
    expect(normalizePluginInputInterceptResult({ action: 'handled', reply: '7' }).decision)
      .toEqual({ action: 'handled', reply: '7' })

    const bad = normalizePluginInputInterceptResult({ action: 'handled', reply: 7 })
    expect(bad.decision).toEqual({ action: 'handled' })
    expect(bad.problem).toContain('reply')
  })

  it('未知 action 不静默 —— pi 那条死订阅的账单就是"写错了什么都不发生"', () => {
    const result = normalizePluginInputInterceptResult({ action: 'handeled' })
    expect(result.decision).toEqual({ action: 'continue' })
    expect(result.problem).toContain('handeled')
    expect(result.problem).toContain('continue | transform | handled')

    // 返回一个不是对象的东西同样被点名。
    expect(normalizePluginInputInterceptResult('handled').problem).toContain('object')
  })
})

describe('链:次序、累积、短路', () => {
  it('跨插件按 pluginId 字典序,插件内保持注册顺序', async () => {
    const { registry } = createRegistry()
    const seen: string[] = []
    const note = (label: string): PluginInputInterceptHandler => () => { seen.push(label); return undefined }
    // 注册顺序刻意与字典序相反,插件内顺序刻意可辨。
    registry.register('zeta', 'a', note('zeta/a'))
    registry.register('alpha', 'second', note('alpha/second'))
    registry.register('alpha', 'first', note('alpha/first'))

    await run(registry, 'hi')
    expect(seen).toEqual(['alpha/second', 'alpha/first', 'zeta/a'])
    expect(registry.listOrdered().map(item => `${item.pluginId}/${item.hookId}`))
      .toEqual(['alpha/second', 'alpha/first', 'zeta/a'])
  })

  it('transform 链式累积:后手看到的是前手改写后的文本', async () => {
    const { registry } = createRegistry()
    registry.register('a-plugin', 'upper', ctx => ({ action: 'transform', text: ctx.text.toUpperCase() }))
    registry.register('b-plugin', 'bang', ctx => ({ action: 'transform', text: `${ctx.text}!` }))

    const outcome = await run(registry, 'hi')
    expect(outcome.text).toBe('HI!')
    expect(outcome.handled).toBe(false)
    expect(outcome.transformedBy).toEqual(['a-plugin', 'b-plugin'])
    expect(outcome.ran).toBe(2)
  })

  it('handled 短路后续 handler,并带走前面累积的改写结果', async () => {
    const { registry } = createRegistry()
    const after = { called: false }
    registry.register('a-plugin', 'upper', ctx => ({ action: 'transform', text: ctx.text.toUpperCase() }))
    registry.register('b-plugin', 'take', () => ({ action: 'handled', reply: 'done' }))
    registry.register('c-plugin', 'never', () => { after.called = true; return undefined })

    const outcome = await run(registry, 'hi')
    expect(outcome).toMatchObject({
      text: 'HI',
      handled: true,
      handledBy: 'b-plugin',
      reply: 'done',
      transformedBy: ['a-plugin'],
    })
    expect(after.called).toBe(false)
  })

  it('没有任何注册者时原样返回(每一次发送都跑,这条早退必须存在)', async () => {
    const { registry } = createRegistry()
    const outcome = await run(registry, 'hi')
    expect(outcome).toEqual({ text: 'hi', handled: false, transformedBy: [], ran: 0 })
  })
})

describe('fail-open —— 发消息永远不能因为插件坏了而发不出去', () => {
  it('handler 抛错 = 当它返回 continue,并计一次熔断', async () => {
    const { registry, failures } = createRegistry()
    registry.register('bad', 'boom', () => { throw new Error('kaboom') })
    registry.register('good', 'shout', ctx => ({ action: 'transform', text: ctx.text.toUpperCase() }))

    const outcome = await run(registry, 'hi')
    // 坏插件排在前面也拦不住后面的:链继续走,消息照常发出。
    expect(outcome.text).toBe('HI')
    expect(outcome.handled).toBe(false)
    expect(failures).toEqual([{ pluginId: 'bad', hookId: 'boom' }])
  })

  it('handler 挂住 = 超时后当它返回 continue,并计一次熔断', async () => {
    const { registry, failures, successes } = createRegistry({ timeoutMs: 10 })
    registry.register('hang', 'forever', () => new Promise(() => {}))

    const outcome = await run(registry, 'hi')
    expect(outcome.text).toBe('hi')
    expect(outcome.handled).toBe(false)
    expect(failures).toEqual([{ pluginId: 'hang', hookId: 'forever' }])
    expect(successes).toEqual([])
  })

  it('返回值不合规同样 fail-open —— 收敛成 continue,但记一条 error', async () => {
    const { registry, errors, failures } = createRegistry()
    registry.register('typo', 'oops', () => ({ action: 'transfrom', text: 'x' } as never))

    const outcome = await run(registry, 'hi')
    expect(outcome.text).toBe('hi')
    // 写错返回值不是运行期抖动,不该连坐:它只报错,不计熔断。
    expect(failures).toEqual([])
    expect(errors.join('\n')).toContain('transfrom')
  })
})

describe('熔断降级 + 注册期违规', () => {
  it('降级的插件被整段跳过,消息照常发出', async () => {
    const degraded = new Set(['broken'])
    const { registry, successes } = createRegistry({ degraded })
    registry.register('broken', 'macro', () => ({ action: 'handled' }))
    registry.register('healthy', 'shout', ctx => ({ action: 'transform', text: ctx.text.toUpperCase() }))

    const outcome = await run(registry, 'hi')
    expect(outcome.handled).toBe(false)
    expect(outcome.text).toBe('HI')
    expect(successes).toEqual([{ pluginId: 'healthy', hookId: 'shout' }])
  })

  it('重复 (pluginId, id) 被拒绝 —— 第二个不会悄悄顶掉第一个', async () => {
    const { registry, violations } = createRegistry()
    registry.register('dup', 'macro', ctx => ({ action: 'transform', text: `${ctx.text}-first` }))
    const noop = registry.register('dup', 'macro', ctx => ({ action: 'transform', text: `${ctx.text}-second` }))

    expect(violations).toHaveLength(1)
    expect(violations[0].reason).toContain('already registered')
    expect(registry.getHookCount()).toBe(1)
    expect((await run(registry, 'x')).text).toBe('x-first')

    // 被拒的那次返回的是 no-op:调它不该把真正注册的那条退掉。
    noop()
    expect(registry.getHookCount()).toBe(1)
  })

  it('空 id 同样是注册期违规', () => {
    const { registry, violations } = createRegistry()
    registry.register('dup', '   ', () => undefined)
    expect(registry.getHookCount()).toBe(0)
    expect(violations[0].reason).toContain('non-empty id')
  })

  it('退订与按插件清扫都把足迹清回去', async () => {
    const { registry } = createRegistry()
    const unsub = registry.register('a', 'one', () => undefined)
    registry.register('a', 'two', () => undefined)
    registry.register('b', 'one', () => undefined)
    expect(registry.getHookCount()).toBe(3)
    unsub()
    expect(registry.getHookCount()).toBe(2)
    registry.clearForPlugin('a')
    expect(registry.listOrdered()).toEqual([{ pluginId: 'b', hookId: 'one' }])
  })
})

describe('熔断车道:input-intercept 自成一族,罚则是降级而不是禁用', () => {
  it('scope 归族并折成同一个 surface', () => {
    expect(classifyPluginScope(pluginScope.inputIntercept('macro'))).toBe('input-intercept')
    const severity = resolvePluginScopeSeverity(pluginScope.inputIntercept('macro'))
    // fail-open 的失败面对用户无害(消息发出去了),为它砍掉整个插件是把小故障
    // 放大成大故障。
    expect(severity.remedy).toBe('degrade-surface')
    expect(severity.surface).toBe('input-intercept')
    // 一个插件的所有拦截钩子共用一个 surface —— "它不再改我的输入了"是一句话。
    expect(resolvePluginScopeSeverity(pluginScope.inputIntercept('other')).surface)
      .toBe('input-intercept')
  })
})

describe('声明门:api.interceptInput 未声明即拒绝', () => {
  function build(permissions: string[], withHostPort = true) {
    const registered: Array<{ id: string }> = []
    const errors: string[] = []
    const failures: string[] = []
    const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
      pluginId: 'macros',
      store: {} as never,
      scheduler: {} as never,
      declaredPermissions: permissions,
      logger: {
        log() {},
        error(message: string) { errors.push(message) },
      },
      onPluginFailure({ scope }: { scope: string }) { failures.push(scope) },
      host: {
        registerTool() {},
        subscribeEvent() { return () => {} },
        steer() {},
        followUp() {},
        notify() {},
        registerPromptContextProvider() { return () => {} },
        registerBeforeContextCompactHook() { return () => {} },
        registerAfterAssistantResponseHook() { return () => {} },
        registerSkillRoot() { return () => {} },
        ...(withHostPort
          ? {
            registerInputInterceptHook(_pluginId: string, id: string) {
              registered.push({ id })
              return () => {}
            },
          }
          : {}),
      } as never,
    })
    return { api: built.api as any, registered, errors, failures }
  }

  it('声明了就注册得上', () => {
    const { api, registered, errors } = build([PLUGIN_PERMISSION_INPUT_INTERCEPT])
    api.interceptInput('big', () => undefined)
    expect(registered).toEqual([{ id: 'big' }])
    expect(errors).toEqual([])
  })

  it('没声明就拒绝,报错但**不计熔断**(manifest 笔误不该连坐整个插件)', () => {
    const { api, registered, errors, failures } = build([])
    api.interceptInput('big', () => undefined)
    expect(registered).toEqual([])
    expect(failures).toEqual([])
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_INPUT_INTERCEPT)
  })

  it('宿主没接这条线时如实报错,而不是静默假装注册成功', () => {
    const { api, errors } = build([PLUGIN_PERMISSION_INPUT_INTERCEPT], false)
    api.interceptInput('big', () => undefined)
    expect(errors.join('\n')).toContain('not available on this host')
  })

  it('装前披露把这条权限念成人话 —— 且两件事都说出来', () => {
    const line = describePluginPermission(PLUGIN_PERMISSION_INPUT_INTERCEPT)
    expect(line).toContain(PLUGIN_PERMISSION_INPUT_INTERCEPT)
    expect(line).toContain('rewrite')
    expect(line).toContain('handle')
    // 未登记的权限名原样显示(向前兼容)。
    expect(describePluginPermission('future:thing')).toBe('future:thing')
  })
})
