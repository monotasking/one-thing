import { describe, expect, it } from 'vitest'
import type { SearchResponse, SearchResult } from '@shared/ipc/search'
import {
  SEARCH_FIRST_PAGE,
  SEARCH_PAGE_SIZE,
  fileExt,
  fileName,
  flatRows,
  itemRefOf,
  moreState,
  originText,
  pageWindow,
  remoteSide,
  resultRows,
  sectionsOf,
  sectionsWindow,
  targetText,
} from './transitions'
import type { SearchMore, SearchRemoteSide } from './transitions'

/**
 * 检索面的纯函数(S4b 之后**只剩一条造行路**)。
 *
 * 这一批用例守的三件事,每一件都对着 §4.0 那张枚举点清账表的一格:
 *  · 造行只认后端的回执(`resultRows`);
 *  · `all` 档的节由**后端的 groups** 说,壳不归堆(`sectionsOf`);
 *  · 底部那条 item 的判据表(`moreState`)一格没变,只是少了一个入参。
 */

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  type: 'message',
  title: '命中的那一行',
  target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
  ...over,
})

describe('resultRows(唯一那条造行路)', () => {
  it('出处取 subtitle,退到 detail —— 壳不去猜第三个产地', () => {
    expect(resultRows([result({ subtitle: '那间会话' })], 'messages')[0].origin)
      .toEqual({ kind: 'path', path: '那间会话' })
    expect(resultRows([result({ detail: '兜底那句' })], 'messages')[0].origin)
      .toEqual({ kind: 'path', path: '兜底那句' })
    // 两格都没有 = 空出处,而不是编一句话。
    expect(resultRows([result()], 'messages')[0].origin).toEqual({ kind: 'path', path: '' })
  })

  it('capability 是**入参**给的那一个 —— 行知道自己是谁产的(预览 / 分组都读它)', () => {
    expect(resultRows([result()], 'messages')[0].capability).toBe('messages')
  })

  it('没有 target 的丢掉 —— 一条按下去什么都不发生的行比不画更让人怀疑', () => {
    const orphan: SearchResult = { id: 'x', type: 'plugin', title: '没有落点' }
    expect(resultRows([orphan, result()], 'messages').map(r => r.id)).toEqual(['r1'])
  })

  it('高亮 / facets / inline 预览**原样驮着**,壳一格都不解释', () => {
    const row = resultRows([result({
      matchRanges: [{ start: 1, end: 3 }],
      facets: { archived: true, spaceId: 'w2', 认不得的键: 7 },
      preview: { kind: 'session-overview', payload: { sessionId: 's1' } },
    })], 'chats')[0]
    expect(row.highlight).toEqual([{ start: 1, end: 3 }])
    // **不认识不等于该丢掉**:认不得的键照样在。
    expect(row.facets).toEqual({ archived: true, spaceId: 'w2', 认不得的键: 7 })
    expect(row.preview?.kind).toBe('session-overview')
  })

  it('三格都缺席时**键也不在**(不是 undefined 占位)—— 与契约上的「缺席 = 不知道」同口径', () => {
    const row = resultRows([result()], 'messages')[0]
    expect('highlight' in row).toBe(false)
    expect('facets' in row).toBe(false)
    expect('preview' in row).toBe(false)
  })
})

describe('itemRefOf(预览 / 动作请求里那条 items)', () => {
  it('三格:能力 + 它自己那套 id + 目标载荷', () => {
    const row = resultRows([result()], 'messages')[0]
    expect(itemRefOf(row)).toEqual({
      capability: 'messages',
      id: 'r1',
      target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
    })
  })
})

describe('sectionsOf(§7.2 全部档 = 分组总览)', () => {
  const groups: SearchResponse['groups'] = [
    { capability: 'chats', label: 'search.capability.chats', total: 12, results: [result({ id: 'c1' })] },
    { capability: 'messages', label: 'search.capability.messages', results: [result({ id: 'm1' }), result({ id: 'm2' })] },
    { capability: 'files', label: 'search.capability.files', results: [], error: '索引不可用' },
  ]

  it('组的次序**原样保留** —— 后端已按 manifest 的 order 排好,壳不再排一遍', () => {
    expect(sectionsOf({ results: [], groups }, 'all').map(s => s.capability))
      .toEqual(['chats', 'messages', 'files'])
  })

  it('offset 是**扁平下标**:第二组从第一组结束的地方数起', () => {
    const sections = sectionsOf({ results: [], groups }, 'all')
    expect(sections.map(s => s.offset)).toEqual([0, 1, 3])
  })

  it('一条结果都没有但**塌了**的组照样有节头(§9 第四条)', () => {
    const failed = sectionsOf({ results: [], groups }, 'all')[2]
    expect(failed.rows).toEqual([])
    expect(failed.error).toBe('索引不可用')
    expect(failed.head).toBe(true)
  })

  it('total 缺席 = 不知道,**不是 0**', () => {
    const sections = sectionsOf({ results: [], groups }, 'all')
    expect(sections[0].total).toBe(12)
    expect('total' in sections[1]).toBe(false)
  })

  it('单类档:一节、不画节头、labelKey 就是能力 id(节头本来就不画)', () => {
    const sections = sectionsOf({ results: [result()] }, 'messages')
    expect(sections).toHaveLength(1)
    expect(sections[0].head).toBe(false)
    expect(sections[0].capability).toBe('messages')
  })

  it('还没有答案 = 一节都没有(不是一节空的)', () => {
    expect(sectionsOf(undefined, 'all')).toEqual([])
  })
})

describe('sectionsWindow / flatRows(翻页只是把窗口拉大)', () => {
  const groups: SearchResponse['groups'] = [
    { capability: 'a', label: 'a', results: [result({ id: 'a1' }), result({ id: 'a2' })] },
    { capability: 'b', label: 'b', results: [result({ id: 'b1' }), result({ id: 'b2' })] },
  ]
  const sections = sectionsOf({ results: [], groups }, 'all')

  it('切在**扁平下标**上 —— 第一组吃不光配额,第二组照样露得出来', () => {
    const window = sectionsWindow(sections, 3)
    expect(flatRows(window).map(r => r.id)).toEqual(['a1', 'a2', 'b1'])
  })

  it('切空了的节**仍然留着**(节头是读数,不是行)', () => {
    const window = sectionsWindow(sections, 2)
    expect(window.map(s => s.capability)).toEqual(['a', 'b'])
    expect(window[1].rows).toEqual([])
  })

  it('单类档那一节切空了就整节不要(它本来就没有节头要说的话)', () => {
    const single = sectionsOf({ results: [result()] }, 'messages')
    expect(sectionsWindow(single, 0)).toEqual([])
  })
})

describe('路径与出处', () => {
  it('fileName / fileExt:没有扩展名就把整个名字大写', () => {
    expect(fileName('/a/b/c.ts')).toBe('c.ts')
    expect(fileExt('/a/b/c.ts')).toBe('TS')
    expect(fileExt('/a/notebook')).toBe('NOTEBOOK')
  })

  it('originText:分隔符是标点不是文案', () => {
    expect(originText({ kind: 'fileLine', file: 'a.ts', line: 12 })).toBe('a.ts:12')
    expect(originText({ kind: 'projectTime', project: 'P', time: '刚刚' })).toBe('P · 刚刚')
    expect(originText({ kind: 'path', path: '/x/y' })).toBe('/x/y')
  })

  it('targetText:不带行号时**不补一个 :1** 去凑格式', () => {
    expect(targetText({ kind: 'file', payload: { filePath: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(targetText({ kind: 'file', payload: { filePath: '/a/b.ts', line: 3 } })).toBe('b.ts:3')
  })
})

describe('remoteSide(次序是判据,不是口味)', () => {
  const cases: Array<[SearchRemoteSide[], SearchRemoteSide]> = [
    [['exhausted', 'failed'], 'failed'],
    [['pending', 'more'], 'more'],
    [['exhausted', 'pending'], 'pending'],
    [['exhausted', 'exhausted'], 'exhausted'],
    [[], 'exhausted'],
  ]
  for (const [sides, want] of cases) {
    it(`${JSON.stringify(sides)} → ${want}`, () => {
      expect(remoteSide(...sides)).toBe(want)
    })
  }
})

describe('pageWindow', () => {
  it('第一页 = 首屏;之后每页加一个增量', () => {
    expect(pageWindow(1)).toBe(SEARCH_FIRST_PAGE)
    expect(pageWindow(3)).toBe(SEARCH_FIRST_PAGE + 2 * SEARCH_PAGE_SIZE)
  })
})

describe('moreState(底部那条 item 的判据表)', () => {
  const at = (over: Partial<Parameters<typeof moreState>[0]>): SearchMore =>
    moreState({ page: 1, total: 5, remote: 'exhausted', ...over })

  it('一条行都没有 = 什么都不画', () => {
    expect(at({ total: 0 })).toEqual({ kind: 'none' })
  })

  it('取尽 + 全装得下 = 读数「共 N 条 · 已全部显示」(第一页就取尽也算数)', () => {
    expect(at({})).toEqual({ kind: 'end', total: 5 })
  })

  it('窗口装不下:取尽时报真总数,没取尽时不猜(null)', () => {
    expect(at({ total: 50 })).toEqual({ kind: 'more', shown: 20, total: 50 })
    expect(at({ total: 50, remote: 'more' })).toEqual({ kind: 'more', shown: 20, total: null })
  })

  it('远端还没落定的第一页:**报数不许诺** —— 「已显示 N 条」,不是「加载更多」', () => {
    expect(at({ remote: 'pending' })).toEqual({ kind: 'count', shown: 5 })
  })

  it('翻过页之后,加载中 / 失败才由这条 item 说', () => {
    expect(at({ page: 2, remote: 'pending' })).toEqual({ kind: 'loading' })
    expect(at({ page: 2, remote: 'failed' })).toEqual({ kind: 'error' })
  })

  it('第一页那次失败仍然给一条**能按的** item —— 「再试一次」得有地方按', () => {
    expect(at({ remote: 'failed' })).toEqual({ kind: 'more', shown: 5, total: null })
  })
})
