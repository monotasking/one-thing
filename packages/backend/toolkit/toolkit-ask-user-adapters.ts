/**
 * `ask_user` 那只工具的适配器工厂(D191,从 `toolkit-adapters.ts` 拆出)。
 *
 * 它绑的是 interaction 的登记表与「这间房里有没有人类」(会话的事实,住在 session)。它**不能**住进 interaction:
 * 会话入口经 `session-permission-events` 引 interaction 入口,interaction 入口再交出一只读会话的东西就成环。
 * 所以留在 toolkit,经 toolkit 入口交出,并作为目录的缺省适配器。内容与旧路**逐字相同**。
 */
import { Interaction } from '@onething/backend/interaction'
import { NO_HUMAN_DECLINE_REASON, noHumanInTheRoom } from '@onething/backend/session'
import type { AskUserToolAdapters } from './builtin/toolkit-builtin-ask-user.js'

export function askUserAdapters(): AskUserToolAdapters {
  return {
    ask: async input => {
      // pair 房里没有人类。当场 declined 并把「这里没人能回答你」写给模型,
      // 而不是让它在一间空房里等到 deadline。
      if (noHumanInTheRoom(input.sessionId)) {
        return { id: '', answers: {}, outcome: 'declined', reason: NO_HUMAN_DECLINE_REASON }
      }
      return Interaction.ask({
        sessionId: input.sessionId,
        origin: 'host-tool',
        questions: input.questions,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.messageId ? { messageId: input.messageId } : {}),
        timeoutMs: input.timeoutMs,
      })
    },
    abort: input => {
      Interaction.abort({
        sessionId: input.sessionId,
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        reason: input.reason,
      })
    },
  }
}
