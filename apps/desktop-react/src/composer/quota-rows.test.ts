import { describe, expect, it } from 'vitest'
import { meterRowsOf, quotaFailureOf, quotaRowsOf } from './components/MeterCard'
import { EMPTY_VIEW } from '../data/meter-source'
import type { MeterView, QuotaFacts } from '../data/meter-source'
import { quotaWarns } from '../providers/quota'
import { translate, type TFn } from '../i18n'

/** 按中文字典断言(§8.4 表写的就是中文);测试环境的 locale 是 system。 */
const t: TFn = (key, vars) => translate('zh', key, vars)

/** 批 5 §8.4 表,逐格。 */
const NOW = new Date(2026, 8, 26, 10, 0).getTime()
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).getTime()
const facts = (quota: QuotaFacts['quota'], extra: Partial<QuotaFacts> = {}): QuotaFacts => ({
  providerId: 'x',
  quota,
  localMonthUsd: null,
  ...extra,
})

describe('配额行(§8.4)', () => {
  it('订阅有窗口:一窗一行,今天的只写钟点,别的日子写周几', () => {
    const rows = quotaRowsOf(
      facts({
        kind: 'windows',
        windows: [
          { id: '5h', seconds: 18_000, usedPercent: 62, resetsAt: at(26, 14, 30) },
          { id: '7d', seconds: 604_800, usedPercent: 31, resetsAt: at(28, 8) },
        ],
        fetchedAt: NOW,
      }),
      t,
      NOW,
    ).map((row) => row.value)
    expect(rows).toEqual(['5 小时 已用 62% · 14:30 重置', '本周 已用 31% · 周一 08:00 重置'])
  })

  it('API 有余额:「余额 ¥123.45」,币种符号按 currency', () => {
    expect(quotaRowsOf(facts({ kind: 'balance', currency: 'CNY', available: 123.45, fetchedAt: 1 }), t, NOW)[0].value)
      .toBe('余额 ¥123.45')
    expect(quotaRowsOf(facts({ kind: 'balance', currency: 'USD', available: 4.1, fetchedAt: 1 }), t, NOW)[0].value)
      .toBe('余额 $4.10')
  })

  it('有余额也有窗口(Codex credits):两种都出', () => {
    const rows = quotaRowsOf(
      facts({
        kind: 'windows',
        windows: [{ id: '5h', seconds: 18_000, usedPercent: 10 }],
        balance: { currency: 'credits', available: 12.5 },
        fetchedAt: 1,
      }),
      t,
      NOW,
    ).map((row) => row.value)
    expect(rows).toEqual(['5 小时 已用 10%', '余额 12.50 点'])
  })

  it('不支持:本月本地估算;账本也答不上来就不出', () => {
    expect(quotaRowsOf(facts({ kind: 'unsupported' }, { localMonthUsd: 4.12 }), t, NOW)[0].value).toBe('本月已用 $4.12(本地估算)')
    expect(quotaRowsOf(facts({ kind: 'unsupported' }), t, NOW)).toEqual([])
  })

  it('失败:不出行,卡底灰字的原话;429 静默(两样都没有)', () => {
    const failed = facts({ kind: 'error', reason: 'network', message: 'fetch failed', fetchedAt: 1 })
    expect(quotaRowsOf(failed, t, NOW)).toEqual([])
    expect(quotaFailureOf(failed)).toBe('fetch failed')
    const limited = facts({ kind: 'error', reason: 'rate-limited', message: '429', fetchedAt: 1 })
    expect(quotaRowsOf(limited, t, NOW)).toEqual([])
    expect(quotaFailureOf(limited)).toBeNull()
  })

  it('插在「上下文」行之后', () => {
    const view: MeterView = { ...EMPTY_VIEW, present: true, contextUsed: 1000, contextMax: 10_000, tokensIn: 5, tokensOut: 6 }
    const keys = meterRowsOf(view, t, undefined, null, facts({ kind: 'balance', currency: 'CNY', available: 1, fetchedAt: 1 }))
      .map((row) => row.key)
    expect(keys.slice(0, 3)).toEqual(['上下文', '余额', 'Tokens'])
  })

  it('圆环警示:最紧的窗 ≥ 80% 或余额低于 ¥10 / $2;点数与失败不警示', () => {
    expect(quotaWarns({ kind: 'windows', windows: [{ id: '5h', seconds: 18_000, usedPercent: 80 }], fetchedAt: 1 })).toBe(true)
    expect(quotaWarns({ kind: 'windows', windows: [{ id: '5h', seconds: 18_000, usedPercent: 79 }], fetchedAt: 1 })).toBe(false)
    expect(quotaWarns({ kind: 'balance', currency: 'CNY', available: 9.99, fetchedAt: 1 })).toBe(true)
    expect(quotaWarns({ kind: 'balance', currency: 'USD', available: 2, fetchedAt: 1 })).toBe(false)
    expect(quotaWarns({ kind: 'balance', currency: 'credits', available: 0, fetchedAt: 1 })).toBe(false)
    expect(quotaWarns({ kind: 'error', reason: 'network', message: '', fetchedAt: 1 })).toBe(false)
    expect(quotaWarns(null)).toBe(false)
  })
})
