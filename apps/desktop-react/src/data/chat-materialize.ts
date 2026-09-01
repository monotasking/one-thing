import {
  materializeNode,
  type ProjectionMaterializeOptions,
  type ProjectionNode,
  type SessionProjectionState,
} from '@onething/core/session'
import type { ProjectedMessage } from './chat-fold'

/**
 * **增量物化**(09-01 P0,用户真机日志:60 万 token 长会话流式期间 chat-source 的
 * rAF 回调连续十几帧 250–335ms、最重 1153ms,流式实际 3–4fps,打字悬停全卡)。
 *
 * ── 病在哪儿 ──────────────────────────────────────────────────────────
 * `compose()` 每帧调一次 `materializeChatMessages(fold.state, …)`,而那一口是
 * **全量**的:整篇抄本每条节点都重新物化一遍。流式期间真正在变的只有一条消息,
 * 其余几百条每帧陪跑一次,代价 ∝ 抄本长度 —— 长会话每帧付全款。
 *
 * 连带还有一条更贵的:`assembleMessage` 的 memo 按**消息对象引用**做键
 * (assemble/index.ts)。全量物化每帧造出全新对象,那张表于是每帧全军 miss ——
 * 整篇抄本每帧重装配一次(日志里那条 `perf.span assemble 206ms`)。它一直是对的,
 * 只是上游每帧把键换掉了;这里把引用稳住,它不用改一个字就跟着好了。
 *
 * ── 钥匙:`(投影节点对象, node.rev)` ──────────────────────────────────
 * 不是新发明。`BaseNode.rev` 与 `forWrite` 早在 core 的归约器里(§17.7.1 批 1):
 * 要往节点上写的分支一律经 `forWrite` 取节点,号顺手前进 —— 于是「这条节点的
 * 物化产物还作数吗」由节点自己回答。`packages/backend/session/materialized-messages.ts`
 * 已按同一把钥匙做过一次(258 条 / 50MB 的会话 46ms → 0.026ms)。
 *
 * **为什么壳要自己存一份,而不是把 memo 塞进 core 的 `materializeNode`**:
 * 与那个文件头第 30 行同一条理由 —— 成品取决于**这条读路自己的物化选项**
 * (壳这边是 `resolveBlob`,读的是壳的 blob 缓存),而 refold 那道门、模型历史、
 * 后端读路各自带着自己的选项走同一口。缓存归读路,节点只负责回答「我变过没有」。
 *
 * ── 失效条件,只有三条 ────────────────────────────────────────────────
 *  ① **节点 rev 前进** —— 唯一产地是归约器的 `forWrite`;
 *  ② **blobEpoch 前进** —— 见下,这是壳比后端多出来的一格;
 *  ③ **节点对象没了** —— 重折换整份 state、换会话丢掉 fold,`WeakMap` 自动清。
 *
 * 没有第四条,也没有「谁去清」这个问题 —— 也就没有清漏的可能。
 * `hidden` **不进** rev(core 的既有裁定:它是列表成员判据不是产物判据),
 * 所以每次现问,与后端那份逐字同一手。
 *
 * ── 内存上界 ──────────────────────────────────────────────────────────
 * 两张表都是 `WeakMap`,键是投影节点 / 投影 state 对象本身,**没有按 id 的强引用
 * 表**。上界 = 当前这一份投影自己的大小(每条节点最多挂一份成品,rev 变了是覆盖
 * 不是追加),不随会话数、不随时间增长。
 */

interface MessageMemo {
  /** 算这一份时那条节点的 `rev`(见 core 的 `BaseNode.rev`)。 */
  rev: number
  /** 算这一份时的 blob 世代(见 `materializeChatMessagesCached` 的 `blobEpoch`)。 */
  epoch: number
  message: ProjectedMessage
}

/** 节点 → 它此刻的成品。键是节点对象本身,节点没了成品跟着没。 */
const memos = new WeakMap<ProjectionNode, MessageMemo>()

/**
 * 投影 state → 上一次交出去的那个**数组实例**。
 *
 * 它不是缓存(正确性全在上面那张 memo 表里),是**实例稳定器**:逐条同一时交回
 * 上一次那个数组,于是「这一帧账本真的没变」在下游是一次引用相等,而不是一个
 * 长得一样的新数组。键是 state 对象:整份重折换新 state,旧数组随它一起消失。
 */
const lists = new WeakMap<SessionProjectionState, ProjectedMessage[]>()

export interface MaterializedChat {
  messages: ProjectedMessage[]
  activeRun?: SessionProjectionState['activeRun']
}

/**
 * 折叠状态 → 屏幕要的那一份消息,**按节点缓存**。
 *
 * 与 core 的 `materializeChatMessages` 逐条同义(同一个 `materializeNode`、同一条
 * `hidden` 过滤、同一份 `activeRun`),差别只在「不变的节点直接取上一份成品」。
 *
 * @param blobEpoch 壳的 blob 缓存世代。`resolveBlob` 读的是模块级那张表,一条 blob
 *   落盘之后成品会变,而账本没变、`node.rev` 因此不动 —— 少了这一格,附件正文
 *   会永远停在「还没读回来」的那一版。这是壳比后端多出来的一格:后端那侧的物化
 *   选项是每会话固定的,没有这个世代问题。
 */
export function materializeChatMessagesCached(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions,
  blobEpoch: number,
): MaterializedChat {
  const next: ProjectedMessage[] = []
  for (const node of state.nodes) {
    // `hidden` 是列表成员判据,不进 `rev` —— 每次现问(见文件头)。
    if (node.hidden) continue
    next.push(cachedNode(node, options, blobEpoch))
  }
  const previous = lists.get(state)
  const messages = previous && sameList(previous, next) ? previous : next
  lists.set(state, messages)
  return { messages, ...(state.activeRun ? { activeRun: state.activeRun } : {}) }
}

function cachedNode(
  node: ProjectionNode,
  options: ProjectionMaterializeOptions,
  epoch: number,
): ProjectedMessage {
  const hit = memos.get(node)
  if (hit && hit.rev === node.rev && hit.epoch === epoch) return hit.message
  const message = materializeNode(node, options) as ProjectedMessage
  memos.set(node, { rev: node.rev, epoch, message })
  return message
}

/** 逐条**引用**相同才算同一份 —— 值相等不算数,下游短路靠的就是引用。 */
function sameList(a: readonly ProjectedMessage[], b: readonly ProjectedMessage[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** 只给测试用:量「这一帧真的物化了几条」。 */
export function __countMemoMisses(
  state: SessionProjectionState,
  options: ProjectionMaterializeOptions,
  blobEpoch: number,
): number {
  let misses = 0
  for (const node of state.nodes) {
    if (node.hidden) continue
    const hit = memos.get(node)
    if (!hit || hit.rev !== node.rev || hit.epoch !== blobEpoch) misses += 1
  }
  return misses
}
