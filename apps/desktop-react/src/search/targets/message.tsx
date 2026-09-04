import { registerTargetRenderer } from './registry'
import { originText } from '../transitions'
import type { SearchContinuation } from '../continuations'
import type { SearchRow } from '../types'

/**
 * `kind: 'message'` —— 一条消息正文命中(`runtime/src/search/capabilities/messages.ts`
 * 的 `MessageTarget`)。
 *
 * 与 `chat` 的差别只有一格:它**带 messageId**,所以落点是「进会话 + 滚到那条消息」。
 * 徽写「消息」—— 与 S4a 之前 `badgeText()` 里 `badge.kind === 'message'` 那一支逐字同。
 *
 * 那一下**只留一格待办**,不在这里去找 DOM:换会话之后聊天区要重开一次折叠、
 * 折出来的消息还要渲染成节点,而这一帧那棵树还是上一条会话的。待办由
 * `toc/useChatToc` 在锚点真的出现时消掉(判据是折叠落地,不是猜一个延迟)——
 * 理由与整条链写在 `content/locate-message.ts` 头上。这里只是把那一句从面板的
 * `activate()` 里搬过来,一个字没改。
 */
export interface MessageTargetPayload {
  sessionId: string
  messageId: string
}

function payloadOf(payload: unknown): MessageTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { sessionId, messageId } = payload as Partial<MessageTargetPayload>
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  return { sessionId, messageId }
}

/**
 * 续搜(S4b,§4.6 那张场景表第一行:「搜到一条消息 → 想在**这个会话里**找那句话」)。
 *
 * 只有**范围片**一种:这一条已经在一间会话里了,「它的消息」对它没有意义
 * (那就是它自己),「提到它的文件」也不是一次检索(消息里的文件引用本来就可点,
 * 见 §4.6 第四行)。片上写的是**所属会话的名字** —— 行尾出处已经是它,
 * 所以片与行说的是同一句话,不另取一个名字。
 */
function continuationsOf(row: SearchRow): SearchContinuation[] {
  const payload = payloadOf(row.target.payload)
  if (payload === undefined) return []
  return [{
    kind: 'scope',
    labelKey: 'search.continueInSession',
    chip: {
      key: 'sessionId',
      value: payload.sessionId,
      // 出处给不出名字时退到 id —— 画一个 id 比画一颗没有字的片诚实。
      label: originText(row.origin) || payload.sessionId,
    },
  }]
}

export const messageTargetRenderer = {
  kind: 'message',
  badge: () => ({ labelKey: 'search.badgeMessage' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.enterSession(payload.sessionId, payload.messageId)
  },
  continuations: continuationsOf,
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
