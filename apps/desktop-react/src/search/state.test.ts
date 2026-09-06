import { describe, expect, it } from 'vitest'
import { INITIAL_FILTERS } from './filters'
import { canGoBack } from './history'
import type { SearchItem } from './sequence'
import * as T from './state'
import type { SearchState } from './state'

/**
 * 检索面**状态机**的判据(检索面终稿 附录 B §4 交互状态表)。
 *
 * 一条贯穿全篇的守卫写在最后:**`reconcile` 不产生任何滚动指令**。滚动只有一条
 * 产地(`SearchList` 那条依赖 `[selection]` 的 effect,`by === 'reconcile'` 时不滚),
 * 所以这里验的是「reconcile 交出去的 `by` 恒是 reconcile」**且**「它除了 selection
 * 什么都没动」—— 后半句是反证的着力点:哪天有人在这只函数里加一格 tick 或者一句
 * 滚动,那条用例当场红。
 */

function item(id: string, kind = 'row'): SearchItem {
  return { id, kind }
}

const seq = (...ids: string[]): SearchItem[] => ids.map(id => item(id))

function state(over: Partial<SearchState> = {}): SearchState {
  return { ...T.initialSearchState, ...over }
}

/* ── 主语三格 ──────────────────────────────────────────────────────────── */

describe('主语(词 / 档 / 片)', () => {
  it('打字**只改词** —— 键不换、活动项不动', () => {
    const before = state({ committedKey: 'k1', selection: { id: 'row:a', by: 'keyboard', at: 3 } })
    const after = T.setQuery(before, 'jira')
    expect(after.query).toBe('jira')
    expect(after.committedKey).toBe('k1')
    expect(after.selection).toBe(before.selection)
  })

  it('同一个值是恒等变换(连引用都不换)', () => {
    const before = state({ query: 'jira' })
    expect(T.setQuery(before, 'jira')).toBe(before)
    expect(T.setScope(before, before.scope)).toBe(before)
    expect(T.setFilters(before, before.filters)).toBe(before)
    expect(T.commitKey(before, before.committedKey)).toBe(before)
  })
})

describe('换一张列表(resetForListing)', () => {
  it('换键 + 活动项归零 + 清多选', () => {
    const before = state({
      committedKey: 'k1',
      selection: { id: 'row:a', by: 'pointer', at: 2 },
      picked: ['a', 'b'],
    })
    const after = T.resetForListing(before, 'k2')
    expect(after.committedKey).toBe('k2')
    expect(after.selection).toEqual({ id: null, by: 'reconcile', at: -1 })
    expect(after.picked).toEqual([])
  })

  it('归零是 `id: null` 而不是「第一项」—— 此刻新格还没落地,序列是空的', () => {
    expect(T.resetForListing(state(), 'k2').selection.id).toBeNull()
  })
})

/* ── 活动项与多选 ──────────────────────────────────────────────────────── */

describe('活动项', () => {
  it('`by` 记的是「谁改的」—— 滚动那条 effect 的判据', () => {
    expect(T.setActive(state(), 'row:a', 'keyboard', 1).selection)
      .toEqual({ id: 'row:a', by: 'keyboard', at: 1 })
    expect(T.setActive(state(), 'row:a', 'pointer').selection.by).toBe('pointer')
  })

  it('`at` 不给就留旧记号 —— 下一次 reconcile 会校准', () => {
    const before = state({ selection: { id: 'row:a', by: 'keyboard', at: 4 } })
    expect(T.setActive(before, 'row:b', 'pointer').selection.at).toBe(4)
  })

  it('一格没变 = 恒等变换', () => {
    const before = state({ selection: { id: 'row:a', by: 'keyboard', at: 1 } })
    expect(T.setActive(before, 'row:a', 'keyboard', 1)).toBe(before)
  })
})

describe('多选', () => {
  it('按 id toggle,次序有意义(compare 的左右两格照它排)', () => {
    let s = T.pick(state(), 'a')
    s = T.pick(s, 'b')
    expect(s.picked).toEqual(['a', 'b'])
    s = T.pick(s, 'a')
    expect(s.picked).toEqual(['b'])
  })

  it('本来就空的清空 = 恒等变换', () => {
    const before = state()
    expect(T.clearPicks(before)).toBe(before)
  })
})

/* ── 对账 ──────────────────────────────────────────────────────────────── */

describe('reconcile(唯一那条落位规则)', () => {
  it('活动项还在 = 一个字不改(只校准 at 那个记号)', () => {
    const before = state({ selection: { id: 'b', by: 'keyboard', at: 0 } })
    const after = T.reconcile(before, seq('a', 'b', 'c'))
    expect(after.selection.id).toBe('b')
    expect(after.selection.by).toBe('keyboard')
    expect(after.selection.at).toBe(1)
  })

  it('at 已经对了就连引用都不换', () => {
    const before = state({ selection: { id: 'b', by: 'keyboard', at: 1 } })
    expect(T.reconcile(before, seq('a', 'b', 'c'))).toBe(before)
  })

  it('还没有活动项 → 序列首项', () => {
    const after = T.reconcile(state(), seq('a', 'b'))
    expect(after.selection).toEqual({ id: 'a', by: 'reconcile', at: 0 })
  })

  it('块尾那条项消失 → **本次追加的第一行**(它就在旧那一位上)', () => {
    // 翻页前:[行 a,块尾 more];按下 more(at=1);翻页后:[a, b, c, more]
    const before = state({ selection: { id: 'more:chats', by: 'pointer', at: 1 } })
    const after = T.reconcile(before, seq('a', 'b', 'c', 'more:chats2'))
    expect(after.selection).toEqual({ id: 'b', by: 'reconcile', at: 1 })
  })

  it('行没了 → 按旧下标夹到最近的幸存项', () => {
    const before = state({ selection: { id: 'gone', by: 'keyboard', at: 5 } })
    expect(T.reconcile(before, seq('a', 'b')).selection).toEqual({ id: 'b', by: 'reconcile', at: 1 })
  })

  it('序列空了 → 没有活动项', () => {
    const before = state({ selection: { id: 'a', by: 'keyboard', at: 0 } })
    expect(T.reconcile(before, []).selection).toEqual({ id: null, by: 'reconcile', at: -1 })
  })

  it('**它不产生任何滚动指令**:`by` 恒是 reconcile,而且除了 selection 什么都没动', () => {
    const before = state({
      query: 'jira',
      picked: ['x'],
      committedKey: 'k1',
      selection: { id: 'gone', by: 'keyboard', at: 0 },
    })
    const after = T.reconcile(before, seq('a', 'b'))
    expect(after.selection.by).toBe('reconcile')
    // 反证的着力点:加一格 tick / 一句滚动,这一条当场红。
    expect({ ...after, selection: null }).toEqual({ ...before, selection: null })
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
  })
})

/* ── 历史 ──────────────────────────────────────────────────────────────── */

describe('历史', () => {
  it('记的是此刻这一步,活动项按 **id** 记(不是下标)', () => {
    const before = state({
      query: 'jira',
      scope: 'messages',
      selection: { id: 'row:messages:m1', by: 'keyboard', at: 3 },
    })
    expect(T.entryOf(before)).toEqual({
      query: 'jira',
      capability: 'messages',
      filters: INITIAL_FILTERS,
      activeId: 'row:messages:m1',
    })
  })

  it('续搜:**先记当前这一步,再换状态**;两格一起入栈', () => {
    const before = state({ query: 'jira', scope: 'messages' })
    const after = T.runContinuation(before, {
      kind: 'scope',
      labelKey: 'search.continuation.inSession' as never,
      chip: { key: 'sessionId', value: 's1', label: '那间会话' },
    })
    expect(after.history.entries).toHaveLength(2)
    expect(after.history.entries[0].filters.scope).toBeUndefined()
    expect(after.history.entries[1].filters.scope?.value).toBe('s1')
    expect(after.filters.scope?.value).toBe('s1')
    expect(canGoBack(after.history)).toBe(true)
  })

  it('枢轴:档 + 词 + 片三格一起换', () => {
    const before = state({ query: 'jira', scope: 'chats' })
    const after = T.runContinuation(before, {
      kind: 'pivot',
      labelKey: 'search.continuation.messagesOf' as never,
      capability: 'messages',
      query: '',
      chip: { key: 'sessionId', value: 's1', label: '那间会话' },
    })
    expect(after.scope).toBe('messages')
    expect(after.query).toBe('')
    expect(after.filters.scope?.value).toBe('s1')
  })

  it('⌘[ 还原四格,`by` 是 history(那一下**要**滚到还原的项上)', () => {
    let s = state({ query: 'jira', scope: 'messages', selection: { id: 'row:m1', by: 'keyboard', at: 2 } })
    s = T.pushCommit(s)
    s = T.setQuery(s, 'kimi')
    s = T.pushCommit(s)
    const back = T.stepHistory(s, 'back')
    expect(back.query).toBe('jira')
    expect(back.selection).toEqual({ id: 'row:m1', by: 'history', at: -1 })
  })

  it('走不动就**原样返回**(调用方据此判「这一下什么都没发生」)', () => {
    const before = state()
    expect(T.stepHistory(before, 'back')).toBe(before)
    expect(T.stepHistory(before, 'forward')).toBe(before)
  })
})

describe('reset', () => {
  it('回到出厂(拍点 G 保旧:词 / 档 / 片 / 历史 / 选中全没了)', () => {
    expect(T.reset()).toBe(T.initialSearchState)
  })
})
