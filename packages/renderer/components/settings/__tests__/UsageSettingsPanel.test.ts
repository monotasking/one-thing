// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UsageSettingsPanel from '../UsageSettingsPanel.vue'

const getUsageSummary = vi.fn()

vi.mock('@/platform', () => ({
  platformApi: {
    getUsageSummary: (...args: unknown[]) => getUsageSummary(...args),
  },
}))

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const todayKey = localDayKey(new Date())

function usage(total = 1500, overrides: Record<string, number> = {}) {
  return { input: 1000, output: 500, cacheRead: 800, cacheWrite: 50, reasoning: 40, total, ...overrides }
}

function breakdownEntry(overrides: Record<string, unknown> = {}) {
  return {
    key: 'anthropic',
    usage: usage(1500),
    apiCostUSD: 0.012,
    subscriptionCostUSD: 0,
    records: 1,
    ...overrides,
  }
}

function bucketFixture(overrides: Record<string, unknown> = {}) {
  return {
    bucketKey: todayKey,
    startTs: Date.now() - 86400000,
    endTs: Date.now(),
    usage: usage(1500),
    apiCostUSD: 0.012,
    subscriptionCostUSD: 0.003,
    records: 2,
    byProvider: [
      breakdownEntry({ key: 'anthropic', apiCostUSD: 0.012, subscriptionCostUSD: 0 }),
      breakdownEntry({ key: 'codex', apiCostUSD: 0, subscriptionCostUSD: 0.003, records: 1 }),
    ],
    byModel: [breakdownEntry({ key: 'claude-fable-5' })],
    byPlatform: [breakdownEntry({ key: 'electron' })],
    bySource: [breakdownEntry({ key: 'chat' })],
    ...overrides,
  }
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    granularity: 'day',
    buckets: [bucketFixture()],
    totalApiCostUSD: 0.012,
    totalSubscriptionCostUSD: 0.003,
    pricingQuality: { pricedTokens: 1500, unpricedTokens: 0, cacheSavingsUSD: 0.5 },
    byProject: [],
    ...overrides,
  }
}

function emptySummary() {
  return summaryFixture({
    buckets: [bucketFixture({
      usage: usage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
      apiCostUSD: 0,
      subscriptionCostUSD: 0,
      records: 0,
      byProvider: [],
      byModel: [],
      byPlatform: [],
      bySource: [],
    })],
    totalApiCostUSD: 0,
    totalSubscriptionCostUSD: 0,
    pricingQuality: { pricedTokens: 0, unpricedTokens: 0, cacheSavingsUSD: 0 },
  })
}

describe('UsageSettingsPanel', () => {
  beforeEach(() => {
    getUsageSummary.mockReset()
  })

  it('fetches 30 trailing day buckets by default and renders the raw token cost', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(getUsageSummary).toHaveBeenCalledWith({ granularity: 'day', count: 30 })
    // $0.0120 api + $0.0030 subscription estimate combined
    expect(wrapper.text()).toContain('$0.0150')
    expect(wrapper.text()).toContain('Raw token cost')
  })

  it('renders per-provider rows with cost share and token totals', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('Anthropic')
    expect(text).toContain('Codex')
    expect(text).toContain('80.0% of cost')
    expect(text).toContain('20.0% of cost')
  })

  it('marks subscription-estimated provider cost as est.', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const rows = wrapper.findAll('.provider-row')
    const codexRow = rows.find(row => row.text().includes('Codex'))
    expect(codexRow?.text()).toContain('est.')
  })

  it('refetches with the selected range when switching to 90 days', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const buttons = wrapper.findAll('.segmented button')
    const ninety = buttons.find(b => b.text() === '90 days')
    expect(ninety).toBeDefined()
    await ninety!.trigger('click')
    await flushPromises()

    expect(getUsageSummary).toHaveBeenLastCalledWith({ granularity: 'day', count: 90 })
  })

  it('shows the model breakdown by default and switches to the day view', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('claude-fable-5')

    const dayButton = wrapper.findAll('.breakdown-block .segmented button')
      .find(b => b.text() === 'Day')
    await dayButton!.trigger('click')

    expect(wrapper.find('.breakdown-block').text()).toContain(todayKey)
  })

  it('day view hides days without records', async () => {
    const yesterday = new Date(Date.now() - 86400000)
    const yesterdayKey = localDayKey(yesterday)
    getUsageSummary.mockResolvedValue(summaryFixture({
      buckets: [
        bucketFixture(),
        bucketFixture({
          bucketKey: yesterdayKey,
          records: 0,
          apiCostUSD: 0,
          subscriptionCostUSD: 0,
          usage: usage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
          byProvider: [],
          byModel: [],
          byPlatform: [],
          bySource: [],
        }),
      ],
    }))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const dayButton = wrapper.findAll('.breakdown-block .segmented button')
      .find(b => b.text() === 'Day')
    await dayButton!.trigger('click')

    const text = wrapper.find('.breakdown-block').text()
    expect(text).toContain(todayKey)
    expect(text).not.toContain(yesterdayKey)
  })

  it('ignores a stale response when the range changed mid-flight', async () => {
    let resolveFirst!: (value: unknown) => void
    getUsageSummary
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(summaryFixture({
        buckets: [bucketFixture({ apiCostUSD: 5, subscriptionCostUSD: 0 })],
        totalApiCostUSD: 5,
        totalSubscriptionCostUSD: 0,
      }))

    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    // Switch to 90 days while the 30-day request is still pending.
    const ninety = wrapper.findAll('.segmented button').find(b => b.text() === '90 days')
    await ninety!.trigger('click')
    await flushPromises()

    // The late 30-day response must not overwrite the 90-day data.
    resolveFirst(summaryFixture({
      buckets: [bucketFixture({ apiCostUSD: 999, subscriptionCostUSD: 0 })],
      totalApiCostUSD: 999,
      totalSubscriptionCostUSD: 0,
    }))
    await flushPromises()

    expect(wrapper.text()).toContain('$5.00')
    expect(wrapper.text()).not.toContain('$999')
  })

  it('lists activity breakdown with friendly labels for background calls', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture({
      buckets: [bucketFixture({
        bySource: [
          breakdownEntry({ key: 'chat', apiCostUSD: 0.012, subscriptionCostUSD: 0 }),
          breakdownEntry({ key: 'memory', apiCostUSD: 0.004, subscriptionCostUSD: 0 }),
        ],
      })],
    }))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const activityButton = wrapper.findAll('.breakdown-block .segmented button')
      .find(b => b.text() === 'Activity')
    await activityButton!.trigger('click')

    const text = wrapper.find('.breakdown-block').text()
    expect(text).toContain('Chat')
    expect(text).toContain('Memory')
  })

  it('renders the stats strip and cost quality from pricingQuality', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('Processed tokens')
    expect(text).toContain('Cached input')
    expect(text).toContain('Cache savings')
    expect(text).toContain('$0.5000')
    expect(text).toContain('Model priced')
    expect(text).toContain('100.0%')
  })

  it('厂商报价与本地估算并排显示 —— 大数字仍是覆盖全部记录的本地估算', async () => {
    getUsageSummary.mockResolvedValue(
      summaryFixture({
        totalProviderCostUSD: 0.008,
        pricingQuality: {
          pricedTokens: 1500,
          unpricedTokens: 0,
          cacheSavingsUSD: 0.5,
          providerReportedTokens: 900,
          providerReportedLocalCostUSD: 0.0072,
        },
      }),
    )
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const text = wrapper.text()
    // 头顶的总数没被厂商值换掉。
    expect(text).toContain('$0.0150')
    // 多出来的那一行:厂商值在前,本地估算在后。
    expect(text).toContain('provider quoted $0.0080')
    expect(text).toContain('locally estimated $0.0072')
    // Cost quality 里 "Provider reported" 是真数了(900 / 1500)。
    expect(text).toContain('60.0%')
  })

  it('没有任何厂商报价时,那一行不出现,老账本读数不变', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const text = wrapper.text()
    expect(text).not.toContain('provider quoted')
    expect(text).toContain('Provider reported')
    expect(text).toContain('$0.0150')
  })

  it('renders the daily chart with one area layer per provider', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const paths = wrapper.findAll('.chart .layer-fill')
    expect(paths.length).toBe(2)
  })

  it('shows a hover tooltip with the largest contributor first', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    // happy-dom rects are all-zero, so the pointer resolves to the last day.
    await wrapper.find('.chart').trigger('mousemove', { clientX: 100, clientY: 50 })

    const tip = wrapper.find('.chart-tip')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toContain(todayKey)
    const rows = tip.findAll('.tip-row')
    // anthropic $0.0120 > codex $0.0030, then the total row.
    expect(rows[0].text()).toContain('Anthropic')
    expect(rows[1].text()).toContain('Codex')
    expect(rows.at(-1)!.text()).toContain('Total')

    await wrapper.find('.chart-wrap').trigger('mouseleave')
    expect(wrapper.find('.chart-tip').exists()).toBe(false)
  })

  it('never smooths a spike below the zero baseline', async () => {
    // A tall spike followed by zero days used to overshoot below zero with
    // Catmull-Rom; the monotone interpolation must stay on the baseline.
    const dayMs = 86400000
    const now = Date.now()
    const spikeBucket = bucketFixture({
      bucketKey: localDayKey(new Date(now - 2 * dayMs)),
      startTs: now - 2 * dayMs,
      endTs: now - dayMs,
      apiCostUSD: 9,
      subscriptionCostUSD: 0,
    })
    const zeroBucket = (offset: number) => bucketFixture({
      bucketKey: localDayKey(new Date(now - offset * dayMs)),
      startTs: now - offset * dayMs,
      endTs: now - (offset - 1) * dayMs,
      apiCostUSD: 0,
      subscriptionCostUSD: 0,
      records: 0,
      usage: usage(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
      byProvider: [],
      byModel: [],
      byPlatform: [],
      bySource: [],
    })
    getUsageSummary.mockResolvedValue(summaryFixture({
      buckets: [spikeBucket, zeroBucket(1), zeroBucket(0)],
      totalApiCostUSD: 9,
      totalSubscriptionCostUSD: 0,
    }))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    // SVG y grows downward; baseline (value 0) sits at y = 194 (PAD_T + PLOT_H).
    const baselineY = 194
    for (const path of wrapper.findAll('.chart path')) {
      const coords = (path.attributes('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
      const ys = coords.filter((_, index) => index % 2 === 1)
      for (const y of ys) {
        expect(y).toBeLessThanOrEqual(baselineY + 0.05)
      }
    }
  })

  it('shows an empty state when no usage has been recorded', async () => {
    getUsageSummary.mockResolvedValue(emptySummary())
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No usage recorded yet')
  })

  it('surfaces a fetch error instead of throwing', async () => {
    getUsageSummary.mockRejectedValue(new Error('network down'))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('network down')
  })

  function projectFixture(overrides: Record<string, unknown> = {}) {
    return {
      projectPath: '/dev/kero',
      projectName: 'kero',
      usage: usage(3200),
      apiCostUSD: 0.008,
      subscriptionCostUSD: 0.002,
      records: 3,
      sessionCount: 2,
      lastActiveTs: Date.now(),
      byProvider: [
        breakdownEntry({ key: 'anthropic', apiCostUSD: 0.008, subscriptionCostUSD: 0 }),
        breakdownEntry({ key: 'codex', apiCostUSD: 0, subscriptionCostUSD: 0.002 }),
      ],
      byModel: [breakdownEntry({ key: 'claude-fable-5' })],
      ...overrides,
    }
  }

  it('renders per-project rows with provider split and session counts', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture({
      byProject: [
        projectFixture(),
        projectFixture({
          projectPath: '/dev/waku',
          projectName: 'waku',
          apiCostUSD: 0.002,
          subscriptionCostUSD: 0,
          sessionCount: 1,
          byModel: [breakdownEntry({ key: 'gpt-5.5' })],
        }),
      ],
    }))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('By project')
    expect(text).toContain('2 projects')
    expect(text).toContain('3 sessions')
    expect(text).toContain('kero')
    expect(text).toContain('/dev/kero')
    expect(text).toContain('waku')
    expect(text).toContain('2 sessions · last active')
    expect(text).toContain('1 session · last active')
    // Provider chips and the split bar per project.
    expect(wrapper.findAll('.project-split').length).toBe(2)
    expect(wrapper.findAll('.project-split')[0].findAll('i').length).toBe(2)
    expect(text).toContain('claude-fable-5')
    expect(text).toContain('gpt-5.5')
  })

  it('filters project rows by name or path', async () => {
    getUsageSummary.mockResolvedValue(summaryFixture({
      byProject: [
        projectFixture(),
        projectFixture({ projectPath: '/dev/waku', projectName: 'waku' }),
      ],
    }))
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.findAll('.project-row').length).toBe(2)

    await wrapper.find('.project-filter').setValue('waku')
    expect(wrapper.findAll('.project-row').length).toBe(1)
    expect(wrapper.text()).not.toContain('/dev/kero')

    await wrapper.find('.project-filter').setValue('zzz-no-match')
    expect(wrapper.findAll('.project-row').length).toBe(0)
    expect(wrapper.text()).toContain('No projects match')
  })

  it('hides the project section when the backend predates byProject', async () => {
    const legacy = summaryFixture()
    delete (legacy as Record<string, unknown>).byProject
    getUsageSummary.mockResolvedValue(legacy)
    const wrapper = mount(UsageSettingsPanel)
    await flushPromises()

    expect(wrapper.text()).not.toContain('By project')
  })
})
