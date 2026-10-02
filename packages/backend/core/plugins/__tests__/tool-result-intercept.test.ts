/**
 * N5 —— 工具结果改写的**协议层**验收。
 *
 * 这一份打的是 core 说了算的那一半:两态归一化(含"作者写错了"的每一种)、
 * 链的次序与 replace 累积、isError 的继承与翻转、长度上限、**fail-open**
 * (抛错 / 超时 = keep,而不是 block)、返回值不合规**不计熔断**(与 N4 刻意相反)、
 * **熔断后跳过 = keep**、重复 id 拒绝,以及 `api.interceptToolResult` 的声明门。
 *
 * 挂点侧的验收(改写排在工具执行之后、与 N4 在同一函数里互不干扰)在
 * `packages/backend/core/engine/__tests__/direct-tool-execution-result-intercept.test.ts`。
 */
import { describe, expect, it } from 'vitest'

import { createCorePluginAPI } from '../api-builder.js'
import {
  CorePluginToolResultInterceptRegistry,
  PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT,
  capPluginToolResultContent,
  normalizePluginToolResultInterceptResult,
  type PluginToolResultInterceptHandler,
  type PluginToolResultView,
} from '../tool-result-intercept.js'
import { classifyPluginScope, pluginScope, resolvePluginScopeSeverity } from '../policy.js'
import { describePluginPermission } from '../sessions.js'

function createRegistry(options: {
  timeoutMs?: number
  degraded?: Set<string>
  maxContentLength?: number
} = {}) {
  const failures: Array<{ pluginId: string; hookId: string }> = []
  const successes: Array<{ pluginId: string; hookId: string }> = []
  const violations: Array<{ pluginId: string; reason: string }> = []
  const errors: string[] = []
  const registry = new CorePluginToolResultInterceptRegistry({
    timeoutMs: options.timeoutMs,
    maxContentLength: options.maxContentLength,
    logger: { error(message: string) { errors.push(message) } },
    onHandlerFailure({ pluginId, hookId }) { failures.push({ pluginId, hookId }) },
    onHandlerSuccess({ pluginId, hookId }) { successes.push({ pluginId, hookId }) },
    isDegraded: pluginId => Boolean(options.degraded?.has(pluginId)),
    onRegistrationViolation({ pluginId, reason }) { violations.push({ pluginId, reason }) },
  })
  return { registry, failures, successes, violations, errors }
}

const run = (
  registry: CorePluginToolResultInterceptRegistry,
  result: PluginToolResultView,
  toolName = 'bash',
) => registry.run({ sessionId: 's1', toolName, toolCallId: 'call-1', input: { a: 1 }, result })

const ok = (content: string): PluginToolResultView => ({ content, isError: false })

describe('两态归一化 —— 读不懂就 keep(fail-open)', () => {
  it('void / undefined / {action:"keep"} 都是 keep,且不算写错', () => {
    for (const raw of [undefined, null, { action: 'keep' }]) {
      const result = normalizePluginToolResultInterceptResult(raw)
      expect(result.decision).toEqual({ action: 'keep' })
      expect(result.problem).toBeUndefined()
    }
  })

  it('未知 action 判 **keep**(而不是 N4 那边的 block),并带 problem', () => {
    const result = normalizePluginToolResultInterceptResult({ action: 'raplace' })
    expect(result.decision.action).toBe('keep')
    expect(result.problem).toContain('unknown action')
  })

  it('返回一个非对象也判 keep —— 读不懂就别改', () => {
    expect(normalizePluginToolResultInterceptResult('nope').decision.action).toBe('keep')
    expect(normalizePluginToolResultInterceptResult(42).decision.action).toBe('keep')
  })

  it('replace 少了 content(或 content 非字符串)判 keep', () => {
    expect(normalizePluginToolResultInterceptResult({ action: 'replace' }).decision.action).toBe('keep')
    expect(normalizePluginToolResultInterceptResult({ action: 'replace', content: 12 }).problem)
      .toContain('needs a string "content"')
  })

  it('replace 省略 isError = 沿用原错误态(decision 不带 isError)', () => {
    const result = normalizePluginToolResultInterceptResult({ action: 'replace', content: 'x' })
    expect(result.decision).toEqual({ action: 'replace', content: 'x' })
    expect(result.problem).toBeUndefined()
  })

  it('replace 的 isError 非布尔被丢掉并点名(content 仍生效)', () => {
    const result = normalizePluginToolResultInterceptResult({ action: 'replace', content: 'x', isError: 'yes' })
    expect(result.decision).toEqual({ action: 'replace', content: 'x' })
    expect(result.problem).toContain('must be a boolean')
  })

  it('replace 带合法 content + isError', () => {
    expect(normalizePluginToolResultInterceptResult({ action: 'replace', content: 'x', isError: true }).decision)
      .toEqual({ action: 'replace', content: 'x', isError: true })
  })
})

describe('链:次序、replace 累积、isError 继承与翻转', () => {
  it('跨插件按 pluginId 字典序,插件内保持注册顺序', () => {
    const { registry } = createRegistry()
    const noop: PluginToolResultInterceptHandler = () => undefined
    registry.register('zeta', 'b', noop)
    registry.register('alpha', 'second', noop)
    registry.register('alpha', 'first', noop)
    expect(registry.listOrdered()).toEqual([
      { pluginId: 'alpha', hookId: 'second' },
      { pluginId: 'alpha', hookId: 'first' },
      { pluginId: 'zeta', hookId: 'b' },
    ])
  })

  it('replace 逐个累积:后手看到的是前手改写后的结果', async () => {
    const { registry } = createRegistry()
    const seen: string[] = []
    registry.register('a-first', 'x', (ctx) => {
      seen.push(ctx.result.content)
      return { action: 'replace', content: `${ctx.result.content}-A` }
    })
    registry.register('b-second', 'y', (ctx) => {
      seen.push(ctx.result.content)
      return { action: 'replace', content: `${ctx.result.content}-B` }
    })

    const outcome = await run(registry, ok('base'))
    expect(outcome).toEqual({
      action: 'replace',
      result: { content: 'base-A-B', isError: false },
      rewrittenBy: ['a-first', 'b-second'],
      ran: 2,
    })
    expect(seen).toEqual(['base', 'base-A'])
  })

  it('replace 省略 isError = 沿用改写前的错误态', async () => {
    const { registry } = createRegistry()
    registry.register('p', 'x', (ctx) => ({ action: 'replace', content: `redacted:${ctx.result.content}` }))
    const outcome = await run(registry, { content: 'leaked /home/me/secret', isError: true })
    expect(outcome.result).toEqual({ content: 'redacted:leaked /home/me/secret', isError: true })
  })

  it('isError 可翻转:把泄露路径的错误改成通用错误(仍是错误)或把错误洗成成功', async () => {
    const { registry } = createRegistry()
    registry.register('p', 'flip', () => ({ action: 'replace', content: 'tool failed', isError: true }))
    const flipped = await run(registry, ok('/home/me/.ssh/id_rsa not found'))
    expect(flipped.result).toEqual({ content: 'tool failed', isError: true })

    const { registry: reg2 } = createRegistry()
    reg2.register('p', 'heal', () => ({ action: 'replace', content: 'ok', isError: false }))
    const healed = await reg2.run({ sessionId: 's', toolName: 't', input: {}, result: { content: 'boom', isError: true } })
    expect(healed.result).toEqual({ content: 'ok', isError: false })
  })

  it('无人注册 = 零成本早退,结果原样返回', async () => {
    const { registry } = createRegistry()
    await expect(run(registry, ok('unchanged'))).resolves.toEqual({
      action: 'keep', result: { content: 'unchanged', isError: false }, rewrittenBy: [], ran: 0,
    })
  })

  it('keep 不改结果、不短路 —— 后面的 handler 照跑', async () => {
    const { registry } = createRegistry()
    let laterRan = false
    registry.register('a-watch', 'x', () => undefined)
    registry.register('b-later', 'y', () => { laterRan = true; return { action: 'replace', content: 'changed' } })
    const outcome = await run(registry, ok('base'))
    expect(laterRan).toBe(true)
    expect(outcome.result.content).toBe('changed')
  })
})

describe('长度上限 —— 防插件把结果撑爆上下文', () => {
  it('capPluginToolResultContent 截断超限内容并留宿主标注', () => {
    const capped = capPluginToolResultContent('x'.repeat(100), 10)
    expect(capped.startsWith('x'.repeat(10))).toBe(true)
    expect(capped).toContain('truncated by the host')
    expect(capPluginToolResultContent('short', 10)).toBe('short')
    expect(capPluginToolResultContent('x'.repeat(100), 0)).toHaveLength(100) // <=0 关闭
  })

  it('链把超限的 replace 截到上限内', async () => {
    const { registry } = createRegistry({ maxContentLength: 8 })
    registry.register('p', 'x', () => ({ action: 'replace', content: 'y'.repeat(1000) }))
    const outcome = await run(registry, ok('base'))
    expect(outcome.result.content.startsWith('y'.repeat(8))).toBe(true)
    expect(outcome.result.content).toContain('truncated by the host')
  })
})

describe('fail-open —— 改写器挂了,原结果照样回模型', () => {
  it('handler 抛错 = keep(用改写前的结果),继续下一个 handler,并计熔断', async () => {
    const { registry, failures } = createRegistry()
    let laterRan = false
    registry.register('a-boom', 'x', () => { throw new Error('kaboom') })
    registry.register('b-later', 'y', () => { laterRan = true; return { action: 'replace', content: 'saved' } })

    const outcome = await run(registry, ok('original'))
    // a-boom 抛错 → keep;b-later 照跑 → 它的改写生效。
    expect(outcome.result.content).toBe('saved')
    expect(laterRan).toBe(true)
    // 抛错计熔断(与 N2 / N4 同)。
    expect(failures).toEqual([{ pluginId: 'a-boom', hookId: 'x' }])
  })

  it('全链只有一个抛错的 handler = 原结果原样返回(fail-open)', async () => {
    const { registry, failures } = createRegistry()
    registry.register('boom', 'x', () => { throw new Error('kaboom') })
    const outcome = await run(registry, ok('original'))
    expect(outcome).toMatchObject({ action: 'keep', result: { content: 'original', isError: false } })
    expect(failures).toEqual([{ pluginId: 'boom', hookId: 'x' }])
  })

  it('超时 = keep,并计熔断', async () => {
    const { registry, failures } = createRegistry({ timeoutMs: 5 })
    registry.register('slow', 'x', () => new Promise(resolve => setTimeout(() => resolve(undefined), 60)))
    const outcome = await run(registry, ok('original'))
    expect(outcome.result.content).toBe('original')
    expect(failures).toEqual([{ pluginId: 'slow', hookId: 'x' }])
  })

  it('返回值读不懂 = keep,**但不计熔断**(与 N4 刻意相反)', async () => {
    const { registry, failures, successes, errors } = createRegistry()
    registry.register('junk', 'x', () => ({ action: 'raplace' }) as never)
    const outcome = await run(registry, ok('original'))
    expect(outcome.result.content).toBe('original')
    // 在 fail-open 一侧,乱返回值只是没改成结果,无害 —— 不进熔断账,也不算成功。
    expect(failures).toEqual([])
    expect(successes).toEqual([])
    expect(errors.some(line => line.includes('invalid result'))).toBe(true)
  })

  it('keep / replace 都算这个 handler 跑成功了 —— 清连败账', async () => {
    const { registry, successes } = createRegistry()
    registry.register('keeper', 'x', () => ({ action: 'keep' }))
    registry.register('changer', 'y', () => ({ action: 'replace', content: 'x' }))
    await run(registry, ok('base'))
    // 全局规范顺序按 pluginId 字典序:'changer' 先于 'keeper'。
    expect(successes).toEqual([
      { pluginId: 'changer', hookId: 'y' },
      { pluginId: 'keeper', hookId: 'x' },
    ])
  })
})

describe('熔断后跳过 —— 降级 = 移除改写 = 原结果', () => {
  it('被降级的插件整段跳过,结果原样返回', async () => {
    const degraded = new Set(['broken'])
    const { registry } = createRegistry({ degraded })
    let called = false
    registry.register('broken', 'x', () => { called = true; return { action: 'replace', content: 'nope' } })

    await expect(run(registry, ok('original'))).resolves.toEqual({
      action: 'keep', result: { content: 'original', isError: false }, rewrittenBy: [], ran: 0,
    })
    expect(called).toBe(false)
  })
})

describe('注册:重复 id 被拒绝', () => {
  it('重复的 (pluginId, hookId) 返回 no-op 并上报违规', () => {
    const { registry, violations } = createRegistry()
    registry.register('p', 'guard', () => undefined)
    registry.register('p', 'guard', () => undefined)
    expect(registry.getHookCount()).toBe(1)
    expect(violations.some(v => v.reason.includes('already registered'))).toBe(true)
  })

  it('clearForPlugin / clear 复位足迹', () => {
    const { registry } = createRegistry()
    const noop: PluginToolResultInterceptHandler = () => undefined
    registry.register('p', 'a', noop)
    registry.register('q', 'b', noop)
    registry.clearForPlugin('p')
    expect(registry.getHookCount()).toBe(1)
    registry.clear()
    expect(registry.getHookCount()).toBe(0)
  })
})

describe('熔断车道:toolresult-intercept 自成一族,罚则是降级而不是禁用', () => {
  it('scope 归族,罚则 degrade-surface,罚则文案点明 fail-open', () => {
    const scope = pluginScope.toolResultIntercept('redact')
    expect(classifyPluginScope(scope)).toBe('toolresult-intercept')
    const severity = resolvePluginScopeSeverity(scope)
    expect(severity.remedy).toBe('degrade-surface')
    expect(severity.rationale).toContain('fail-open')
  })
})

describe('声明门:api.interceptToolResult 未声明即拒绝', () => {
  function build(permissions: string[], withHostPort = true) {
    const registered: Array<{ id: string }> = []
    const errors: string[] = []
    const failures: string[] = []
    const built = createCorePluginAPI<any, any, any, any, any, any, any, any, any, any, any>({
      pluginId: 'redactor',
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
            registerToolResultInterceptHook(_pluginId: string, id: string) {
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
    const { api, registered, errors } = build([PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT])
    api.interceptToolResult('redact', () => undefined)
    expect(registered).toEqual([{ id: 'redact' }])
    expect(errors).toEqual([])
  })

  it('没声明就拒绝,报错但**不计熔断**(manifest 笔误不该连坐整个插件)', () => {
    const { api, registered, errors, failures } = build([])
    api.interceptToolResult('redact', () => undefined)
    expect(registered).toEqual([])
    expect(failures).toEqual([])
    expect(errors.join('\n')).toContain(PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT)
  })

  it('宿主没接这条线时如实报错', () => {
    const { api, errors } = build([PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT], false)
    api.interceptToolResult('redact', () => undefined)
    expect(errors.join('\n')).toContain('not available on this host')
  })

  it('装前披露把 read 与 rewrite 两个动词都念出来', () => {
    const line = describePluginPermission(PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT)
    expect(line).toContain(PLUGIN_PERMISSION_TOOLRESULT_INTERCEPT)
    expect(line).toContain('read')
    expect(line).toContain('rewrite')
  })
})
