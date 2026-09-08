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
  /**
   * **被右键的是哪一格**(U3,2026-09-08;`refId`,缺席 = 没有指名)。
   *
   * ── 它为什么是这张表的一部分 ──────────────────────────────────────────
   * U2 之前「右键先激活」把这件事盖住了:右键那一发 `pointerdown` 顺手把那一格
   * 点成活动的,于是「表作用在活动格」与「表作用在被右键那格」永远同一个答案。
   * U2 按用户裁定让**右键不再切标签**(`LeafStrip.onTabDown` 只认主键)之后,
   * 右键一格**非活动**标签开出来的表仍旧作用在活动那一格 —— 关闭关错人、
   * 「与右边的标签二合一」并的是别人的右邻。Chrome / VS Code 的表都作用在被右键
   * 的那一格,所以这不是新裁定,是把 U2 顺手带走的那个行为接回来。
   *
   * 缺席的两个来源同样是**指名**的对立面,不是遗漏:顶栏右端那颗 ⋯ 与右键檐上
   * 的空白处说的是「这片叶」,没有哪一格可指 —— 那时表落回 `leaf.active`
   * (判词在 `LeafActions` 的目标那一格上)。键盘 `Shift+F10` / ContextMenu 键
   * 反而**有**:`ui/Tabs` 从焦点那一格量点,顺手把它的 id 一起交出来。
   */
  tabId?: string
  /** 视口坐标(点锚)。 */
  x: number
  y: number
}

interface LeafMenuStore {
  at: LeafMenuAt | null
  /** 在这一点上开那一片叶的动作菜单(右键一格标签 / 右键檐上空白,同一口)。 */
  openLeafMenu: (leafId: string, x: number, y: number, tabId?: string) => void
  /** 关掉。幂等 —— 已经关着时不写,免得白惊动订阅者。 */
  closeLeafMenu: () => void
}

export const useLeafMenuStore = create<LeafMenuStore>((set) => ({
  at: null,
  openLeafMenu: (leafId, x, y, tabId) => set({ at: { leafId, x, y, tabId } }),
  closeLeafMenu: () => set((st) => (st.at === null ? st : { at: null })),
}))

/** 这一片叶此刻要不要画那张菜单,以及画在哪儿。不是它就答 null。 */
export function useLeafMenuAt(leafId: string): LeafMenuAt | null {
  return useLeafMenuStore((st) => (st.at?.leafId === leafId ? st.at : null))
}

/**
 * **开这片叶的动作菜单**,开在给定的那一点上。
 *
 * ── 为什么参数是「一个点」而不是「一发事件」(W7-c)────────────────────────
 * W6-c 时这只函数收的是 `MouseEvent`,因为它只有右键一个来源。W7-c 起这张表有
 * **两个**来源:右键那一下(点 = 光标)与键盘 `Shift+F10` / 上下文菜单键
 * (点 = 那一格标签的左下角)。两者的差别只在**点从哪儿来**,而那件事标签条自己
 * 最清楚(它手上有那一格的矩形)—— 所以量点的活留在 `ui/Tabs`,这只函数只收结果。
 * 收事件的话第二个来源就得伪造一发 MouseEvent,那是把「谁该量」答错了。
 *
 * **它不选中那一格**(U2 起这句话有了它真正的分量)。W6-b 时理由是「选中已经在
 * `LeafStrip.onTabDown` 里发生过了」;U2 按用户裁定让右键**不再**切标签,于是
 * 它成了一句真的承诺:右键一格标签不动活动位,只开表。
 *
 * 表因此要自己知道**说的是哪一格** —— 那就是第三个参数 `tabId`(U3;判词整段在
 * `LeafMenuAt.tabId` 上)。缺席 = 没有指名,表落回这片叶的活动格。
 */
export function openLeafMenuAt(
  leafId: string,
  at: { x: number; y: number },
  tabId?: string,
): void {
  useLeafMenuStore.getState().openLeafMenu(leafId, at.x, at.y, tabId)
}
