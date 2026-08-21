/**
 * N5 —— 工具结果改写的**熔断接线**验收(装配层)。
 *
 * core 那一份验的是链本身;这一份验的是链与健康态之间的那根线。这条链是
 * **fail-open**(interceptToolCall 的镜像):单次故障 = keep(原结果照回模型),
 * 插件整体熔断 = 之后跳过它的改写。降级在这里只是"别再浪费 2s 了",不是逃生口。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CORE_PLUGIN_FAILURE_THRESHOLD, PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE } from '@onething/core/plugins'

import {
  clearPluginRuntimeHealth,
  getPluginRuntimeHealth,
} from '../health.js'
import {
  getToolResultInterceptHookCount,
  registerPluginToolResultInterceptHook,
  resetPluginToolResultIntercept,
  runPluginToolResultIntercept,
} from '../tool-result-intercept.js'

const PLUGIN = 'redact-plugin'

const run = (content: string, isError = false, toolName = 'bash') =>
  runPluginToolResultIntercept({
    sessionId: 's1',
    toolName,
    toolCallId: 'call-1',
    input: { command: 'cat secrets' },
    result: { content, isError },
  })

beforeEach(() => {
  resetPluginToolResultIntercept()
  clearPluginRuntimeHealth(PLUGIN)
})

afterEach(() => {
  resetPluginToolResultIntercept()
  clearPluginRuntimeHealth(PLUGIN)
  vi.useRealTimers()
})

describe('装配层接线', () => {
  it('没有注册者时零成本早退(它挂在每一次工具执行上)', async () => {
    expect(getToolResultInterceptHookCount()).toBe(0)
    await expect(run('raw output')).resolves.toEqual({
      action: 'keep', result: { content: 'raw output', isError: false }, rewrittenBy: [], ran: 0,
    })
  })

  it('注册 → 改写 → 退订,足迹回到零', async () => {
    const unsub = registerPluginToolResultInterceptHook(PLUGIN, 'redact', (ctx) => ({
      action: 'replace',
      content: ctx.result.content.replace(/sk-\S+/g, '[REDACTED]'),
    }))
    expect(getToolResultInterceptHookCount()).toBe(1)
    const redacted = await run('key is sk-abc123 done')
    expect(redacted.action).toBe('replace')
    expect(redacted.result.content).toBe('key is [REDACTED] done')

    unsub()
    expect(getToolResultInterceptHookCount()).toBe(0)
    expect((await run('key is sk-abc123 done')).action).toBe('keep')
  })

  it('keep = 结果原样,不算改写', async () => {
    registerPluginToolResultInterceptHook(PLUGIN, 'watch', () => undefined)
    const outcome = await run('untouched')
    expect(outcome).toMatchObject({ action: 'keep', result: { content: 'untouched', isError: false } })
  })
})

describe('单次 fail-open / 熔断后跳过', () => {
  it('单次故障 = keep(原结果);连败到阈值后降级掉这一个界面,之后仍跳过', async () => {
    let calls = 0
    registerPluginToolResultInterceptHook(PLUGIN, 'boom', () => {
      calls += 1
      throw new Error('kaboom')
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      // 前半句:每一次故障都 keep —— 原结果照样回模型,工作流不断。
      const outcome = await run('original')
      expect(outcome).toMatchObject({ action: 'keep', result: { content: 'original', isError: false } })
    }
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)

    const health = getPluginRuntimeHealth(PLUGIN)
    // 罚则是降级而不是禁用:插件的工具/命令/面板与它的改写力无关。
    expect(health?.status).toBe('degraded')
    expect(health?.degradedSurfaces?.map(entry => entry.surface))
      .toEqual([PLUGIN_TOOL_RESULT_INTERCEPT_SURFACE])

    // 后半句:降级 = 跳过改写。handler 不再被调用,结果照样原样回。
    const after = await run('original')
    expect(after).toEqual({ action: 'keep', result: { content: 'original', isError: false }, rewrittenBy: [], ran: 0 })
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)
  })

  it('降级不连坐同一条链上的其他插件', async () => {
    registerPluginToolResultInterceptHook(PLUGIN, 'boom', () => { throw new Error('kaboom') })
    registerPluginToolResultInterceptHook('zz-healthy', 'tag', (ctx) => ({
      action: 'replace',
      content: `${ctx.result.content} [seen]`,
    }))
    try {
      for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
        await run('base')
      }
      // 坏插件降级之后,健康的那个照常改写。
      const outcome = await run('base')
      expect(outcome.result.content).toBe('base [seen]')
      expect(getPluginRuntimeHealth('zz-healthy')).toBeUndefined()
    } finally {
      clearPluginRuntimeHealth('zz-healthy')
    }
  })

  it('半开:降级满一个探测间隔之后放行一次,成功即解除', async () => {
    let mode: 'throw' | 'ok' = 'throw'
    registerPluginToolResultInterceptHook(PLUGIN, 'flaky', (ctx) => {
      if (mode === 'throw') throw new Error('kaboom')
      return { action: 'replace', content: `${ctx.result.content}!` }
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) await run('x')
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces).toHaveLength(1)

    // 闸在改写口,被跳过的插件永远不会成功 —— 没有时间半开就是一扇单向死门。
    mode = 'ok'
    expect((await run('x')).action).toBe('keep')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    expect((await run('x')).action).toBe('replace')
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces ?? []).toHaveLength(0)
  })
})
