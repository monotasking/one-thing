/**
 * `notes` 那一类的**第二条召回路**与**行动作**(P5,
 * `docs/design/notes-obsidian-cli-2026-09.md` §4.1 / §4.3)。
 *
 * 四件事各自可证:
 *
 *  ① **什么算「明说要了」**(`looksLikeLiveQuery` / `wantsLiveSearch`)——
 *     普通词永远不跑活检索,这是 R3「搜笔记缺省走索引」在代码里的那一行;
 *  ② **答不上的库交出理由**,而不是答一个空数组冒充「这里没有」;
 *  ③ **两条召回路的候选 id 是同一把尺子**(`note:<绝对路径>`),否则同一篇笔记
 *     在两条路下看起来是两篇 —— 用同一份夹具两边各算一次来证;
 *  ④ **行动作的能力位由库自己答**(`typeof vault.openInApp === 'function'`),
 *     而不是任何一张系统名单。
 */
import { describe, expect, it, vi } from 'vitest'
import type { SearchQuery } from '@onething/core/search'
import { FolderVault } from '../../notes/folder/vault.js'
import { NoteVaultUnavailable, type NoteHit, type NoteVault } from '../../notes/types.js'
import { vaultRelativeKey } from '../index/vault-feed.js'
import {
  LIVE_FILTER_KEY,
  LIVE_RETRIEVER_ID,
  createLiveNotesRetriever,
  createNotesSearchCapability,
  looksLikeLiveQuery,
  notesManifestOf,
  openInAppActionIdOf,
  wantsLiveSearch,
} from '../capabilities/index.js'
import type { NoteTarget } from '../capabilities/index.js'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { createSearchContext } from '../service.js'
import { fakeIndexFace } from './fake-index.js'

/** 一个会答活检索的假库。**只实现真库有的那几个方法**,别的按 `FolderVault` 走。 */
function liveVault(options: {
  id: string
  root: string
  hits?: NoteHit[]
  fail?: NoteVaultUnavailable | Error
  openInApp?: boolean
  onSearch?: (query: string, signal?: AbortSignal) => void
}): NoteVault {
  const base = new FolderVault({ root: options.root, id: options.id })
  const vault: NoteVault = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, {
    system: 'obsidian',
    async liveSearch(query: string, search?: { signal?: AbortSignal }): Promise<NoteHit[]> {
      options.onSearch?.(query, search?.signal)
      if (options.fail !== undefined) throw options.fail
      return options.hits ?? []
    },
  }) as NoteVault
  if (options.openInApp === true) {
    Object.assign(vault, { openInApp: async () => undefined })
  }
  return vault
}

function adaptersWith(vaults: NoteVault[]): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [],
    iterateSessionMessages: () => [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
    getNoteVaults: () => vaults,
    getPrimaryNoteVault: () => null,
  }
}

function queryOf(raw: string, filters: Record<string, unknown> = {}): SearchQuery {
  return {
    raw,
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: filters as SearchQuery['filters'],
    capability: 'notes',
  }
}

describe('looksLikeLiveQuery:什么样的词该去问 app 自己的搜索', () => {
  // 七个操作符 + 属性查询各一例。**一张表,不是七条 it** —— 加一个操作符 =
  // 表里加一行。
  const HITS: Array<[string, string]> = [
    ['tag:', 'tag:项目'],
    ['path:', 'path:Journal/2026'],
    ['file:', 'file:README'],
    ['line:', 'line:(alpha beta)'],
    ['section:', 'section:方案'],
    ['block:', 'block:(a b)'],
    ['task:', 'task:未完成'],
    ['[prop]', '[status]'],
  ]
  for (const [name, raw] of HITS) {
    it(`${name} 是 app 的搜索语法`, () => {
      expect(looksLikeLiveQuery(raw)).toBe(true)
    })
  }

  it('普通词不是 —— 缺省走索引(R3)', () => {
    for (const raw of ['笔记', 'alpha beta', '2026-09-18', 'README.md', 'a [ ] b', 'http://x/y']) {
      expect(looksLikeLiveQuery(raw)).toBe(false)
    }
  })

  it('那颗片自己也算「明说」', () => {
    expect(wantsLiveSearch(queryOf('笔记'))).toBe(false)
    expect(wantsLiveSearch(queryOf('笔记', { [LIVE_FILTER_KEY]: true }))).toBe(true)
    // `false` 与缺席同义 —— 关掉的片不发这一格,发了也一样。
    expect(wantsLiveSearch(queryOf('笔记', { [LIVE_FILTER_KEY]: false }))).toBe(false)
  })
})

describe('notes-live 召回路', () => {
  it('答得出的库交候选,答不上的库交理由(不是空数组)', async () => {
    const good = liveVault({
      id: 'v1',
      root: '/vault-a',
      hits: [{ path: '/vault-a/Journal/2026-09-18.md', matches: [{ line: 3, text: '今天见了 alpha' }] }],
    })
    const bad = liveVault({
      id: 'v2',
      root: '/vault-b',
      fail: new NoteVaultUnavailable('system-not-running', 'v2'),
    })
    const retriever = createLiveNotesRetriever(adaptersWith([good, bad]))
    const outcome = await retriever.collect(queryOf('tag:alpha'), createSearchContext(), 6)

    expect(outcome.items).toHaveLength(1)
    expect(outcome.items[0]?.title).toBe('2026-09-18')
    expect(outcome.items[0]?.subtitle).toBe('今天见了 alpha')
    expect(outcome.skipped).toEqual([
      { vaultId: 'v2', vault: 'vault-b', system: 'Obsidian', reason: 'system-not-running' },
    ])
  })

  it('答不出 `liveSearch` 的库根本不在这条路上(目录库就是这一档)', async () => {
    const plain = new FolderVault({ root: '/plain', id: 'v0' })
    const retriever = createLiveNotesRetriever(adaptersWith([plain]))
    const outcome = await retriever.collect(queryOf('tag:alpha'), createSearchContext(), 6)
    expect(outcome).toEqual({ items: [], skipped: [] })
  })

  it('别的错(超时 / CLI 说错话)也如实说一句,不装成「这里没有」', async () => {
    const boom = liveVault({ id: 'v1', root: '/vault-a', fail: new Error('search:context timed out') })
    const retriever = createLiveNotesRetriever(adaptersWith([boom]))
    const outcome = await retriever.collect(queryOf('tag:alpha'), createSearchContext(), 6)
    expect(outcome.skipped).toEqual([
      { vaultId: 'v1', vault: 'vault-a', system: 'Obsidian', reason: 'failed' },
    ])
  })

  it('换词那一下整发被撤:一句解释都不必说', async () => {
    const controller = new AbortController()
    const slow = liveVault({
      id: 'v1',
      root: '/vault-a',
      fail: new Error('aborted'),
      onSearch: () => controller.abort(),
    })
    const retriever = createLiveNotesRetriever(adaptersWith([slow]))
    const outcome = await retriever.collect(
      queryOf('tag:alpha'),
      { ...createSearchContext(), signal: controller.signal },
      6,
    )
    expect(outcome).toEqual({ items: [], skipped: [] })
  })

  it('信号递到库手上(换词即 kill 的那条线的这一端)', async () => {
    const seen: Array<AbortSignal | undefined> = []
    const vault = liveVault({
      id: 'v1',
      root: '/vault-a',
      onSearch: (_query, signal) => seen.push(signal),
    })
    await createLiveNotesRetriever(adaptersWith([vault]))
      .collect(queryOf('tag:alpha'), createSearchContext(), 6)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })

  it('召回器 id 是 `notes-live` —— 自述里不点任何一个笔记系统的名字', () => {
    expect(createLiveNotesRetriever(adaptersWith([])).id).toBe(LIVE_RETRIEVER_ID)
    expect(LIVE_RETRIEVER_ID).not.toContain('obsidian')
  })
})

describe('两条召回路是同一把尺子', () => {
  /**
   * **同一份夹具两边各算一次**:活检索那一条候选的 id / 出处,与索引那一条从
   * `VaultFeed` 的 key 算出来的逐字相同。两边分家了这一条当场红。
   */
  it('候选 id = `note:<绝对路径>`,出处 = 库相对 posix 路径', async () => {
    const root = '/vault-a'
    const absolute = '/vault-a/Journal/2026-09-18.md'
    const vault = liveVault({ id: 'v1', root, hits: [{ path: absolute, matches: [] }] })
    const outcome = await createLiveNotesRetriever(adaptersWith([vault]))
      .collect(queryOf('tag:alpha'), createSearchContext(), 6)

    expect(outcome.items[0]?.id).toBe(`note:${absolute}`)
    // 没有命中行时出处退到库相对名 —— 与索引那一路的 `doc.key` 同一个产地。
    expect(outcome.items[0]?.subtitle).toBe(vaultRelativeKey(root, absolute))
    expect(outcome.items[0]?.subtitle).toBe('Journal/2026-09-18.md')
    expect(outcome.items[0]?.facets).toEqual({ path: absolute, vault: 'v1' })
  })
})

describe('自述:有活检索路才摆得出那一格', () => {
  it('一个库答得出 `liveSearch` → `live` 那一格出现;都答不出 → 整格不画', () => {
    const plain = new FolderVault({ root: '/plain', id: 'v0' })
    const withLive = liveVault({ id: 'v1', root: '/vault-a' })
    const keysOf = (vaults: NoteVault[]): string[] =>
      (notesManifestOf(adaptersWith(vaults)).facets ?? []).map(facet => facet.key)

    expect(keysOf([plain])).toEqual(['vault', 'path', 'time', 'daily'])
    expect(keysOf([plain, withLive])).toEqual(['vault', 'path', 'time', 'daily', 'live'])
  })
})

describe('能力:这一次跑不跑活检索', () => {
  function capabilityWith(vault: NoteVault) {
    const adapters = adaptersWith([vault])
    return createNotesSearchCapability(adapters, fakeIndexFace([]))
  }

  it('普通词:一个库都不问(缺省走索引,R3)', async () => {
    const asked = vi.fn()
    const vault = liveVault({ id: 'v1', root: '/vault-a', onSearch: asked })
    await capabilityWith(vault).search(queryOf('笔记'), { limit: 6 }, createSearchContext())
    expect(asked).not.toHaveBeenCalled()
  })

  it('带操作符的词:问,而且问的是**原词**(操作符不许被洗掉)', async () => {
    const asked = vi.fn()
    const vault = liveVault({ id: 'v1', root: '/vault-a', onSearch: asked })
    await capabilityWith(vault).search(queryOf('tag:项目'), { limit: 6 }, createSearchContext())
    expect(asked).toHaveBeenCalledWith('tag:项目', expect.anything())
  })

  it('那颗片打开:问;而且**控制位不进索引**(不然词法那一路当场零命中)', async () => {
    const asked = vi.fn()
    const vault = liveVault({ id: 'v1', root: '/vault-a', onSearch: asked })
    const index = fakeIndexFace([])
    const seen: Array<Record<string, unknown>> = []
    const spy = {
      ...index,
      search: async (request: Parameters<typeof index.search>[0]) => {
        seen.push((request.filters ?? {}) as Record<string, unknown>)
        return await index.search(request)
      },
    }
    const capability = createNotesSearchCapability(adaptersWith([vault]), spy)
    await capability.search(
      queryOf('笔记', { [LIVE_FILTER_KEY]: true }),
      { limit: 6 },
      createSearchContext(),
    )
    expect(asked).toHaveBeenCalledOnce()
    expect(seen[0]).not.toHaveProperty(LIVE_FILTER_KEY)
  })

  it('答不上的库 → 页上一条提示(`kind: notice`),不是一条动作', async () => {
    const vault = liveVault({
      id: 'v1',
      root: '/vault-a',
      fail: new NoteVaultUnavailable('vault-not-open', 'v1'),
    })
    const page = await capabilityWith(vault)
      .search(queryOf('tag:alpha'), { limit: 6 }, createSearchContext())
    expect(page.actions).toEqual([{
      id: 'notes-live:vault-not-open:v1',
      kind: 'notice',
      capability: 'notes',
      labelKey: 'search.notice.liveVaultNotOpen',
      params: { system: 'Obsidian', vault: 'vault-a' },
    }])
  })

  it('活检索的命中并进这一页(RRF);零命中时这一页逐字不变', async () => {
    const hit = { path: '/vault-a/Journal/2026-09-18.md', matches: [{ line: 1, text: 'alpha' }] }
    const answering = liveVault({ id: 'v1', root: '/vault-a', hits: [hit] })
    const silent = liveVault({ id: 'v1', root: '/vault-a', hits: [] })

    const withHit = await capabilityWith(answering)
      .search(queryOf('tag:alpha'), { limit: 6 }, createSearchContext())
    expect(withHit.items.map(item => item.id)).toEqual([`note:${hit.path}`])

    const without = await capabilityWith(silent)
      .search(queryOf('tag:alpha'), { limit: 6 }, createSearchContext())
    expect(without.items).toEqual([])
  })
})

describe('行动作:在它自己的 app 里打开', () => {
  const doc = {
    docId: 1,
    capability: 'notes',
    key: 'Journal/2026-09-18.md',
    time: 300,
    facets: { path: '/vault-a/Journal/2026-09-18.md', time: 300, vault: 'v1', daily: true },
    fields: { title: '2026-09-18', content: 'alpha' },
  }

  async function firstTarget(vault: NoteVault): Promise<NoteTarget> {
    const capability = createNotesSearchCapability(adaptersWith([vault]), fakeIndexFace([doc]))
    const page = await capability.search(queryOf('alpha'), { limit: 6 }, createSearchContext())
    return page.items[0]?.target as NoteTarget
  }

  it('库答得出 `openInApp` → 那一格能力位在场,且编着这一篇的路径', async () => {
    const target = await firstTarget(liveVault({ id: 'v1', root: '/vault-a', openInApp: true }))
    expect(target.payload.openInAppActionId).toBe(openInAppActionIdOf(doc.facets.path))
    expect(target.payload.openInAppActionId).toContain(encodeURIComponent(doc.facets.path))
  })

  it('库答不出 → 整格缺席(目录库就是这一档);判据是库自己,不是系统名单', async () => {
    const target = await firstTarget(new FolderVault({ root: '/vault-a', id: 'v1' }))
    expect(target.payload.openInAppActionId).toBeUndefined()
  })

  it('按下去 = 那个库的 `openInApp(路径, { mayLaunch: true })`', async () => {
    const opened: Array<[string, unknown]> = []
    const vault = liveVault({ id: 'v1', root: '/vault-a' })
    Object.assign(vault, {
      openInApp: async (target: string, options: unknown) => { opened.push([target, options]) },
    })
    const capability = createNotesSearchCapability(adaptersWith([vault]), fakeIndexFace([doc]))
    await capability.invoke!(openInAppActionIdOf(doc.facets.path), [], createSearchContext())
    expect(opened).toEqual([[doc.facets.path, { mayLaunch: true }]])
  })

  it('路径不在任何一个库里 → 抛,不去猜一个库', async () => {
    const vault = liveVault({ id: 'v1', root: '/vault-a', openInApp: true })
    const capability = createNotesSearchCapability(adaptersWith([vault]), fakeIndexFace([doc]))
    await expect(capability.invoke!(openInAppActionIdOf('/etc/passwd'), [], createSearchContext()))
      .rejects.toThrow(/no note vault contains/)
  })
})
