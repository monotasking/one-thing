/**
 * 六个内置能力(检索重建 S2 包装 + S3b 换索引,
 * `docs/design/search-index-2026-09.md` §4 / §10 S2·S3)。
 *
 * 两半:
 *
 *  - **还在旧路上的那三类**(prompts / actions / files)问的仍是 S2 那句话:
 *    「包装之后,答案与今天那条旧路一模一样」—— 同一份取材面跑两遍再比。这是
 *    `search:parity-A` 那道真库门在单测尺度上的同一个判据。
 *  - **换成索引型的那三类**(chats / messages / daily)问的是另一句话:
 *    「自述说对了没有」+「索引答了一批文档,能力把它们投影成什么」。旧路那条对账
 *    在这三类上**已经不成立、也不该成立**(索引是词与前缀,旧扫描是子串;§13 留账),
 *    差集由 S3c 的 `search:parity-B` 按 ⊇ 判。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES, createCapabilityRegistry } from '@onething/core/search'
import type { IndexedDoc, SearchCapability, SearchQuery } from '@onething/core/search'
import {
  createOnethingSearchRuntimeAdapters,
  type OnethingSearchProvidersAdapters,
} from '../providers.js'
import { executeOnethingSearch } from '../search-runtime.js'
import type { OnethingSearchCategory } from '../ipc-operations.js'
import {
  chatsSearchManifest,
  createBuiltinSearchCapabilities,
  createActionsSearchCapability,
  createChatsSearchCapability,
  createDailySearchCapability,
  createFilesSearchCapability,
  createMessagesSearchCapability,
  createPromptsSearchCapability,
  dailySearchManifest,
  filesSearchManifest,
  legacyScanCapability,
  messagesSearchManifest,
  searchResultOf,
} from '../capabilities/index.js'
import { createSearchContext, OnethingSearchService } from '../service.js'
import { fakeIndexFace } from './fake-index.js'

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

/** 投影器会产的那几份文档(键与 `IndexProjector` 写出来的逐字同名)。 */
function makeDocs(): IndexedDoc[] {
  return [
    {
      docId: 1,
      capability: 'chats',
      key: 's1',
      time: 200,
      facets: { sessionId: 's1', spaceId: '', archived: false, time: 200 },
      fields: { title: 'Alpha notes' },
    },
    {
      docId: 2,
      capability: 'messages',
      key: 's1:m1',
      time: 10,
      facets: { sessionId: 's1', spaceId: '', role: 'user', archived: false, time: 10 },
      fields: { content: 'the alpha thing' },
    },
    {
      docId: 3,
      capability: 'daily',
      key: '2026-09-05.md',
      time: 300,
      facets: { path: '/notes/2026-09-05.md', time: 300 },
      fields: { title: '2026-09-05', content: 'alpha showed up today' },
    },
  ]
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
  // `target` / `facets` / `preview` 是新路多出来的三格(S0 加前两格,S4a 加 `preview`)——
  // parity 只守**旧形**,所以对账前一律剥掉。剥的是键而不是值:内联预览在与不在
  // 都不该让「新旧结果逐字同」这条判据说话。
  return page.items.map(searchResultOf).map(({ target, facets, preview, ...rest }) => {
    void target
    void facets
    void preview
    return rest
  })
}

/**
 * 仍走旧扫描 / 静态表的那三类。chats / messages / daily 换索引之后**不在这张表里**
 * —— 拿旧扫描去对账一条索引路,对的是两种不同的匹配语义。
 */
const LEGACY_CASES: Array<{
  category: OnethingSearchCategory
  create(adapters: OnethingSearchProvidersAdapters): SearchCapability
  query: string
}> = [
  { category: 'prompts', create: createPromptsSearchCapability, query: 'alpha' },
  { category: 'actions', create: createActionsSearchCapability, query: 'chat' },
  { category: 'files', create: createFilesSearchCapability, query: 'alpha' },
]

describe('内置检索能力(S2 包装:仍在旧路上的三类)', () => {
  for (const testCase of LEGACY_CASES) {
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

  it('supports:五类无条件参与全部档(旧路对它们是无条件调用的)', () => {
    const adapters = makeAdapters()
    const blank: SearchQuery = {
      raw: '   ',
      ast: { type: 'and', children: [] },
      intent: 'content',
      filters: {},
      capability: ALL_CAPABILITIES,
    }
    for (const create of [
      createPromptsSearchCapability,
      createActionsSearchCapability,
      createFilesSearchCapability,
    ]) {
      expect(create(adapters).supports(blank)).toBe(true)
    }
  })
})

describe('索引型能力(S3b:chats / messages / daily)', () => {
  const blank: SearchQuery = {
    raw: '   ',
    ast: { type: 'and', children: [] },
    intent: 'content',
    filters: {},
    capability: ALL_CAPABILITIES,
  }

  function query(raw: string, capability: string): SearchQuery {
    return { raw, ast: { type: 'and', children: [] }, intent: 'content', filters: {}, capability }
  }

  it('三份自述都说了「我是索引型」:kind / schema / facets / 真预算', () => {
    for (const manifest of [chatsSearchManifest, messagesSearchManifest, dailySearchManifest]) {
      expect(manifest.kind).toBe('indexed')
      // 字段表在自述里 —— 装配层把它递给索引,索引不认识任何能力。
      expect(Object.keys(manifest.schema ?? {}).length).toBeGreaterThan(0)
      for (const spec of Object.values(manifest.schema ?? {})) {
        expect(spec.analyzer).toBe('composite')
        expect(spec.weight).toBeGreaterThan(0)
      }
      // S2 那个 `0`(不设刹车)是给全库扫的临时豁免;换索引之后钉真预算。
      expect(manifest.budget.timeoutMs).toBe(300)
      // 索引型吃放宽阶梯(词与前缀的匹配语义下,放宽是有意义的)。
      expect(manifest.relax).toBeUndefined()
      // 谁能看:用户全可见;agent 那一支是 S6(拍点辛)。
      expect(manifest.visibility?.({ kind: 'user', id: 'local' })).toEqual({})
    }
  })

  it('schema 与 ranking 逐格:权重表与 §6.5 那三格数据', () => {
    expect(chatsSearchManifest.schema).toEqual({
      title: { analyzer: 'composite', weight: 2 },
    })
    // `embed`(S7)只在**正文**那一格上:附件名是文件名不是句子,推理段默认根本
    // 不产(拍点乙 a),会话标题短到向量没意义(§15.4 里 chats 走 'explicit' 的
    // 同一个理由)。这张表是「哪些字段进模型」的唯一产地。
    expect(messagesSearchManifest.schema).toEqual({
      content: { analyzer: 'composite', weight: 1, embed: true },
      attachments: { analyzer: 'composite', weight: 1 },
      reasoning: { analyzer: 'composite', weight: 0.6 },
    })
    expect(dailySearchManifest.schema).toEqual({
      title: { analyzer: 'composite', weight: 2 },
      content: { analyzer: 'composite', weight: 1, embed: true },
    })
    // 向量路什么时候跑(§15.4):数据,不是 if。
    expect(messagesSearchManifest.retrievers).toEqual({ vector: { when: 'relaxed' } })
    expect(dailySearchManifest.retrievers).toEqual({ vector: { when: 'relaxed' } })
    expect(chatsSearchManifest.retrievers)
      .toEqual({ vector: { when: 'explicit', surfaces: ['agent-tool'] } })
    // §6.5:半衰 / 按 facet 值加权 —— 全是**数据**,`role` 这个词只出现在这份自述
    // 里,core 里一个都没有。**没有 `pinFieldHit`**:消息文档没有 `title` 字段,
    // 声明它是一句永不触发的假话(S3b 删)。
    expect(messagesSearchManifest.ranking)
      .toEqual({ halfLifeDays: 30, boosts: { role: { user: 1.1 } } })
    expect(messagesSearchManifest.ranking?.pinFieldHit).toBeUndefined()
    // chats / daily 的照留 —— 它们真有 `title` 字段(见上面那张 schema 表)。
    expect(dailySearchManifest.ranking).toEqual({ pinFieldHit: 'title' })
    for (const manifest of [chatsSearchManifest, dailySearchManifest, messagesSearchManifest]) {
      const pinned = manifest.ranking?.pinFieldHit
      if (pinned !== undefined) expect(Object.keys(manifest.schema ?? {})).toContain(pinned)
    }
  })

  it('facets 与投影器写进 doc_facets 的键逐字同名', () => {
    const keysOf = (manifest: typeof chatsSearchManifest) =>
      (manifest.facets ?? []).map(facet => facet.key)
    expect(keysOf(chatsSearchManifest)).toEqual(['sessionId', 'spaceId', 'archived', 'time'])
    expect(keysOf(messagesSearchManifest))
      .toEqual(['sessionId', 'spaceId', 'role', 'archived', 'time'])
    expect(keysOf(dailySearchManifest)).toEqual(['path', 'time'])

    // 「逐字同名」不是靠眼睛比的:文档里出现的每一个 facet 键都要在自述里。
    const declared = new Map([
      ['chats', new Set(keysOf(chatsSearchManifest))],
      ['messages', new Set(keysOf(messagesSearchManifest))],
      ['daily', new Set(keysOf(dailySearchManifest))],
    ])
    for (const doc of makeDocs()) {
      for (const key of Object.keys(doc.facets)) {
        expect(declared.get(doc.capability)?.has(key)).toBe(true)
      }
    }
  })

  it('空词:messages 不答(索引零命中),chats 答(最近几间会话),daily 整组不出现', () => {
    const index = fakeIndexFace(makeDocs())
    const adapters = makeAdapters()

    // 索引对零词元查询零命中,所以纯索引那一路的自述说的是「有词才问我」。
    const messages = createMessagesSearchCapability(adapters, index)
    expect(messages.supports(blank)).toBe(false)
    expect(messages.supports({ ...blank, raw: 'alpha' })).toBe(true)

    // chats 空词答的不是检索,是「按 updatedAt 取前 N 间」—— 旧壳的空态(S3b)。
    const chats = createChatsSearchCapability(adapters, index)
    expect(chats.supports(blank)).toBe(true)
    // 裸 `/` `>` 归一化之后也是空词,旧路对它们同样答最近几间会话。
    expect(chats.supports({ ...blank, raw: '/' })).toBe(true)
    expect(chats.supports({ ...blank, raw: 'alpha' })).toBe(true)

    // daily 照旧路 `all` 档的 `includeDaily`:空词(含裸 `/`)整组不出现。
    const daily = createDailySearchCapability(adapters, index)
    expect(daily.supports(blank)).toBe(false)
    expect(daily.supports({ ...blank, raw: '>' })).toBe(false)
    expect(daily.supports({ ...blank, raw: 'alpha' })).toBe(true)
  })

  it('messages:候选带旧字段 + target(壳按 target.kind 取渲染器)', async () => {
    const index = fakeIndexFace(makeDocs(), { matched: ['alpha'] })
    const capability = createMessagesSearchCapability(makeAdapters(), index)
    const page = await capability.search(query('alpha', 'messages'), { limit: 5 }, createSearchContext())
    const [result] = page.items.map(searchResultOf)

    expect(result).toMatchObject({
      id: 'msg:s1:m1',
      type: 'message',
      // 标题是摘要(从文档表的正文开窗),不是整条消息。
      title: 'the alpha thing',
      // 副标题是会话名 —— 它不在文档里,从会话列表取(见 indexed.ts 的说明)。
      subtitle: 'Alpha notes',
      detail: 'User message',
      sessionId: 's1',
      messageId: 'm1',
      timestamp: 10,
    })
    expect(result?.target).toEqual({ kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } })
    // 高亮指原文偏移(「alpha」在 "the alpha thing" 里是 [4,9))。
    expect(result?.matchRanges).toEqual([{ start: 4, end: 9 }])
    expect(page.total).toBe(1)
  })

  it('chats:标题来自索引、预览文来自会话列表', async () => {
    const index = fakeIndexFace(makeDocs(), { matched: ['alpha'] })
    const capability = createChatsSearchCapability(makeAdapters(), index)
    const page = await capability.search(query('alpha', 'chats'), { limit: 5 }, createSearchContext())
    const [result] = page.items.map(searchResultOf)

    expect(result).toMatchObject({
      id: 'chat:s1',
      type: 'chat',
      title: 'Alpha notes',
      subtitle: 'about alpha',
      sessionId: 's1',
      timestamp: 200,
    })
    expect(result?.target).toEqual({ kind: 'chat', payload: { sessionId: 's1' } })
  })

  it('daily:filePath 取 facets.path(绝对路径),正文命中时副标题是正文摘要', async () => {
    const index = fakeIndexFace(makeDocs(), { matched: ['alpha'] })
    // `makeAdapters()` 的设置里 `dailyNotes.enabled === false` → 没有笔记根目录 →
    // 「今天那一条」不出现,这一条量的只有索引那一半。
    const capability = createDailySearchCapability(makeAdapters(), index)
    const page = await capability.search(query('alpha', 'daily'), { limit: 5 }, createSearchContext())
    const [result] = page.items.map(searchResultOf)

    expect(result).toMatchObject({
      id: 'daily:/notes/2026-09-05.md',
      type: 'daily',
      title: '2026-09-05',
      subtitle: 'alpha showed up today',
      filePath: '/notes/2026-09-05.md',
      timestamp: 300,
    })
    expect(result?.target).toEqual({ kind: 'daily', payload: { filePath: '/notes/2026-09-05.md' } })
  })

  it('索引不可用时不回退到旧扫描:零结果,不是「另一条路答的结果」(§13)', async () => {
    const empty = fakeIndexFace([])
    const capability = createMessagesSearchCapability(makeAdapters(), empty)
    const page = await capability.search(query('alpha', 'messages'), { limit: 5 }, createSearchContext())
    expect(page.items).toEqual([])
  })
})

/**
 * S3b 补回来的两件「索引在结构上答不出」的事(设计 §10 S3b 落地记录的留账 1 / 2)。
 *
 * 判据不是「像旧路」而是**就是旧路**:chats 空词直接调 `searchChats`,daily 的
 * 「今天那一条」直接调从旧扫描器抽出来的 `resolveDailyTodayShortcut`。所以第一条
 * 用例拿旧路的答案逐字对。
 */
describe('索引答不出的那两件(S3b:空词最近会话 / 今天那一条)', () => {
  function query(raw: string, capability: string): SearchQuery {
    return { raw, ast: { type: 'and', children: [] }, intent: 'content', filters: {}, capability }
  }

  it('chats 空词:与旧路 `searchChats("")` 逐字同(最近几间会话,不走索引)', async () => {
    const adapters = makeAdapters()
    // 索引里**有**一份 chats 文档;空词走的是另一条路,所以它不该出现在答案里。
    const capability = createChatsSearchCapability(adapters, fakeIndexFace(makeDocs()))

    const legacy = await legacyAnswer(adapters, 'chats', '', 20)
    const wrapped = await capabilityAnswer(capability, '', 20)
    expect(wrapped).toEqual(legacy)
    // 空词的答案是「最近几间」而不是「零条」——摘掉那个分支这一行当场红。
    expect(wrapped.length).toBe(2)
    expect(wrapped.map(result => result.id)).toEqual(['chat:s1', 'chat:s2'])
  })

  it('chats 空词:`all` 档的分组里有这一组(命令面板的空态)', async () => {
    const adapters = makeAdapters()
    const service = new OnethingSearchService({ index: fakeIndexFace(makeDocs()) })
    for (const capability of createBuiltinSearchCapabilities(adapters, fakeIndexFace(makeDocs()))) {
      service.register(capability)
    }

    const response = await service.query({ query: '', category: 'all', limit: 20 })
    const chats = response.groups?.find(group => group.capability === 'chats')
    expect(chats?.results.map(result => result.id)).toEqual(['chat:s1', 'chat:s2'])
    // daily 那一组照旧路的 `includeDaily`:空词时整组不出现(不是「有一组 0 条」)。
    expect(response.groups?.some(group => group.capability === 'daily')).toBe(false)
  })

  describe('daily 的「今天那一条」', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function notesAdapters(): { adapters: OnethingSearchProvidersAdapters; notesDir: string } {
      const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-daily-cap-'))
      dirs.push(notesDir)
      const base = makeAdapters()
      return {
        notesDir,
        adapters: {
          ...base,
          getSettings: () => ({ general: { dailyNotes: { enabled: true, useObsidianConfig: false } } }),
          getVariablesStore: () => ({ getUserNoteDir: () => notesDir, getWorkNoteDir: () => undefined }),
        },
      }
    }

    function todayIso(): string {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    it('今天的笔记不存在:多一条「新建今天的日记」,排在**最后**(旧扫描器那只 sort)', async () => {
      const { adapters } = notesAdapters()
      const capability = createDailySearchCapability(adapters, fakeIndexFace(makeDocs(), { matched: ['alpha'] }))
      // 查询要「像今天」才有这一条 —— 判据是旧路的 `todayMatchesQuery`(空词恒真,
      // 有词时按今天的 ISO 日期或 today/daily/日记 那几个词根)。
      const page = await capability.search(query('today', 'daily'), { limit: 5 }, createSearchContext())
      const results = page.items.map(searchResultOf)

      const last = results[results.length - 1]
      expect(last?.title).toBe(`Create today's daily note: ${todayIso()}`)
      expect(last?.actionId).toBe(`create-daily-note:${encodeURIComponent(last?.filePath ?? '')}`)
      expect(last?.target).toEqual({
        kind: 'daily',
        payload: { filePath: last?.filePath, actionId: last?.actionId },
      })
      // 索引答的那一条还在,而且还在前面。
      expect(results[0]?.id).toBe('daily:/notes/2026-09-05.md')
    })

    it('今天的笔记已经存在:那一条变成「打开今天」排在**最前**,并与索引答的同一份去重', async () => {
      const { adapters, notesDir } = notesAdapters()
      const iso = todayIso()
      const todayPath = path.join(notesDir, `${iso}.md`)
      fs.writeFileSync(todayPath, `# ${iso}\n\nalpha\n`)

      // 索引里也有今天这一份(真索引会有)——两条同 filePath,只许出一条。
      const docs = [...makeDocs(), {
        docId: 9,
        capability: 'daily',
        key: `${iso}.md`,
        time: 400,
        facets: { path: todayPath, time: 400 },
        fields: { title: iso, content: 'alpha' },
      }]
      const capability = createDailySearchCapability(adapters, fakeIndexFace(docs, { matched: ['alpha'] }))
      const page = await capability.search(query('today', 'daily'), { limit: 5 }, createSearchContext())
      const results = page.items.map(searchResultOf)

      expect(results[0]?.title).toBe(`Today: ${iso}`)
      expect(results[0]?.filePath).toBe(todayPath)
      expect(results.filter(result => result.filePath === todayPath).length).toBe(1)
    })

    it('查询与今天对不上时一条都不多给(`todayMatchesQuery` 是唯一判据)', async () => {
      const { adapters } = notesAdapters()
      const capability = createDailySearchCapability(adapters, fakeIndexFace(makeDocs(), { matched: ['alpha'] }))
      const page = await capability.search(query('zzz-nothing', 'daily'), { limit: 5 }, createSearchContext())
      expect(page.items.map(searchResultOf).some(result => result.id.startsWith('daily-create:'))).toBe(false)
    })
  })
})

/**
 * **扫描根 `dir`**(S4b 修,设计 §9)。
 *
 * 旧行为:文件那一档搜的是壳 `useSessionCwd()` 那个目录。改读后端之后根变成
 * `getSearchDirs()`(认的是后端 `getCurrentSessionId()` 的工作目录),而 React 壳
 * 从不告诉后端当前会话是谁 —— 于是会话目录下的文件搜不到。把根做成一格 facet
 * 由壳递进来,旧行为就回来了。
 */
describe('files 的扫描根 `dir`(S4b)', () => {
  /** 两个目录各一个文件;`listFiles` 按 cwd 答。 */
  function twoDirAdapters(): OnethingSearchProvidersAdapters {
    return {
      ...makeAdapters(),
      getVariablesStore: () => ({
        getUserNoteDir: () => '/roots/notes',
        getWorkNoteDir: () => undefined,
      }),
      listFiles: ({ cwd }) => ({
        async *[Symbol.asyncIterator]() {
          if (cwd === '/roots/notes') yield 'alpha-note.md'
          if (cwd === '/session/cwd') yield 'alpha-session.ts'
        },
      }),
    }
  }

  const filesQuery = (filters: Record<string, unknown> = {}): SearchQuery => ({
    raw: 'alpha',
    ast: { type: 'and', children: [] },
    intent: 'content',
    capability: 'files',
    filters: filters as SearchQuery['filters'],
  })

  it('自述里有 `dir` 那一格 —— 没有它,fanout 一个键都不会递到这一路上', () => {
    expect(filesSearchManifest.facets).toEqual([{ key: 'dir', type: 'enum' }])
  })

  it('不带 `dir` = 后端自己那张根列表(笔记根),会话目录里那个文件搜不到', async () => {
    const capability = createFilesSearchCapability(twoDirAdapters())
    const page = await capability.search(filesQuery(), { limit: 10 }, createSearchContext())
    expect(page.items.map(item => item.title)).toEqual(['alpha-note.md'])
  })

  it('带 `dir` = **只扫那一个目录**;不在它下面的文件一条都不出现', async () => {
    const capability = createFilesSearchCapability(twoDirAdapters())
    const page = await capability.search(
      filesQuery({ dir: '/session/cwd' }),
      { limit: 10 },
      createSearchContext(),
    )
    expect(page.items.map(item => item.title)).toEqual(['alpha-session.ts'])
  })

  it('`dir` 不是一个字符串(数组 / 区间那几种形)= 当缺席 —— 一次扫只吃一个 cwd', async () => {
    const capability = createFilesSearchCapability(twoDirAdapters())
    const page = await capability.search(
      filesQuery({ dir: ['/a', '/b'] }),
      { limit: 10 },
      createSearchContext(),
    )
    expect(page.items.map(item => item.title)).toEqual(['alpha-note.md'])
  })
})

describe('扫描型的预算(S2:不许多一道刹车)', () => {
  /** 慢到比「原本那个 2000ms 预算」还久的一路扫描。 */
  const SLOW_SCAN_MS = 2500

  function slowFilesCapability() {
    return legacyScanCapability({
      manifest: filesSearchManifest,
      run: async () => {
        await new Promise<void>(resolve => setTimeout(resolve, SLOW_SCAN_MS))
        return [{ id: 'f-slow', type: 'file' as const, title: 'alpha 慢慢来', filePath: '/tmp/alpha' }]
      },
      supports: () => true,
      target: result => ({ kind: 'file', payload: { filePath: result.filePath ?? '' } }),
    })
  }

  it('还在扫描型上的 files:timeoutMs 是 0 —— core 的 deriveSignal 于是一个计时器都不装', () => {
    const manifest = createFilesSearchCapability(makeAdapters()).manifest
    expect(manifest.kind).toBe('scan')
    expect(manifest.budget.timeoutMs).toBe(0)
  })

  it('files:扫 2.5s 也照样出结果,而不是 error: timeout(旧扫描路本来就没有超时)', async () => {
    vi.useFakeTimers()
    try {
      const service = new OnethingSearchService()
      service.register(slowFilesCapability())
      const pending = service.query({ query: 'alpha', category: 'files', limit: 5 })
      // 先放一拍让那只慢扫描把自己的计时器装上,再把时间推过 2.5s。
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(SLOW_SCAN_MS)
      const response = await pending
      // 把 timeoutMs 改回 2000 → 派生信号在 2000ms 掐掉扫描,这一格变成空页 + error:'timeout'。
      expect(response.results.map(result => result.id)).toEqual(['f-slow'])
    } finally {
      vi.useRealTimers()
    }
  })
})
