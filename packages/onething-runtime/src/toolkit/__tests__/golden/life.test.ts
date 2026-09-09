/**
 * `practice` 的行为金标(R3a 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。
 *
 * K3-b:`radio` 那一族金标随那只工具一起退役 —— 音乐成了一个资源 scheme,同一批
 * 用例(五条做法 / 两条参数校验 / 状态读法)逐条迁到
 * `packages/backend/wiring/resource/__tests__/music-provider.test.ts`。金标必须跟着
 * 实现走:留一份对着已删工具的快照,只会在下一个人跑 `-u` 的时候被静默清掉。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zodToJsonSchema } from '../../contract.js'
import type { OnethingPracticeBucket, OnethingPracticeSummaryResult } from '../../../practice/summary.js'
import type { OnethingPracticeLedgerRecord } from '../../../practice/types.js'
import { createPracticeTool, PracticeInputSchema, type PracticeToolAdapters } from '../../builtin/practice.js'
import { annotationsOf, modelTextOf, normalizeDetails, runNewTool } from '../support.js'

const RECORD: OnethingPracticeLedgerRecord = {
  id: 'r1',
  // This fixture exercises local display time, not conversion from a UTC instant.
  ts: new Date(2026, 7, 18, 11, 4).getTime(),
  kind: 'exercise',
  source: 'agent',
  name: '俯卧撑',
  exercise: { sets: 3, repsPerSet: 20 },
}

function bucket(overrides: Partial<OnethingPracticeBucket> = {}): OnethingPracticeBucket {
  return {
    bucketKey: '2026-08-18',
    startTs: 0,
    endTs: 0,
    records: 2,
    kegel: { sessions: 1, completedSessions: 1, reps: 30 },
    pomodoro: { sessions: 1, completedSessions: 1, minutes: 25, byCategory: [{ key: '写作', sessions: 1, minutes: 25 } as never] },
    exercise: { entries: 1, byName: [{ key: '俯卧撑', sets: 3, reps: 60, durationMin: 0 } as never] },
    ...overrides,
  }
}

function practiceAdapters(options: {
  summary?: OnethingPracticeSummaryResult
  recent?: OnethingPracticeLedgerRecord[]
} = {}): PracticeToolAdapters {
  return {
    log: () => RECORD,
    query: async () => options.summary ?? { granularity: 'day', buckets: [bucket()] },
    recent: async () => options.recent ?? [RECORD],
  }
}

describe('golden: practice', () => {
  const toLocaleString = Date.prototype.toLocaleString
  beforeEach(() => {
    // Locale is a fixture input too; preserve the real Date formatting behavior.
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, locales, options) {
      return toLocaleString.call(this, locales ?? 'en-US', options)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('spec 钉住', () => {
    const tool = createPracticeTool(practiceAdapters())
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(PracticeInputSchema))
    expect(tool.spec.concurrency).toBe('sequential')
    expect(tool.spec.effects).toEqual([])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; adapters?: PracticeToolAdapters }> = [
    { name: '正常:log 一条 3×20', args: { action: 'log', name: '俯卧撑', sets: 3, repsPerSet: 20 } },
    { name: '正常:query 默认粒度', args: { action: 'query' } },
    { name: '边界:log 缺 name', args: { action: 'log' } },
    {
      name: '边界:query 区间内没有记录',
      args: { action: 'query', granularity: 'week', count: 3 },
      adapters: practiceAdapters({ summary: { granularity: 'week', buckets: [bucket({ records: 0 })] }, recent: [] }),
    },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const adapters = fixture.adapters ?? practiceAdapters()
      const run = await runNewTool(createPracticeTool(adapters), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      expect(annotationsOf(run).at(-1)?.title).toMatchSnapshot('title')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
      expect(run.intent.effects).toEqual([])
    })
  }

  it('错误:适配层抛错原样冒泡', async () => {
    const boom: PracticeToolAdapters = {
      ...practiceAdapters(),
      query: async () => { throw new Error('ledger unavailable') },
    }
    const run = await runNewTool(createPracticeTool(boom), { action: 'query' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe('ledger unavailable')
  })

  it('错误:action 不合契约', async () => {
    const run = await runNewTool(createPracticeTool(practiceAdapters()), { action: 'delete' })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createPracticeTool(practiceAdapters()), { action: 'query' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
