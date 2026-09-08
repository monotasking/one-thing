import type { SearchBlock, SearchListing } from '../data/search-listing-source'
import { moreStateOf, type MoreState } from './paging'

/**
 * **序列** —— 一张清单 → ↑↓ 走得到的那一串项(检索面终稿 附录 B §1「纯模型」
 * / §5.4 ②)。纯函数,不认识 React。
 *
 * 照 `src/expose/list-model.ts` 的判例:「屏幕上有哪些项」与「方向键走哪些项」
 * 由**同一次 flatten** 产出,结构上不可能漂移。那边的教训是两处各算一遍
 * (`buildGroups` 画、`visibleCardIds` 走),这边一开始就只有一处。
 *
 * ── 项的身份是 id,不是下标(§5.4 ②)────────────────────────────────────
 * `row:<cap>:<id>` / `more:<cap>` / `action:<cap>:<id>`。翻页只在块末尾追加,
 * 于是**存量项的 id 一个字不变** —— 活动位按 id 记,列表怎么长它都还在原处;
 * 而按下标记的话,追加一页就得把活动位重算一遍(那正是「点了 Load more 跳回
 * 顶部」链条上的一环)。
 *
 * ── 项不认前缀 ──────────────────────────────────────────────────────────
 * `SearchItem` 上 `kind` / `block` / `rowId` 三格是**分开摆着的事实**,
 * 消费方不许去解析 `id` 那个串。id 只是身份,不是编码。
 */

/**
 * 三种序列项。
 *
 * 这三个名字在这里出现**不是**「按能力枚举」——它们说的是**这张清单的结构**
 * (块里的行 → 块尾那条 → 末尾的动作),与有哪些能力无关。「这一种项怎么画、
 * 按下去干什么」才是开放的,那归 `items/registry.ts`。
 */
export const SEARCH_ITEM_KINDS = {
  row: 'row',
  more: 'more',
  action: 'action',
} as const

export type SearchItemKindName = (typeof SEARCH_ITEM_KINDS)[keyof typeof SEARCH_ITEM_KINDS]

/** 序列里的一项。`kind` 是开放的:注册表里有几种就有几种。 */
export interface SearchItem {
  /** 这一项在序列里的身份。**稳定** —— 同一行不论列表怎么长都是同一个串。 */
  readonly id: string
  readonly kind: string
  /** 哪一块(能力 id)。页级动作没有块。 */
  readonly block?: string
  /** 哪一行 / 哪一条动作(它自己那套 id)。块尾项没有。 */
  readonly rowId?: string
  /**
   * **这一块的第一行**(只有行项才可能为真)。
   *
   * 块之间那一格空 + 一条发线(R1:组头退役之后,块边界只剩这一条)由它画。
   * 判据在这里而不是在画法里,理由与「id 不认前缀」同一条:画法不许去数
   * 「我是第几行、上一行属于哪一块」—— 那是序列这一次遍历本来就知道的事。
   */
  readonly first?: boolean
}

/** 行的身份。 */
export function rowItemId(capability: string, rowId: string): string {
  return `${SEARCH_ITEM_KINDS.row}:${capability}:${rowId}`
}

/** 块尾那条的身份。**一块一条**,所以只有块名。 */
export function moreItemId(capability: string): string {
  return `${SEARCH_ITEM_KINDS.more}:${capability}`
}

/** 一条动作的身份。 */
export function actionItemId(capability: string, actionId: string): string {
  return `${SEARCH_ITEM_KINDS.action}:${capability}:${actionId}`
}

/** 页级动作没有归属的块;它们仍然要有一个身份,用空块名。 */
const PAGE_LEVEL = ''

/** 一张空序列的恒等引用(律④:「一条都没有」不该每次换一张新的空表)。 */
export const EMPTY_SEQUENCE: readonly SearchItem[] = []

/**
 * 这一块的块尾项此刻是什么。缺省是「不忙」—— 忙态由消费方
 * (`useAsyncPending(searchLoadMore, key#cap)` 与 `held.inflight`)注入,
 * 纯函数不去问谁在飞。
 */
export type MoreStateOf = (block: SearchBlock) => MoreState

const IDLE_MORE: MoreStateOf = block => moreStateOf(block, false, false)

/**
 * 一张清单 → 一串项。**一次遍历**。
 *
 * 次序就是屏幕上的次序:
 *  1. 逐块:这一块的行 → 这一块的块尾项(**仅当它是 item**:`end` 是读数、
 *     `none` 什么都不画,两者都不进序列);
 *  2. 全部块走完之后,才是动作项 —— 它们在分隔线**下面**,不计任何数、
 *     不参与「零结果」判据,是序列的**末项**(R3)。
 *
 * 零命中的块一个像素都不占,所以它既不产行、也不产块尾项(`moreStateOf` 的
 * 第一条就是 `none`)—— 用户 09-05 裁定的「零命中不占行」在序列这一侧是
 * **自动成立**的,不需要第二处判据。
 */
export function sequenceOf(
  listing: SearchListing | undefined,
  more: MoreStateOf = IDLE_MORE,
): readonly SearchItem[] {
  if (listing === undefined) return EMPTY_SEQUENCE
  const items: SearchItem[] = []

  for (const block of listing.blocks) {
    for (const [at, row] of block.rows.entries()) {
      items.push({
        id: rowItemId(block.capability, row.id),
        kind: SEARCH_ITEM_KINDS.row,
        block: block.capability,
        rowId: row.id,
        // 只在真的是块首那一行时才带这一格 —— 缺席与 `false` 同义,不摆一格恒假的事实。
        ...(at === 0 ? { first: true } : {}),
      })
    }
    const state = more(block)
    // `scanning` 与 `loading` 同一条理由进序列:焦点不该在等待途中蒸发。
    if (
      state.kind === 'more'
      || state.kind === 'loading'
      || state.kind === 'scanning'
      || state.kind === 'error'
    ) {
      items.push({
        id: moreItemId(block.capability),
        kind: SEARCH_ITEM_KINDS.more,
        block: block.capability,
      })
    }
  }

  for (const block of listing.blocks) {
    for (const action of block.actions ?? []) {
      items.push({
        id: actionItemId(block.capability, action.id),
        kind: SEARCH_ITEM_KINDS.action,
        block: block.capability,
        rowId: action.id,
      })
    }
  }
  for (const action of listing.actions ?? []) {
    items.push({
      id: actionItemId(action.capability ?? PAGE_LEVEL, action.id),
      kind: SEARCH_ITEM_KINDS.action,
      ...(action.capability === undefined ? {} : { block: action.capability }),
      rowId: action.id,
    })
  }

  return items.length === 0 ? EMPTY_SEQUENCE : items
}

/* ── 反查(项 → 它指的那件东西)────────────────────────────────────────── */

/** 这一项属于哪一块。 */
export function blockOfItem(
  listing: SearchListing | undefined,
  item: SearchItem,
): SearchBlock | undefined {
  if (listing === undefined || item.block === undefined) return undefined
  return listing.blocks.find(block => block.capability === item.block)
}

/** 这一项指的那一行(不是 `row` 项就没有)。 */
export function rowOfItem(listing: SearchListing | undefined, item: SearchItem) {
  if (item.kind !== SEARCH_ITEM_KINDS.row || item.rowId === undefined) return undefined
  return blockOfItem(listing, item)?.rows.find(row => row.id === item.rowId)
}

/** 这一项指的那条动作(块级的先找,再找页级的)。 */
export function actionOfItem(listing: SearchListing | undefined, item: SearchItem) {
  if (listing === undefined) return undefined
  if (item.kind !== SEARCH_ITEM_KINDS.action || item.rowId === undefined) return undefined
  const inBlock = blockOfItem(listing, item)?.actions?.find(action => action.id === item.rowId)
  if (inBlock !== undefined) return inBlock
  return listing.actions?.find(action => action.id === item.rowId)
}

/** 这一项在序列里的下标;不在就是 -1(与 `indexOf` 同一口径)。 */
export function indexOfItem(sequence: readonly SearchItem[], id: string | null): number {
  if (id === null) return -1
  return sequence.findIndex(item => item.id === id)
}
