import { createContext } from 'react'

/**
 * **一格内容的身子挂在哪儿**(W6-a,设计 `workbench-tabs-2026-09.md` §11 拍点 8:
 * 「一格都不重挂:换序、二合一、拆开、换比例四步内容根节点同一 DOM」)。
 *
 * ── 它为什么必须存在 ────────────────────────────────────────────────────
 * 二合一改的是**标签的身份**:两格普通 tab(`file:/a` 与 `session:x`)换成一格
 * 复合 tab(`pair:file:/a|session:x`)。若内容层照旧按**标签**分格,React 那一侧
 * 看到的就是「两个 key 没了、一个新 key 来了」—— 两块内容当场卸载重挂:聊天区
 * 重跑一次进场、查看器丢掉滚动位与未保存的编辑。而用户做的只是把两块东西摆到
 * 一起看。
 *
 * 所以内容层按**内容**分格(`refId`,复合的摊开成它装着的那几格),而
 * 「这一格此刻画在屏幕上哪一块地方」由这张表回答:内容那一侧交出一个**身份恒定
 * 的 holder**(一个 `display: contents` 的 `<div>`),画法那一侧(普通 tab 的一层、
 * 两格标签的左右格)交出一个**槽**,两者按 `refId` 配对,配上就 `appendChild`。
 * `appendChild` 是**移动**不是复制 —— 前后是同一个 DOM 节点,React 那一侧一格
 * 都没动。这与 `PaneLeaf` 把整片叶的身子搬进全屏层用的是同一手(判词与三条
 * 实测读数写在那只文件头上),只是粒度从「一片叶」细到「一格内容」。
 *
 * ── 两边谁先到都行 ──────────────────────────────────────────────────────
 * 一次提交里,槽的 ref 回调与内容层的 layout effect 谁先跑取决于它们在树里的
 * 位置 —— 那是实现细节,不该变成这张表的前提。所以两只登记口**各自登记完就
 * 试一次配对**,配不上就等对面来。少了这一条,「先并再拆再并」这种连着来的
 * 手势里总有一次会落在错的次序上。
 *
 * ── 摘不掉的那一格是有意的 ──────────────────────────────────────────────
 * 槽没了(两格标签被拆开)时 holder **留在原地不动**:它下一拍就会被新的槽认领,
 * 而中间那一拍把它摘到文档外面等于让内容量到 0 高度(与 `PaneLeaf.mountBody`
 * 那条判例逐字同源)。真正该收尸的是**内容层自己卸载**那一路,它摘的是自己那格
 * 登记 —— 而 holder 随它一起被 React 拆掉。
 */

/*
 * ── 键是「片叶 + 内容」,不是只有内容(09-24 报障「文件打开后主区只剩标签」)──
 * 从前两张表只按 `refId` 记。可文件不是单例 —— 同一份文件可以在两片叶里各开一格
 * (W3「拖一份到旁边对照着看」),于是两片叶各交一个 holder、各交一个槽,却只剩
 * 一格表位:后到的那片叶的槽认领了先到那片叶的 holder,`appendChild` 把主区那块
 * 内容**搬**进了右架子,主区只剩标签、身子空了。配对只该发生在同一片叶里,所以
 * 两侧都带上所在那片叶的 id(`ContentSlotScope`,由 `PaneLeaf` 提供,穿过 portal)。
 */

/** 这一格内容的身子与槽属于哪片叶。`PaneLeaf` 在它的 portal 外面提供。 */
export const ContentSlotScope = createContext<string>('')

/** 表键:片叶 + 内容。 */
export function slotKeyOf(scope: string, id: string): string {
  return `${scope}\u0000${id}`
}

/** 内容那一侧交出来的身子。键 = `slotKeyOf(片叶, refId)`。 */
const holders = new Map<string, HTMLElement>()
/** 画法那一侧交出来的槽。键 = `slotKeyOf(片叶, refId)`。 */
const slots = new Map<string, HTMLElement>()

/** 配一次对。两边都在、而且还没挂上去时才动 DOM。 */
function attach(key: string): void {
  const holder = holders.get(key)
  const slot = slots.get(key)
  if (!holder || !slot) return
  if (holder.parentNode === slot) return
  slot.appendChild(holder)
}

/**
 * 内容那一侧:这一格的身子是这个节点。登记完当场试一次配对。
 *
 * 它由一个**ref 回调**调(不是 layout effect)—— 判词与那个坑的病历写在
 * `PaneLeaf.PaneContentLayer` 的 `anchor` 上:内容自己的 layout effect 排在
 * 这只组件之前,在那里登记的话内容首挂那一帧量到的是一个游离节点。
 */
export function registerContentHolder(key: string, holder: HTMLElement): void {
  holders.set(key, holder)
  attach(key)
}

/** 卸载时摘掉。**只摘自己那一份** —— 别人已经换上去了就不动它。 */
export function unregisterContentHolder(key: string, holder: HTMLElement): void {
  if (holders.get(key) === holder) holders.delete(key)
}

/** 画法那一侧:这一格该画在这个槽里。登记完当场试一次配对。 */
export function claimContentSlot(key: string, slot: HTMLElement): void {
  slots.set(key, slot)
  attach(key)
}

/**
 * 这个槽没了(ref 回调收到 `null`)。**只摘自己那一份** —— 换宿主那一拍新旧两次
 * 调用的次序不由这只文件说了算,新槽可能已经先认领了(从前这里无条件删,正是
 * 那条注释说的「别人已经认领了就不动」的反面)。holder 留在原地 —— 判词在文件头。
 */
export function releaseContentSlot(key: string, slot: HTMLElement): void {
  if (slots.get(key) === slot) slots.delete(key)
}

/** 只给测试与热更:归零。 */
export function resetContentSlots(): void {
  holders.clear()
  slots.clear()
}

/*
 * 模块级可变状态 = 这个模块实例的寿命(09-01 立法)。退役复用已有那一口拆卸。
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetContentSlots)
}
