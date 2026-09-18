/**
 * 六个内置能力(检索重建 S2 包装 + S3b 换索引 + S5 收回各自的匹配器,
 * `docs/design/search-index-2026-09.md` §4 / §10 S2·S3·S5)。
 *
 * 两半:
 *
 *  - **静态 / 扫描那三类**(prompts / actions / files)问的是「自述完整」+「匹配器
 *    答什么」。S5 之前这里拿旧扫描路跑第二遍来对账;旧路删了之后参照物换成
 *    **期望值本身**——匹配器就是这三个文件里的那份代码,没有第二份可比。
 *  - **索引型那三类**(chats / messages / notes)问的是「自述说对了没有」+
 *    「索引答了一批文档,能力把它们投影成什么」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_CAPABILITIES, createCapabilityRegistry } from '@onething/core/search'
import type { IndexedDoc, SearchCapability, SearchQuery } from '@onething/core/search'
import type { OnethingSearchProvidersAdapters } from '../providers.js'
import { FolderVault } from '../../notes/folder/vault.js'
import {
  chatsSearchManifest,
  createBuiltinSearchCapabilities,
  createActionsSearchCapability,
  createChatsSearchCapability,
  createNotesSearchCapability,
  createFilesSearchCapability,
  createMessagesSearchCapability,
  createPromptsSearchCapability,
  notesManifestOf,
  notesSearchManifest,
  sanitizeNoteFileName,
  todayMatchesQuery,
  filesSearchManifest,
  messagesSearchManifest,
  scanBackedCapability,
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
    getVariablesStore: () => ({
      getUserNoteDir: () => undefined,
      getWorkNoteDir: () => undefined,
    }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [
      { id: 'p1', title: 'Alpha prompt', description: 'about alpha', body: 'body', updatedAt: 5 },
    ],
    // 一个库在册(`notes` 的 `supports` 问的就是它),但**没有主库** —— 于是
    // 「今天那一条」与「新建笔记」都不出现,这一批用例量的只有索引那一半。
    getNoteVaults: () => [new FolderVault({ root: '/notes', id: 'v1' })],
    getPrimaryNoteVault: () => null,
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
      capability: 'notes',
      key: '2026-09-05.md',
      time: 300,
      facets: { path: '/notes/2026-09-05.md', time: 300, vault: 'v1', daily: true },
      fields: { title: '2026-09-05', content: 'alpha showed up today' },
    },
  ]
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
    // `target` / `facets` / `preview` 是能力多说的三格,与「这一条结果长什么样」
    // 无关,所以断言前一律剥掉;它们各有自己的用例。
    void target
    void facets
    void preview
    return rest
  })
}

/** 静态 / 扫描那三类。 */
const SCAN_CASES: Array<{
  id: string
  create(adapters: OnethingSearchProvidersAdapters): SearchCapability
  query: string
  expected: Array<Record<string, unknown>>
}> = [
  {
    id: 'prompts',
    create: createPromptsSearchCapability,
    query: 'alpha',
    expected: [{
      id: 'prompt:p1',
      type: 'prompt',
      title: 'Alpha prompt',
      subtitle: 'about alpha',
      detail: 'Prompt',
      actionId: 'insert-prompt:p1',
      timestamp: 5,
      matchRanges: [{ start: 0, end: 5 }],
    }],
  },
  {
    id: 'actions',
    create: createActionsSearchCapability,
    query: 'chat',
    expected: [
      {
        id: 'action:new-chat',
        type: 'action',
        title: 'New Chat',
        subtitle: 'chat · conversation · create',
        actionId: 'new-chat',
        shortcut: '⌘N',
        matchRanges: [{ start: 4, end: 8 }],
      },
      {
        id: 'action:close-chat',
        type: 'action',
        title: 'Close Chat',
        subtitle: 'delete · remove',
        actionId: 'close-chat',
        matchRanges: [{ start: 6, end: 10 }],
      },
    ],
  },
  // `makeAdapters()` 的 `listFiles` 一个文件都不吐,所以这一类答空 —— 空词与
  // 「扫得到但不命中」在结果上是同一件事,而扫盘那一半有它自己的用例(下面
  // 「files 的扫描根 `dir`」那一组)。
  { id: 'files', create: createFilesSearchCapability, query: 'alpha', expected: [] },
]

describe('内置检索能力(静态 / 扫描那三类)', () => {
  for (const testCase of SCAN_CASES) {
    it(`${testCase.id}:manifest 自述完整,匹配器答的就是这几条`, async () => {
      const adapters = makeAdapters()
      const capability = testCase.create(adapters)
      const manifest = capability.manifest

      // manifest 形:id 就是壳与 CLI 认的那个名字,预算与次序都在自述里。
      expect(manifest.id).toBe(testCase.id)
      expect(manifest.labelKey).toBe(`search.capability.${testCase.id}`)
      expect(manifest.budget.default).toBeGreaterThan(0)
      /*
       * 扫描型 3000ms(09-07 事故第二/三条修:从前是 `0` = 不设限,真机上换来
       * 「一次搜索永不落地」);静态型是内存表,2000 这个数永远碰不到。
       * 钉预算不再等于把慢盘判死 —— 超时那一刻它交已扫到的部分并标 `partial`
       * (见下面「扫描型的预算」那一组)。
       */
      expect(manifest.budget.timeoutMs).toBe(manifest.kind === 'scan' ? 3000 : 2000)
      expect(manifest.order).toBeGreaterThan(0)
      // scan / static / remote 型不吃放宽阶梯(§6.2 末句)。
      expect(manifest.relax).toBe(false)

      expect(await capabilityAnswer(capability, testCase.query, 20)).toEqual(testCase.expected)
    })
  }

  it('supports:三类无条件参与全部档(`all` 档的分组里恒有它们那一格)', () => {
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

describe('索引型能力(S3b:chats / messages / notes)', () => {
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
    for (const manifest of [chatsSearchManifest, messagesSearchManifest, notesSearchManifest]) {
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
    expect(notesSearchManifest.schema).toEqual({
      title: { analyzer: 'composite', weight: 2 },
      content: { analyzer: 'composite', weight: 1, embed: true },
    })
    // 向量路什么时候跑(§15.4):数据,不是 if。
    expect(messagesSearchManifest.retrievers).toEqual({ vector: { when: 'relaxed' } })
    expect(notesSearchManifest.retrievers).toEqual({ vector: { when: 'relaxed' } })
    expect(chatsSearchManifest.retrievers)
      .toEqual({ vector: { when: 'explicit', surfaces: ['agent-tool'] } })
    // §6.5:半衰 / 按 facet 值加权 —— 全是**数据**,`role` 这个词只出现在这份自述
    // 里,core 里一个都没有。**没有 `pinFieldHit`**:消息文档没有 `title` 字段,
    // 声明它是一句永不触发的假话(S3b 删)。
    expect(messagesSearchManifest.ranking)
      .toEqual({ halfLifeDays: 30, boosts: { role: { user: 1.1 } } })
    expect(messagesSearchManifest.ranking?.pinFieldHit).toBeUndefined()
    // chats / notes 的照留 —— 它们真有 `title` 字段(见上面那张 schema 表)。
    expect(notesSearchManifest.ranking).toEqual({ pinFieldHit: 'title' })
    for (const manifest of [chatsSearchManifest, notesSearchManifest, messagesSearchManifest]) {
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
    // P2:`vault`(哪个库)与 `daily`(日记文件夹里的那一篇)是新的两格。
    expect(keysOf(notesSearchManifest)).toEqual(['vault', 'path', 'time', 'daily'])
    // `vault` 那一格的 enum 值**现算**:库表变了自述跟着变(core 的
    // `FacetDeclaration.values?` 本来就是可选数组,一个字没改)。
    expect(notesSearchManifest.facets?.find(facet => facet.key === 'vault')?.values)
      .toBeUndefined()
    expect(notesManifestOf(makeAdapters()).facets)
      .toEqual([
        { key: 'vault', type: 'enum', values: ['v1'] },
        { key: 'path', type: 'enum' },
        { key: 'time', type: 'range' },
        { key: 'daily', type: 'boolean' },
      ])

    // **能力交出去的那份自述也是现算的**,不是装配那一刻的快照:壳画过滤片读的
    // 就是它,而库表会跟着设置与宿主信任状态变。把 `get manifest()` 改回一个
    // 常量,这一行当场红。
    let vaults = [new FolderVault({ root: '/notes', id: 'v1' })]
    const live = createNotesSearchCapability(
      { ...makeAdapters(), getNoteVaults: () => vaults, getPrimaryNoteVault: () => null },
      fakeIndexFace([]),
    )
    const vaultValues = (): unknown =>
      live.manifest.facets?.find(facet => facet.key === 'vault')?.values
    expect(vaultValues()).toEqual(['v1'])
    vaults = [...vaults, new FolderVault({ root: '/other', id: 'v2' })]
    expect(vaultValues()).toEqual(['v1', 'v2'])

    // 「逐字同名」不是靠眼睛比的:文档里出现的每一个 facet 键都要在自述里。
    const declared = new Map([
      ['chats', new Set(keysOf(chatsSearchManifest))],
      ['messages', new Set(keysOf(messagesSearchManifest))],
      ['notes', new Set(keysOf(notesSearchManifest))],
    ])
    for (const doc of makeDocs()) {
      for (const key of Object.keys(doc.facets)) {
        expect(declared.get(doc.capability)?.has(key)).toBe(true)
      }
    }
  })

  it('空词:messages 不答(索引零命中),chats 答(最近几间会话),notes 整组不出现', () => {
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

    // notes 照旧路 `all` 档的 `includeDaily`:空词(含裸 `/`)整组不出现。
    const notes = createNotesSearchCapability(adapters, index)
    expect(notes.supports(blank)).toBe(false)
    expect(notes.supports({ ...blank, raw: '>' })).toBe(false)
    expect(notes.supports({ ...blank, raw: 'alpha' })).toBe(true)

    // **一个库都没有 = 整组不出现**(不是「零条」)。这一格是能力自述的边界:
    // 没有笔记领域的宿主上,`notes` 那一组在屏幕上根本不该有位置。
    const noVaults = createNotesSearchCapability(
      { ...adapters, getNoteVaults: () => [], getPrimaryNoteVault: () => null },
      index,
    )
    expect(noVaults.supports({ ...blank, raw: 'alpha' })).toBe(false)
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

  it('notes:filePath 取 facets.path(绝对路径),正文命中时副标题是正文摘要', async () => {
    const index = fakeIndexFace(makeDocs(), { matched: ['alpha'] })
    // `makeAdapters()` 没有主库 → 「今天那一条」不出现,这一条量的只有索引那一半。
    const capability = createNotesSearchCapability(makeAdapters(), index)
    const page = await capability.search(query('alpha', 'notes'), { limit: 5 }, createSearchContext())
    const [result] = page.items.map(searchResultOf)

    expect(result).toMatchObject({
      id: 'note:/notes/2026-09-05.md',
      type: 'note',
      title: '2026-09-05',
      subtitle: 'alpha showed up today',
      filePath: '/notes/2026-09-05.md',
      timestamp: 300,
    })
    expect(result?.target).toEqual({ kind: 'note', payload: { filePath: '/notes/2026-09-05.md' } })
  })

  it('索引不可用时不回退到旧扫描:零结果,不是「另一条路答的结果」(§13)', async () => {
    const empty = fakeIndexFace([])
    const capability = createMessagesSearchCapability(makeAdapters(), empty)
    const page = await capability.search(query('alpha', 'messages'), { limit: 5 }, createSearchContext())
    expect(page.items).toEqual([])
  })
})

/**
 * 两件「索引在结构上答不出」的事(设计 §10 S3b 落地记录的留账 1 / 2)。
 *
 *  - chats 的空词浏览态 —— 「按 `updatedAt` 取前 N 间」不是一次检索;
 *  - notes 的「今天那一条」—— 不存在的文件没有文档。
 *
 * 「与旧路逐字同」这条判据在 S5 之后由 `chats-browse.test.ts` 拿**录下来的旧输出**
 * 守(旧函数已删,参照物只能是快照);这里守的是能力这一层的形状与位置。
 */
describe('索引答不出的那两件(S3b:空词最近会话 / 今天那一条)', () => {
  function query(raw: string, capability: string): SearchQuery {
    return { raw, ast: { type: 'and', children: [] }, intent: 'content', filters: {}, capability }
  }

  it('chats 空词:最近几间会话(不走索引,按 updatedAt 降序)', async () => {
    const adapters = makeAdapters()
    // 索引里**有**一份 chats 文档;空词走的是另一条路,所以它不该出现在答案里。
    const capability = createChatsSearchCapability(adapters, fakeIndexFace(makeDocs()))

    const wrapped = await capabilityAnswer(capability, '', 20)
    // 空词的答案是「最近几间」而不是「零条」——摘掉那个分支这一行当场红。
    expect(wrapped).toEqual([
      {
        id: 'chat:s1',
        type: 'chat',
        title: 'Alpha notes',
        subtitle: 'about alpha',
        sessionId: 's1',
        timestamp: 200,
      },
      {
        id: 'chat:s2',
        type: 'chat',
        title: 'Beta log',
        subtitle: 'nothing here',
        sessionId: 's2',
        timestamp: 100,
      },
    ])
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
    // notes 那一组照旧路的 `includeDaily`:空词时整组不出现(不是「有一组 0 条」)。
    expect(response.groups?.some(group => group.capability === 'notes')).toBe(false)
  })

  describe('notes 的「今天那一条」与两条建文件的动作', () => {
    const dirs: string[] = []
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    /** 一个真目录 = 一个真库。主库在场,于是「今天那一条」与两条动作都活。 */
    function notesAdapters(): { adapters: OnethingSearchProvidersAdapters; notesDir: string } {
      const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-cap-'))
      dirs.push(notesDir)
      const vault = new FolderVault({ root: notesDir, id: 'v1', name: 'notes' })
      return {
        notesDir,
        adapters: {
          ...makeAdapters(),
          getNoteVaults: () => [vault],
          getPrimaryNoteVault: () => vault,
        },
      }
    }

    function todayIso(): string {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    /*
     * 检索面终稿 §0 ③ 推翻了「『新建今天的日记』是排在最后的一条结果」:它指的文件
     * 还不存在 —— 占一格配额、计进 total、停在它上面预览只能抛「还没有文件可看」。
     * 它现在是**页级动作**(`SearchPage.actions`),不在 `items` 里、不计任何数。
     */
    it('今天的笔记不存在:它是一条**动作**,不进 results、不计 total', async () => {
      const { adapters } = notesAdapters()
      const capability = createNotesSearchCapability(adapters, fakeIndexFace(makeDocs(), { matched: ['alpha'] }))
      // 查询要「像今天」才有这一条 —— 判据是 `todayMatchesQuery`。
      const page = await capability.search(query('today', 'notes'), { limit: 5 }, createSearchContext())
      const results = page.items.map(searchResultOf)

      // 一条都不在结果里(旧路它在 results 的末尾)。
      expect(results[0]?.id).toBe('note:/notes/2026-09-05.md')

      const action = page.actions?.find(item => item.id.startsWith('create-daily:'))
      expect(action?.kind).toBe('create')
      expect(action?.capability).toBe('notes')
      // **句子不在后端**(R12):只交键与料,`Create today's daily note: …` 这种
      // 成品英文句从此由壳按 `labelKey + params` 拼。
      expect(action?.labelKey).toBe('search.action.createDailyNote')
      expect(action?.label).toBeUndefined()
      const filePath = (action?.payload as { filePath: string }).filePath
      expect(filePath.endsWith(`${todayIso()}.md`)).toBe(true)
      expect(action?.id).toBe(`create-daily:${encodeURIComponent(filePath)}`)
    })

    it('那条动作按下去真的把文件建出来(`invoke` → 库自己的 `createDailyNote`)', async () => {
      const { adapters } = notesAdapters()
      const capability = createNotesSearchCapability(adapters, fakeIndexFace(makeDocs(), { matched: ['alpha'] }))
      const page = await capability.search(query('today', 'notes'), { limit: 5 }, createSearchContext())
      const action = page.actions!.find(item => item.id.startsWith('create-daily:'))!
      const filePath = (action.payload as { filePath: string }).filePath
      expect(fs.existsSync(filePath)).toBe(false)

      await capability.invoke?.(action.id, [], createSearchContext())
      expect(fs.existsSync(filePath)).toBe(true)

      // 不认识的动作 id **结构化拒绝**,不悄悄成功。
      await expect(capability.invoke?.('nope', [], createSearchContext())).rejects.toThrow()
    })

    it('今天的笔记已经存在:那一条变成「打开今天」排在**最前**,并与索引答的同一份去重', async () => {
      const { adapters, notesDir } = notesAdapters()
      const iso = todayIso()
      const todayPath = path.join(notesDir, `${iso}.md`)
      fs.writeFileSync(todayPath, `# ${iso}\n\nalpha\n`)

      // 索引里也有今天这一份(真索引会有)——两条同 filePath,只许出一条。
      const docs = [...makeDocs(), {
        docId: 9,
        capability: 'notes',
        key: `${iso}.md`,
        time: 400,
        facets: { path: todayPath, time: 400, vault: 'v1', daily: true },
        fields: { title: iso, content: 'alpha' },
      }]
      const capability = createNotesSearchCapability(adapters, fakeIndexFace(docs, { matched: ['alpha'] }))
      const page = await capability.search(query('today', 'notes'), { limit: 5 }, createSearchContext())
      const results = page.items.map(searchResultOf)

      expect(results[0]?.filePath).toBe(todayPath)
      expect(results.filter(result => result.filePath === todayPath).length).toBe(1)
      // 文件在 = 没有「新建今天」那条动作。
      expect(page.actions?.some(item => item.id.startsWith('create-daily:'))).not.toBe(true)
    })

    it('查询与今天对不上时一条都不多给(`todayMatchesQuery` 是唯一判据)', async () => {
      const { adapters } = notesAdapters()
      const capability = createNotesSearchCapability(adapters, fakeIndexFace(makeDocs(), { matched: ['alpha'] }))
      const page = await capability.search(query('zzz-nothing', 'notes'), { limit: 5 }, createSearchContext())
      expect(page.actions?.some(item => item.id.startsWith('create-daily:'))).not.toBe(true)
    })

    /**
     * 「像今天」的判据**收紧过**(壳正本 84 号)。从前是 `todayIso.includes(q)` 加上
     * 那几个词根的**互含**,于是单个字母 `n`(note 的头一个字)、ISO 里的任意一位
     * 数字都能把「今天」顶到第一行 —— 一次正常的检索被一条与词无关的快捷项挤掉。
     */
    it('todayMatchesQuery:两字起、整词前缀或 ISO 前缀', () => {
      const iso = todayIso()
      expect(todayMatchesQuery('', iso)).toBe(false)
      expect(todayMatchesQuery('t', iso)).toBe(false)
      expect(todayMatchesQuery('n', iso)).toBe(false)
      expect(todayMatchesQuery('to', iso)).toBe(true)
      expect(todayMatchesQuery('日记', iso)).toBe(true)
      expect(todayMatchesQuery(iso.slice(0, 7), iso)).toBe(true)
      expect(todayMatchesQuery(iso, iso)).toBe(true)
      // 「某个月的某天」不是「今天」:ISO 的**前缀**才算,子串不算。
      expect(todayMatchesQuery(iso.slice(5), iso)).toBe(false)
      // 词根是**前缀**关系,不是互含:`journalism` 不是在问今天的日记。
      expect(todayMatchesQuery('journalism', iso)).toBe(false)
    })

    it('`vault` facet:选了哪个库,「新建笔记」就落哪个库', async () => {
      const { adapters, notesDir } = notesAdapters()
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-notes-cap2-'))
      dirs.push(other)
      const second = new FolderVault({ root: other, id: 'v2', name: 'second' })
      const two: OnethingSearchProvidersAdapters = {
        ...adapters,
        getNoteVaults: () => [...adapters.getNoteVaults!(), second],
      }
      const capability = createNotesSearchCapability(two, fakeIndexFace([]))

      const plain = await capability.search(
        { ...query('zeta', 'notes') },
        { limit: 5 },
        createSearchContext(),
      )
      const plainAction = plain.actions!.find(item => item.id.startsWith('create-note:'))!
      // 没选库 = 主库。
      expect(decodeURIComponent(plainAction.id.slice('create-note:'.length)))
        .toBe(path.join(notesDir, 'zeta.md'))

      const scoped = await capability.search(
        { ...query('zeta', 'notes'), filters: { vault: 'v2' } },
        { limit: 5 },
        createSearchContext(),
      )
      const scopedAction = scoped.actions!.find(item => item.id.startsWith('create-note:'))!
      expect(decodeURIComponent(scopedAction.id.slice('create-note:'.length)))
        .toBe(path.join(other, 'zeta.md'))
      expect(scopedAction.labelKey).toBe('search.action.createNote')
      expect(scopedAction.params?.title).toBe('zeta')

      // **大小写照用户打的那一串**:屏幕上那句话与真落盘的文件名是同一串字。
      // `normalizeSearchQuery` 会小写,那一份只配当判据(把 title 换回它,这里红)。
      const cased = await capability.search(
        { ...query('OnethingNotes', 'notes') },
        { limit: 5 },
        createSearchContext(),
      )
      const casedAction = cased.actions!.find(item => item.id.startsWith('create-note:'))!
      expect(casedAction.params?.title).toBe('OnethingNotes')
      expect(decodeURIComponent(casedAction.id.slice('create-note:'.length)))
        .toBe(path.join(notesDir, 'OnethingNotes.md'))

      // 按下去真的建出来,而且建在选中的那个库里。
      await capability.invoke?.(scopedAction.id, [], createSearchContext())
      expect(fs.existsSync(path.join(other, 'zeta.md'))).toBe(true)
      expect(fs.existsSync(path.join(notesDir, 'zeta.md'))).toBe(false)
    })

    it('标题精确命中时不给「新建笔记」—— 按下去不是建,是撞名', async () => {
      const { adapters } = notesAdapters()
      const docs = [{
        docId: 11,
        capability: 'notes',
        key: 'zeta.md',
        time: 500,
        facets: { path: '/notes/zeta.md', time: 500, vault: 'v1', daily: false },
        fields: { title: 'zeta', content: 'zeta 正文' },
      }]
      const capability = createNotesSearchCapability(adapters, fakeIndexFace(docs, { matched: ['zeta'] }))
      const page = await capability.search(query('zeta', 'notes'), { limit: 5 }, createSearchContext())
      expect(page.items).toHaveLength(1)
      expect(page.actions?.some(item => item.id.startsWith('create-note:'))).not.toBe(true)
    })

    it('文件名里的非法字符换成 `-`,不是让 `createNote` 去撞一个建不出来的路径', () => {
      expect(sanitizeNoteFileName('a/b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i')
      expect(sanitizeNoteFileName('   ')).toBe('Untitled')
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

describe('扫描型的预算(有边界,但超时不等于作废)', () => {
  /** 比 3000ms 预算还慢的一路扫描。 */
  const SLOW_SCAN_MS = 5000

  /**
   * 一只**认信号**的慢扫描:被打断时交它已经扫到的那些,并说自己没扫完。
   * 这正是 `capabilities/files.ts` 里 `searchFiles` 的形状。
   */
  function slowFilesCapability() {
    return scanBackedCapability({
      manifest: filesSearchManifest,
      run: async (_query, _limit, _filters, ctx) => {
        const scanned = [{ id: 'f-slow', type: 'file' as const, title: 'alpha 慢慢来', filePath: '/tmp/alpha' }]
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SLOW_SCAN_MS)
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
        return ctx.signal.aborted ? { items: scanned, partial: true } : { items: scanned }
      },
      supports: () => true,
      target: result => ({ kind: 'file', payload: { filePath: result.filePath ?? '' } }),
    })
  }

  it('扫描型的 files:timeoutMs 是 3000 —— 一次搜索的等待有一个说得出口的上限', () => {
    const manifest = createFilesSearchCapability(makeAdapters()).manifest
    expect(manifest.kind).toBe('scan')
    expect(manifest.budget.timeoutMs).toBe(3000)
  })

  it('files:预算到点交已扫到的那些并标 partial,而不是 error: timeout', async () => {
    vi.useFakeTimers()
    try {
      const service = new OnethingSearchService()
      service.register(slowFilesCapability())
      const pending = service.query({ query: 'alpha', category: 'files', limit: 5 })
      // 先放一拍让 `deriveSignal` 把 3000ms 那只计时器装上,再把时间推过去。
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(3000)
      const response = await pending
      // 反证:把 `runLadder` 里那句 `last?.partial === true` 拆掉 → 这里当场变成
      // `success:false` + `error: 'timeout'`(整块作废),两条断言一起红。
      expect(response.success).toBe(true)
      expect(response.results.map(result => result.id)).toEqual(['f-slow'])
      expect(response.partial).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
