import { describe, expect, it } from 'vitest'
import type { SearchResponse, SearchResult } from '@shared/ipc/search'
import type { SearchBlock, SearchListing } from '../data/search-listing-source'
import {
  actionItemId,
  actionOfItem,
  blockOfItem,
  EMPTY_SEQUENCE,
  indexOfItem,
  moreItemId,
  rowItemId,
  rowOfItem,
  sequenceOf,
} from './sequence'
import { flatRows, sectionsOf, sectionsWindow } from './transitions'

/**
 * **序列**的判据(检索面终稿 附录 B §1 / §5.4 ②)。
 *
 * 文件里有两批用例:
 *  · 新的一组(`sequenceOf` 与它的反查)—— 本批立的产地;
 *  · 旧的两组(`sectionsOf` / `sectionsWindow` + `flatRows`)—— 从
 *    `transitions.test.ts` 搬过来的,函数本体还在那边活着(删旧是第 ⑨ 步)。
 */

/* ── 装置 ──────────────────────────────────────────────────────────────── */

function row(id: string): SearchResult {
  return { id, type: 'message', title: id, target: { kind: 'message', payload: { id } } }
}

function block(capability: string, ids: string[], over: Partial<SearchBlock> = {}): SearchBlock {
  const merged: SearchBlock = {
    capability,
    rows: ids.map(row),
    cursor: 'c1',
    exhausted: false,
    pages: 1,
    ...over,
  }
  return { ...merged, exhausted: merged.cursor === undefined }
}

function listing(blocks: SearchBlock[], over: Partial<SearchListing> = {}): SearchListing {
  return { mode: 'overview', query: 'jira', blocks, ...over }
}

const ids = (items: readonly { id: string }[]): string[] => items.map(i => i.id)

/* ── 一次 flatten ──────────────────────────────────────────────────────── */

describe('sequenceOf(一次 flatten)', () => {
  it('逐块:这一块的行 → 这一块的块尾项 → 下一块', () => {
    const seq = sequenceOf(listing([block('chats', ['a']), block('files', ['b', 'c'])]))
    expect(ids(seq)).toEqual([
      rowItemId('chats', 'a'),
      moreItemId('chats'),
      rowItemId('files', 'b'),
      rowItemId('files', 'c'),
      moreItemId('files'),
    ])
  })

  it('取尽的块没有块尾项(那时它是一条读数,不是 item)', () => {
    const seq = sequenceOf(listing([block('chats', ['a'], { cursor: undefined })]))
    expect(ids(seq)).toEqual([rowItemId('chats', 'a')])
  })

  it('零命中的块一个像素都不占 —— 连块尾项都没有', () => {
    const seq = sequenceOf(listing([
      block('chats', [], { error: 'boom' }),
      block('files', ['b'], { cursor: undefined }),
    ]))
    expect(ids(seq)).toEqual([rowItemId('files', 'b')])
  })

  it('R3:动作项是**末项**,排在所有块之后', () => {
    const seq = sequenceOf(listing(
      [block('prompts', ['p1'], { cursor: undefined, actions: [{ id: 'create', labelKey: 'k' }] })],
      { actions: [{ id: 'create-daily', labelKey: 'k2', capability: 'daily' }] },
    ))
    expect(ids(seq)).toEqual([
      rowItemId('prompts', 'p1'),
      actionItemId('prompts', 'create'),
      actionItemId('daily', 'create-daily'),
    ])
    expect(seq[seq.length - 1].kind).toBe('action')
  })

  it('块尾项的四态由外面注入 —— `end` / `none` 不进序列,`loading` / `error` 进', () => {
    const one = listing([block('chats', ['a'])])
    expect(ids(sequenceOf(one, () => ({ kind: 'loading' })))).toContain(moreItemId('chats'))
    expect(ids(sequenceOf(one, () => ({ kind: 'error' })))).toContain(moreItemId('chats'))
    expect(ids(sequenceOf(one, () => ({ kind: 'end', total: 1 })))).not.toContain(moreItemId('chats'))
    expect(ids(sequenceOf(one, () => ({ kind: 'none' })))).not.toContain(moreItemId('chats'))
  })

  it('翻一页:存量项的 id 一个字不变,新行追加在块末尾', () => {
    const before = sequenceOf(listing([block('chats', ['a', 'b'])]))
    const after = sequenceOf(listing([block('chats', ['a', 'b', 'c', 'd'])]))
    expect(ids(after).slice(0, 2)).toEqual(ids(before).slice(0, 2))
    // 块尾项还在末位 —— 它的 id 也没变(一块一条,只有块名)。
    expect(after[after.length - 1].id).toBe(moreItemId('chats'))
  })

  it('没有清单 = 空序列的**恒等引用**(律④)', () => {
    expect(sequenceOf(undefined)).toBe(EMPTY_SEQUENCE)
    expect(sequenceOf(listing([]))).toBe(EMPTY_SEQUENCE)
  })
})

describe('反查(项 → 它指的那件东西)', () => {
  const l = listing(
    [block('prompts', ['p1'], { actions: [{ id: 'create', labelKey: 'k' }] })],
    { actions: [{ id: 'page-level', labelKey: 'k2' }] },
  )
  const seq = sequenceOf(l)

  it('行 / 块 / 动作各查得到;查不到就是 undefined', () => {
    const rowItem = seq.find(i => i.kind === 'row')!
    expect(rowOfItem(l, rowItem)?.id).toBe('p1')
    expect(blockOfItem(l, rowItem)?.capability).toBe('prompts')
    expect(actionOfItem(l, rowItem)).toBeUndefined()

    const blockAction = seq.find(i => i.id === actionItemId('prompts', 'create'))!
    expect(actionOfItem(l, blockAction)?.id).toBe('create')

    const pageAction = seq.find(i => i.id === actionItemId('', 'page-level'))!
    expect(actionOfItem(l, pageAction)?.id).toBe('page-level')
  })

  it('indexOfItem:不在序列里是 -1(与 indexOf 同一口径)', () => {
    expect(indexOfItem(seq, seq[0].id)).toBe(0)
    expect(indexOfItem(seq, 'row:nope:x')).toBe(-1)
    expect(indexOfItem(seq, null)).toBe(-1)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * 以下两组从 `transitions.test.ts` 搬过来(第 ⑤ 步),函数本体还在那边。
 * ══════════════════════════════════════════════════════════════════════════ */

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  type: 'message',
  title: '命中的那一行',
  target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
  ...over,
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
