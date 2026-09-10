import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { ScrollAnchor } from '../data/session-view-state'

/**
 * **一片聊天此刻渲染到第几条**(2026-09-10,交互预算第一单「响应先行」)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * 点一行会话 → React 离散事件 → 紧急更新**同步渲染同步提交**:拼贴台 `replaceRef`
 * → 旧叶卸载 → 新叶挂载时一次性造出全部 388 条消息 / 916 张工具卡 / 37,470 个节点
 * → 贴底那一发逼一次全树排版 → 任务结束浏览器才画。用户看到的是:列表高亮、标签
 * 标题、内容**在 1–2s 之后同一帧一起换**。b3eee0d0 的 `content-visibility: auto`
 * 把**排版**那一半按视口计价了(切回 1027 → 215ms),剩下的 215ms 是 React 造
 * 38,871 个 DOM 节点 —— 那一半只有「别造」才治得了。
 *
 * 规范第 5 轴(交互预算)判「一次交互对应一个长任务」为**结构性违例**:点击当帧
 * 必须有可见响应,内容按屏进、空闲补。这只文件就是「按屏进」那一格。
 *
 * ── 形:窗口是消息数组的一个**后缀**,只有起点 ────────────────────────────
 * 记的是 `start`(渲染从第几条开始),不是「渲染几条」。差别在流式:
 * 记条数的话每追加一条,后缀就往前滑一格 —— **顶上那一条会被摘掉**,人正在看的
 * 内容当场往上跳。记起点则追加只让后缀变长,顶上一条不动。
 *
 * **起点只许变小,不许变大**(`growChatWindow` 里那一句):窗口只增不减 ——
 * 已经渲出来的行永远不会被收回去,所以扩窗只会 prepend,永远不会让视口下面的
 * 内容凭空消失。这条不变量是「扩窗视口不跳」那一格补偿(`ChatStream` 里那只
 * 布局 effect)成立的前提:它只需要处理「上面长出来了多少」这一个方向。
 *
 * ── 谁写它 ────────────────────────────────────────────────────────────────
 * 四条路,全在 `content/ChatStream.tsx` 与 `toc/useChatToc.ts` 两处:
 *  ① **进场种一格**(`seedWindowStart`)—— 缺省尾窗;进场要落回锚点时把窗口
 *     一次性扩到那条(判词在 `seedWindowStart` 上);
 *  ② **空闲往前补**(`CHAT_WINDOW_STEP` 一批,`requestIdleCallback` + `startTransition`);
 *  ③ **人翻到窗口顶部附近**(离顶 < 2 屏)—— 不等空闲,当场补一批;
 *  ④ **要落到某一条**(钢琴键 / 检索命中 / `locate-message`)—— `reachChatWindow`
 *     先把窗口够到它,那一条下一次提交才有 DOM。
 *
 * ── 寿命:一次挂载一格,卸载就忘 ──────────────────────────────────────────
 * 这一格**不该跨挂载活着**:切回一条停靠池里的会话,要的正是「重新只渲一屏」。
 * 留着上一次扩到全量的那个 0,切回来就又是一次 37,470 个节点的同步提交 ——
 * 本单治的病原样长回来。所以 `useChatWindowStart` 的 cleanup 里 `release`。
 *
 * **它不是「看到哪儿」**:那一格是 `data/session-view-state.ts` 的锚点,按会话记、
 * 跨挂载留着。窗口是渲染预算,锚点是视图状态,两件事两张表 —— 合成一张的话
 * 「切回来停在离开时那一行」与「切回来只渲一屏」就得互相让步。
 *
 * 模块级可变状态(那张表)配 HMR 退役(09-01 立法),复用已有那口 `resetChatWindows()`。
 */

/**
 * **进场先渲最后几条**。
 *
 * 24 是「一屏多一点」的**估计**,不是规格 —— 与 `--msg-intrinsic-h` 那个 240px
 * 同一族的谎:真机上一条消息均值 695px、视口 ~800px,所以一屏其实常常只装得下
 * 一两条,24 条是把「刚进来往上翻两下」也算进去的余量。它是**条数不是时长**,
 * 所以不进 `components/motion.ts` 那张时长镜像表(与 `ANCHOR_RESETTLE_ROUNDS`
 * 同一条理由)。
 *
 * 往大了调的代价是首帧的 DOM 造价(一条消息 ≈ 100 个节点),往小了调的代价是
 * 人一进来就撞到窗口顶部、要等第一批扩窗。
 */
export const CHAT_TAIL_WINDOW = 24

/** 空闲里一批往前补几条。比尾窗大一档 —— 尾窗要快,补窗要少排几次。 */
export const CHAT_WINDOW_STEP = 48

/**
 * 落回锚点 / 跳到某一条时,那一条**上面**再多留几条。
 *
 * 不留的话锚点就是窗口的第一行,人往上翻一格就到顶了(而空闲扩窗还没跑到);
 * 留 12 条 ≈ 好几屏的余量,足够撑到第一批空闲扩窗落地。
 */
export const CHAT_ANCHOR_BACKFILL = 12

/** 只认 id 这一格 —— 这只文件不认识消息还有别的字段。 */
interface Addressable {
  readonly id: string
}

/** 缺省尾窗的起点。总数不够一窗就是 0(整份都渲)。 */
export function tailWindowStart(total: number): number {
  return Math.max(0, total - CHAT_TAIL_WINDOW)
}

/**
 * 把窗口够到第 `index` 条:起点只许往小走,并且在它上面留一段回旋余地。
 *
 * **已经在窗口里就一格不动** —— 回旋余地是为「够过去」准备的,不是每问一次就
 * 往前多摆十二条(那会让「点一枚已经在屏上的钢琴键」白造一批 DOM)。
 */
export function windowStartFor(start: number, index: number): number {
  if (index >= start) return start
  return Math.max(0, index - CHAT_ANCHOR_BACKFILL)
}

/**
 * **进场那一格窗口**(纯函数)。
 *
 * `anchor` 是「这一次进场会不会落回锚点」的答案,由调用方给 —— 不是这里去问表:
 *  · 停靠池命中那条路上,进场第一次提交树上就已经有消息,锚点当场用得上,所以
 *    窗口必须**一次性**扩到包含那一行(分批扩的话第一帧落不下去,得等一两帧再跳,
 *    而「首帧就在底 / 就在那一行,不许先画别处再跳」是 C1 立的法);
 *  · 冷载入那条路上进场第一帧树是空的,锚点这一次用不上(留账 ② 在
 *    `data/session-view-state.ts` 末尾),调用方给 `undefined`,于是老实尾窗。
 *
 * `'bottom'` 与「那条消息不在这棵树上」都退回尾窗 —— 前者本来就是尾窗的意思,
 * 后者是 `applyScrollAnchor` 会如实答 false 的那一种。
 */
export function seedWindowStart(
  messages: readonly Addressable[],
  anchor: ScrollAnchor | undefined,
): number {
  const tail = tailWindowStart(messages.length)
  if (!anchor || anchor === 'bottom') return tail
  const index = messages.findIndex((message) => message.id === anchor.messageId)
  if (index < 0) return tail
  return windowStartFor(tail, index)
}

/* ── 表 ────────────────────────────────────────────────────────────────── */

interface WindowEntry {
  start: number
  /** 改了几次 —— 订阅方(`useChatToc` 的落点重试)只关心「又扩了一次」。 */
  version: number
}

const WINDOWS = new Map<string, WindowEntry>()
const LISTENERS = new Map<string, Set<() => void>>()

function notify(sessionId: string): void {
  const set = LISTENERS.get(sessionId)
  if (!set) return
  for (const listener of [...set]) listener()
}

function subscribe(sessionId: string, listener: () => void): () => void {
  let set = LISTENERS.get(sessionId)
  if (!set) {
    set = new Set()
    LISTENERS.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) LISTENERS.delete(sessionId)
  }
}

/** 这条会话此刻的窗口起点;没种过 = undefined。 */
export function peekChatWindowStart(sessionId: string): number | undefined {
  return WINDOWS.get(sessionId)?.start
}

/**
 * 种一格(**幂等**:已经有了就一个字不动)。
 *
 * 不通知:种下去的值与调用方这一帧算出来的那个逐字相同(`seedWindowStart` 是
 * 纯函数,两边喂的是同一份消息与同一个锚点),通知只会白推一次渲染。
 */
export function seedChatWindow(sessionId: string, start: number): void {
  if (WINDOWS.has(sessionId)) return
  WINDOWS.set(sessionId, { start: Math.max(0, start), version: 0 })
}

/**
 * 往前扩。**只许变小** —— 窗口只增不减(判词在文件头);没变就不通知。
 * 答「这一下真的扩了没有」,调用方拿它决定要不要等下一次提交。
 */
export function growChatWindow(sessionId: string, nextStart: number): boolean {
  const entry = WINDOWS.get(sessionId)
  const next = Math.max(0, nextStart)
  if (!entry) {
    WINDOWS.set(sessionId, { start: next, version: 1 })
    notify(sessionId)
    return true
  }
  if (next >= entry.start) return false
  entry.start = next
  entry.version += 1
  notify(sessionId)
  return true
}

/** 够得到那一条了吗 —— 三种答案,判词见 `reachChatWindow`。 */
export type WindowReach =
  /** 那一条已经在窗口里(此刻就有 DOM) */
  | 'ready'
  /** 刚为它扩了窗 —— 下一次提交之后才有 DOM */
  | 'grew'
  /** 这棵树上根本没有这条消息(被删 / 被压缩折进去了) */
  | 'absent'

/**
 * **把窗口够到某一条消息**(落点那四条路共用的一口)。
 *
 * 判据只有一个:那条消息**在不在这份数据里**。在,就一定能渲出来(窗口是数据的
 * 后缀,够过去就有);不在,如实答 `absent` —— 调用方据此说那句「这条消息不在
 * 这棵树上」,而不是滚到一个差不多的位置(判例照抄 `useChatToc.useScrollToMessage`)。
 */
export function reachChatWindow(
  sessionId: string,
  messages: readonly Addressable[],
  messageId: string,
): WindowReach {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index < 0) return 'absent'
  const start = WINDOWS.get(sessionId)?.start ?? tailWindowStart(messages.length)
  if (index >= start) return 'ready'
  return growChatWindow(sessionId, windowStartFor(start, index)) ? 'grew' : 'ready'
}

/** 这片聊天卸载了 —— 窗口跟着忘(判词在文件头「寿命」那一节)。 */
export function releaseChatWindow(sessionId: string): void {
  WINDOWS.delete(sessionId)
}

/** 只给测试与整台壳重置。 */
export function resetChatWindows(): void {
  WINDOWS.clear()
  LISTENERS.clear()
}

/** 只给测试:表里此刻记着哪几条会话。 */
export function chatWindowKeys(): readonly string[] {
  return [...WINDOWS.keys()]
}

/* ── React 那半边 ─────────────────────────────────────────────────────── */

/**
 * **这一片聊天此刻从第几条开始渲**(唯一消费者 `content/ChatStream.tsx`)。
 *
 * 表里没种过的时候答的是**算出来的那一格**(`seedWindowStart`),种下去在布局
 * 阶段 —— 两者逐字相同,所以「先渲一帧再种」没有任何可见差别,而渲染期写外部
 * 表会让 `useSyncExternalStore` 在同一次渲染里读到两个不同的快照(React 会当作
 * 「撕裂」再渲一遍)。
 *
 * `lastRef` 那道闸是**给同一条会话开着两片叶**准备的:另一片卸载时会把表里那
 * 一格删掉,这一片下一次渲染就会读回尾窗 —— 而那等于把已经渲出来的行收回去,
 * 视口当场跳。窗口只增不减这条不变量因此在组件这一端再钉一遍。
 */
export function useChatWindowStart(
  sessionId: string,
  messages: readonly Addressable[],
  anchor: ScrollAnchor | undefined,
): number {
  const stored = useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => WINDOWS.get(sessionId)?.start,
    () => WINDOWS.get(sessionId)?.start,
  )
  const seeded = stored ?? seedWindowStart(messages, anchor)
  const lastRef = useRef<{ sid: string; start: number } | undefined>(undefined)
  const last = lastRef.current
  const start = last && last.sid === sessionId ? Math.min(last.start, seeded) : seeded
  lastRef.current = { sid: sessionId, start }
  /*
   * 种下去那一格读的是**挂载那一刻**的值,所以它走 ref 不进依赖表:进了依赖表
   * 这条 effect 就会随每一次扩窗重跑,而它的 cleanup 是 `release` —— 扩一次窗
   * 就把刚扩出来的窗口忘一次。
   */
  const startRef = useRef(start)
  startRef.current = start

  useLayoutEffect(() => {
    seedChatWindow(sessionId, startRef.current)
    // 卸载 = 这一格作废(见文件头)。依赖只有会话 id:换会话也算一次卸载。
    return () => releaseChatWindow(sessionId)
  }, [sessionId])

  return start
}

/**
 * **窗口又扩了一次**(唯一消费者 `toc/useChatToc.ts`)。
 *
 * 目录 / 检索的落点要等那一条真的渲出来才滚得过去,而「渲出来了」在这一侧的
 * 表现就是窗口变了一次。它只订版本号不订起点:那边不关心窗口摆在哪,只关心
 * 「该再试一次了」。
 */
export function useChatWindowVersion(sessionId: string): number {
  return useSyncExternalStore(
    (listener) => subscribe(sessionId, listener),
    () => WINDOWS.get(sessionId)?.version ?? 0,
    () => WINDOWS.get(sessionId)?.version ?? 0,
  )
}

/* 模块级可变状态的 HMR 退役(09-01 立法),复用已有那口拆卸;幂等。 */
if (import.meta.hot) import.meta.hot.dispose(() => resetChatWindows())
