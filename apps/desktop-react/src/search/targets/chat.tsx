import { registerTargetRenderer } from './registry'

/**
 * `kind: 'chat'` —— 一间会话(`runtime/src/search/capabilities/sessions.ts` 的
 * `ChatTarget`)。
 *
 * 行的视觉与 S4a 之前**逐字相同**:徽写「会话」,正文是会话名 / 预览 / 章节那一段,
 * 出处由行自己驮着(项目 · 时间 / 会话名)。搬进来的只有两件事 ——
 * 徽上的字(从前是 `badgeText()` 里 `badge.kind === 'session'` 那一支)与落点
 * (从前是面板 `activate()` 里 `case 'session'` 那一支)。
 */
export interface ChatTargetPayload {
  sessionId: string
  /**
   * 落到会话里**哪一条消息**上。缺席 = 落点就是这条会话本身(标题 / 预览 / 章节
   * 命中都给不出一个具体的消息 id —— 章节说的是一段,预览说的是一段截断)。
   *
   * **它长在 chat 而不是只长在 message 上**,是因为壳这一侧的会话行确实有两种:
   * 会话级(落到会话)与「预览那一段」(它其实指着第一条用户消息)。产地给得出
   * 才有值,给不出就缺席,不去补一个「第一条」凑格式。
   */
  messageId?: string
}

function payloadOf(payload: unknown): ChatTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { sessionId, messageId } = payload as Partial<ChatTargetPayload>
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  return typeof messageId === 'string' ? { sessionId, messageId } : { sessionId }
}

export const chatTargetRenderer = {
  kind: 'chat',
  badge: () => ({ labelKey: 'search.badgeSession' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.enterSession(payload.sessionId, payload.messageId)
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
