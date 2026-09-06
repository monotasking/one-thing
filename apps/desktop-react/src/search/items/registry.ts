import type { ComponentType, MouseEvent as ReactMouseEvent } from 'react'
import type { SearchActionDescriptor, SearchResult } from '@shared/ipc/search'
import type { SearchListing } from '../../data/search-listing-source'
import type { TFn } from '../../i18n'
import { getLogger } from '../../services/log'
import type { MoreState } from '../paging'
import type { SearchItem } from '../sequence'

/**
 * **序列项的开放注册表**(检索面终稿 附录 B §0 ③)。
 *
 * 仓根 CLAUDE.md 09-02 那条立法(「凡按能力枚举的地方改成能力自述、别人读表」)
 * 在**组件尺度**上的落地:行 / 块尾「加载更多」/ 动作行三种项各是一个模块 +
 * 一行注册,`sequence.ts` 只负责拼接,`reconcile` 与 ⏎ **只读表**。
 *
 * 两路评审都点名的那一处 `switch (kind)` 因此不存在:加一种序列项(例如「块级
 * 失败可重试读数项」)= `items/<kind>.tsx` + 一行注册,面板 / 键盘 / 分页
 * 一个字不改。
 *
 * 体例逐条照 `../targets/registry.ts`(同一族的另一张表):重复注册抛错、注销
 * 只删自己那一条、查不到不是错误(答 `undefined`,dev 下每种 kind 只 warn 一次)。
 */

/**
 * 一项画出来时**宿主给的能力**(与 `SearchItemContext` 同一条分界:宿主给能力,
 * 项只说要画什么 / 要干什么)。这里没有 store、没有数据层、没有 Placement ——
 * 所以项模块脱离 React 树也测得动。
 *
 * 第 ⑦ 步把它立起来:第 ⑤ 步那三个 `Render` 只是最小骨架(徽 / 正文 / 出处 /
 * 右列 / 高亮 / i18n 全缺),而那几样每一样都要一件宿主才拿得到的东西。
 */
export interface SearchItemView {
  /** 字典。**句子由壳按键查出**(R12);项模块里一句成品文案都没有。 */
  t: TFn
  /** 当前空间 / 缺省空间 / 此刻是不是「全部空间」那一档 —— 事实徽读它们。 */
  spaceId: string
  defaultSpaceId: string
  allSpaces: boolean
  /** 这一块的块尾项此刻是什么(只有 `more` 那一种读它)。 */
  moreStateOf(capability: string): MoreState
  /** 点一项(素点 / ⇧⌘ 点 / 按块尾项 / 按动作行)。 */
  onPointer(item: SearchItem, event: ReactMouseEvent): void
  /** 右键一项(今天只有行有菜单;别的项按了不开表)。 */
  onContextMenu(item: SearchItem, event: ReactMouseEvent): void
  /** 这一项是不是被「挑」中了(多选;块尾项与动作行恒假)。 */
  picked(item: SearchItem): boolean
  /** 这一行在整张列表里的第几行(`data-row`;非行项给 `undefined`)。 */
  rowIndexOf(item: SearchItem): number | undefined
}

/** 一项画出来时拿到的东西。**只读事实 + 此刻的词 + 宿主给的那几样能力**。 */
export interface SearchItemRenderProps {
  item: SearchItem
  /** 屏上那份清单(项只带 id,内容从这里查:`rowOfItem` / `actionOfItem`)。 */
  listing: SearchListing | undefined
  /** 造这份清单用的词(高亮用)。**不是输入框里那个** —— 换词在飞时两者不同。 */
  query: string
  /** 这一项是不是活动项(`aria-selected` 与 `--st-sel` 读它)。 */
  active: boolean
  view: SearchItemView
}

/**
 * 一项按下去时手上的窄回调。**宿主给能力,项只说要干什么。**
 *
 * 与 `SearchTargetContext` 是同一条分界:这里没有 store、没有数据层、没有
 * Placement —— 三个口子由面板填,项模块因此可以脱离 React 树被测。
 */
export interface SearchItemContext {
  /** 屏上那份清单。 */
  listing: SearchListing | undefined
  /** 打开一行(落点最终由目标渲染器给)。 */
  openRow(row: SearchResult, capability: string): void
  /** 让这一块再长一页。`cursor` 是**发车这一刻**那一块的游标(闸①)。 */
  loadMore(capability: string, cursor: string): void
  /** 跑一条动作。 */
  runAction(action: SearchActionDescriptor, capability: string | undefined): void
  /**
   * 这一块此刻能不能翻页。缺席 = 能。
   *
   * 判据在面板那一侧(`pending ∨ held.inflight ∨ held.stale`,§5.3 闸②)——
   * 纯模型不去问谁在飞,但**「按下无效」这件事本身归项**:它是这一项的语义,
   * 不该在每个调用点各判一遍。
   */
  canLoadMore?(capability: string): boolean
}

export interface SearchItemKind {
  /** 表里的键,也是 `data-item-kind` 的值。 */
  kind: string
  /** 画这一项。 */
  Render: ComponentType<SearchItemRenderProps>
  /** ⏎ / 点击落在这一项上时干什么。**落点只有这一处**,面板不再 switch。 */
  activate(item: SearchItem, ctx: SearchItemContext): void
  /**
   * **列表长了一页之后,这一项还在吗**(`reconcile` 读它)。
   *
   * 为什么不是「在新序列里找一下 id」:那件事 `reconcile` 自己就会做,而它答不出
   * 「块尾那条项消失是因为取尽了(该把活动位交给本次追加的第一行),还是因为
   * 这一块整个没了」。判据只有产这一种项的模块知道,所以它是表上的一格。
   */
  survivesGrowth(item: SearchItem, next: SearchListing | undefined): boolean
}

const kinds = new Map<string, SearchItemKind>()

/** 重复注册 = 抛错。返回注销 —— 与目标渲染器那张表逐字同款。 */
export function registerItemKind(kind: SearchItemKind): () => void {
  if (kinds.has(kind.kind)) {
    throw new Error(`search item kind already registered: ${kind.kind}`)
  }
  kinds.set(kind.kind, kind)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 只删自己那一条:注销晚到时不许把后来注册的同名件顺手删掉。
    if (kinds.get(kind.kind) === kind) kinds.delete(kind.kind)
  }
}

const warned = new Set<string>()

/** 查不到**不是错误**:答 `undefined`,由调用方当没这一项处理。 */
export function resolveItemKind(kind: string): SearchItemKind | undefined {
  const found = kinds.get(kind)
  if (found === undefined && !warned.has(kind)) {
    warned.add(kind)
    getLogger('search.items').warn('no renderer for this item kind; skipping it', { kind })
  }
  return found
}

/** 表里现在有哪些 kind(测试与门读它)。 */
export function itemKindNames(): string[] {
  return [...kinds.keys()]
}

/** 测试用:清表重来。产品代码一处都不该调它。 */
export function resetItemKinds(): void {
  kinds.clear()
  warned.clear()
}
