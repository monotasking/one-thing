import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
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
import { moreStateOf } from './paging'

/**
 * **序列**的判据(检索面终稿 附录 B §1 / §5.4 ②)。
 *
 * 一组:`sequenceOf` 与它的三只反查(`rowOfItem` / `blockOfItem` / `actionOfItem`)。
 *
 * ── 第 ⑨ 步:旧那两组用例随函数本体一起下葬 ────────────────────────────────
 * 第 ⑤ 步把 `sectionsOf` / `sectionsWindow` / `flatRows` 的用例从 `transitions.test.ts`
 * 搬来这里「按新家归位」,那时函数本体还在 `transitions.ts` 活着。本批删旧:
 * 分节那台机整台作废(块 → 序列项由 `sequenceOf` 一次 flatten 产出),用例跟着走。
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
      { actions: [{ id: 'create-daily', labelKey: 'k2', capability: 'notes' }] },
    ))
    expect(ids(seq)).toEqual([
      rowItemId('prompts', 'p1'),
      actionItemId('prompts', 'create'),
      actionItemId('notes', 'create-daily'),
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

/* ── 09-07 事故第二条修:还没问的那一块也在序列里 ──────────────────────── */

describe('scanning 块的块尾项', () => {
  it('零行的 `scanning` 块**产一条块尾项** —— 焦点不该在等待途中蒸发', () => {
    const one = listing([block('files', [], { cursor: undefined, scanning: true })])
    /*
     * 反证:把 `sequenceOf` 里那句 `|| state.kind === 'scanning'` 删掉 →
     * 序列空了,↑↓ 走不到它,而屏上那条「扫描中…」还画着(两处判据分家)。
     */
    expect(sequenceOf(one, b => moreStateOf(b, false, false)).map(item => item.id))
      .toEqual([moreItemId('files')])
  })

  it('零行且**没在扫**的块照旧一格都不占(R2 一个字没改)', () => {
    const one = listing([block('files', [], { cursor: undefined })])
    expect(sequenceOf(one, b => moreStateOf(b, false, false))).toBe(EMPTY_SEQUENCE)
  })

  it('`partial` 是读数不是 item:行在,块尾不进序列', () => {
    const one = listing([block('files', ['f1'], { cursor: undefined, partial: true })])
    expect(sequenceOf(one, b => moreStateOf(b, false, false)).map(item => item.id))
      .toEqual([rowItemId('files', 'f1')])
  })
})
