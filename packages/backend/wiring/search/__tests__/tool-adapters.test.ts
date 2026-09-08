/**
 * `search` 工具适配器的**补一发**(09-08 用户裁定;`docs/design/search-index-2026-09.md`
 * §13.x 留账①)。
 *
 * 守的是一句话:**「不挑」那一档里被 `deferred` 掉的组,工具这一路要自己补回来**,
 * 而且补的判据是响应里那格 `deferred`,不是任何一个能力的名字 —— 所以这份夹具里的
 * 能力 id 是 `scan-a` / `scan-b` / `indexed`,故意一个真名都不用:换成别的名字这些
 * 用例逐字照过,才说明适配器真的不认识它们。
 *
 * 服务是一只假的:真索引 / 真流水线那一层由 `search-tool-store.test.ts` 与
 * `gate:search-index` 证,这里量的是**适配器的合并口径**(组序、扁平列表的那一刀、
 * 一组塌了别拖累整发、非 deferred 的组不重发)。
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  OnethingSearchService,
  SearchServiceGroup,
  SearchServiceRequest,
  SearchServiceResponse,
} from '@onething/runtime/search'
import type { SearchToolPrincipal } from '@onething/runtime/toolkit'
import { createAppSearchToolAdapters } from '../tool-adapters.js'

const PRINCIPAL: SearchToolPrincipal = {
  kind: 'agent',
  id: 'a1',
  sessionId: 's-here',
  spaceId: 'space-a',
}

function result(id: string, title = id): SearchServiceResponse['results'][number] {
  return { id, type: 'file', title, target: { kind: 't', payload: { id } } }
}

function group(partial: Partial<SearchServiceGroup> & { capability: string }): SearchServiceGroup {
  return { label: partial.capability, results: [], ...partial }
}

/** 一次「不挑」的总览:一路 scan 被 defer 排在最前(fanout 先出没跑的那些),一路索引型答了。 */
function allOverview(): SearchServiceResponse {
  const groups = [
    group({ capability: 'scan-a', total: 0, results: [], deferred: true }),
    group({ capability: 'indexed', total: 2, results: [result('m-1'), result('m-2')] }),
  ]
  return { success: true, groups, results: groups.flatMap(one => one.results) }
}

/** 单类档的答复(补一发拿到的那一份)。 */
function single(
  results: SearchServiceResponse['results'],
  extra: Partial<SearchServiceResponse> = {},
): SearchServiceResponse {
  return { success: true, results, total: results.length, ...extra }
}

function adaptersOver(query: (
  request: SearchServiceRequest,
) => Promise<SearchServiceResponse> | SearchServiceResponse): {
  adapters: ReturnType<typeof createAppSearchToolAdapters>
  query: ReturnType<typeof vi.fn>
} {
  const spy = vi.fn(async (request: SearchServiceRequest) => await query(request))
  const service = { query: spy, capabilities: () => [] } as unknown as OnethingSearchService
  return { adapters: createAppSearchToolAdapters(service), query: spy }
}

describe('search 工具的 all 档:deferred 的组补一发', () => {
  it('① 被 defer 的那一组补成真结果,组序不变,扁平列表按组序重拼', async () => {
    const { adapters, query } = adaptersOver(request =>
      request.category === 'scan-a'
        ? single([result('f-1'), result('f-2')])
        : allOverview())

    const page = await adapters.search({ query: '蜘蛛纹', limit: 8 }, PRINCIPAL)

    // 组序 = deferred 那一组在前(它就在 groups[0]),所以扁平列表也是它先。
    expect(page.hits.map(hit => hit.ref)).toEqual([
      'scan-a:f-1', 'scan-a:f-2', 'indexed:m-1', 'indexed:m-2',
    ])
    // 归属是按合完之后的 groups 反查出来的,不是从 id 前缀猜的。
    expect(page.hits.map(hit => hit.capability)).toEqual(['scan-a', 'scan-a', 'indexed', 'indexed'])
    // 补的那一发:同词、同 limit,只多一格 category。
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]![0]).toMatchObject({ query: '蜘蛛纹', limit: 8, category: 'scan-a' })
    // 补完就没有「这一次没问它」这件事了。
    expect(page.incomplete).toBeUndefined()
  })

  it('① b 同词同 filters 同 limit —— 会话收窄与时间窗原样带进补的那一发', async () => {
    const { adapters, query } = adaptersOver(request =>
      request.category === 'scan-a' ? single([result('f-1')]) : allOverview())

    await adapters.search(
      { query: 'x', limit: 5, sessionId: 's-here', since: 1000, until: 2000 },
      PRINCIPAL,
    )

    const first = query.mock.calls[0]![0] as SearchServiceRequest
    const second = query.mock.calls[1]![0] as SearchServiceRequest
    expect(second).toEqual({ ...first, category: 'scan-a' })
    expect(second.filters).toEqual({ sessionId: 's-here', time: { gte: 1000, lte: 2000 } })
  })

  it('① c 扁平列表切到本次 limit —— 与服务对全部档那一刀同一条规则', async () => {
    const many = [result('f-1'), result('f-2'), result('f-3')]
    const { adapters } = adaptersOver(request =>
      request.category === 'scan-a' ? single(many) : allOverview())

    const page = await adapters.search({ query: 'x', limit: 4 }, PRINCIPAL)

    expect(page.hits).toHaveLength(4)
    expect(page.hits.map(hit => hit.ref)).toEqual(['scan-a:f-1', 'scan-a:f-2', 'scan-a:f-3', 'indexed:m-1'])
  })

  it('② 补扫只扫到一半:那一组的 partial 透出到工具的末行', async () => {
    const { adapters } = adaptersOver(request =>
      request.category === 'scan-a'
        ? single([result('f-1')], { partial: true })
        : allOverview())

    const page = await adapters.search({ query: 'x', limit: 8 }, PRINCIPAL)

    expect(page.hits.map(hit => hit.ref)).toContain('scan-a:f-1')
    expect(page.incomplete).toEqual([{ capability: 'scan-a', reason: 'partial' }])
  })

  it('③ 补的那一发塌了:只有那一组 error,别的组照常上屏', async () => {
    const groups = [
      group({ capability: 'scan-a', total: 0, results: [], deferred: true }),
      group({ capability: 'scan-b', total: 0, results: [], deferred: true }),
      group({ capability: 'indexed', total: 1, results: [result('m-1')] }),
    ]
    const overview: SearchServiceResponse = {
      success: true, groups, results: groups.flatMap(one => one.results),
    }
    const { adapters, query } = adaptersOver(request => {
      if (request.category === 'scan-a') throw new Error('rg 没起来')
      if (request.category === 'scan-b') return single([result('f-9')])
      return overview
    })

    const page = await adapters.search({ query: 'x', limit: 8 }, PRINCIPAL)

    expect(query).toHaveBeenCalledTimes(3)
    // 塌的那一组没有行,别的两组一条不少 —— 一组塌了不拖累整发。
    expect(page.hits.map(hit => hit.ref)).toEqual(['scan-b:f-9', 'indexed:m-1'])
    expect(page.incomplete).toEqual([{ capability: 'scan-a', reason: 'error' }])
  })

  it('③ b `success:false` 与抛出去是同一件事:这一类没搜成', async () => {
    const { adapters } = adaptersOver(request =>
      request.category === 'scan-a'
        ? { success: false, results: [], error: 'scan-timeout' }
        : allOverview())

    const page = await adapters.search({ query: 'x', limit: 8 }, PRINCIPAL)

    expect(page.hits.map(hit => hit.ref)).toEqual(['indexed:m-1', 'indexed:m-2'])
    expect(page.incomplete).toEqual([{ capability: 'scan-a', reason: 'error' }])
  })

  it('④ 没有 deferred 的组就一发也不多发', async () => {
    const groups = [group({ capability: 'indexed', total: 1, results: [result('m-1')] })]
    const { adapters, query } = adaptersOver(() => ({
      success: true, groups, results: groups.flatMap(one => one.results),
    }))

    const page = await adapters.search({ query: 'x', limit: 8 }, PRINCIPAL)

    expect(query).toHaveBeenCalledTimes(1)
    expect(page.hits.map(hit => hit.ref)).toEqual(['indexed:m-1'])
  })

  it('④ b 单类档(没有 groups)也一发就是一发', async () => {
    const { adapters, query } = adaptersOver(() => single([result('f-1')]))

    const page = await adapters.search({ query: 'x', limit: 8, capability: 'scan-a' }, PRINCIPAL)

    expect(query).toHaveBeenCalledTimes(1)
    expect(page.hits.map(hit => hit.ref)).toEqual(['scan-a:f-1'])
    expect(page.incomplete).toBeUndefined()
  })

  it('单类档只扫到一半:整发那一格 partial 也照实说', async () => {
    const { adapters } = adaptersOver(() => single([result('f-1')], { partial: true }))

    const page = await adapters.search({ query: 'x', limit: 8, capability: 'scan-a' }, PRINCIPAL)

    expect(page.incomplete).toEqual([{ capability: 'scan-a', reason: 'partial' }])
  })

  it('工具的 abort signal 递到 SearchContext —— 整发与补的那一发都吃它', async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const spy = vi.fn(async (request: SearchServiceRequest, context: { signal?: AbortSignal }) => {
      seen.push(context.signal)
      return request.category === 'scan-a' ? single([result('f-1')]) : allOverview()
    })
    const service = { query: spy, capabilities: () => [] } as unknown as OnethingSearchService

    await createAppSearchToolAdapters(service)
      .search({ query: 'x', limit: 8, signal: controller.signal }, PRINCIPAL)

    expect(seen).toEqual([controller.signal, controller.signal])
  })
})
