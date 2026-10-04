/**
 * 「我在这间房能看到什么时候为止」—— 历史检索的唯一授权判据
 * (docs/design/collab-history-search.md §3)。
 *
 * ## 规则
 *
 * ```
 * 当前成员(memberAgentIds 含我)   → +∞          全部可见
 * 曾经在场(formerMembers 命中)     → 最后一次 removedAt
 * 都不在                            → undefined   从不可见
 * ```
 *
 * 一句话:**看得到「我最后一次在场那一刻」之前的一切,看不到之后的。**
 *
 * ## 三条取舍
 *
 *  - **当前成员看得到入房之前的历史**。与既有行为一致:一位同事第一次被拉进一间
 *    老房时,首轮 drive 本来就把整段房历史铺给它。检索若不给,同一份内容在两条
 *    路上表现不同,而"表现不同"正是这套系统里最贵的那类 bug。
 *  - **被移出的仍看得到移出之前**。它当时在场,那些话它读过;事后抹掉不是隐私
 *    保护,是让它记错自己的过去。
 *  - **取最后一次移出**。移出→拉回→再移出的人,前几次的 `removedAt` 都是旧账;
 *    而拉回之后它是当前成员,第一条分支已经先答了 +∞。
 *
 * 纯函数,零 I/O。调用方(app 层)负责把 `SessionMeta.room` 喂进来。
 */

export interface CollabRoomVisibilityLike {
  memberAgentIds?: readonly string[]
  formerMembers?: readonly { agentId: string; removedAt: number }[]
}

/**
 * 我在这间房能看到什么时候为止。
 *
 * @returns `Number.POSITIVE_INFINITY` = 全部可见;一个时间戳 = 只到那一刻;
 *          `undefined` = 这间房对我不可见(**不是**"看不到内容",是"这间房不存在"
 *          —— 调用方据此把它整间排除,连房名都不该出现在任何列表里)。
 */
export function collabRoomVisibleUntil(
  room: CollabRoomVisibilityLike | undefined,
  agentId: string | undefined,
): number | undefined {
  if (!agentId) return undefined
  if (room?.memberAgentIds?.includes(agentId)) return Number.POSITIVE_INFINITY

  let latest: number | undefined
  for (const entry of room?.formerMembers ?? []) {
    if (entry?.agentId !== agentId) continue
    if (typeof entry.removedAt !== 'number' || !Number.isFinite(entry.removedAt)) continue
    if (latest === undefined || entry.removedAt > latest) latest = entry.removedAt
  }
  return latest
}

/** 这条消息在授权窗口内吗。`visibleUntil` 来自上面那个函数。 */
export function isCollabMessageVisible(
  timestamp: number | undefined,
  visibleUntil: number | undefined,
): boolean {
  if (visibleUntil === undefined) return false
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return false
  return timestamp <= visibleUntil
}
