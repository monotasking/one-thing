/**
 * N4 —— 工具调用拦截的**熔断接线**验收(装配层)。
 *
 * core 那一份验的是链本身;这一份验的是链与健康态之间的那根线,而在这一期
 * 那根线不只是"别浪费预算"—— 它是 fail-closed 链**唯一的逃生口**:
 *
 *   单次故障 → 挡这一次;插件整体熔断 → 之后放行。
 *
 * 两句话都要有测试钉住,少了后一句,一个坏插件就能永久挡死所有工具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CORE_PLUGIN_FAILURE_THRESHOLD, PLUGIN_TOOL_CALL_INTERCEPT_SURFACE } from '@onething/core/plugins'

import {
  clearPluginRuntimeHealth,
  getPluginRuntimeHealth,
} from '../health.js'
import {
  getToolCallInterceptHookCount,
  registerPluginToolCallInterceptHook,
  resetPluginToolCallIntercept,
  runPluginToolCallIntercept,
} from '../tool-call-intercept-bound.js'

const PLUGIN = 'guard-plugin'
/** 一个真工具:校验口接的是**注册表里那份 zod**,拿个假的验等于什么都没验。 */
const TOOL = 'n4-probe'

const run = (input: unknown, toolName = TOOL) =>
  runPluginToolCallIntercept({ sessionId: 's1', toolName, toolCallId: 'call-1', input })

/**
 * R4b:校验口的读源从旧注册表的 `validateToolArgs` 换成**目录 + `ZodValidator`**。
 *
 * 目录与校验器都住在产品层(`@onething/runtime/toolkit`),而装配层的测试**不许
 * import 产品层**(boundary 的 "plugin logic stays out of the host assembly tree"),
 * 所以这里把那个模块整个替身掉 —— 与它换源之前用一个 `safeParse` 替身是同一条
 * 理由。替身覆盖的正是这里要证的东西:**校验口确实被接上了、失败确实转成 block**;
 * "真 zod 会怎么判"由产品层那份契约测试负责。
 */
vi.mock('../../toolkit/index.js', () => ({
  getToolkitCatalog: () => ({
    get: (id: string) => (id === TOOL ? { spec: { input: { type: 'object' } } } : undefined),
  }),
  ZodValidator: class {
    parse(_schema: unknown, input: unknown) {
      return typeof (input as { command?: unknown })?.command === 'string'
        ? { ok: true as const, value: input }
        : { ok: false as const, message: 'Invalid arguments: command is required' }
    }
  },
}))

beforeEach(() => {
  resetPluginToolCallIntercept()
  clearPluginRuntimeHealth(PLUGIN)
})

afterEach(() => {
  resetPluginToolCallIntercept()
  clearPluginRuntimeHealth(PLUGIN)
  vi.useRealTimers()
})

describe('装配层接线', () => {
  it('没有注册者时零成本早退(它挂在每一次工具执行上)', async () => {
    expect(getToolCallInterceptHookCount()).toBe(0)
    await expect(run({ command: 'ls' })).resolves.toEqual({
      action: 'allow', input: { command: 'ls' }, rewrittenBy: [], ran: 0,
    })
  })

  it('注册 → 阻断 → 退订,足迹回到零', async () => {
    const unsub = registerPluginToolCallInterceptHook(PLUGIN, 'guard', () => ({
      action: 'block',
      reason: 'rm -rf / is not allowed',
    }))
    expect(getToolCallInterceptHookCount()).toBe(1)
    const blocked = await run({ command: 'rm -rf /' })
    expect(blocked.action).toBe('block')

    unsub()
    expect(getToolCallInterceptHookCount()).toBe(0)
    expect((await run({ command: 'rm -rf /' })).action).toBe('allow')
  })

  it('改写后的参数真的过工具那份 zod —— 非法改写被转成 block', async () => {
    registerPluginToolCallInterceptHook(PLUGIN, 'bad-rewrite', () => ({
      action: 'rewrite',
      input: { nope: 1 },
    }))
    const outcome = await run({ command: 'ls' })
    expect(outcome.action).toBe('block')
    if (outcome.action !== 'block') throw new Error('unreachable')
    expect(outcome.reason).toContain(TOOL)
    expect(outcome.reason).toContain('was NOT run either')
  })

  it('合法改写照常放行,参数换成新的那一份', async () => {
    registerPluginToolCallInterceptHook(PLUGIN, 'ok-rewrite', () => ({
      action: 'rewrite',
      input: { command: 'ls -l' },
    }))
    const outcome = await run({ command: 'ls' })
    expect(outcome).toMatchObject({ action: 'allow', input: { command: 'ls -l' } })
  })

  it('认不出的工具名(MCP / 外部 agent)不在这里判死 —— 校验在别人家', async () => {
    registerPluginToolCallInterceptHook(PLUGIN, 'rewrite', () => ({
      action: 'rewrite',
      input: { anything: true },
    }))
    const outcome = await run({ q: 'x' }, 'mcp__server__search')
    expect(outcome).toMatchObject({ action: 'allow', input: { anything: true } })
  })
})

describe('单次 fail-closed / 熔断后 fail-open —— 本期的心脏', () => {
  it('单次故障挡这一次;连败到阈值后降级掉这一个界面,之后放行', async () => {
    let calls = 0
    registerPluginToolCallInterceptHook(PLUGIN, 'boom', () => {
      calls += 1
      throw new Error('kaboom')
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      // 前半句:每一次故障都**阻断**这次工具调用。
      const outcome = await run({ command: 'ls' })
      expect(outcome.action).toBe('block')
      if (outcome.action !== 'block') throw new Error('unreachable')
      expect(outcome.reason).toContain('fail-closed')
    }
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)

    const health = getPluginRuntimeHealth(PLUGIN)
    // 罚则仍是降级而不是禁用:插件的工具/命令/面板与它的判断力无关。
    expect(health?.status).toBe('degraded')
    expect(health?.degradedSurfaces?.map(entry => entry.surface))
      .toEqual([PLUGIN_TOOL_CALL_INTERCEPT_SURFACE])

    // 后半句:降级 = 移除拦截。handler 不再被调用,工具照常执行 ——
    // 一个坏插件挡得住三次,瘫痪不了应用。
    const after = await run({ command: 'ls' })
    expect(after).toEqual({ action: 'allow', input: { command: 'ls' }, rewrittenBy: [], ran: 0 })
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)
  })

  it('降级不连坐同一条链上的其他插件', async () => {
    registerPluginToolCallInterceptHook(PLUGIN, 'boom', () => { throw new Error('kaboom') })
    registerPluginToolCallInterceptHook('zz-healthy', 'guard', () => undefined)
    try {
      for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
        expect((await run({ command: 'ls' })).action).toBe('block')
      }
      // 坏插件降级之后,健康的那个照常判定(这一次它放行)。
      expect((await run({ command: 'ls' })).action).toBe('allow')
      expect(getPluginRuntimeHealth('zz-healthy')).toBeUndefined()
    } finally {
      clearPluginRuntimeHealth('zz-healthy')
    }
  })

  it('半开:降级满一个探测间隔之后放行一次,成功即解除', async () => {
    let mode: 'throw' | 'ok' = 'throw'
    registerPluginToolCallInterceptHook(PLUGIN, 'flaky', () => {
      if (mode === 'throw') throw new Error('kaboom')
      return { action: 'block', reason: 'guarding again' }
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) await run({ command: 'ls' })
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces).toHaveLength(1)

    // 闸在拦截口,被跳过的插件永远不会成功 —— 没有时间半开就是一扇单向死门。
    mode = 'ok'
    expect((await run({ command: 'ls' })).action).toBe('allow')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    expect((await run({ command: 'ls' })).action).toBe('block')
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces ?? []).toHaveLength(0)
  })
})
