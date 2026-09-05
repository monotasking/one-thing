import { create } from 'zustand'

/**
 * **全屏层那格空容器的落点**(W2,设计 §4)。
 *
 * ── 它为什么存在:全屏必须是「投影」,不能是「再画一遍」──────────────────
 * 进全屏时那一格内容**不许重挂**:查看器的滚动位、编辑器的脏态、总览滚了半天的
 * 位置,全在那棵 React 子树的实例里。所以全屏层自己**不调 `renderRef`** ——
 * 它只摆一个空容器(`data-full-slot`),由**持有那一格的那片叶**把身子
 * `createPortal` 进去。两边要认识同一个 DOM 节点,而它们在 React 树上是兄弟
 * (`AppShell` 里 `<main>` 与 `<FullLayer/>` 各一支),context 递不过去 ——
 * 所以是一格模块级单槽,与 `workspace/components/palette-hub` 逐字同型。
 *
 * ── 单槽,不是一张表 ────────────────────────────────────────────────────
 * 全屏至多一个(那一格瞬态本身就是单数),所以这里也只有一格。
 * 全屏层没挂载时是 `null`,叶据此把身子留在自己身上。
 *
 * ── 真正做到「零重挂」的那一句在叶那一侧 ────────────────────────────────
 * **换 `createPortal` 的容器会重挂**(React 19 实测:`updatePortal` 比对
 * `containerInfo`,不同就新建 fiber)。所以叶不是「一会儿 portal 到这儿、一会儿
 * portal 到那儿」——它自己持有一格**身份恒定的 holder**,永远 portal 进那一格,
 * 搬家搬的是 holder 这个 DOM 节点(`appendChild` 是**移动**不是复制)。
 * 判词与那三条读数写在 `PaneLeaf` 上。
 */
interface FullSlotHub {
  /** 全屏层身子里那格空容器。没开全屏时是 null。 */
  slot: HTMLElement | null
  setSlot: (el: HTMLElement | null) => void
}

export const useFullSlot = create<FullSlotHub>()((set) => ({
  slot: null,
  /*
   * 同一个值不 set —— 一次无谓的 set 会让每一片叶(它们都订着这一格)白重渲一遍。
   * 全屏层至多一个,所以这里不必再判身份:ref 回调的次序恒是「先交新值 / 后交 null」。
   */
  setSlot: (el) => set((s) => (s.slot === el ? s : { slot: el })),
}))

/**
 * 模块级单槽 = 这个模块实例的寿命,配一段 HMR 退役(CLAUDE.md 那条法)。
 * 幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 * 热更后那格 DOM 节点属于**上一份**全屏层,留着就是一个谁都够不着的容器。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    useFullSlot.setState({ slot: null })
  })
}
