import { create } from 'zustand'

/**
 * **「哪一片叶的动作菜单此刻开着,开在哪儿」——这一个事实的唯一产地**
 * (W6-c,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md` §7)。
 *
 * ── 它为什么存在 ────────────────────────────────────────────────────────
 * §7 的原话是「动作单产地是标签的**右键菜单**」,而这台壳里那张表(`LeafActions`)
 * 从 W1-b 起只有一个开口:檐右端那颗钮。于是「右键一格标签」这条本仓判例
 * (CLAUDE.md「动作单产地=右键上下文菜单」)在拼贴台上是个空档 —— `ui/drag` 的
 * `useDragSource` 早就写着 `if (e.button !== 0) return`「右键要留给上下文菜单」,
 * 但留出来的那一格一直没人接。
 *
 * 接它需要一格**跨组件**的事实:顶栏上标签条(`TopBarLeafTabs`)与那张菜单
 * (`TopBarLeafActions`)是 `TopBar` 里的两兄弟,不是父子 —— 前者收得到右键,
 * 后者才画得出菜单。架子 / 浮窗那两处虽然同在 `PaneLeafStrip` 里,但**判据只能有
 * 一个**:两处各写一套「菜单开在哪」,第二个宿主上迟早漂。所以它成了一格极小的
 * store,与 `stage/live-title` 同一条理由(不落盘、不惊动形态机的订阅者)。
 *
 * ── 它**不是**第二张菜单 ────────────────────────────────────────────────
 * 菜单的内容、判据、动作一格都不在这里 —— 那些整件仍在 `LeafActions` 里,而它调的
 * 是拖拽落定同一只 store 动作。这一格只回答「开不开、开在哪一片叶上、开在哪个点」,
 * 于是**钮与右键开出来的是同一张表**(`gate:a11y` 的「标签右键菜单全档可达」逐项
 * 比对两条路的项目文本,一个字不同就红)。
 *
 * ── 为什么坐标记在这里,而不是让菜单自己去问 ──────────────────────────────
 * `ui/Menu` 是**点锚**档(CLAUDE.md 浮层那条:点锚不跟滚),它收的就是一对
 * 视口坐标。右键那一下的坐标只在那一发事件里存在,过了这一帧谁都拿不到 ——
 * 所以它必须跟着请求一起递过来,而不是由菜单事后去量。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:这只 store 是模块级单例,寿命 = 这个模块实例。它**没有订阅、没有
 *    计时器、没有注册**(只是一格数据),所以 CLAUDE.md 那条「模块级副作用必须配
 *    HMR dispose」不落到它头上 —— 热更后新模块拿到 `at: null`,屏幕上等于菜单关了,
 *    与「热更后浮层关掉」这件事本来就一致。
 * ② UI 生命状态:`at === null`(没开)/ 有 `at`(开在那一片叶的那个点)。
 *    **只有一格**:第二片叶上右键 = 第一片那张自己就没了,这正是上下文菜单该有的样子。
 * ③ UI 交互状态:归 `ui/Menu`(它自己那套 roving / 点外关 / Esc)。
 */
export interface LeafMenuAt {
  /** 开在哪一片叶的动作表上。`LeafActions` 拿自己的叶 id 与它比。 */
  leafId: string
  /** 视口坐标(点锚)。 */
  x: number
  y: number
}

interface LeafMenuStore {
  at: LeafMenuAt | null
  /** 在这一点上开那一片叶的动作菜单(右键一格标签 / 按檐上那颗钮,同一口)。 */
  openLeafMenu: (leafId: string, x: number, y: number) => void
  /** 关掉。幂等 —— 已经关着时不写,免得白惊动订阅者。 */
  closeLeafMenu: () => void
}

export const useLeafMenuStore = create<LeafMenuStore>((set) => ({
  at: null,
  openLeafMenu: (leafId, x, y) => set({ at: { leafId, x, y } }),
  closeLeafMenu: () => set((st) => (st.at === null ? st : { at: null })),
}))

/** 这一片叶此刻要不要画那张菜单,以及画在哪儿。不是它就答 null。 */
export function useLeafMenuAt(leafId: string): LeafMenuAt | null {
  return useLeafMenuStore((st) => (st.at?.leafId === leafId ? st.at : null))
}

/**
 * 右键一格标签 = 在指针那一点开这片叶的动作菜单。
 *
 * **它不选中那一格**:选中这件事已经在 `LeafStrip.onTabDown` 里发生过了
 * (按下即激活,W6-b —— `pointerdown` 对右键一样派得出来),而那张表说的正是
 * 「这一格活动标签能做什么」。两处各选一次等于把同一句话说两遍。
 */
export function openLeafMenuAtPointer(leafId: string, e: { clientX: number; clientY: number }): void {
  useLeafMenuStore.getState().openLeafMenu(leafId, e.clientX, e.clientY)
}
