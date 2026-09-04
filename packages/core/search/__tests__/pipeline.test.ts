import { describe, expect, it, vi } from 'vitest'

import type { Candidate, SearchCapability, SearchPage, SearchQuery } from '../index.js'
import { ALL_CAPABILITIES } from '../candidate.js'
import { createCapabilityRegistry } from '../capability.js'
import { plan } from '../pipeline/plan.js'
import { parse } from '../pipeline/parse.js'
import { budgetPolicy } from '../pipeline/budget.js'
import { fanout } from '../pipeline/fanout.js'
import { applyVisibility, assertAuthorized, visibilityScopeOf } from '../pipeline/authorize.js'
import {
  PREFIX_EXPANSION_LIMIT,
  createDefaultExpanderRegistry,
  createPrefixExpander,
  expandTerm,
} from '../pipeline/expand.js'
import { collectGroups, compose } from '../pipeline/compose.js'
import { createGroupMerge } from '../pipeline/merge.js'
import { defaultRanker, emptyRankingSignals } from '../pipeline/rank.js'
import { buildSnippet, hitRangesFromTokens } from '../pipeline/snippet.js'
import { rrfFusion } from '../bases/indexed.js'
import { staticCapability } from '../bases/static.js'
import { scanCapability } from '../bases/scan.js'
import { DEFAULT_NORMALIZERS, composeNormalizers } from '../analyzer/normalize.js'
import { compositeAnalyzer } from '../analyzer/composite.js'
import { CAP_A, CAP_B, CORPUS_NOW, corpusDocuments, secondaryDocuments } from './unit-fixtures/corpus.js'
import {
  buildIndex,
  collect,
  makeContext,
  makeIndexedCapability,
  makeManifest,
  makePipeline,
} from './unit-fixtures/harness.js'

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    capability: CAP_A,
    id,
    title: id,
    score: 1,
    target: { kind: 'row', payload: {} },
    ...overrides,
  }
}

describe('plan:放宽阶梯', () => {
  const query = parse('索引 重建 加速')

  it('四级,严格在最前', () => {
    const ladder = plan(query)
    expect(ladder.map(step => step.level)).toEqual([0, 1, 2, 3])
    expect(ladder[0]).toEqual({
      level: 0, minShouldMatch: 3, phraseAdjacent: true, multiTokenTerms: 'phrase',
    })
    expect(ladder[1]!.phraseAdjacent).toBe(false)
    expect(ladder[2]!.minShouldMatch).toBe(2)
    expect(ladder[3]!.minShouldMatch).toBe(1)
  })

  /**
   * 「一个 AST 词摊成多词元」这一维是**分级**的:①② 词还是词,③④ 才摊开。
   * `minShouldMatch` 推不出它 —— 单词查询在四级上都是 1(见 `LadderStep` 那段)。
   */
  it('①②把一个词当一体,③④才摊成词元', () => {
    const ladder = plan(query)
    expect(ladder.map(step => step.multiTokenTerms)).toEqual(['phrase', 'phrase', 'split', 'split'])
  })

  it('relax:false 只跑第一级', () => {
    const only = plan(query, { relax: false })
    expect(only.map(step => step.level)).toEqual([0])
    expect(only[0]!.multiTokenTerms).toBe('phrase')
  })
})

describe('expand:前缀展开与上限', () => {
  const index = buildIndex(corpusDocuments())
  const expanders = createDefaultExpanderRegistry()

  it('末词才展开', () => {
    const last = expandTerm({ text: 'search', last: true }, expanders.list(), index, { fields: ['content'] })
    const notLast = expandTerm({ text: 'search', last: false }, expanders.list(), index, { fields: ['content'] })
    expect(last.length).toBeGreaterThan(1)
    expect(notLast).toEqual([{ term: 'search', weight: 1 }])
  })

  it('原词永远在且权重 1,展开项权重更低', () => {
    const expanded = expandTerm({ text: 'search', last: true }, expanders.list(), index, { fields: ['content'] })
    expect(expanded[0]).toEqual({ term: 'search', weight: 1 })
    expect(expanded.slice(1).every(entry => entry.weight < 1)).toBe(true)
  })

  it('上限 64:一个字母不许把半个词典展开出来', () => {
    const wide = buildIndex(Array.from({ length: 300 }, (_, position) => ({
      capability: CAP_A,
      key: `w-${position}`,
      time: CORPUS_NOW,
      facets: {},
      fields: { content: `a${position}` },
    })))
    const expanded = expandTerm({ text: 'a', last: true }, [createPrefixExpander()], wide, { fields: ['content'] })
    expect(expanded.length).toBe(PREFIX_EXPANSION_LIMIT + 1)
  })

  it('上限对整条生效,不是每个 expander 各一份', () => {
    const wide = buildIndex(Array.from({ length: 300 }, (_, position) => ({
      capability: CAP_A,
      key: `w-${position}`,
      time: CORPUS_NOW,
      facets: {},
      fields: { content: `a${position}` },
    })))
    const two = [createPrefixExpander(), { ...createPrefixExpander(), id: 'prefix-2' }]
    expect(expandTerm({ text: 'a', last: true }, two, wide, { fields: ['content'] }).length)
      .toBe(PREFIX_EXPANSION_LIMIT + 1)
  })
})

describe('授权:范围进 filters,total 是真数', () => {
  const visibility = () => ({ space: 's1' })

  it('visibility 的范围合进 filters,而且赢过用户手打的那格', () => {
    const scope = visibilityScopeOf(makeManifest({ id: CAP_A, visibility }), { kind: 'user', id: 'u1' })
    const query = applyVisibility(parse('身份牌 space:s2'), scope)
    expect(query.filters.space).toBe('s1')
  })

  it('没声明 visibility = 全可见,filters 一字不动', () => {
    const query = parse('身份牌')
    expect(applyVisibility(query, visibilityScopeOf(makeManifest({ id: CAP_A }), { kind: 'user', id: 'u1' })))
      .toBe(query)
  })

  it('范围是查询的输入:total 是授权之后的真数,不是滤前的', async () => {
    const scoped = makeIndexedCapability(CAP_A, { manifest: { visibility } }).capability
    const open = makeIndexedCapability(CAP_A).capability
    const ctx = makeContext()
    const request = { limit: 50 }
    const query = { ...parse('身份牌'), ladder: plan(parse('身份牌'))[0] }

    const openPage = await open.search(query, request, ctx)
    const scopedPage = await scoped.search(applyVisibility(query, visibility()), request, ctx)

    expect(openPage.items.map(item => item.id)).toContain('a-17')
    expect(scopedPage.items.map(item => item.id)).not.toContain('a-17')
    // 关键:条数与 total 一起变小 —— 若授权是「事后过滤」,total 会仍是 openPage 那个数。
    expect(scopedPage.total).toBe(scopedPage.items.length)
    expect(scopedPage.total).toBeLessThan(openPage.total!)
  })

  it('兜底核验:漏网的丢掉、total 跟着改、warn 报出来', () => {
    const warn = vi.fn()
    const page: SearchPage = {
      items: [candidate('ok', { facets: { space: 's1' } }), candidate('leak', { facets: { space: 's2' } })],
      total: 2,
      took: 0,
    }
    const result = assertAuthorized(page, { space: 's1' }, { capability: CAP_A, warn })
    expect(result.page.items.map(item => item.id)).toEqual(['ok'])
    expect(result.page.total).toBe(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('判不了的不丢 —— 这一段不承担正确性', () => {
    const warn = vi.fn()
    const page: SearchPage = { items: [candidate('nofacets')], total: 1, took: 0 }
    expect(assertAuthorized(page, { space: 's1' }, { capability: CAP_A, warn }).page.items).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('fanout', () => {
  function slowCapability(id: string, delay: number, items: Candidate[] = []): SearchCapability {
    return {
      manifest: makeManifest({ id, budget: { default: 5, timeoutMs: 50 } }),
      supports: () => true,
      search: (_query, _page, ctx) => new Promise<SearchPage>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ items, took: delay }), delay)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(ctx.signal.reason)
        }, { once: true })
      }),
    }
  }

  it('谁先答完谁先出', async () => {
    const registry = createCapabilityRegistry()
    registry.register(slowCapability('slow', 30, [candidate('s')]))
    registry.register(slowCapability('fast', 1, [candidate('f')]))

    const groups = await collect(fanout(registry, budgetPolicy)(makeContext(), parse('x')))
    expect(groups.map(group => group.capability)).toEqual(['fast', 'slow'])
  })

  it('一路超时不拖死别路,超时那组带 error', async () => {
    const registry = createCapabilityRegistry()
    registry.register(slowCapability('hang', 5_000, [candidate('h')]))
    registry.register(slowCapability('quick', 1, [candidate('q')]))

    const groups = await collect(fanout(registry, budgetPolicy)(makeContext(), parse('x')))
    expect(groups.find(group => group.capability === 'quick')?.page?.items).toHaveLength(1)
    expect(groups.find(group => group.capability === 'hang')?.error).toBe('timeout')
  })

  it('超时经派生信号传进 search(),不是外面包一层让它白算', async () => {
    let sawAbort = false
    const registry = createCapabilityRegistry()
    registry.register({
      manifest: makeManifest({ id: 'watcher', budget: { default: 5, timeoutMs: 10 } }),
      supports: () => true,
      search: (_q, _p, ctx) => new Promise<SearchPage>(resolve => {
        ctx.signal.addEventListener('abort', () => {
          sawAbort = true
          resolve({ items: [], took: 0 })
        }, { once: true })
      }),
    })
    await collect(fanout(registry, budgetPolicy)(makeContext(), parse('x')))
    expect(sawAbort).toBe(true)
  })

  it('预算是整条阶梯的:四级放宽加起来也不许超过一路的 timeoutMs 太多', async () => {
    // 每级都比半个预算略长再答空页:逐级各派生一次的话四级能占到 4 × timeoutMs。
    const timeoutMs = 60
    const perStep = 40
    const registry = createCapabilityRegistry()
    registry.register({
      manifest: makeManifest({ id: 'creeper', budget: { default: 5, timeoutMs } }),
      supports: () => true,
      search: async () => {
        await new Promise(resolve => setTimeout(resolve, perStep))
        return { items: [] as Candidate[], took: perStep }
      },
    })

    const startedAt = Date.now()
    const groups = await collect(fanout(registry, budgetPolicy)(makeContext(), parse('a b c d')))
    const elapsed = Date.now() - startedAt

    expect(groups).toHaveLength(1)
    expect(groups[0]!.error).toBe('timeout')
    expect(elapsed).toBeLessThan(2 * timeoutMs)
  })

  it('按能力各自逐级试:一路放宽到 ③ 不影响另一路停在 ①', async () => {
    // strict 那一路第一级就有结果;picky 那一路只有放宽之后才有。
    const strict: SearchCapability = {
      manifest: makeManifest({ id: 'strict' }),
      supports: () => true,
      search: async query => ({ items: [candidate('always')], took: 0, relaxed: query.ladder?.level }),
    }
    const picky: SearchCapability = {
      manifest: makeManifest({ id: 'picky' }),
      supports: () => true,
      search: async query => ({
        items: (query.ladder?.level ?? 0) >= 2 ? [candidate('late')] : [],
        took: 0,
      }),
    }
    const registry = createCapabilityRegistry()
    registry.register(strict)
    registry.register(picky)

    const groups = await collect(fanout(registry, budgetPolicy)(makeContext(), parse('a b c d')))
    const byId = new Map(groups.map(group => [group.capability, group]))
    expect(byId.get('strict')!.page!.relaxed).toBe(0)
    expect(byId.get('picky')!.page!.relaxed).toBe(2)
  })

  it('relax:false 的能力只被问一次', async () => {
    const search = vi.fn(async () => ({ items: [] as Candidate[], took: 0 }))
    const registry = createCapabilityRegistry()
    registry.register({
      manifest: makeManifest({ id: 'once', relax: false }),
      supports: () => true,
      search,
    })
    await collect(fanout(registry, budgetPolicy)(makeContext(), parse('a b c')))
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('supports 说不参与就不问它', async () => {
    const search = vi.fn(async () => ({ items: [] as Candidate[], took: 0 }))
    const registry = createCapabilityRegistry()
    registry.register({ manifest: makeManifest({ id: 'shy' }), supports: () => false, search })
    expect(await collect(fanout(registry, budgetPolicy)(makeContext(), parse('a')))).toEqual([])
    expect(search).not.toHaveBeenCalled()
  })

  it('surfaces 声明把这一路挡在别的消费面外', async () => {
    const registry = createCapabilityRegistry()
    registry.register({
      manifest: makeManifest({ id: 'narrow', surfaces: ['other'] }),
      supports: () => true,
      search: async () => ({ items: [candidate('n')], took: 0 }),
    })
    expect(await collect(fanout(registry, budgetPolicy)(makeContext(), parse('a')))).toEqual([])
  })

  it('预算读的是各自的 manifest,函数里没有能力名', () => {
    const capabilities = [
      { manifest: makeManifest({ id: 'x', budget: { default: 6, timeoutMs: 100, whenIntent: { y: 8 } } }) },
      { manifest: makeManifest({ id: 'y', budget: { default: 4, timeoutMs: 100 } }) },
    ] as SearchCapability[]
    const table = budgetPolicy({ ...parse('a'), intent: 'y' }, capabilities)
    expect(table.x!.limit).toBe(8)
    expect(table.y!.limit).toBe(4)
  })
})

describe('RRF 融合', () => {
  it('单路恒等:逐字同一批候选、同一次序、同一份分数', () => {
    const items = [candidate('a', { score: 9 }), candidate('b', { score: 3 })]
    expect(rrfFusion()([{ id: 'lexical', items }])).toEqual(items)
  })

  it('两路融合:两边都靠前的赢', () => {
    const lexical = [candidate('shared'), candidate('lex-only')]
    const vector = [candidate('vec-only'), candidate('shared')]
    const fused = rrfFusion(60)([
      { id: 'lexical', items: lexical },
      { id: 'vector', items: vector },
    ])
    expect(fused[0]!.id).toBe('shared')
    expect(fused.map(item => item.id).sort()).toEqual(['lex-only', 'shared', 'vec-only'])
    // score 换成了 RRF 的分,并且确实是两路之和。
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10)
  })
})

describe('merge / rank / snippet', () => {
  it('全部档按 manifest 的 order 摆,命中意图时用 orderWhenIntent', () => {
    const manifests = [
      makeManifest({ id: 'x', order: 2, orderWhenIntent: { special: 0 } }),
      makeManifest({ id: 'y', order: 1 }),
    ]
    const groups = [{ capability: 'x' }, { capability: 'y' }]
    expect(createGroupMerge(manifests, 'content')(groups).map(group => group.capability)).toEqual(['y', 'x'])
    expect(createGroupMerge(manifests, 'special')(groups).map(group => group.capability)).toEqual(['x', 'y'])
  })

  it('rank:分高在前,同分按时间倒序,再同分按 id 升序', () => {
    const ranked = defaultRanker.rank([
      candidate('b', { score: 1, time: 100 }),
      candidate('a', { score: 1, time: 100 }),
      candidate('c', { score: 1, time: 500 }),
      candidate('d', { score: 9, time: 1 }),
    ], makeContext(), emptyRankingSignals)
    expect(ranked.map(item => item.id)).toEqual(['d', 'c', 'a', 'b'])
  })

  it('rank 的信号提供者缺省是空的(不做个性化)', () => {
    const items = [candidate('a', { score: 1 })]
    expect(defaultRanker.rank(items, makeContext(), emptyRankingSignals)[0]!.score).toBe(1)
  })

  it('snippet 开 120 字窗,区间指原文', () => {
    const normalize = composeNormalizers(DEFAULT_NORMALIZERS)
    const source = `${'前'.repeat(200)}身份牌${'后'.repeat(200)}`
    const normalized = normalize(source)
    const hits = hitRangesFromTokens(
      normalized,
      compositeAnalyzer.analyze(normalized.text).filter(token => token.text === '身份'),
    )
    const snippet = buildSnippet(source, hits, 120)
    expect(snippet.text.length).toBe(120)
    expect(snippet.text).toContain('身份')
    expect(snippet.truncatedStart).toBe(true)
    expect(snippet.truncatedEnd).toBe(true)
    const range = snippet.ranges[0]!
    expect(snippet.text.slice(range.start, range.end)).toBe('身份')
  })

  it('短文本整段给出,不开窗', () => {
    const snippet = buildSnippet('很短', [], 120)
    expect(snippet.text).toBe('很短')
    expect(snippet.truncatedStart).toBe(false)
  })
})

describe('三种基座', () => {
  it('静态型一次全给,cursor 恒缺席', async () => {
    const capability = staticCapability({
      manifest: makeManifest({ id: 'static-one', kind: 'static' }),
      items: ['alpha one', 'alpha two', 'beta'],
      score: (item, query) => (item.includes(query.raw) ? item.length : null),
      toCandidate: (item, score) => candidate(item, { score }),
    })
    const page = await capability.search(parse('alpha'), { limit: 1 }, makeContext())
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(2)
    expect(page.cursor).toBeUndefined()
  })

  it('扫描型续扫:第二页从游标那条的下一条接着扫', async () => {
    const rows = ['r1', 'r2', 'r3', 'r4']
    const capability = scanCapability<string>({
      manifest: makeManifest({ id: 'scan-one', kind: 'scan' }),

      scan: async function* () {
        for (const row of rows) yield row
      },
      match: () => row => candidate(row),
      positionOf: row => row,
    })
    const ctx = makeContext()
    const first = await capability.search(parse('r'), { limit: 2 }, ctx)
    expect(first.items.map(item => item.id)).toEqual(['r1', 'r2'])
    expect(first.cursor).toBeDefined()
    // 扫描型不知道全集多大 —— 不知道就别编。
    expect(first.total).toBeUndefined()

    const second = await capability.search(parse('r'), { limit: 2, cursor: first.cursor }, ctx)
    expect(second.items.map(item => item.id)).toEqual(['r3', 'r4'])
    expect(second.cursor).toBeUndefined()
  })
})

describe('整条流水线', () => {
  it('全部档:每个能力一组,按 order 摆', async () => {
    const primary = makeIndexedCapability(CAP_A, { manifest: { order: 2 } }).capability
    const secondary = makeIndexedCapability(CAP_B, {
      documents: secondaryDocuments(),
      manifest: { order: 1 },
    }).capability
    const { pipeline, registry } = makePipeline([primary, secondary])

    const groups = await collectGroups(
      pipeline.search('身份牌', makeContext()),
      { registry, intent: 'content', capability: ALL_CAPABILITIES },
    )
    expect(groups.map(group => group.capability)).toEqual([CAP_B, CAP_A])
    expect(groups.every(group => (group.page?.items.length ?? 0) > 0)).toBe(true)
  })

  it('单类档:只问那一路', async () => {
    const primary = makeIndexedCapability(CAP_A).capability
    const secondary = makeIndexedCapability(CAP_B, { documents: secondaryDocuments() }).capability
    const { pipeline } = makePipeline([primary, secondary])

    const groups = await collect(pipeline.search('身份牌', makeContext(), { capability: CAP_A }))
    expect(groups.map(group => group.capability)).toEqual([CAP_A])
  })

  it('注销一个能力,它就不再出现在结果里(加一类 = 一行,删一类 = 删那一行)', async () => {
    const registry = createCapabilityRegistry()
    const dispose = registry.register(makeIndexedCapability(CAP_A).capability)
    registry.register(makeIndexedCapability(CAP_B, { documents: secondaryDocuments() }).capability)
    const pipeline = compose({ registry, now: () => CORPUS_NOW })

    expect((await collect(pipeline.search('身份牌', makeContext()))).length).toBe(2)
    dispose()
    const after = await collect(pipeline.search('身份牌', makeContext()))
    expect(after.map(group => group.capability)).toEqual([CAP_B])
  })

  it('相邻命中排在只沾了词的前面,而且都在同一组里', async () => {
    const { capability } = makeIndexedCapability(CAP_A)
    const { pipeline } = makePipeline([capability])
    const groups = await collect(pipeline.search('"身份牌"', makeContext()))
    const items = groups[0]!.page!.items
    expect(items[0]!.id).toBe('a-01')
    expect(items.map(item => item.id)).not.toContain('a-02')
  })

  it('翻页:第二页接得上,不重不漏', async () => {
    const { capability } = makeIndexedCapability(CAP_A, { manifest: { budget: { default: 3, timeoutMs: 200 } } })
    const { pipeline } = makePipeline([capability])
    const ctx = makeContext()

    const first = (await collect(pipeline.search('索引', ctx, { capability: CAP_A })))[0]!.page!
    expect(first.items.length).toBeLessThanOrEqual(3)
    if (first.cursor === undefined) return
    const second = (await collect(pipeline.search('索引', ctx, {
      capability: CAP_A,
      page: { limit: 3, cursor: first.cursor },
    })))[0]!.page!
    const firstIds = new Set(first.items.map(item => item.id))
    expect(second.items.some(item => firstIds.has(item.id))).toBe(false)
  })

  it('manifest.ranking 是数据:boosts 与 pinFieldHit 由能力自述,core 里没有这些词', async () => {
    const withPin = makeIndexedCapability(CAP_A, {
      manifest: { ranking: { pinFieldHit: 'title' } },
    }).capability
    const plain = makeIndexedCapability(CAP_A).capability
    const query: SearchQuery = { ...parse('索引'), ladder: plan(parse('索引'))[0] }
    const ctx = makeContext()

    const pinned = await withPin.search(query, { limit: 10 }, ctx)
    const normal = await plain.search(query, { limit: 10 }, ctx)
    // 标题里有「索引」的那条被顶到第一。
    expect(pinned.items[0]!.title).toContain('索引')
    expect(pinned.items[0]!.score).toBeGreaterThan(normal.items[0]!.score)
  })

  it('半衰是数据:越旧的那条被压得越狠', async () => {
    const decayed = makeIndexedCapability(CAP_A, { manifest: { ranking: { halfLifeDays: 1 } } }).capability
    const plain = makeIndexedCapability(CAP_A).capability
    const query: SearchQuery = { ...parse('身份'), ladder: plan(parse('身份'))[0] }
    const ctx = makeContext()

    const scoreOf = (page: SearchPage, id: string): number =>
      page.items.find(item => item.id === id)?.score ?? 0
    const before = await plain.search(query, { limit: 10 }, ctx)
    const after = await decayed.search(query, { limit: 10 }, ctx)

    // a-01 是当天的,a-03 是两天前的 —— 同一条半衰曲线,旧的那条掉得更多。
    const ratioNew = scoreOf(after, 'a-01') / scoreOf(before, 'a-01')
    const ratioOld = scoreOf(after, 'a-03') / scoreOf(before, 'a-03')
    expect(ratioNew).toBeLessThanOrEqual(1)
    expect(ratioOld).toBeLessThan(ratioNew)
    expect(ratioOld).toBeCloseTo(0.25, 6)
  })
})
