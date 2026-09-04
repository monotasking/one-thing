/**
 * 每日笔记那一路,**从盘上的文件一直问到能力的答案**(S3b)。
 *
 * 设计:docs/design/search-index-2026-09.md §5.2b(`DailyNotesFeed`,`build: 'lazy'`)
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

import { createDailySearchCapability } from '../../capabilities/index.js'
import type { OnethingSearchProvidersAdapters } from '../../providers.js'
import { OnethingSearchService } from '../../service.js'
import { DailyNotesFeed } from '../daily-feed.js'
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

/** 笔记根目录关着 —— 这一条量的是索引那一半,「今天那一条」不该掺进来。 */
function noDailyAdapters(): OnethingSearchProvidersAdapters {
  return {
    getSessionsList: () => [],
    iterateSessionMessages: () => [],
    getSession: () => undefined,
    getCurrentSessionId: () => undefined,
    getSettings: () => ({ general: { dailyNotes: { enabled: false } } }),
    getVariablesStore: () => ({ getUserNoteDir: () => undefined, getWorkNoteDir: () => undefined }),
    listFiles: () => ({ async *[Symbol.asyncIterator]() {} }),
    listPrompts: () => [],
  }
}

async function serviceOverNotes(notes: Record<string, string>): Promise<OnethingSearchService> {
  const store = createTempStore()
  stores.push(store)
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-daily-notes-'))
  dirs.push(notesDir)
  for (const [name, content] of Object.entries(notes)) {
    fs.writeFileSync(path.join(notesDir, name), content)
  }

  const index = new SearchIndexService({
    createWorker: () => {
      const worker = createSameThreadWorker({
        indexPath: store.indexPath,
        feeds: [new DailyNotesFeed({ notesDir })],
        debounceMs: 5,
      })
      spawned.push(worker)
      return worker.handle
    },
  })
  index.start()
  services.push(index)

  const search = new OnethingSearchService({ index })
  search.register(createDailySearchCapability(noDailyAdapters(), index))
  // feed 是 `lazy` 的:第一次问 `daily` 才纳入,`drain()` 等它建完(§5.2b)。
  await search.query({ query: 'warmup', category: 'daily', limit: 1 })
  await index.drain()
  return search
}

describe('每日笔记:按文件名里的日期搜得到(S3b 留账 2)', () => {
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

    const full = await search.query({ query: '2026-09-05', category: 'daily', limit: 10 })
    expect(full.results[0]?.title).toBe('2026-09-05')
    expect(full.relaxed).toBe(0)

    const partial = await search.query({ query: '09-05', category: 'daily', limit: 10 })
    expect(partial.results[0]?.title).toBe('2026-09-05')
    expect(partial.relaxed).toBe(0)

    const other = await search.query({ query: '09-06', category: 'daily', limit: 10 })
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
    const full = await search.query({ query: '2026-09-05', category: 'daily', limit: 10 })
    expect(full.relaxed).toBe(0)
    expect(full.results.map(result => result.title)).toEqual(['2026-09-05'])
  })

  it('正文也可搜(换索引换来的那一件)', async () => {
    const search = await serviceOverNotes({ '2026-09-05.md': '# 2026-09-05\n\n索引重建大约五秒\n' })
    const response = await search.query({ query: '索引重建', category: 'daily', limit: 10 })
    expect(response.results.map(result => result.filePath?.endsWith('2026-09-05.md'))).toEqual([true])
  })
})
