/**
 * `web_search` / `web_open` 的行为金标(R3a 起的对拍 suite,R4b 转成金标 —— 见
 * time.test.ts 的头注释)。
 *
 * 四组夹具:正常 / 边界(去重 + 上限)/ 错误(没有配 provider、抓页失败)/ 取消。
 * 网络全部走注入的假 fetch 与假 provider,一条真请求都不发。
 */

import { describe, expect, it } from 'vitest'
import { Outcome } from '@onething/core/toolkit'
import { zodToJsonSchema } from '../../contract.js'
import type { SearchProvider, SearchResponse } from '../../../tools/builtin/web-search/providers/types.js'
import { createWebSearchTool, WebSearchInputSchema } from '../../builtin/web-search.js'
import { createWebOpenTool, WebOpenInputSchema } from '../../builtin/web-open.js'
import { annotationsOf, modelTextOf, normalizeDetails, partialsOf, runNewTool } from '../support.js'

function fakeProvider(): SearchProvider {
  return {
    id: 'fake',
    name: 'Fake Search',
    isConfigured: () => true,
    async search(query): Promise<SearchResponse> {
      return {
        query,
        provider: 'fake',
        results: [
          { title: `T1 ${query}`, url: 'https://example.com/a', snippet: 's1', publishedDate: '2026-01-01', extraSnippets: ['extra'] },
          { title: `T2 ${query}`, url: 'https://example.com/b', snippet: 's2' },
        ],
      }
    },
  }
}

const HTML = '<html><head><title>Page</title><meta name="description" content="D"></head><body><p>Hello world</p></body></html>'

function fakeFetch(): typeof globalThis.fetch {
  return (async () => new Response(HTML, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })) as unknown as typeof globalThis.fetch
}

function failingFetch(): typeof globalThis.fetch {
  return (async () => { throw new Error('boom') }) as unknown as typeof globalThis.fetch
}

describe('golden: web_search', () => {
  const adapters = () => ({ providers: { fake: fakeProvider() }, getFetch: fakeFetch })

  it('spec 钉住(描述 + JSON schema + 并发档 + 渲染档)', () => {
    const tool = createWebSearchTool(adapters())
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(WebSearchInputSchema))
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.presentation.kind).toBe('search')
    // 新增的静态上界:web_search 会出网。策略表里 `net_fetch` 是 silent,
    // 所以它不会多出一张权限卡(旧值 permissionGuard: 'safe')。
    expect(tool.spec.effects).toEqual(['net_fetch'])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: '正常:单条 query', args: { query: 'onething' } },
    { name: '边界:多 query 去重 + 大小写归一', args: { query: 'a', queries: ['A', ' a ', 'b'] } },
    { name: '边界:抓页(fetchPages + maxPages=1)', args: { query: 'a', fetchPages: true, maxPages: 1 } },
    { name: '边界:count 被夹到 10', args: { query: 'a', count: 10 } },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const run = await runNewTool(createWebSearchTool(adapters()), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')

      // 权限输入:一条 net_fetch,资源就是归一化后的 query 列表
      expect(run.intent.effects.map(effect => effect.kind)).toEqual(['net_fetch'])
      expect(run.intent.effects[0]?.resources.length).toBeGreaterThan(0)
      // 合表后按效果表(2026-09-10):`net_fetch` 是 silent,查一次资料不弹卡。
      // 合表之前判定核另有一份只认 read / ui_change 的名单,这一句是假的。
      expect(run.intent.requiresAuthorization).toBe(false)

      // 渲染信息:两个标题(搜索中 + 结果)与最终 metadata 都在
      expect(annotationsOf(run).map(entry => entry.title)).toMatchSnapshot('annotation titles')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
      // 进度事件仍然存在
      expect(partialsOf(run).length).toMatchSnapshot('partial count')
    })
  }

  it('错误:没有配置任何 provider', async () => {
    const run = await runNewTool(createWebSearchTool({}), { query: 'x' })
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toMatchSnapshot('no provider')
  })

  it('错误:参数不合契约(query 为空)', async () => {
    const run = await runNewTool(createWebSearchTool(adapters()), { query: '' })
    expect(run.outcome.kind).toBe('invalid')
    expect(Outcome.toModelText(run.outcome)).toContain('Invalid arguments')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createWebSearchTool(adapters()), { query: 'x' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})

describe('golden: web_open', () => {
  const adapters = () => ({ getFetch: fakeFetch })

  it('spec 钉住', () => {
    const tool = createWebOpenTool(adapters())
    expect(tool.spec.description).toMatchSnapshot('description')
    expect(tool.spec.input).toEqual(zodToJsonSchema(WebOpenInputSchema))
    expect(tool.spec.concurrency).toBe('parallel')
    expect(tool.spec.effects).toEqual(['net_fetch'])
  })

  const FIXTURES: Array<{ name: string; args: Record<string, unknown>; fetch: () => typeof globalThis.fetch }> = [
    { name: '正常:抓到一页', args: { url: 'https://example.com/a' }, fetch: fakeFetch },
    { name: '边界:带 title/query/snippet 与 maxChars 下限', args: { url: 'https://example.com/a', title: 'T', query: 'q', snippet: 's', maxChars: 1000 }, fetch: fakeFetch },
    { name: '错误:抓页失败(工具仍然正常返回,只是 status 不是 ready)', args: { url: 'https://example.com/a' }, fetch: failingFetch },
  ]

  for (const fixture of FIXTURES) {
    it(`模型文本与渲染信息钉住:${fixture.name}`, async () => {
      const run = await runNewTool(createWebOpenTool({ getFetch: fixture.fetch }), fixture.args)
      expect(run.outcome.kind).toBe('ok')
      expect(modelTextOf(run.outcome)).toMatchSnapshot('model text')
      expect(annotationsOf(run).map(entry => entry.title).at(-1)).toMatchSnapshot('title')
      expect(normalizeDetails(annotationsOf(run).at(-1)?.details)).toMatchSnapshot('metadata')
      expect(partialsOf(run).length).toMatchSnapshot('partial count')
      expect(run.intent.effects.map(effect => effect.resources[0])).toEqual([fixture.args.url])
    })
  }

  it('错误:url 不合契约', async () => {
    const run = await runNewTool(createWebOpenTool(adapters()), { url: 'not-a-url' })
    expect(run.outcome.kind).toBe('invalid')
  })

  it('取消:信号先响,结局恒为 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runNewTool(createWebOpenTool(adapters()), { url: 'https://example.com/a' }, { signal: controller.signal })
    expect(run.outcome.kind).toBe('aborted')
  })
})
