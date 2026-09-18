/**
 * 笔记那一路,**从盘上的文件一直问到能力的答案**(P2;S3b 时它叫 daily)。
 *
 * 设计:`docs/design/notes-obsidian-cli-2026-09.md` §4.1(`VaultFeed`)+
 * docs/design/search-index-2026-09.md §5.2b(`build: 'lazy'`)
 * + §10 S3b 落地记录的留账 2(「按文件名日期匹配的标题形」)。
 *
 * 这一条要证的是留账 2 的后半句:换索引之后,**按文件名里的日期仍然搜得到**。
 * 它不是靠 `title` 里塞一份原样文件名兜出来的,而是分析器的事 —— `2026-09-05`
 * 在索引与查询两侧走的是同一只 `compositeAnalyzer`,切出 `2026` `09` `05` 三个
 * 词元,所以整串查得到,`09-05` 也查得到(它的两个词元是那三个的子集,AND 成立)。
 * 真读数写在下面的注释里。
 *
 * 夹具照 `helpers.ts` 的三条纪律:临时目录、同线程 Worker、不 import backend。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { compositeAnalyzer } from '@onething/core/search'

import { FolderVault } from '../../../notes/folder/vault.js'

import { createNotesSearchCapability } from '../../capabilities/index.js'
import type { OnethingSearchProvidersAdapters } from '../../providers.js'
import { OnethingSearchService } from '../../service.js'
import { VaultFeed } from '../vault-feed.js'
import { SearchIndexService } from '../service.js'
import { createSameThreadWorker, createTempStore } from './helpers.js'
import type { SameThreadWorker, TempStore } from './helpers.js'

const stores: TempStore[] = []
const spawned: SameThreadWorker[] = []
const services: SearchIndexService[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const worker of spawned.splice(0)) worker.handle.terminate()
  for (const store of stores.splice(0)) store.dispose()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/**
 * 一个库在册、**没有主库** —— 这一条量的是索引那一半,「今天那一条」与「新建
 * 笔记」都不该掺进来。
 */
function indexOnlyAdapters(root: string): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [],
    iterateSessionMessages: () => [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getVariablesStore: () => ({ getUserNoteDir: () => undefined, getWorkNoteDir: () => undefined }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
    getNoteVaults: () => [new FolderVault({ root, id: 'v1' })],
    getPrimaryNoteVault: () => null,
  }
}

/** 相对路径 → 内容。`a/b.md` 这样的键会把中间那层目录建出来。 */
function writeVault(notes: Record<string, string>): string {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-vault-'))
  dirs.push(notesDir)
  for (const [name, content] of Object.entries(notes)) {
    const target = path.join(notesDir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return notesDir
}

async function serviceOverNotes(
  notes: Record<string, string>,
  spec: { dailyFolder?: string } = {},
): Promise<OnethingSearchService> {
  const store = createTempStore()
  stores.push(store)
  const notesDir = writeVault(notes)

  const index = new SearchIndexService({
    createWorker: () => {
      const worker = createSameThreadWorker({
        indexPath: store.indexPath,
        feeds: [new VaultFeed({ id: 'v1', root: notesDir, ...spec })],
        debounceMs: 5,
      })
      spawned.push(worker)
      return worker.handle
    },
  })
  index.start()
  services.push(index)

  const search = new OnethingSearchService({ index })
  search.register(createNotesSearchCapability(indexOnlyAdapters(notesDir), index))
  // feed 是 `lazy` 的:第一次问 `notes` 才纳入,`drain()` 等它建完(§5.2b)。
  await search.query({ query: 'warmup', category: 'notes', limit: 1 })
  await index.drain()
  return search
}

describe('笔记:按文件名里的日期搜得到(S3b 留账 2)', () => {
  it('分析器把 `2026-09-05` 切成三个词元 —— 这就是「09-05 也中」的全部理由', () => {
    // 真读数(2026-09-05 本机):['2026', '09', '05'] / ['09', '05']。
    expect(compositeAnalyzer.analyze('2026-09-05').map(token => token.text))
      .toEqual(['2026', '09', '05'])
    expect(compositeAnalyzer.analyze('09-05').map(token => token.text)).toEqual(['09', '05'])
  })

  it('`2026-09-05` 与 `09-05` 都命中那份笔记,并排在第一', async () => {
    const search = await serviceOverNotes({
      '2026-09-05.md': '# 2026-09-05\n\n索引重建大约五秒\n',
      '2026-09-06.md': '# 2026-09-06\n\n另一天\n',
    })

    const full = await search.query({ query: '2026-09-05', category: 'notes', limit: 10 })
    expect(full.results[0]?.title).toBe('2026-09-05')
    expect(full.relaxed).toBe(0)

    const partial = await search.query({ query: '09-05', category: 'notes', limit: 10 })
    expect(partial.results[0]?.title).toBe('2026-09-05')
    expect(partial.relaxed).toBe(0)

    const other = await search.query({ query: '09-06', category: 'notes', limit: 10 })
    expect(other.results[0]?.title).toBe('2026-09-06')
  })

  /**
   * **严格档不再顺带召回同月的隔壁天**(S3b 第二轮修;这条用例从「如实记下的读数」
   * 翻面成期望)。
   *
   * 病是这样的:`plan` 的 `minShouldMatch` 数的是**查询 AST 里的词**(`2026-09-05`
   * 是一个词),而索引侧把它按分析器摊成三个词元后取 `min(1, 3) = 1` —— 于是
   * 「①严格 = 全 AND」在这一形上实际是 OR。旧的子串路不会这样,那是相对旧路的
   * 过召回(§2「找得到」不包括「多找到」)。
   *
   * 治法在 `buildLexicalQuery`:①② 把这样一个词翻成**一条短语**(与用户手打
   * `"…"` 同一条翻译),③④ 才摊平。所以这里严格档只中那一天;`2026-09-06` 要到
   * 阶梯 ③ 才回来,而 fanout「第一级有结果即停」根本走不到那一级。
   */
  it('严格档只中那一天 —— 同月的隔壁天不进组', async () => {
    const search = await serviceOverNotes({
      '2026-09-05.md': '# 2026-09-05\n\n索引重建大约五秒\n',
      '2026-09-06.md': '# 2026-09-06\n\n另一天\n',
    })
    const full = await search.query({ query: '2026-09-05', category: 'notes', limit: 10 })
    expect(full.relaxed).toBe(0)
    expect(full.results.map(result => result.title)).toEqual(['2026-09-05'])
  })

  it('正文也可搜(换索引换来的那一件)', async () => {
    const search = await serviceOverNotes({ '2026-09-05.md': '# 2026-09-05\n\n索引重建大约五秒\n' })
    const response = await search.query({ query: '索引重建', category: 'notes', limit: 10 })
    expect(response.results.map(result => result.filePath?.endsWith('2026-09-05.md'))).toEqual([true])
  })
})

/**
 * feed 本身的形(P2 新增)。这一组不起索引 —— 它问的是 `VaultFeed` 从盘上看到
 * 什么、写出什么 facets,与倒排无关。
 */
describe('VaultFeed:递归、跳过、四格 facets', () => {
  async function keysOf(feed: VaultFeed): Promise<string[]> {
    const out: string[] = []
    for await (const key of feed.keys()) out.push(key)
    return out.sort()
  }

  async function docOf(feed: VaultFeed, key: string) {
    for await (const doc of feed.documentsOf(key)) return doc
    return undefined
  }

  it('递归整棵树,key 是库相对路径(posix)', async () => {
    const root = writeVault({
      'top.md': 'top',
      'Journal/2026-09-18.md': '今天',
      'a/b/deep.md': 'deep',
      'skip.png': 'not a note',
    })
    const feed = new VaultFeed({ id: 'v1', root })
    expect(await keysOf(feed)).toEqual(['Journal/2026-09-18.md', 'a/b/deep.md', 'top.md'])
  })

  it('点开头的目录与 node_modules 一律不下去', async () => {
    const root = writeVault({
      'ok.md': 'ok',
      '.obsidian/plugins/x/README.md': '插件自带的文档不是笔记',
      '.trash/deleted.md': '回收站',
      '.git/COMMIT_EDITMSG.md': 'git',
      'node_modules/pkg/readme.md': '依赖',
    })
    const feed = new VaultFeed({ id: 'v1', root })
    expect(await keysOf(feed)).toEqual(['ok.md'])
  })

  it('facets 四格:vault / path(绝对)/ time / daily', async () => {
    const root = writeVault({ 'Journal/2026-09-18.md': '今天', 'notes/other.md': '别的' })
    const feed = new VaultFeed({ id: 'v1', root, dailyFolder: 'Journal' })

    const daily = await docOf(feed, 'Journal/2026-09-18.md')
    expect(daily?.capability).toBe('notes')
    expect(daily?.facets.vault).toBe('v1')
    expect(daily?.facets.path).toBe(path.join(root, 'Journal', '2026-09-18.md'))
    expect(typeof daily?.facets.time).toBe('number')
    expect(daily?.facets.daily).toBe(true)
    expect(daily?.fields.title).toBe('2026-09-18')

    const other = await docOf(feed, 'notes/other.md')
    expect(other?.facets.daily).toBe(false)
  })

  it('dailyFolder 缺席 → 每一篇的 daily 都是 false(不猜一个)', async () => {
    const root = writeVault({ 'x.md': 'x', 'Journal/y.md': 'y' })
    const feed = new VaultFeed({ id: 'v1', root })
    expect((await docOf(feed, 'x.md'))?.facets.daily).toBe(false)
    expect((await docOf(feed, 'Journal/y.md'))?.facets.daily).toBe(false)
  })

  it('dailyFolder 是空串(日记落在库根):库根那一层为真,子目录为假', async () => {
    const root = writeVault({ 'x.md': 'x', 'sub/y.md': 'y' })
    const feed = new VaultFeed({ id: 'v1', root, dailyFolder: '' })
    expect((await docOf(feed, 'x.md'))?.facets.daily).toBe(true)
    expect((await docOf(feed, 'sub/y.md'))?.facets.daily).toBe(false)
  })

  it('feed id = `vault:<库 id>`,一个库一把 —— 索引服务按 id 找 feed', () => {
    expect(new VaultFeed({ id: 'v1', root: '/x' }).id).toBe('vault:v1')
    expect(new VaultFeed({ id: 'v2', root: '/y' }).id).toBe('vault:v2')
  })

  it('指纹是 `mtimeMs:size`;文件没了就答 undefined(那把钥匙打墓碑)', () => {
    const root = writeVault({ 'x.md': 'hello' })
    const feed = new VaultFeed({ id: 'v1', root })
    expect(feed.fingerprint('x.md')).toMatch(/^\d+(\.\d+)?:5$/)
    expect(feed.fingerprint('gone.md')).toBeUndefined()
  })
})
