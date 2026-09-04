/**
 * 六个内置能力(检索重建 S2,`docs/design/search-index-2026-09.md` §4 / §10 S2)。
 *
 * 每一条问的都是同一句话:**包装之后,答案与今天那条旧路一模一样**。所以每一类都
 * 拿同一份取材面跑两遍 —— 一遍 `executeOnethingSearch`(旧),一遍能力(新)——
 * 再比结果。这是 `search:parity-A` 那道真库门在单测尺度上的同一个判据。
 */
import { describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES, createCapabilityRegistry } from '@onething/core/search'
import type { SearchCapability, SearchQuery } from '@onething/core/search'
import {
  createOnethingSearchRuntimeAdapters,
  type OnethingSearchProvidersAdapters,
} from '../providers.js'
import { executeOnethingSearch } from '../search-runtime.js'
import type { OnethingSearchCategory } from '../ipc-operations.js'
import {
  createActionsSearchCapability,
  createChatsSearchCapability,
  createDailySearchCapability,
  createFilesSearchCapability,
  createMessagesSearchCapability,
  createPromptsSearchCapability,
  legacyScanCapability,
  messagesSearchManifest,
  searchResultOf,
} from '../capabilities/index.js'
import { createSearchContext, OnethingSearchService } from '../service.js'

function makeAdapters(): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [
      { id: 's1', name: 'Alpha notes', previewText: 'about alpha', updatedAt: 200 },
      { id: 's2', name: 'Beta log', previewText: 'nothing here', updatedAt: 100 },
    ],
    iterateSessionMessages: sessionId => sessionId === 's1'
      ? [
        { id: 'm1', role: 'user', content: 'the alpha thing', timestamp: 10 },
        { id: 'm2', role: 'assistant', content: 'more alpha please', timestamp: 20 },
      ]
      : [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getSettings: () => ({ general: { dailyNotes: { enabled: false } } }),
    getVariablesStore: () => ({
      getUserNoteDir: () => undefined,
      getWorkNoteDir: () => undefined,
    }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [
      { id: 'p1', title: 'Alpha prompt', description: 'about alpha', body: 'body', updatedAt: 5 },
    ],
  }
}

/** 旧路那一档的答案(单类档 = `adapters.searchX(query, limit)` 那一刀)。 */
function legacyAnswer(
  adapters: OnethingSearchProvidersAdapters,
  category: OnethingSearchCategory,
  query: string,
  limit: number,
) {
  return executeOnethingSearch(query, category, limit, createOnethingSearchRuntimeAdapters(adapters))
}

async function capabilityAnswer(capability: SearchCapability, query: string, limit: number) {
  const registry = createCapabilityRegistry()
  registry.register(capability)
  const parsed: SearchQuery = {
    raw: query,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: capability.manifest.id,
  }
  const page = await capability.search(parsed, { limit }, createSearchContext())
  return page.items.map(searchResultOf).map(({ target, facets, ...rest }) => {
    void target
    void facets
    return rest
  })
}

const CASES: Array<{
  category: OnethingSearchCategory
  create(adapters: OnethingSearchProvidersAdapters): SearchCapability
  query: string
}> = [
  { category: 'chats', create: createChatsSearchCapability, query: 'alpha' },
  { category: 'messages', create: createMessagesSearchCapability, query: 'alpha' },
  { category: 'prompts', create: createPromptsSearchCapability, query: 'alpha' },
  { category: 'actions', create: createActionsSearchCapability, query: 'chat' },
  { category: 'files', create: createFilesSearchCapability, query: 'alpha' },
  { category: 'daily', create: createDailySearchCapability, query: 'alpha' },
]

describe('内置检索能力(S2 包装)', () => {
  for (const testCase of CASES) {
    it(`${testCase.category}:manifest 自述完整,且答案与旧路逐字同`, async () => {
      const adapters = makeAdapters()
      const capability = testCase.create(adapters)
      const manifest = capability.manifest

      // manifest 形:id 沿用今天的 category(S5 之前不改名),预算与次序都在自述里。
      expect(manifest.id).toBe(testCase.category)
      expect(manifest.labelKey).toBe(`search.capability.${testCase.category}`)
      expect(manifest.budget.default).toBeGreaterThan(0)
      // 扫描型不设超时(旧扫描路一道刹车也没有,S2 行为零变化);静态型是内存表,
      // 2000 这个数永远碰不到,留着当 S3 的形。
      expect(manifest.budget.timeoutMs).toBe(manifest.kind === 'scan' ? 0 : 2000)
      expect(manifest.order).toBeGreaterThan(0)
      // scan / static / remote 型不吃放宽阶梯(§6.2 末句)。
      expect(manifest.relax).toBe(false)

      const legacy = await legacyAnswer(adapters, testCase.category, testCase.query, 20)
      const wrapped = await capabilityAnswer(capability, testCase.query, 20)
      expect(wrapped).toEqual(legacy)
    })
  }

  it('supports:daily 空词不参与全部档 —— 旧路那个 includeDaily 的 if 变成了它自己的话', () => {
    const adapters = makeAdapters()
    const daily = createDailySearchCapability(adapters)
    const blank: SearchQuery = {
      raw: '   ',
      ast: { type: 'and', children: [] },
      intent: 'content',
      filters: {},
      capability: ALL_CAPABILITIES,
    }
    expect(daily.supports(blank)).toBe(false)
    expect(daily.supports({ ...blank, raw: 'alpha' })).toBe(true)
    // 其余五类无条件参与(旧路 `all` 档对它们是无条件调用的)。
    for (const create of [
      createChatsSearchCapability,
      createMessagesSearchCapability,
      createPromptsSearchCapability,
      createActionsSearchCapability,
      createFilesSearchCapability,
    ]) {
      expect(create(adapters).supports(blank)).toBe(true)
    }
  })

  it('候选带着目标形回来:壳按 target.kind 取渲染器(§4.1)', async () => {
    const adapters = makeAdapters()
    const messages = createMessagesSearchCapability(adapters)
    const page = await messages.search(
      { raw: 'alpha', ast: { type: 'and', children: [] }, intent: 'content', filters: {}, capability: 'messages' },
      { limit: 5 },
      createSearchContext(),
    )
    expect(page.items[0]?.target).toEqual({
      kind: 'message',
      payload: { sessionId: 's1', messageId: 'm1' },
    })
  })
})

describe('扫描型的预算(S2:不许多一道刹车)', () => {
  /** 慢到比「原本那个 2000ms 预算」还久的一路扫描。 */
  const SLOW_SCAN_MS = 2500

  function slowMessagesCapability() {
    return legacyScanCapability({
      manifest: messagesSearchManifest,
      run: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, SLOW_SCAN_MS))
        return [{ id: 'm-slow', type: 'message' as const, title: 'alpha 慢慢来', sessionId: 's1', messageId: 'm-slow' }]
      },
      supports: () => true,
      target: result => ({ kind: 'message', payload: { sessionId: result.sessionId ?? '', messageId: result.messageId ?? '' } }),
    })
  }

  it('四个扫描型 manifest 的 timeoutMs 是 0 —— core 的 deriveSignal 于是一个计时器都不装', () => {
    const adapters = makeAdapters()
    for (const create of [
      createChatsSearchCapability,
      createMessagesSearchCapability,
      createFilesSearchCapability,
      createDailySearchCapability,
    ]) {
      const manifest = create(adapters).manifest
      expect(manifest.kind).toBe('scan')
      expect(manifest.budget.timeoutMs).toBe(0)
    }
  })

  it('messages:扫 2.5s 也照样出结果,而不是 error: timeout(旧扫描路本来就没有超时)', async () => {
    vi.useFakeTimers()
    try {
      const service = new OnethingSearchService()
      service.register(slowMessagesCapability())
      const pending = service.query({ query: 'alpha', category: 'messages', limit: 5 })
      // 先放一拍让那只慢扫描把自己的计时器装上,再把时间推过 2.5s。
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(SLOW_SCAN_MS)
      const response = await pending
      // 把 timeoutMs 改回 2000 → 派生信号在 2000ms 掐掉扫描,这一格变成空页 + error:'timeout'。
      expect(response.results.map(result => result.id)).toEqual(['m-slow'])
    } finally {
      vi.useRealTimers()
    }
  })
})
