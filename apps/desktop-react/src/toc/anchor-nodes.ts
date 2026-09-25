/**
 * **页面上此刻在场的锚点:id → 节点** —— 以及它的结构缓存(G 线 P4-a ②,正本
 * `docs/stream-geometry-2026-09.md` §21.5)。
 *
 * ── 病 ──────────────────────────────────────────────────────────────────────
 * `useChatToc` 的当前键每次同步都要量一遍锚点(滚动同步合并到一帧一次,贴底跟随
 * 期间 = 流式时几乎每帧)。从前每一次都 `querySelectorAll('[data-message-id]')` 扫整列
 * 再建一张 Map:真店档(412 条)一轮 67 + 38 + 19ms,是「其余 JS」那一格的一半以上
 * (§21.3 Q1)。可那张表只在**列的结构**变了的时候才会变 —— 流式那几百帧里,
 * 变的只有最后那一行的高,哪一条消息在哪个节点上一格没动。
 *
 * ── 治:表按结构版本缓存,测量照旧每次做 ──────────────────────────────────────
 * 节点表(结构)缓存;`getBoundingClientRect`(坐标)照旧每次量 —— 坐标每帧都在变,
 * 结构不是。**不长观察者**(不用 MutationObserver 盯 DOM):结构版本从数据侧读,
 * 那是 DOM 的来源,读它不花一次 DOM 调用。
 *
 * ── 结构版本 = 三格,缺一格都会陈 ────────────────────────────────────────────
 * 列里挂 `data-message-id` 的节点,恰好是 `ChatStream` 摆出去的那几条账本消息
 * (`messages.slice(窗口起点)`;在飞那几格不挂这个属性,折痕与垫块也不挂 —— 判词在
 * `ChatStream.tsx` 那张行表上)。所以节点表是这三样的函数:
 *  ① **容器**:换一片叶 / 容器重挂,节点全是新的;
 *  ② **窗口起点**(`chat-window` 那一格):窗口往前扩,上面多摆出一批行;
 *  ③ **消息 id 序列**:落账(在飞那一格原节点上长出 `data-message-id`)、删、重试截断、
 *     重折起底。**比的是 id 序列,不是数组身份** —— 流式期间 `messages` 每帧是一只
 *     新数组(活的那一条换了对象),id 序列却一格不变;按身份比,缓存每帧都失效,
 *     等于没缓存。逐格比 id 是 O(n) 次字符串 `===`,零 DOM 调用,比一次整列扫描
 *     便宜两个量级。
 * 施工单(§21.5)写的是「`anchorIds` 数组身份、窗口起点、容器」三格。这里把
 * `anchorIds` 换成了③,理由两条:一是这张表认的是**列里全部**消息节点,与键列
 * (只有用户消息)无关,键列变了表不必变;二是只看键列会陈 —— 键列来自
 * `sessions.getUserMarkers`,那是一次 RPC,与「这一行落账上屏」是两条异步路,
 * 键列先到、行后落账时,按键列缓存的那张表会一直缺着这一条,直到键列再变一次。
 *
 * **兜底一格**:交出去之前,调用方用到的节点若已不在文档里(`isConnected` 为假),
 * 当场作废重扫一次 —— 防的是「结构版本没变、节点却被换掉」这种上面三格没想到的路
 * (比如哪一天某一行因为元素类型变了被 React 重挂)。它只查**用到的**那几个节点。
 */

/** 一次整列扫描(结构变了才走到这里)。 */
export function scanAnchorNodes(container: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = node.getAttribute('data-message-id')
    if (id) map.set(id, node)
  }
  return map
}

/** 列的结构从数据侧读的那两格(容器由调用方直接给)。 */
export interface AnchorStructure {
  /** 这条会话的账本消息(`chat-source` 的 `messages`)。只读 `id`。 */
  messages: readonly { readonly id: string }[]
  /** 这条会话此刻的窗口起点(`chat-window`;没种过 = undefined)。 */
  windowStart: number | undefined
}

export class AnchorNodeCache {
  private container: HTMLElement | null = null
  private windowStart: number | undefined = undefined
  /** 上一次对过的那只数组 —— 身份相同时连 id 都不必逐格比。 */
  private messages: readonly { readonly id: string }[] | null = null
  /** 扫描那一刻的 id 序列(比的是它,不是数组身份)。 */
  private ids: string[] = []
  private nodes: Map<string, HTMLElement> | null = null

  /** 结构没变就交回上一张表;变了(或第一次)重扫。 */
  nodesFor(container: HTMLElement, structure: AnchorStructure): Map<string, HTMLElement> {
    if (this.nodes && this.sameStructure(container, structure)) return this.nodes
    this.container = container
    this.windowStart = structure.windowStart
    this.messages = structure.messages
    this.ids = structure.messages.map((message) => message.id)
    this.nodes = scanAnchorNodes(container)
    return this.nodes
  }

  /** 兜底那一格:调用方发现交出去的节点已离开文档,下一次必重扫。 */
  invalidate(): void {
    this.nodes = null
  }

  private sameStructure(container: HTMLElement, structure: AnchorStructure): boolean {
    if (container !== this.container) return false
    if (structure.windowStart !== this.windowStart) return false
    const messages = structure.messages
    if (messages === this.messages) return true
    if (messages.length !== this.ids.length) return false
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i].id !== this.ids[i]) return false
    }
    /* id 序列相同:记住这只新数组,下一次身份相同就直接命中。 */
    this.messages = messages
    return true
  }
}

