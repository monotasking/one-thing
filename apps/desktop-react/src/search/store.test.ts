import { beforeEach, describe, expect, it } from 'vitest'
import { INITIAL_FILTERS } from './filters'
import * as T from './state'
import { searchScrollOf, useSearchStore } from './store'

/**
 * 检索面 store 的判据。
 *
 * 它是 `state.ts` 的一层壳,所以这里**不重验判据**(那些在 `state.test.ts` 的 26 例
 * 里)——这份验的是壳自己该守的三件事:
 *  1. 每个 action 落的就是同名那只纯函数(拿纯函数算一遍对答案,不手抄期望值);
 *  2. 恒等变换不换 store 引用(订阅者不该被一次「什么都没变」叫醒);
 *  3. `reset()` 回到出厂那一份**恒等引用**(HMR dispose 复用的就是它)。
 */

beforeEach(() => {
  useSearchStore.getState().reset()
})

const snap = () => useSearchStore.getState()
/** store 上那几格状态(把 action 摘掉),用来与纯函数的结果对答案。 */
function stateOf(): T.SearchState {
  const s = snap()
  return {
    query: s.query,
    scope: s.scope,
    filters: s.filters,
    committedKey: s.committedKey,
    selection: s.selection,
    picked: s.picked,
    history: s.history,
    scrollByKey: s.scrollByKey,
  }
}

describe('每个 action 一句 set(T.f)', () => {
  it('主语三格 + 订阅键', () => {
    const store = snap()
    store.setQuery('jira')
    store.setScope('messages')
    store.setFilters({ ...INITIAL_FILTERS, role: 'user' })
    store.commitKey('k1')
    let expected = T.setQuery(T.initialSearchState, 'jira')
    expected = T.setScope(expected, 'messages')
    expected = T.setFilters(expected, { ...INITIAL_FILTERS, role: 'user' })
    expected = T.commitKey(expected, 'k1')
    expect(stateOf()).toEqual(expected)
  })

  it('换一张列表:换键 + 活动项归零 + 清多选', () => {
    const store = snap()
    store.setActive('row:a', 'keyboard', 2)
    store.pick('row:a')
    store.resetForListing('k2')
    expect(stateOf().committedKey).toBe('k2')
    expect(stateOf().selection).toEqual({ id: null, by: 'reconcile', at: -1 })
    expect(stateOf().picked).toEqual([])
  })

  it('对账落位,而且 `by` 恒是 reconcile(不滚)', () => {
    const store = snap()
    store.setActive('gone', 'keyboard', 1)
    store.reconcile([{ id: 'a', kind: 'row' }, { id: 'b', kind: 'row' }])
    expect(stateOf().selection).toEqual({ id: 'b', by: 'reconcile', at: 1 })
  })

  it('续搜两格入栈,历史走得回来', () => {
    const store = snap()
    store.setQuery('jira')
    store.runContinuation({
      kind: 'scope',
      labelKey: 'search.continuation.inSession' as never,
      chip: { key: 'sessionId', value: 's1', label: '那间会话' },
    })
    expect(stateOf().filters.scope?.value).toBe('s1')
    store.stepHistory('back')
    expect(stateOf().filters.scope).toBeUndefined()
    expect(stateOf().query).toBe('jira')
  })

  it('滚动记忆两口:写进 store,`searchScrollOf` 读得出来', () => {
    snap().setScroll('k1', 120)
    expect(searchScrollOf('k1')).toBe(120)
    expect(searchScrollOf('k2')).toBe(0)
  })
})

describe('壳自己该守的两件事', () => {
  it('恒等变换**不换 store 引用**(订阅者不被白叫醒)', () => {
    const store = snap()
    store.setQuery('jira')
    const before = snap()
    store.setQuery('jira')
    store.setScope(before.scope)
    store.commitKey(before.committedKey)
    store.setScroll('k1', 0)
    expect(snap()).toBe(before)
  })

  it('reset() 回到出厂那一份恒等引用(HMR dispose 复用的就是它)', () => {
    const store = snap()
    store.setQuery('jira')
    store.setActive('row:a', 'pointer')
    store.setScroll('k1', 40)
    store.reset()
    expect(stateOf()).toEqual(T.initialSearchState)
    expect(stateOf().selection).toBe(T.initialSearchState.selection)
    expect(stateOf().scrollByKey).toBe(T.initialSearchState.scrollByKey)
  })
})
