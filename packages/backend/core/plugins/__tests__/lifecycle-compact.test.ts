/**
 * N7-a —— beforeContextCompact 可返回替换摘要的**协议层**验收。
 *
 * 打的是 core 说了算的那一半:第一个返回非空 summary 的胜出、空串/void 不算替换、
 * fail-open(抛错/超时当没返回,继续问下一个,失败进熔断账)、长度硬约束。
 * 真实"跳过宿主自压"的消费在装配层(context-compact-plugin.test.ts)。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS,
  CorePluginLifecycleRegistry,
} from '../index.js'

function registry() {
  const failures: Array<{ pluginId: string; hookId: string; scope: string }> = []
  const successes: Array<{ pluginId: string; hookId: string; scope: string }> = []
  const reg = new CorePluginLifecycleRegistry<{ sessionId: string }>({
    logger: { error: () => {} },
    // 短超时让 fail-open 的超时分支跑得快。
    timeoutMs: 40,
    onHookFailure: ({ pluginId, hookId, scope }) => failures.push({ pluginId, hookId, scope }),
    onHookSuccess: ({ pluginId, hookId, scope }) => successes.push({ pluginId, hookId, scope }),
  })
  return { reg, failures, successes }
}

describe('runBeforeContextCompactHooks (N7-a)', () => {
  it('returns a plugin summary that replaces host compaction', async () => {
    const { reg } = registry()
    reg.registerBeforeContextCompactHook('p1', 'h', () => ({ summary: 'structured summary' }))
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    expect(outcome).toEqual({ summary: 'structured summary', pluginId: 'p1', hookId: 'h' })
  })

  it('first hook to return a non-empty summary wins; later hooks do not override', async () => {
    const { reg } = registry()
    const second = vi.fn(() => ({ summary: 'second' }))
    reg.registerBeforeContextCompactHook('p1', 'first', () => ({ summary: 'first' }))
    reg.registerBeforeContextCompactHook('p2', 'second', second)
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    expect(outcome?.summary).toBe('first')
    expect(outcome?.pluginId).toBe('p1')
    // 第一个已经赢了,后面的钩子根本不会被问。
    expect(second).not.toHaveBeenCalled()
  })

  it('treats empty string and void as no replacement (falls through to host)', async () => {
    const { reg, successes } = registry()
    reg.registerBeforeContextCompactHook('p1', 'empty', () => ({ summary: '   ' }))
    reg.registerBeforeContextCompactHook('p2', 'void', () => undefined)
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    expect(outcome).toBeUndefined()
    // 两个都成功跑完(只是没给替换),都进了成功账。
    expect(successes.map(s => s.hookId)).toEqual(['empty', 'void'])
  })

  it('fail-open: a throwing hook is treated as no summary and reported to the breaker', async () => {
    const { reg, failures } = registry()
    reg.registerBeforeContextCompactHook('p1', 'boom', () => {
      throw new Error('hook exploded')
    })
    const winner = vi.fn(() => ({ summary: 'from the survivor' }))
    reg.registerBeforeContextCompactHook('p2', 'ok', winner)
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    // 抛错的钩子被跳过,后一个仍能赢 —— 压缩不会因为一个坏钩子卡住。
    expect(outcome?.summary).toBe('from the survivor')
    expect(failures).toEqual([{ pluginId: 'p1', hookId: 'boom', scope: 'beforeContextCompact' }])
  })

  it('fail-open on timeout: a hanging hook does not block, returns undefined', async () => {
    const { reg, failures } = registry()
    reg.registerBeforeContextCompactHook('p1', 'hang', () => new Promise<never>(() => {}))
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    expect(outcome).toBeUndefined()
    expect(failures[0]).toMatchObject({ pluginId: 'p1', hookId: 'hang', scope: 'beforeContextCompact' })
  })

  it('hard-caps an over-long replacement summary', async () => {
    const { reg } = registry()
    const huge = 'x'.repeat(CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS + 5_000)
    reg.registerBeforeContextCompactHook('p1', 'h', () => ({ summary: huge }))
    const outcome = await reg.runBeforeContextCompactHooks({ sessionId: 's' })
    expect(outcome?.summary.length).toBe(CORE_PLUGIN_COMPACT_SUMMARY_MAX_CHARS)
  })
})
