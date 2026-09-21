import { AT_BOTTOM_EPS } from '../content/follow'
import { onSessionsRemoved } from './sessions-source'

/**
 * **一条会话的视图状态**(C1 · §5.2,正本 `docs/session-continuity-2026-09.md`)。
 *
 * ── 它治的是哪半边病 ──────────────────────────────────────────────────────
 * 「切走再切回来会话要重新加载」是两件事叠在一起:**机器被扔了**(§5.1,治法是
 * `data/chat-source.ts` 的停靠池)与**看到哪儿被忘了**(这一格)。停靠池让切回来
 * 的那一帧不必再拉一次账本;这只文件让那一帧停在**离开时那一行**上,而不是一律
 * 弹回底。两件都做到,切回来的那一帧才真的是离开时的样子。
 *
 * ── 记什么、不记什么 ──────────────────────────────────────────────────────
 * 记:**滚动锚点**。
 *
 * **不记草稿** —— 它已经有产地:`composer/drafts.ts` 按 `sessionId` 记 HTML + 附件
 * + 拍立得摞的展开态,连丢弃时机(会话被真的关掉)都定过了。在这里再记一格
 * 就是同一件事记两遍,而两遍迟早会漂(那正是 `sessions-source` 头上「模块级
 * `ledger` 退役」记的同一条判例)。§5.2 原话「草稿若已有落盘产地就复用它,
 * 不立第二处」。
 *
 * **不记折叠态** —— 今天工具卡 / 折痕的展开态是 `content/tools/ToolCard.tsx` 里
 * 两格组件级 `useState`(`open` / `openKeys`),**外面没有键可记**:它随那片叶
 * 卸载一起消失,而停靠池保的是数据机器不是 React 组件树。要记它得先给它一个
 * 有主的键(一张按 `messageId + toolCallId` 的表),那是另一单 —— 见文件末尾留账。
 *
 * ── 锚点的形 ──────────────────────────────────────────────────────────────
 * `'bottom'` 与 `{ messageId, offset }` 是**两种事实**,不是一种事实的两个取值:
 * 前者说「我在最新处,内容再长我还要跟」,后者说「我停在这一条上」。存成
 * 一个 `scrollTop` 数字两者都表达不了 —— 流式期间内容一直在长,那个数字下一帧
 * 就指向别的地方了(这正是 `content/follow.ts` 头上「判据只有位置与意图」那条
 * 纪律的另一面:位置要挂在**内容**上,不能挂在像素上)。
 *
 * ── 量法与用法住在一起 ────────────────────────────────────────────────────
 * `measureScrollAnchor` / `applyScrollAnchor` 是这个形状唯一的一对翻译,所以它们
 * 长在这只文件里而不是散在调用方(与 `follow.ts` 把 `AT_BOTTOM_EPS` 与状态机放在
 * 一起同一条理由:判据与用它的人分家,两边迟早对不上)。「在底」的容差**不另立
 * 一个 2**,直接读 follow.ts 那一个 —— 它是纯函数、零依赖,从 data/ 读它不拖进
 * 任何 DOM 或 React。这是全树**唯一**一条 `data/ → content/` 的边,是有意的:
 * 「在底算几像素」这句话的主人是那台跟随状态机,把它抄一份到这里就是两个 2,
 * 而两个 2 迟早会漂;反过来把它搬进 data/ 更糟(那会让 content/ 反过来依赖 data/
 * 才拿得到自己的判据)。
 *
 * ── 寿命 ──────────────────────────────────────────────────────────────────
 * 纯内存,一张模块级 Map。会话被摘掉就清掉(`forgetSessionViewStates`);
 * 模块级可变状态配 HMR 退役(09-01 立法),退役复用已有那口 `resetSessionViewStates()`。
 * 重启之后没有锚点 = 一次正常的冷载入落底,那不是这条病(§5.3)。
 */

/** `'bottom'` = 贴在最新处;否则 = 停在某条消息上,`offset` 是它上缘到容器上缘的距离(可负)。 */
export type ScrollAnchor = 'bottom' | { readonly messageId: string; readonly offset: number }

export interface SessionViewState {
  readonly scrollAnchor?: ScrollAnchor
}

const VIEW = new Map<string, SessionViewState>()

/** 没记过 = 一份空的(调用方不必判 undefined)。 */
const EMPTY_VIEW: SessionViewState = {}

export function readSessionViewState(sessionId: string): SessionViewState {
  return VIEW.get(sessionId) ?? EMPTY_VIEW
}

/** 这条会话上次看到哪儿。没记过 = undefined(= 按缺省落底)。 */
export function readSessionScrollAnchor(sessionId: string): ScrollAnchor | undefined {
  return VIEW.get(sessionId)?.scrollAnchor
}

/**
 * 记下这条会话看到哪儿。
 *
 * `undefined` **不当一次写**:量不出锚点(容器已经离场、树上一条消息都没有)时
 * 覆盖掉上一次的读数,等于拿一份垃圾把真读数冲掉 —— 老实留着旧的那一份。
 * 会话 id 空串是一格合法的键(「还没绑会话」那一态),与 `composer/drafts.ts`
 * 那条「不拿空串当缺席」逐字同源。
 */
export function saveSessionScrollAnchor(sessionId: string, anchor: ScrollAnchor | undefined): void {
  if (!anchor) return
  ensureRosterHook()
  VIEW.set(sessionId, { ...VIEW.get(sessionId), scrollAnchor: anchor })
}

/** 这条会话没了 —— 记录一起没。 */
export function dropSessionViewState(sessionId: string): void {
  VIEW.delete(sessionId)
}

/**
 * 一批会话离场(删掉 / 换空间离场)时把它们的记录清掉。
 *
 * 与 `chat-source` 的停靠池读同一条接缝(`onSessionsRemoved`),而那条接缝
 * **把「被删」与「离开这个工作区」说成同一句话**(产地在 `sessions-source` 的
 * `onLifecycle` 与 `onSpaceChanged`)。对这一格而言两者的结局本来就该一样:
 * 一个锚点是「我上次在这条会话里看到哪儿」,清掉它最坏是下次进去落回底。
 */
export function forgetSessionViewStates(sessionIds: readonly string[]): void {
  for (const id of sessionIds) dropSessionViewState(id)
}

/**
 * 接上名册那条接缝。**惰性**(第一次真的记下东西时才接)——
 * 模块作用域里接线会在这台壳那条存量 import 环上读到 TDZ,判例写在
 * `content/session-projection.ts` 头上;而第一次 `save` 一定发生在整棵树跑起来之后。
 */
let stopRoster: (() => void) | undefined
function ensureRosterHook(): void {
  if (stopRoster) return
  stopRoster = onSessionsRemoved(forgetSessionViewStates)
}

/** 只给测试与整台壳重置:清空这张表并把名册那条订阅退掉。 */
export function resetSessionViewStates(): void {
  VIEW.clear()
  stopRoster?.()
  stopRoster = undefined
}

/** 只给测试:表里此刻记着哪几条会话。 */
export function sessionViewStateKeys(): readonly string[] {
  return [...VIEW.keys()]
}

/* ── 锚点:量出来 / 用回去 ────────────────────────────────────────────── */

/** 页面上此刻在场的锚点节点。一次查询,免得逐个 id 拼选择器转义(同 `toc/useChatToc`)。 */
function anchorNodeOf(container: HTMLElement, messageId: string): HTMLElement | undefined {
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.getAttribute('data-message-id') === messageId) return node
  }
  return undefined
}

/**
 * 量出此刻的锚点。**贴底优先** —— 在底就是在底,不必也不该记成「停在最后一条上」
 * (那两句话在下一段流到来时的行为完全不同)。
 *
 * 取的是**视口内最上面那条还露着的消息**:它整条已经滚过容器上缘的就跳过。
 * 用 `getBoundingClientRect` 而不是 `offsetTop` —— 后者依赖 offsetParent 是谁,
 * 聊天列包一层定位元素就会算错(判例照抄 `toc/useChatToc.measureAnchors`)。
 *
 * 容器不在文档上(卸载正在进行、还没挂上)时**答 undefined**:那时读到的矩形
 * 全是 0,记下去就是一份说谎的锚点。
 *
 * **它答 undefined 的那一次曾经是全部**(2026-09-10):换会话走的是整棵子树的
 * 删除,React 先摘宿主根再逐个跑 destroy,所以离场那一拍的 cleanup 里容器
 * `isConnected` 恒为 false —— 这只函数一直在如实作答,而调用方一直在如实地
 * 什么都不记。写点因此搬到了「滚动停稳」那一拍(`content/ChatStream.tsx`),
 * 这一格降为兜底:依赖变化那条路上容器确实还连着,量得到就是白拿一笔。
 */
export function measureScrollAnchor(container: HTMLElement): ScrollAnchor | undefined {
  if (!container.isConnected) return undefined
  const gap = container.scrollHeight - container.clientHeight - container.scrollTop
  if (gap <= AT_BOTTOM_EPS) return 'bottom'
  const base = container.getBoundingClientRect().top
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = node.getAttribute('data-message-id')
    if (!id) continue
    const rect = node.getBoundingClientRect()
    // 整条都在容器上缘之上 = 已经翻过去了,不是「我在看的那一条」。
    if (rect.bottom <= base) continue
    return { messageId: id, offset: rect.top - base }
  }
  return undefined
}

/**
 * 把锚点用回去。**答 true / false 而不是尽力而为**:那条消息不在树上(还没起底、
 * 被删了、被压缩折进去了)时**如实回 false**,由调用方决定落回哪儿 —— 滚到一个
 * 差不多的位置比什么都不做更像在说谎(判例照抄 `toc/useChatToc.useScrollToMessage`)。
 *
 * 直接赋 `scrollTop`,不用 `scrollTo({behavior:'smooth'})`:**定位不是动效**
 * (动效档「无」下它照样得工作),这条与 `ChatStream` 里落底那一手同源。
 *
 * ── 一次可能落不准(2026-09-10)──────────────────────────────────────────
 * 消息行挂上 `content-visibility: auto` 之后,**没进过视口的行**占的是估高的位。
 * 于是这一手算出来的落点是「按估高摆出来的那张排版」里的落点:赋完 `scrollTop`,
 * 锚点行连同它周围几行当场渲出真高,那张排版就变了,它跟着漂。
 * **这只函数不为此负责** —— 它做的仍然是「按此刻的排版落到那一行」,这句话每一次
 * 调用都是真的;要落准就再调一次。调用方(`content/ChatStream.tsx` 的进场
 * layout effect)因此落完之后逐帧再对,直到位置不再动为止。
 */
export function applyScrollAnchor(
  container: HTMLElement,
  anchor: ScrollAnchor,
  /**
   * **谁来写那一格**(G 线 P2-a 收口)。缺省仍是 `container.scrollTop = top` ——
   * 这只函数的形一个字没变,答 true / false 的语义也没变。
   *
   * 聊天流把它换成 `ScrollPort.setTop(top, 'restore')`:P2-a 之后**写滚动位只有
   * 一个口**,停靠守卫与 `lastTop` 同步都在那口里做一次(判词在
   * `content/viewport/scroll-port.ts`)。这里收一个函数而不是反过来 import 那只口,
   * 是因为方向只许 `content → data`,`data/` 不认识 `content/viewport`。
   */
  write: (top: number) => void = (top) => void (container.scrollTop = top),
): boolean {
  if (anchor === 'bottom') {
    write(container.scrollHeight)
    return true
  }
  const node = anchorNodeOf(container, anchor.messageId)
  if (!node) return false
  // 内容坐标原点 = 容器上缘在视口里的位置减去已经滚掉的那一段。
  const origin = container.getBoundingClientRect().top - container.scrollTop
  const top = node.getBoundingClientRect().top - origin
  write(top - anchor.offset)
  return true
}

/*
 * 模块级可变状态(那张表 + 名册订阅)的 HMR 退役(09-01 立法)。
 * 复用已有那口拆卸,不写第二套;幂等。生产构建里 `import.meta.hot` 是 undefined。
 */
if (import.meta.hot) import.meta.hot.dispose(() => resetSessionViewStates())

/*
 * ── 留账 ────────────────────────────────────────────────────────────────
 * ① **折叠态没记**(理由见文件头):工具卡 / 折痕的展开态今天是组件级 useState,
 *    没有可记的键。给它一张有主的表是独立一单。
 * ② **冷载入不落锚点**:锚点只在**进场那一拍树上已经有消息**时用得上(= 停靠池
 *    命中的那条路,也正是 C1 要治的那条)。冷启动第一帧树是空的,此时落回锚点
 *    会先贴底再跳一次 —— 与「首帧就在底,不许先画顶部再跳」相悖,所以这一批
 *    老实落底,锚点留着下次用。要治它得等消息到齐再落一次,那是一次可见的跳。
 *    **09-10 补一句**:写点改成「滚动停稳就记」之后,冷载入那条路上消息到齐后
 *    的自动贴底会发一次真滚动,于是把留着的那份锚点改写成 `'bottom'` ——
 *    「留着下次用」到此为止。不给它加「这一下是不是我自己滚的」标志位是有意的
 *    (follow.ts 文件头那条纪律),真要保住它得先治这一格本身。
 *
 * ③ **切会话是整片叶卸载重挂** —— **09-10 结清**(组件级停靠,`content/session-park.ts`)。
 *    治法就是那时写下的那一句:藏起来而不是卸载。落地之后这张表的**读者少了
 *    一整条路**:同一棵树藏起来再拿出来时,位置由那棵树自己记的一格像素恢复
 *    (`ChatStream.useParkedScroll`),锚点表压根不参与。
 *
 *    **今天它只服务两条路**,两条的共同点是「树换了」:
 *      · **冷载入** —— 机器和组件树都不在了,进场那一拍要落回上次看到的那一行;
 *      · **被逐出** —— 视图停靠池上限 3、数据池上限 8,超出去的那几条视图真的
 *        卸载了(数据可能还在池里),切回来是一次「池命中冷渲」,照旧落回锚点。
 *    留账 ①(折叠态没有键)因此也**缩小了**:停靠着的那三条会话,工具卡的展开态
 *    随组件树一起活着,不需要键;只有跨出停靠池那一次才丢。
 *
 * ④ **`npm run gate:continuity` 今天守不住任何断言**(09-10):它的种子阶段
 *    「账本落到 4 条」20s 超时崩,整条门跑不到断言那一步。本批因此只跑单测,
 *    不跑那条真机门 —— 修门是另一单。
 */
