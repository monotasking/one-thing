import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import { useMutation } from '../../data/kernel'
import type { HeldSnapshot } from '../../data/kernel'
import {
  searchLoadMore,
  searchLoadMoreKey,
  searchScanBlock,
  useSearchListing as useListingQuery,
} from '../../data/search-listing-source'
import type { SearchBlock, SearchListing } from '../../data/search-listing-source'
import { moreStateOf } from '../paging'
import type { MoreState } from '../paging'
import { sequenceOf } from '../sequence'
import type { SearchItem } from '../sequence'
import { useSearchStore } from '../store'

/**
 * **屏幕上这一张清单**(检索面终稿 附录 B §1「useSearchListing」那一行 + §6
 * 「组件订阅面」)。第 ⑦ 步换心:面板从这一只 hook 拿全部与数据有关的事实,
 * 除此之外**一个字都不从数据层读**。
 *
 * 交出去四样:
 *  · `held` —— `useQueryHeld` 的快照(`data / phase / inflight / error / stale /
 *    shownKey`)。换词在飞的那一段,上一把键的行留在屏上(律②′);
 *  · `blocks` —— 屏上那几块(零命中的块也在表里,**画不画由 `SearchBlockRows` 判**);
 *  · `sequence` —— ↑↓ 走得到的那一串项(行 → 块尾项 → … → 动作项);
 *  · `moreStateOf` / `canLoadMore` —— 块尾那条项此刻是什么、按不按得动。
 *
 * ── 这里是**唯一允许依赖序列的 effect** ────────────────────────────────────
 * `useLayoutEffect([sequence]) → store.reconcile(sequence)`:新序列到了,活动项
 * 落在哪。它**只落位,不滚动**(`reconcile` 一律记 `by: 'reconcile'`,而滚动那条
 * effect 只认 keyboard / pointer / history 三种)—— 这是「行集增长绝不触发滚动」
 * 四条不变量里的第三条。评审点名的「`activeAfterGrowth` 的调用方没有归属」由
 * 这一行结清:归属就是这只 hook,别处一个字都不许再调它。
 *
 * 为什么是 `useLayoutEffect` 而不是 `useEffect`:活动项决定 `aria-selected` 与
 * `--st-sel`,晚一帧落位就是屏幕上闪一下「谁都没选中」。
 *
 * ── 忙态怎么读(律③:反馈逐块)──────────────────────────────────────────
 * 翻页那只 mutation 按 `${key}#${capability}` 记账,所以「这一块在飞吗」是
 * `pendingKeys.has(...)`。整格在飞(头页重拉 / 回放链)或屏上这份是上一把键的,
 * 也算忙 —— **闸②**:回放链与 `loadMore` 因此永不重叠。
 */

const NO_BLOCKS: readonly SearchBlock[] = []

export interface SearchListingView {
  /**
   * **订着的那把键**(`store.committedKey`)。
   *
   * 它与 `held.shownKey` 是两个东西,而且混用会静默出错:`shownKey` 是 kernel 交出
   * 来的**格名**(带族名前缀 `search.listing:…`),它只配当一个身份串(滚动记忆的
   * 键);而翻页 / 重拉要的是**族里那把键** —— 拿 `shownKey` 去 `get()` 会建出一格
   * 崭新的空格,`patch` 打在那上面等于什么都没发生(第 ⑦ 步真撞上过,读数是
   * 「APPEND prev=undefined」)。
   */
  key: string
  /** 屏上那份答案(可能是上一把键的 —— `stale` 说)。 */
  held: HeldSnapshot<SearchListing>
  blocks: readonly SearchBlock[]
  sequence: readonly SearchItem[]
  /** 这一块的块尾项此刻是什么(四态 + 一条读数 + 不画)。 */
  moreStateOf(capability: string): MoreState
  /** 这一块此刻能不能再要一页(闸②;项按下去先问它)。 */
  canLoadMore(capability: string): boolean
}

export function useSearchListing(): SearchListingView {
  const committedKey = useSearchStore(st => st.committedKey)
  const reconcile = useSearchStore(st => st.reconcile)
  const held = useListingQuery(committedKey)
  /*
   * 订的是**整只 mutation**,读的是逐块那一格。`useAsyncPending` 一次只订一把键,
   * 而这里要的是「每一块各自忙不忙」——块数由后端说,hook 不能在循环里调。
   */
  const loadMore = useMutation(searchLoadMore)

  const blocks = held.data?.blocks ?? NO_BLOCKS
  /** 整格在飞 / 屏上这份是别的键的 —— 两种都不许翻页(闸②)。 */
  const busy = held.inflight || held.stale
  const pendingKeys = loadMore.pendingKeys

  const pendingOf = useCallback(
    (capability: string) => pendingKeys.has(searchLoadMoreKey(committedKey, capability)),
    [pendingKeys, committedKey],
  )

  const stateOf = useCallback(
    (capability: string): MoreState => {
      const block = blocks.find(one => one.capability === capability)
      if (block === undefined) return { kind: 'none' }
      return moreStateOf(block, pendingOf(capability), busy)
    },
    [blocks, pendingOf, busy],
  )

  const sequence = useMemo(
    () => sequenceOf(held.data, block => moreStateOf(block, pendingOf(block.capability), busy)),
    [held.data, pendingOf, busy],
  )

  const canLoadMore = useCallback(
    (capability: string) => !busy && !pendingOf(capability),
    [busy, pendingOf],
  )

  useLayoutEffect(() => {
    reconcile(sequence)
  }, [sequence, reconcile])

  /*
   * ── **「不挑」那一档没问的那几块,在这里补上**(09-07 事故第二条修)──────
   *
   * 后端在 `all` 里对去外部枚举的那几路当场答一句「这次没问」(`groups[].deferred`),
   * 别的块因此立刻上屏;壳随即对那一档发一发**单类**请求(同词同片同页大小),
   * 落地 `patch` 填进那一块。
   *
   * **为什么落在这只 hook 里,而不是 fetcher 里**:fetcher 是在格 `settle` 之前
   * 跑的,它当场发出去的那一发有可能先落地 —— 那时 `patch` 打在上一份数据上,
   * 紧接着 settle 把它整份盖掉,补扫就凭空消失。effect 跑在数据已经进格之后,
   * 这条竞态在结构上不存在。顺带还有一条好处:面板收起来(这只 hook 卸载)之后
   * 不会再有新的扫盘发出去。
   *
   * 三道闸都不是纪律:①`scanning` 由 `landScan` / `landScanError` 摘掉,落地一次
   * 就不会再触发;②mutation 按 `key#capability` 折叠同键并发(律③),重复渲染
   * 只发一次;③换词换键 = 换了 `committedKey`,旧格的补扫在 `ensureSearchListing`
   * 里被 abort,落地的补丁也只会打在没人看的旧格上。
   */
  useEffect(() => {
    for (const block of blocks) {
      if (block.scanning !== true) continue
      if (pendingKeys.has(searchLoadMoreKey(committedKey, block.capability))) continue
      void searchScanBlock.run({ key: committedKey, capability: block.capability })
    }
  }, [blocks, committedKey, pendingKeys])

  return { key: committedKey, held, blocks, sequence, moreStateOf: stateOf, canLoadMore }
}
