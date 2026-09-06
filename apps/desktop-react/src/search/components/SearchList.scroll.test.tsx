import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { SearchResult } from '@shared/ipc/search'
import { SearchList } from './SearchList'
import type { SearchBlock, SearchListing } from '../../data/search-listing-source'
import type { HeldSnapshot } from '../../data/kernel'
import type { SearchItemView } from '../items'
import '../items'
import '../targets'
import { sequenceOf } from '../sequence'
import type { SearchItem } from '../sequence'
import { useSearchStore } from '../store'
import type { SearchListingView } from '../hooks/useSearchListing'
import { moreStateOf } from '../paging'
import { translate } from '../../i18n'
import type { MessageKey } from '../../i18n'

/**
 * **滚动那条 effect 的判据**(检索面终稿 §5.4 ③ / 附录 B §4 那张表最后一列;
 * 第 ⑦ 步交卷时留的账:「滚动 effect 反证未咬住」)。
 *
 * ── 第 ⑦ 步为什么没咬住 ────────────────────────────────────────────────
 * 那一批的反证是在真机门里做的:`reconcile` 把活动位落到**恰好已经在视野里**的那一行,
 * 于是 `scrollIntoView({block:'nearest'})` 是个恒等操作 —— 拆掉 `by === 'reconcile'`
 * 那句早退,`scrollTop` 读数一个像素都不变,门照样绿。**判据不该是「屏幕动没动」,
 * 该是「有没有下过那条滚动指令」** —— 后者在 jsdom 里正好数得清楚
 * (`Element.prototype.scrollIntoView` 在 jsdom 里根本没有实现,装一只 mock 上去,
 * 调用次数就是读数)。
 *
 * ── 两条,一正一反 ──────────────────────────────────────────────────────
 *  · `store.reconcile(sequence)` 落位之后 **零次** —— 行集长了 / 换了一份答案时活动位
 *    跟着落一下,那一下不该动屏幕(用户按「加载更多」跳回顶部的另一半病根);
 *  · `setActive(id, 'keyboard')` 之后 **恰一次** —— 键盘走位当然要把那一项带进视野。
 *
 * 拆掉 `SearchList` 里 `selection.by === 'reconcile'` 那句早退,第一条当场红
 * (0 → 1):落位那一下会真的下一条滚动指令。
 */

/* ── 装置 ──────────────────────────────────────────────────────────────── */

function result(id: string): SearchResult {
  return {
    id,
    type: 'message',
    title: id,
    target: { kind: 'message', payload: { sessionId: 's1', messageId: id } },
  }
}

function block(rows: string[]): SearchBlock {
  return {
    capability: 'messages',
    rows: rows.map(result),
    exhausted: true,
    pages: 1,
  }
}

function listingOf(rows: string[]): SearchListing {
  return { mode: 'single', query: '', blocks: [block(rows)] }
}

function held(data: SearchListing): HeldSnapshot<SearchListing> {
  return {
    data,
    phase: 'ready',
    inflight: false,
    error: undefined,
    updatedAt: 1,
    dataRev: 1,
    stale: false,
    shownKey: 'search.listing:k1',
  }
}

const t = (key: MessageKey, vars?: Record<string, string | number>) => translate('zh', key, vars)

function viewOf(): SearchListingView {
  const data = listingOf(['a', 'b', 'c'])
  const snapshot = held(data)
  const sequence = sequenceOf(data, one => moreStateOf(one, false, false))
  return {
    key: 'k1',
    held: snapshot,
    blocks: data.blocks,
    sequence,
    moreStateOf: () => ({ kind: 'none' }),
    canLoadMore: () => true,
  }
}

function itemViewOf(): SearchItemView {
  return {
    t,
    spaceId: 'w1',
    defaultSpaceId: 'w1',
    allSpaces: false,
    moreStateOf: () => ({ kind: 'none' }),
    onPointer: () => undefined,
    onContextMenu: () => undefined,
    picked: () => false,
    rowIndexOf: () => 0,
  }
}

function renderList(view: SearchListingView) {
  return render(
    <SearchList
      listing={view}
      itemView={itemViewOf()}
      query=""
      typed=""
      t={t}
      labelOf={(capability: string) => capability}
      indexReadout={undefined}
      onRetryBlock={() => undefined}
    />,
  )
}

/* ── 用例 ──────────────────────────────────────────────────────────────── */

describe('SearchList:滚动只随选中变,而且 reconcile 那一下不滚', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    useSearchStore.getState().reset()
    scrollIntoView = vi.fn()
    // jsdom 里这只方法本来就不存在 —— 装上去,调用次数就是「下过几条滚动指令」。
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
  })

  afterEach(() => {
    cleanup()
    useSearchStore.getState().reset()
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('reconcile 落位:活动项换了,**一条滚动指令都不下**', () => {
    const view = viewOf()
    renderList(view)
    // 挂载那一刻还没有活动项(selection.id === null),不该有任何调用。
    expect(scrollIntoView).toHaveBeenCalledTimes(0)

    act(() => {
      useSearchStore.getState().reconcile(view.sequence)
    })

    // 落位真的发生了(否则这条用例是在验一个空转)。
    const selection = useSearchStore.getState().selection
    expect(selection.id).toBe(view.sequence[0].id)
    expect(selection.by).toBe('reconcile')
    // 而屏幕上一条滚动指令都没有下过。
    expect(scrollIntoView).toHaveBeenCalledTimes(0)
  })

  it('键盘走位:恰一次,落在那一项自己的 [data-item-id] 上', () => {
    const view = viewOf()
    const { container } = renderList(view)
    const target: SearchItem = view.sequence[1]

    act(() => {
      useSearchStore.getState().setActive(target.id, 'keyboard')
    })

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    // 调用挂在那一项自己的节点上(effect 是按 `data-item-id` 认项的)。
    const node = container.querySelector(`[data-item-id="${target.id}"]`)
    expect(node).not.toBeNull()
    expect(scrollIntoView.mock.instances[0]).toBe(node)
  })
})
