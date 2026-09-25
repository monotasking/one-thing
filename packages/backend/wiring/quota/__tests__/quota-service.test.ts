import { describe, expect, it, vi } from 'vitest'
import type { ProviderQuota, ProviderQuotaPushPayload } from '@shared/contracts/quota.js'
import {
  QUOTA_CARD_TTL_MS,
  QUOTA_RATE_LIMIT_HOLD_MS,
  QUOTA_RUN_END_DEBOUNCE_MS,
  QuotaService,
  quotaCooldownUntil,
  type QuotaServiceDeps,
} from '../service.js'

const T0 = 1_770_000_000_000

/** 可手拨的钟 + 可手放的计时器:门的时间尺度(30 秒 / 10 分钟)在单测里一步走完。 */
function harness(answers: Array<ProviderQuota | ((call: number) => ProviderQuota)>, extra: Partial<QuotaServiceDeps> = {}) {
  let now = T0
  const timers = new Map<number, { at: number; run: () => void }>()
  let timerSeq = 0
  const emitted: ProviderQuotaPushPayload[] = []
  const cooldowns: Array<[string, string, string, number]> = []
  let calls = 0
  const fetch = vi.fn(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]
    calls += 1
    return typeof answer === 'function' ? answer(calls) : answer
  })
  const deps: QuotaServiceDeps = {
    hasSource: providerId => providerId !== 'gemini',
    decide: () => 'entry-1',
    resolve: async (_providerId, _spaceId, credentialId) => ({ kind: 'ready', credentialId, context: { apiKey: 'k' } }),
    fetch,
    fetchImpl: () => globalThis.fetch,
    emit: payload => { emitted.push(payload) },
    markCooldown: (spaceId, providerId, credentialId, until) => { cooldowns.push([spaceId, providerId, credentialId, until]) },
    now: () => now,
    setTimer: (run, ms) => {
      timerSeq += 1
      timers.set(timerSeq, { at: now + ms, run })
      return timerSeq
    },
    clearTimer: handle => { timers.delete(handle as number) },
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    ...extra,
  }
  const advance = async (ms: number) => {
    now += ms
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id)
        timer.run()
      }
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return { service: new QuotaService(deps), fetch, emitted, cooldowns, advance, timers }
}

const balance = (available: number): ProviderQuota => ({ kind: 'balance', currency: 'CNY', available, fetchedAt: T0 })
const windows = (pct: number, resetsAt?: number): ProviderQuota => ({
  kind: 'windows',
  windows: [{ id: '5h', seconds: 18_000, usedPercent: pct, ...(resetsAt ? { resetsAt } : {}) }],
  fetchedAt: T0,
})
const limited: ProviderQuota = { kind: 'error', reason: 'rate-limited', message: 'Claude usage request failed: 429', fetchedAt: T0 }

describe('QuotaService', () => {
  it('不支持的家:unsupported,零请求', async () => {
    const h = harness([balance(1)])
    await expect(h.service.get({ providerId: 'gemini', spaceId: 'default' })).resolves.toEqual({ quota: { kind: 'unsupported' } })
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('卡片打开:60 秒内复用缓存,超 60 秒才真去问;force 绕过;答案带 decide 出来的凭证', async () => {
    const h = harness([balance(10), balance(9), balance(8)])
    await expect(h.service.get({ providerId: 'deepseek', spaceId: 'default' })).resolves.toEqual({ quota: balance(10), credentialId: 'entry-1' })
    await h.advance(QUOTA_CARD_TTL_MS - 1)
    await h.service.get({ providerId: 'deepseek', spaceId: 'default' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
    await h.advance(2)
    await h.service.get({ providerId: 'deepseek', spaceId: 'default' })
    expect(h.fetch).toHaveBeenCalledTimes(2)
    await h.service.get({ providerId: 'deepseek', spaceId: 'default', force: true })
    expect(h.fetch).toHaveBeenCalledTimes(3)
    expect(h.emitted.map(payload => payload.credentialId)).toEqual(['entry-1', 'entry-1', 'entry-1'])
  })

  it('同一格并发两问只起一发(单飞)', async () => {
    const h = harness([balance(1)])
    await Promise.all([
      h.service.get({ providerId: 'deepseek', spaceId: 'default' }),
      h.service.get({ providerId: 'deepseek', spaceId: 'default' }),
    ])
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('run/end:30 秒去抖,窗口内三次只问一次', async () => {
    const h = harness([balance(1)])
    const end = { providerId: 'deepseek', spaceId: 'default', credentialId: 'entry-1' }
    h.service.noteRunEnd(end)
    await h.advance(10_000)
    h.service.noteRunEnd(end)
    await h.advance(10_000)
    h.service.noteRunEnd(end)
    await h.advance(QUOTA_RUN_END_DEBOUNCE_MS - 1)
    expect(h.fetch).not.toHaveBeenCalled()
    await h.advance(2)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.service.pendingTimers()).toBe(0)
  })

  it('429:静默 10 分钟 —— 期间 force / run/end 都零请求,答上一份好的数、不推送', async () => {
    const h = harness([balance(5), limited, balance(4)])
    await h.service.get({ providerId: 'claude-code', spaceId: 'default', force: true })
    const second = await h.service.get({ providerId: 'claude-code', spaceId: 'default', force: true })
    expect(second.quota).toEqual(balance(5))
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.emitted).toHaveLength(1)
    for (let i = 0; i < 5; i += 1) {
      await h.service.get({ providerId: 'claude-code', spaceId: 'default', force: true })
      h.service.noteRunEnd({ providerId: 'claude-code', spaceId: 'default', credentialId: 'entry-1' })
      await h.advance(QUOTA_RUN_END_DEBOUNCE_MS + 1)
    }
    await h.advance(QUOTA_RATE_LIMIT_HOLD_MS - 6 * (QUOTA_RUN_END_DEBOUNCE_MS + 1))
    expect(h.fetch).toHaveBeenCalledTimes(2)
    await h.advance(10 * (QUOTA_RUN_END_DEBOUNCE_MS + 1))
    await h.service.get({ providerId: 'claude-code', spaceId: 'default', force: true })
    expect(h.fetch).toHaveBeenCalledTimes(3)
  })

  it('429 且从没有过好数:答那条 rate-limited 错(壳按它静默)', async () => {
    const h = harness([limited])
    const answer = await h.service.get({ providerId: 'claude-code', spaceId: 'default' })
    expect(answer.quota).toMatchObject({ kind: 'error', reason: 'rate-limited' })
    expect(h.emitted).toHaveLength(0)
  })

  it('被动源:一条头进缓存并推送,零请求;近 60 秒刷过的格子 run/end 到点也不问', async () => {
    const h = harness([balance(1)])
    h.service.observe({ providerId: 'codex', spaceId: 'default', credentialId: 'entry-1', quota: windows(40) })
    expect(h.emitted).toEqual([{ providerId: 'codex', credentialId: 'entry-1', quota: windows(40) }])
    await expect(h.service.get({ providerId: 'codex', spaceId: 'default', credentialId: 'entry-1' }))
      .resolves.toEqual({ quota: windows(40), credentialId: 'entry-1' })
    h.service.noteRunEnd({ providerId: 'codex', spaceId: 'default', credentialId: 'entry-1' })
    await h.advance(QUOTA_RUN_END_DEBOUNCE_MS + 1)
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('配额冷却(批 6 的那一格):窗口 ≥100% → 冷却到重置;余额 ≤0 → +10 分钟;有数的才写', async () => {
    const h = harness([windows(100, T0 + 3_600_000), balance(0), balance(3)])
    await h.service.get({ providerId: 'codex', spaceId: 's1', force: true })
    await h.service.get({ providerId: 'codex', spaceId: 's1', force: true })
    await h.service.get({ providerId: 'codex', spaceId: 's1', force: true })
    expect(h.cooldowns).toEqual([
      ['s1', 'codex', 'entry-1', T0 + 3_600_000],
      ['s1', 'codex', 'entry-1', T0 + 10 * 60_000],
    ])
    expect(quotaCooldownUntil(windows(99), T0)).toBeUndefined()
    expect(quotaCooldownUntil(windows(100), T0)).toBe(T0 + 10 * 60_000)
  })

  it('凭证解不出来:auth 错,不进缓存、不推送、不起请求', async () => {
    const h = harness([balance(1)], { resolve: async () => { throw new Error('Not logged in') } })
    const answer = await h.service.get({ providerId: 'codex', spaceId: 'default' })
    expect(answer.quota).toMatchObject({ kind: 'error', reason: 'auth', message: 'Not logged in' })
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.emitted).toHaveLength(0)
  })

  it('dispose 收掉所有计时器', async () => {
    const h = harness([balance(1)])
    h.service.noteRunEnd({ providerId: 'deepseek', spaceId: 'default', credentialId: 'a' })
    h.service.noteRunEnd({ providerId: 'deepseek', spaceId: 'default', credentialId: 'b' })
    expect(h.service.pendingTimers()).toBe(2)
    h.service.dispose()
    expect(h.timers.size).toBe(0)
    await h.advance(QUOTA_RUN_END_DEBOUNCE_MS + 1)
    expect(h.fetch).not.toHaveBeenCalled()
  })
})
