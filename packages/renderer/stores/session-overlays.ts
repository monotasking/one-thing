/**
 * **渲染层覆盖层**(overlay 车道,§17.8 前置批裁定)。
 *
 * ## 为什么要有这条车道
 *
 * U2 之后消息树来自账本折叠 —— 那棵树上只有**账本上有产地**的东西。可屏幕上有两类
 * 东西**按定义**进不了账本:
 *
 *  1. **本地错误卡**(`addLocalMessage`):说的正是"这条消息**没能**到达账本"
 *     (会话建失败 / 命令没发出去)。把它写进账本是自相矛盾;
 *  2. **占位型瞬态**(`image-loading` 等):追加即撤,append-only 的账本表达不了
 *     "我刚加了一格、现在把它拿掉"(`ephemeral-policy` 的 `contentPart.placeholder`
 *     那一条早就写着这句)。
 *
 * 从前这两类是**直接插进消息数组 / contentParts** 的,于是"消息树"里混着两种寿命
 * 完全不同的东西。这里给它们一条显式具名的车道:**fold 树保持纯净,渲染时叠加**。
 *
 * ## 本批的位置:双写,只写不读
 *
 * U2-a 还没切,屏幕仍由手写管道渲染。所以这一批**只加不改**:老路照旧往数组里插
 * (行为一个字不变),同时把同一条记进 overlay。U2-a 把树换成 fold 产物那一刻,
 * 渲染侧改读 overlay,老路那半边随十项手写派生一起休眠。
 *
 * 这样做的理由是**风险最小**:今天动渲染路径 = 动那七个滚动/交互碰面,而它们的
 * 判例是这个仓里最贵的一批。
 *
 * ## 它不进对拍
 *
 * overlay 不是消息树的一部分,所以 ui-refold 的两道门都不比它(账本侧永远没有它,
 * 比了必红)。这不是"豁免一格事实",是**车道划分**:门比的是树,树上没有它。
 */

import { shallowRef, triggerRef } from 'vue'
import type { ChatMessage, ContentPart } from '@/types'

/** 一条本地消息(整条,不在账本上)。 */
export interface OverlayLocalMessage {
  message: ChatMessage
  /** 挂在哪条消息之后;缺席 = 挂在末尾。 */
  afterMessageId?: string
}

/** 一格占位型瞬态(挂在某条消息的 contentParts 尾部)。 */
export interface OverlayTransientPart {
  messageId: string
  part: ContentPart
}

export interface SessionOverlay {
  localMessages: OverlayLocalMessage[]
  transientParts: OverlayTransientPart[]
}

function emptyOverlay(): SessionOverlay {
  return { localMessages: [], transientParts: [] }
}

const overlays = shallowRef<Map<string, SessionOverlay>>(new Map())

function mutate(sessionId: string, apply: (overlay: SessionOverlay) => void): void {
  const map = overlays.value
  const overlay = map.get(sessionId) ?? emptyOverlay()
  apply(overlay)
  map.set(sessionId, overlay)
  triggerRef(overlays)
}

/** 这条会话此刻的覆盖层(渲染侧叠加用;没有就是空的那份)。 */
export function getSessionOverlay(sessionId: string): SessionOverlay {
  return overlays.value.get(sessionId) ?? emptyOverlay()
}

/** 响应式句柄(组件里 `computed` 依赖它)。 */
export function sessionOverlaysRef() {
  return overlays
}

/** 记一条本地消息(与老路往数组里插的是同一条)。 */
export function addOverlayLocalMessage(
  sessionId: string,
  message: ChatMessage,
  afterMessageId?: string,
): void {
  mutate(sessionId, overlay => {
    overlay.localMessages = [
      ...overlay.localMessages,
      { message, ...(afterMessageId ? { afterMessageId } : {}) },
    ]
  })
}

/**
 * 挂 / 换一格占位瞬态。同一条消息上**同类型只有一格**(与
 * `content-parts.ts` 的 `pushImageLoading` 同款去重口径:末尾已经是它就不再加)。
 */
export function setOverlayTransientPart(
  sessionId: string,
  messageId: string,
  part: ContentPart,
): void {
  mutate(sessionId, overlay => {
    const rest = overlay.transientParts.filter(
      entry => !(entry.messageId === messageId && entry.part.type === part.type),
    )
    overlay.transientParts = [...rest, { messageId, part }]
  })
}

/** 扫掉瞬态:给了 messageId 就只扫那一条,否则整会话。 */
export function clearOverlayTransientParts(sessionId: string, messageId?: string): void {
  mutate(sessionId, overlay => {
    overlay.transientParts = messageId
      ? overlay.transientParts.filter(entry => entry.messageId !== messageId)
      : []
  })
}

/** 本地消息的 id 集合 —— ui-refold 用它把这些消息从对拍里摘掉(它们不在树上)。 */
export function overlayLocalMessageIds(sessionId: string): Set<string> {
  return new Set(getSessionOverlay(sessionId).localMessages.map(entry => entry.message.id))
}

/** 会话没了 / 测试重置。 */
export function forgetSessionOverlay(sessionId: string): void {
  if (!overlays.value.delete(sessionId)) return
  triggerRef(overlays)
}

/** 仅测试。 */
export function resetSessionOverlays(): void {
  overlays.value = new Map()
  triggerRef(overlays)
}
