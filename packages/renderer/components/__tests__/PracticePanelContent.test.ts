// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import PracticePanelContent from '../PracticePanelContent.vue'

/**
 * storeToRefs 只挑得出**真 ref** —— 普通字面量会被它跳过,模板里就成了
 * `undefined.value`。而 `vi.hoisted` 的工厂跑在所有 import 之前,拿不到 `ref`,
 * 所以 store 在 mock 工厂里现造,再放进这个被提升的盒子给用例改。
 */
const practiceStore = vi.hoisted(() => ({
  lastSettled: null as unknown,
  config: null as unknown,
  soundEnabled: null as unknown,
  isRunning: false,
  init: vi.fn(),
  saveConfig: vi.fn(),
  startKegel: vi.fn(),
}))

const practiceApi = vi.hoisted(() => ({
  summary: vi.fn(),
  recent: vi.fn(),
}))

vi.mock('@/stores/practice', async () => {
  const { ref } = await import('vue')
  practiceStore.lastSettled = ref(null)
  practiceStore.config = ref({
    kegel: { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true },
    pomodoro: { minutes: 25, categories: ['学习'] },
  })
  practiceStore.soundEnabled = ref(true)
  return { usePracticeStore: () => practiceStore }
})

vi.mock('@/platform/practice-client', () => ({ practiceApi }))

function bucket(key: string, records: number) {
  return {
    bucketKey: key,
    records,
    kegel: { sessions: records > 0 ? 1 : 0, reps: records * 20 },
    pomodoro: { sessions: 0, minutes: 0 },
    exercise: { byName: [] as Array<{ key: string; sets: number; reps: number; durationMin: number }> },
  }
}

const RECORDS = [
  {
    id: 'r1',
    ts: Date.now(),
    kind: 'kegel',
    source: 'timer',
    name: '凯格尔',
    kegel: { holdSec: 10, relaxSec: 5, repsDone: 40, repsTarget: 20, setsDone: 2, setsTarget: 3 },
  },
  {
    id: 'r2',
    ts: Date.now(),
    kind: 'pomodoro',
    source: 'timer',
    name: '学习',
    pomodoro: { minutes: 25, elapsedMin: 25, completed: true },
  },
  {
    id: 'r3',
    ts: Date.now(),
    kind: 'exercise',
    source: 'manual',
    name: '俯卧撑',
    exercise: { sets: 3, repsPerSet: 12 },
  },
]

async function mountPanel() {
  const wrapper = mount(PracticePanelContent)
  await vi.waitFor(() => {
    expect(wrapper.findAll('.entry-row').length).toBeGreaterThan(0)
  })
  return wrapper
}

describe('PracticePanelContent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    practiceStore.isRunning = false
    practiceApi.summary.mockResolvedValue({
      buckets: [bucket('wk-11', 1), bucket('wk-12', 2), bucket('wk-13', 3)],
    })
    practiceApi.recent.mockResolvedValue({ records: RECORDS })
  })

  it('draws a 3px progress bar and a right-aligned mono count for ratio records', async () => {
    const wrapper = await mountPanel()
    const rows = wrapper.findAll('.entry-row')
    expect(rows).toHaveLength(3)

    // 凯格尔 2/3 组:未完成 → 警示色
    const kegel = rows[0]
    expect(kegel.find('.plr-title').text()).toBe('凯格尔 · 40 rep')
    expect(kegel.find('.pp-progress-fill').attributes('style')).toContain('width: 67%')
    expect(kegel.find('.pp-progress-fill').classes()).toContain('is-warning')
    expect(kegel.find('.entry-count').text()).toBe('2 / 3')

    // 番茄跑满 → 成功色(没有 is-warning)
    const pomodoro = rows[1]
    expect(pomodoro.find('.pp-progress-fill').classes()).not.toContain('is-warning')
    expect(pomodoro.find('.entry-count').text()).toBe('25 / 25')
  })

  it('falls back to a timestamp sub-line and a faint count when there is no ratio', async () => {
    const wrapper = await mountPanel()
    const exercise = wrapper.findAll('.entry-row')[2]

    expect(exercise.find('.pp-progress').exists()).toBe(false)
    expect(exercise.find('.entry-stamp').exists()).toBe(true)
    expect(exercise.find('.entry-count').classes()).toContain('is-faint')
    expect(exercise.find('.entry-count').text()).toBe('3×12')
  })

  it('reports today and the streak in the status bar', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.panel-shell-status').text()).toBe('今日 3 条 · 连续 3 天')
  })

  it('keeps the params form and the ledger table, with params collapsed by default', async () => {
    const wrapper = await mountPanel()

    const headers = wrapper.findAll('.ledger-group-header .lgh-label').map(h => h.text())
    expect(headers).toEqual(['参数', '最近条目', '账页'])

    // 参数区仍在 DOM 里(v-show),只是收起来了
    expect(wrapper.find('.params').attributes('style')).toContain('display: none')
    await wrapper.find('.lgh-toggle').trigger('click')
    expect(wrapper.find('.params').attributes('style') ?? '').not.toContain('display: none')
    expect(wrapper.findAll('.param-row')).toHaveLength(3)

    // 账页是真 <table>,没被换成别的东西
    expect(wrapper.findAll('table.ledger tbody tr')).toHaveLength(3)
  })

  it('starts a practice from the control bar and locks the button while running', async () => {
    const wrapper = await mountPanel()
    const action = wrapper.find('.panel-primary-action')
    expect(action.text()).toBe('开始练习')

    await action.trigger('click')
    expect(practiceStore.startKegel).toHaveBeenCalledTimes(1)
  })

  it('filters both the entry rows and the ledger rows from one search box', async () => {
    const wrapper = await mountPanel()

    await wrapper.find('.filter-search-input').setValue('番茄')
    expect(wrapper.findAll('.entry-row')).toHaveLength(1)
    expect(wrapper.findAll('table.ledger tbody tr')).toHaveLength(0)

    await wrapper.find('.filter-search-input').setValue('wk-13')
    expect(wrapper.findAll('.entry-row')).toHaveLength(0)
    expect(wrapper.findAll('table.ledger tbody tr')).toHaveLength(1)
  })

  it('pulls a separate day summary when the ledger is on a coarser granularity', async () => {
    const wrapper = await mountPanel()
    expect(practiceApi.summary).toHaveBeenCalledTimes(1)

    const pills = wrapper.findAll('.segmented-pill-item')
    await pills[2].trigger('click')

    await vi.waitFor(() => {
      expect(practiceApi.summary).toHaveBeenCalledWith({ granularity: 'month' })
      expect(practiceApi.summary).toHaveBeenCalledWith({ granularity: 'day' })
    })
  })
})
