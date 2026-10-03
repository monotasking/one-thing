/**
 * N4 —— 工具调用拦截的**协议层**验收。
 *
 * 这一份打的是 core 说了算的那一半:三态归一化(含"作者写错了"的每一种)、
 * 链的次序与 rewrite 累积、block 短路、**fail-closed**(抛错 / 超时 = 阻断)、
 * **熔断后 fail-open**(降级 = 移除拦截 = 放行)、改写后校验失败转 block、
 * 重复 id 拒绝,以及 `api.interceptToolCall` 的声明门。
 *
 * 挂点侧的验收(拦截排在 analyze / permission 之前、block 走工具错误结果)在
 * `packages/backend/engine/__tests__/direct-tool-execution-intercept.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import { createCorePluginAPI } from '../api-builder.js'
import {
  CorePluginToolCallInterceptRegistry,
  PLUGIN_PERMISSION_TOOLCALL_INTERCEPT,
  normalizePluginToolCallInterceptResult,
  type PluginToolCallInputValidation,
  type PluginToolCallInterceptHandler,
} from '../tool-call-intercept.js'
import { classifyPluginScope, pluginScope, resolvePluginScopeSeverity } from '../policy.js'
import { describePluginPermission } from '../sessions.js'

function createRegistry(options: {
  timeoutMs?: number
  degraded?: Set<string>
  validate?: (toolName: string, input: object) => PluginToolCallInputValidation
} = {}) {
  const failures: Array<{ pluginId: string; hookId: string }> = []
  const successes: Array<{ pluginId: string; hookId: string }> = []
  const violations: Array<{ pluginId: string; reason: string }> = []
  const errors: string[] = []
  const registry = new CorePluginToolCallInterceptRegistry({
    timeoutMs: options.timeoutMs,
    logger: { error(message: string) { errors.push(message) } },
    validateInput: options.validate,
    onHandlerFailure({ pluginId, hookId }) { failures.push({ pluginId, hookId }) },
    onHandlerSuccess({ pluginId, hookId }) { successes.push({ pluginId, hookId }) },
    isDegraded: pluginId => Boolean(options.degraded?.has(pluginId)),
    onRegistrationViolation({ pluginId, reason }) { violations.push({ pluginId, reason }) },
  })
  return { registry, failures, successes, violations, errors }
}

const run = (
  registry: CorePluginToolCallInterceptRegistry,
  input: unknown,
  toolName = 'bash',
) => registry.run({ sessionId: 's1', toolName, toolCallId: 'call-1', input })

describe('三态归一化 —— 只有"明文的沉默"算放行', () => {
  it('void / undefined / {action:"allow"} 都是 allow,且不算写错', () => {
    for (const raw of [undefined, null, { action: 'allow' }]) {
      const result = normalizePluginToolCallInterceptResult(raw)
      expect(result.decision).toEqual({ action: 'allow' })
      expect(result.problem).toBeUndefined()
    }
  })

  it('未知 action 判 **block**(而不是 N2 那边的回落放行)', () => {
    const result = normalizePluginToolCallInterceptResult({ action: 'alow' })
    expect(result.decision.action).toBe('block')
    expect(result.problem).toContain('unknown action')
  })

  it('返回一个非对象也判 block —— 读不懂就别跑', () => {
    expect(normalizePluginToolCallInterceptResult('nope').decision.action).toBe('block')
    expect(normalizePluginToolCallInterceptResult(42).decision.action).toBe('block')
  })

  it('rewrite 少了 input 判 block:降级成 allow 会**原样执行作者想换掉的调用**', () => {
    const result = normalizePluginToolCallInterceptResult({ action: 'rewrite' })
    expect(result.decision.action).toBe('block')
    expect(result.problem).toContain('needs an "input"')
  })

  it('rewrite 的 input 必须是 JSON 对象(数组 / 标量 / null 都不行)', () => {
    for (const input of [[1, 2], 'x', 7, null]) {
      const result = normalizePluginToolCallInterceptResult({ action: 'rewrite', input })
      expect(result.decision.action).toBe('block')
    }
    expect(normalizePluginToolCallInterceptResult({ action: 'rewrite', input: { a: 1 } }).decision)
      .toEqual({ action: 'rewrite', input: { a: 1 } })
  })

  it('block 的 reason 可省;非字符串被丢掉并点名', () => {
    expect(normalizePluginToolCallInterceptResult({ action: 'block' }).decision)
      .toEqual({ action: 'block' })
    expect(normalizePluginToolCallInterceptResult({ action: 'block', reason: 'no' }).decision)
      .toEqual({ action: 'block', reason: 'no' })
    const bad = normalizePluginToolCallInterceptResult({ action: 'block', reason: 12 })
    expect(bad.decision).toEqual({ action: 'block' })
    expect(bad.problem).toContain('must be a string')
  })
})

describe('链:次序、rewrite 累积、block 短路', () => {
  it('跨插件按 pluginId 字典序,插件内保持注册顺序', () => {
    const { registry } = createRegistry()
    const noop: PluginToolCallInterceptHandler = () => undefined
    registry.register('zeta', 'b', noop)
    registry.register('alpha', 'second', noop)
    registry.register('alpha', 'first', noop)
    expect(registry.listOrdered()).toEqual([
      { pluginId: 'alpha', hookId: 'second' },
      { pluginId: 'alpha', hookId: 'first' },
      { pluginId: 'zeta', hookId: 'b' },
    ])
  })

  it('rewrite 逐个累积:后手看到的是前手改写后的参数', async () => {
    const { registry } = createRegistry()
    const seen: unknown[] = []
    registry.register('a-first', 'x', (ctx) => {
      seen.push(ctx.input)
      return { action: 'rewrite', input: { command: 'ls -a' } }
    })
    registry.register('b-second', 'y', (ctx) => {
      seen.push(ctx.input)
      return { action: 'rewrite', input: { command: `${(ctx.input as { command: string }).command} -l` } }
    })

    const outcome = await run(registry, { command: 'ls' })
    expect(outcome).toEqual({
      action: 'allow',
      input: { command: 'ls -a -l' },
      rewrittenBy: ['a-first', 'b-second'],
      ran: 2,
    })
    expect(seen).toEqual([{ command: 'ls' }, { command: 'ls -a' }])
  })

  it('第一个 block 短路后续 handler,并把归因写进理由的最前面', async () => {
    const { registry } = createRegistry()
    let laterRan = false
    registry.register('a-guard', 'x', () => ({ action: 'block', reason: 'rm -rf / is not allowed' }))
    registry.register('b-later', 'y', () => { laterRan = true; return undefined })

    const outcome = await run(registry, { command: 'rm -rf /' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.blockedBy).toBe('a-guard')
    expect(outcome.reason).toBe('Blocked by plugin "a-guard": rm -rf / is not allowed')
    expect(laterRan).toBe(false)
  })

  it('无人注册 = 零成本早退,参数原样返回', async () => {
    const { registry } = createRegistry()
    await expect(run(registry, { a: 1 })).resolves.toEqual({
      action: 'allow', input: { a: 1 }, rewrittenBy: [], ran: 0,
    })
  })
})

describe('改写后校验 —— 与 pi 的关键差异:我们不跳 schema', () => {
  it('校验不过 = 当作 block,绝不把非法参数喂给工具', async () => {
    const { registry, failures } = createRegistry({
      validate: (_tool, input) => (input as { command?: unknown }).command === undefined
        ? { ok: false, message: 'Invalid arguments: command is required' }
        : { ok: true },
    })
    registry.register('bad-rewriter', 'x', () => ({ action: 'rewrite', input: { cmd: 'ls' } }))

    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.reason).toContain('command is required')
    // 原始调用也不跑:改写本身就表示"这个插件不想让它按原样跑"。
    expect(outcome.reason).toContain('was NOT run either')
    // 计熔断 —— 否则一个永远写错改写的插件会永久挡死这个工具。
    expect(failures).toEqual([{ pluginId: 'bad-rewriter', hookId: 'x' }])
  })

  it('校验过了就继续走链,后手看到的是改写后的参数', async () => {
    const { registry, failures } = createRegistry({ validate: () => ({ ok: true }) })
    registry.register('a-rewriter', 'x', () => ({ action: 'rewrite', input: { command: 'ls -l' } }))
    const outcome = await run(registry, { command: 'ls' })
    expect(outcome).toMatchObject({ action: 'allow', input: { command: 'ls -l' } })
    expect(failures).toEqual([])
  })

  it('校验口自己抛错 = 无法确认,同样阻断', async () => {
    const { registry } = createRegistry({
      validate: () => { throw new Error('registry exploded') },
    })
    registry.register('a-rewriter', 'x', () => ({ action: 'rewrite', input: { command: 'ls' } }))
    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.reason).toContain('registry exploded')
  })
})

describe('fail-closed —— 拦截器挂了,工具就不跑', () => {
  it('handler 抛错 = 阻断这一次(不是放行),理由标注"拦截器故障"', async () => {
    const { registry, failures } = createRegistry()
    let laterRan = false
    registry.register('a-boom', 'x', () => { throw new Error('kaboom') })
    registry.register('b-later', 'y', () => { laterRan = true; return undefined })

    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.blockedBy).toBe('a-boom')
    expect(outcome.reason).toContain('kaboom')
    expect(outcome.reason).toContain('interceptor fault')
    expect(outcome.reason).toContain('fail-closed')
    // 故障阻断也短路:后面的 handler 没有机会"救回"这次调用。
    expect(laterRan).toBe(false)
    expect(failures).toEqual([{ pluginId: 'a-boom', hookId: 'x' }])
  })

  it('超时 = 阻断', async () => {
    const { registry, failures } = createRegistry({ timeoutMs: 5 })
    registry.register('slow', 'x', () => new Promise(resolve => setTimeout(resolve, 60)))
    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    expect(failures).toEqual([{ pluginId: 'slow', hookId: 'x' }])
  })

  it('返回值读不懂 = 阻断,**并且计熔断**(与 N2 刻意不同)', async () => {
    const { registry, failures, successes, errors } = createRegistry()
    registry.register('junk', 'x', () => ({ action: 'alow' }) as never)

    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    // 计熔断的理由:fail-closed 下"不计熔断"等于"永远挡着" —— 熔断是这条链
    // 唯一的逃生口,一个每次返回垃圾的插件必须能被降级掉。
    expect(failures).toEqual([{ pluginId: 'junk', hookId: 'x' }])
    expect(successes).toEqual([])
    expect(errors.some(line => line.includes('invalid result'))).toBe(true)
  })

  it('插件主动 block 算它跑成功了 —— 那是判决,不是故障', async () => {
    const { registry, failures, successes } = createRegistry()
    registry.register('guard', 'x', () => ({ action: 'block', reason: 'nope' }))
    await run(registry, { command: 'ls' })
    expect(failures).toEqual([])
    expect(successes).toEqual([{ pluginId: 'guard', hookId: 'x' }])
  })
})

describe('熔断后 fail-open —— 降级 = 移除拦截,不是永远挡着', () => {
  it('被降级的插件整段跳过,工具照常执行', async () => {
    const degraded = new Set(['broken'])
    const { registry } = createRegistry({ degraded })
    let called = false
    registry.register('broken', 'x', () => { called = true; throw new Error('kaboom') })

    await expect(run(registry, { command: 'ls' })).resolves.toEqual({
      action: 'allow', input: { command: 'ls' }, rewrittenBy: [], ran: 0,
    })
    expect(called).toBe(false)
  })

  it('降级只跳过它自己,同一条链上别的插件照常判定', async () => {
    const degraded = new Set(['a-broken'])
    const { registry } = createRegistry({ degraded })
    registry.register('a-broken', 'x', () => ({ action: 'block', reason: 'never seen' }))
    registry.register('b-guard', 'y', () => ({ action: 'block', reason: 'still guarding' }))

    const outcome = await run(registry, { command: 'ls' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.blockedBy).toBe('b-guard')
  })
})

describe('注册期违规', () => {
  it('空 id 与重复的 (pluginId, id) 都被拒绝,并上报 registration 违规', () => {
    const { registry, violations } = createRegistry()
    const noop: PluginToolCallInterceptHandler = () => undefined
    registry.register('p', '  ', noop)
    registry.register('p', 'guard', noop)
    registry.register('p', 'guard', noop)
    expect(registry.getHookCount()).toBe(1)
    expect(violations).toHaveLength(2)
    expect(violations[1].reason).toContain('already registered')
  })

  it('clearForPlugin / clear 把足迹归零(拆除守卫的口径)', () => {
    const { registry } = createRegistry()
    const noop: PluginToolCallInterceptHandler = () => undefined
    registry.register('p', 'a', noop)
    registry.register('q', 'b', noop)
    registry.clearForPlugin('p')
    expect(registry.getHookCount()).toBe(1)
    registry.clear()
    expect(registry.getHookCount()).toBe(0)
  })
})

describe('熔断车道:toolcall-intercept 自成一族,罚则是降级而不是禁用', () => {
  it('scope 归族,罚则 degrade-surface', () => {
    const scope = pluginScope.toolCallIntercept('guard')
    expect(classifyPluginScope(scope)).toBe('toolcall-intercept')
    const severity = resolvePluginScopeSeverity(scope)
    expect(severity.remedy).toBe('degrade-surface')
    // 罚则文案必须自己说清"它是这条链唯一的逃生口"。
    expect(severity.rationale).toContain('fail-open')
  })
})

describe('声明门:api.interceptToolCall 未声明即拒绝', () => {
  function build(permissions: string[], withHostPort = true) {
    const registered: Array<{ id: string }> = []
    const errors: string[] = []
    const failures: string[] = []
    const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
      pluginId: 'guardian',
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
            registerToolCallInterceptHook(_pluginId: string, id: string) {
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
    const { api, registered, errors } = build([PLUGIN_PERMISSION_TOOLCALL_INTERCEPT])
    api.interceptToolCall('guard', () => undefined)
    expect(registered).toEqual([{ id: 'guard' }])
    expect(errors).toEqual([])
  })

  it('没声明就拒绝,报错但**不计熔断**(manifest 笔误不该连坐整个插件)', () => {
    const { api, registered, errors, failures } = build([])
    api.interceptToolCall('guard', () => undefined)
    expect(registered).toEqual([])
    expect(failures).toEqual([])
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_TOOLCALL_INTERCEPT)
  })

  it('宿主没接这条线时如实报错 —— "以为装了守卫其实没装"是最坏的结局', () => {
    const { api, errors } = build([PLUGIN_PERMISSION_TOOLCALL_INTERCEPT], false)
    api.interceptToolCall('guard', () => undefined)
    expect(errors.join('\n')).toContain('not available on this host')
  })

  it('装前披露把三个动词都念出来(inspect / block / rewrite)', () => {
    const line = describePluginPermission(PLUGIN_PERMISSION_TOOLCALL_INTERCEPT)
    expect(line).toContain(PLUGIN_PERMISSION_TOOLCALL_INTERCEPT)
    expect(line).toContain('inspect')
    expect(line).toContain('block')
    expect(line).toContain('rewrite')
  })
})
