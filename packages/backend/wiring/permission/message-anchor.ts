import { sessionReads } from '../../session/reads.js'

/**
 * 审批卡的**消息锚**——一次审批要挂在哪条消息上。
 *
 * ## 为什么这件事需要一个单一所有者
 *
 * 渲染侧把一次 ask 落到屏幕上要过两道闸(`renderer/stores/chat.ts:applyPermissionRequest`):
 *
 *   1. 先按 `messageId` 找消息 —— **找不到就进缓存空等**;
 *   2. 再按 `callId` 找 toolCall —— 找不到才轮到领养兜底
 *      (`adoptToolCallForPermission`,2026-08-11 死锁修复)。
 *
 * 第 2 道闸已经堵死:后台子代理的工具调用带 `parent_tool_use_id`,连接器按既有约定
 * **不为它另起工具卡**(`external-agents/claude-code-connector.ts:725`),于是 ask 携带的
 * 嵌套 `toolCallId` 在消息上根本不存在 —— 领养兜底正是为这种"锚不存在"准备的。
 *
 * 第 1 道闸没有兜底,而且**没有自愈**:缓存只由 `applyPendingPermissionRequests(sessionId,
 * messageId)` 在**那条消息被创建时**唤醒。一个永远不会被创建的 messageId(最典型的就是
 * 空串)= 永远不唤醒 = 后端挂着等人答、前端一张卡都没有,用户只能等 30 分钟墙钟或按停止。
 *
 * 两条外部通路从前各写了一份**逐字相同**的解析器,并且各自以 `?? ''` 收尾:
 *
 *   - `app/external-agents/index.ts`(Claude Code SDK)
 *   - `app/acp/permission-bridge.ts`(ACP)
 *
 * 而 `?? ''` 正是那个"永远不会被创建的 messageId"。这份文件把两份拷贝合成一个所有者,
 * 并把口径从"取最新的 assistant 消息"改成**"取一条渲染侧真的拿得到的消息"**。
 *
 * ## 口径
 *
 * 1. `preferred` 在会话里**确实存在** → 用它(调用方比我们更清楚这一轮写在哪);
 * 2. 会话一条消息都没有 → 原样退回 `preferred`:此刻无从校验,而渲染侧同样没有可投影的
 *    载体(`applyPendingPermissionSnapshot` 对空消息列表直接 return),销毁信息没有好处;
 * 3. 否则取最新的 assistant 消息 —— 卡片本来就该长在 assistant 消息上;
 * 4. 再否则取**最后一条消息(不论角色)**:一条 user 消息也是渲染侧真的拿得到的锚,
 *    领养兜底会把工具卡挂上去、账页照常画。位置略偏 ≫ 一张卡都没有。
 *
 * 只有"会话里真的一条消息都没有"才会回到空串 —— 那一格是真空,不是漏判。
 */
export function resolvePermissionMessageAnchor(
  sessionId: string,
  preferred?: string,
): string {
  const messages = sessionReads.listMessages(sessionId).messages
  if (!messages.length) return preferred ?? ''

  if (preferred && messages.some(message => message.id === preferred)) return preferred

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant') return messages[index].id
  }

  return messages[messages.length - 1].id
}
