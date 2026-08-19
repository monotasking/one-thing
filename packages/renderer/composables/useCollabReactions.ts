/**
 * 房间消息的表情回应 —— 从 `MessageList.vue` 抬出的那一段(去复用重构 R1)。
 *
 * 抬出来是因为房面(`RoomSurface`)也收 `SayMessageRow` 的 `react` 事件。这里现在
 * 只剩**失败痕迹**这一件事:写本身与它的回填约定(`message:updated` 广播)归
 * chat store 的 `reactToCollabMessage`(架构收敛 C4 §4)。
 *
 * 失败痕迹之所以必须存在:这条写路径不做乐观更新,chips 永远显示真正落盘的东西,
 * 所以一次被拒的写在结构上是"看不见"的(P2-19)—— 不说一句就等于按了没反应。
 */
import { onScopeDispose, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.collab')

const HINT_LINGER_MS = 4000

export function useCollabReactions(getSessionId: () => string | undefined) {
  /** Failure trace for room actions taken from the list (self-clearing). */
  const reactionHint = ref('')
  let reactionHintTimer: ReturnType<typeof setTimeout> | null = null

  function showReactionHint(message: string): void {
    reactionHint.value = message
    if (reactionHintTimer) clearTimeout(reactionHintTimer)
    reactionHintTimer = setTimeout(() => {
      reactionHint.value = ''
      reactionHintTimer = null
    }, HINT_LINGER_MS)
  }

  async function react(messageId: string, emoji: string) {
    const sessionId = getSessionId()
    if (!sessionId || !messageId || !emoji) return
    try {
      const response = await useChatStore().reactToCollabMessage(
        sessionId,
        messageId,
        emoji,
        { type: 'user' },
      )
      if (response && response.success === false) {
        showReactionHint(response.error || '这个表情没有记上')
      }
    } catch (error) {
      log.error('reaction send failed', {}, error)
      showReactionHint(error instanceof Error ? error.message : String(error))
    }
  }

  onScopeDispose(() => {
    if (reactionHintTimer) clearTimeout(reactionHintTimer)
    reactionHintTimer = null
  })

  return { reactionHint, react }
}
