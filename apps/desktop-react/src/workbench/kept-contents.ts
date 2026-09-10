import { create } from 'zustand'
import { refId } from './kinds'
import type { ContentRef } from './kinds'

/**
 * **一片叶里「没有标签、但保持挂载」的那几格内容**(2026-09-10,交互预算第三单
 * 「组件级停靠」)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * 这片叶里的 keep-alive 一直是**按标签**算的:`PaneLeaf` 给每一格 tab 各挂一层,
 * 切 tab 只翻显形(`.layerHidden` = `content-visibility: hidden` + `inert`),
 * 谁都不卸载。可**原位换 ref**(`store.replaceRef`)不是切 tab —— 它把标签的
 * refId 换掉,于是旧那一格的层连同整棵内容子树当场卸载重挂。真机读数(官方
 * 夹具 50.9MB / 400 条 / 900 卡):那一次紧急提交本身 prod 18–71ms、dev 102–244ms,
 * 全部花在 React 造节点与随之而来的 GC 上 —— 屏幕上的表现就是「点了会话行,
 * 高亮和内容在同一帧一起换」,规范第 5 轴判为结构性违例。
 *
 * 治法只有一条:**别卸载**。而「别卸载谁」这句话核心层答不出来 —— 它不认识
 * 会话,更不知道「刚才切走的那条待会儿多半还会切回来」。所以这里只放一张表:
 *
 *   谁写它     能力自己(`content/session-park.ts`:LRU、上限、真删、换工作区)
 *   谁读它     `PaneLeaf`,一句「这片叶还要额外挂哪几格」
 *
 * **这只文件里一个能力的名字都没有**(grep `session` 零命中)——「加功能不许改
 * 骨架」那条法的字面兑现:将来文件叶要停靠、终端要停靠,写这张表就行,
 * `PaneLeaf` 一个字不改。
 *
 * ── 读进来之后 `PaneLeaf` 做什么 ────────────────────────────────────────
 * 把它并进 `leaf.tabs`(去重,标签优先),得到**这片叶要挂的全集**;画法层与
 * 内容层照旧按 refId 分格、照旧走 `useFrameOrder` 的出生序。于是:
 *  · 一格从「标签」变成「停靠」——**同一把 key、同一个位置**,React 只翻两个
 *    prop(`on` false),DOM 一个节点都没搬,`content-slots` 那张配对表连试都不必试;
 *  · 从「停靠」变回「标签」—— 同样只翻 `on`。
 * 这正是「切回 = 改属性,不卸载不重挂」那句话在代码里的全部内容。
 *
 * ── 排出去的那一格是有意的 ──────────────────────────────────────────────
 * 停靠的层**不画 `data-pane-tab`**,画 `data-pane-kept`。理由是那个属性名早有
 * 主:三条真机门(`gate:focus` 数活动层、`gate:chat-follow` 数中央区上有几条
 * 会话)都按它枚举「这片叶上有几格标签」,而停靠的那一格**不是一格标签** ——
 * 让它顶着同一个名字混进去,那几条门量的就不再是它们各自要量的东西了。
 */

const EMPTY: readonly ContentRef[] = []

interface KeptContentsHub {
  /** 叶 id → 这片叶额外要挂的那几格(没有 = 这一格不在表上)。 */
  byLeaf: Readonly<Record<string, readonly ContentRef[]>>
  setKept: (leafId: string, refs: readonly ContentRef[]) => void
  clearKept: () => void
}

/** 两份名单说的是不是同一件事(按 refId 逐位比)。 */
function sameRefs(a: readonly ContentRef[], b: readonly ContentRef[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (refId(a[i]) !== refId(b[i])) return false
  return true
}

export const useKeptContentsStore = create<KeptContentsHub>()((set) => ({
  byLeaf: {},
  /*
   * **没变就不 set**:这张表的每一次 set 都会让读它的那几片叶重渲一遍,而写它的
   * 那一头(`session-park` 的对账)跑在每一次拼贴台 store 变化上 —— 绝大多数拍
   * 里答案与上一拍逐字相同。判据与 `full-slot.setSlot` 那一句同源。
   */
  setKept: (leafId, refs) =>
    set((st) => {
      const now = st.byLeaf[leafId] ?? EMPTY
      if (sameRefs(now, refs)) return st
      const next = { ...st.byLeaf }
      // 空名单**从表上摘掉**而不是留一格空数组:`byLeaf` 的键就是「哪几片叶有
      // 停靠」,留着空数组会让对账那一头每次都多走一遍。
      if (refs.length === 0) delete next[leafId]
      else next[leafId] = refs
      return { byLeaf: next }
    }),
  clearKept: () => set((st) => (Object.keys(st.byLeaf).length === 0 ? st : { byLeaf: {} })),
}))

/**
 * 这片叶额外要挂哪几格。**选出来的是那一格数组本身**(不是现造的),所以
 * 别处的叶动一下不会让这一片重渲 —— 与 `PaneLeaf` 里那句 `regionOfLeafIn`
 * 只选一个字符串同一条判据。
 */
export function useKeptContents(leafId: string): readonly ContentRef[] {
  return useKeptContentsStore((st) => st.byLeaf[leafId] ?? EMPTY)
}

/** 非组件上下文里读一次(对账那一头用)。 */
export function keptContentsOf(leafId: string): readonly ContentRef[] {
  return useKeptContentsStore.getState().byLeaf[leafId] ?? EMPTY
}

/** 此刻哪几片叶有停靠(对账那一头要遍历它)。 */
export function keptContentLeafIds(): readonly string[] {
  return Object.keys(useKeptContentsStore.getState().byLeaf)
}

/** 写一格。空名单 = 这片叶没有停靠。 */
export function setKeptContents(leafId: string, refs: readonly ContentRef[]): void {
  useKeptContentsStore.getState().setKept(leafId, refs)
}

/** 整张表归零(能力那一侧的换工作区 / 退役 / 测试各用它一次)。 */
export function resetKeptContents(): void {
  useKeptContentsStore.getState().clearKept()
}

/*
 * 模块级可变状态 = 这个模块实例的寿命(09-01 立法)。退役复用已有那一口拆卸,
 * 不写第二套;幂等。生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(resetKeptContents)
}
