/**
 * N2 —— 发送前拦截的**熔断接线**验收(装配层)。
 *
 * core 那一份验的是链本身;这一份验的是链与健康态之间的那根线:失败真的进
 * `inputIntercept:<hookId>` 车道、连败三次真的降级、降级之后拦截真的被跳过
 * (而消息照常发出)、以及降级靠时间半开而不是一扇单向死门。
 *
 * 这根线值得单独打,是因为它在 R7 里断过一次:声明 degrade-surface 却没有闸,
 * 等于取消了熔断(必败的面板 action 照常一次次跑满预算)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CORE_PLUGIN_FAILURE_THRESHOLD, PLUGIN_INPUT_INTERCEPT_SURFACE } from '@onething/core/plugins'

import {
  clearPluginRuntimeHealth,
  getPluginRuntimeHealth,
} from '../health.js'
import {
  getInputInterceptHookCount,
  registerPluginInputInterceptHook,
  resetPluginInputIntercept,
  runPluginInputIntercept,
} from '../input-intercept.js'

const PLUGIN = 'macro-plugin'

const run = (text: string) =>
  runPluginInputIntercept({ sessionId: 's1', text, source: 'user' })

beforeEach(() => {
  resetPluginInputIntercept()
  clearPluginRuntimeHealth(PLUGIN)
})

afterEach(() => {
  resetPluginInputIntercept()
  clearPluginRuntimeHealth(PLUGIN)
  vi.useRealTimers()
})

describe('装配层接线', () => {
  it('没有注册者时零成本早退(它挂在每一次发送上)', async () => {
    expect(getInputInterceptHookCount()).toBe(0)
    await expect(run('hello')).resolves.toEqual({
      text: 'hello', handled: false, transformedBy: [], ran: 0,
    })
  })

  it('注册 → 改写 → 退订,足迹回到零', async () => {
    const unsub = registerPluginInputInterceptHook(PLUGIN, 'shout', ctx => ({
      action: 'transform',
      text: ctx.text.toUpperCase(),
    }))
    expect(getInputInterceptHookCount()).toBe(1)
    expect((await run('hi')).text).toBe('HI')

    unsub()
    expect(getInputInterceptHookCount()).toBe(0)
    expect((await run('hi')).text).toBe('hi')
  })
})

describe('熔断:连败降级、降级即跳过、消息永远发得出去', () => {
  it('连败到阈值后降级到 input-intercept 这一个界面(而不是禁用插件)', async () => {
    let calls = 0
    registerPluginInputInterceptHook(PLUGIN, 'boom', () => {
      calls += 1
      throw new Error('kaboom')
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
      // 每一次都 fail-open:文本原样出去。
      expect((await run('hi')).text).toBe('hi')
    }
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)

    const health = getPluginRuntimeHealth(PLUGIN)
    // 罚则是降级,不是禁用 —— 拦截失败对用户无害(他的消息发出去了),
    // 为它砍掉插件的工具/命令/面板是把小故障放大成大故障。
    expect(health?.status).toBe('degraded')
    expect(health?.degradedSurfaces?.map(entry => entry.surface))
      .toEqual([PLUGIN_INPUT_INTERCEPT_SURFACE])

    // 降级之后这个插件整段被跳过:handler 不再被调用,消息照常发出。
    expect((await run('hi')).text).toBe('hi')
    expect(calls).toBe(CORE_PLUGIN_FAILURE_THRESHOLD)
  })

  it('降级不连坐同一条链上的其他插件', async () => {
    registerPluginInputInterceptHook(PLUGIN, 'boom', () => { throw new Error('kaboom') })
    registerPluginInputInterceptHook('zz-healthy', 'shout', ctx => ({
      action: 'transform',
      text: ctx.text.toUpperCase(),
    }))
    try {
      for (let i = 0; i <= CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) {
        expect((await run('hi')).text).toBe('HI')
      }
      expect(getPluginRuntimeHealth('zz-healthy')).toBeUndefined()
    } finally {
      clearPluginRuntimeHealth('zz-healthy')
    }
  })

  it('半开:降级满一个探测间隔之后放行一次,成功即解除', async () => {
    let mode: 'throw' | 'ok' = 'throw'
    registerPluginInputInterceptHook(PLUGIN, 'flaky', (ctx) => {
      if (mode === 'throw') throw new Error('kaboom')
      return { action: 'transform', text: ctx.text.toUpperCase() }
    })

    for (let i = 0; i < CORE_PLUGIN_FAILURE_THRESHOLD; i += 1) await run('hi')
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces).toHaveLength(1)

    // 闸在拦截口,被跳过的插件永远不会成功 —— 没有时间半开的话,这就是一扇
    // 单向的死门(拦截族没有"用户点重试"这种逃生口)。
    mode = 'ok'
    expect((await run('hi')).text).toBe('hi')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    expect((await run('hi')).text).toBe('HI')
    expect(getPluginRuntimeHealth(PLUGIN)?.degradedSurfaces ?? []).toHaveLength(0)
  })
})
