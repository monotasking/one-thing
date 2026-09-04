import { registerTargetRenderer } from './registry'
import type { SearchContinuation } from '../continuations'
import type { SearchRow } from '../types'

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

/**
 * 续搜两条(S4b,§4.6 那张场景表第一行与结论 2 的「会话 → 它的消息」)。
 *
 *  · **范围片**「在此会话内搜」= 加一格 `sessionId`,词留着 —— 「我刚才搜的那个词,
 *    只在这间会话里再看一遍」;
 *  · **枢轴**「它的消息」= 换到消息那一档 + 同一格 `sessionId` + **清词**。
 *    §4.6 原话把它记成「等价于范围片 + 清词」,这里就是那句话的逐字落地。
 *
 * ── 这个文件为什么可以出现 `'messages'` 这个能力 id ──────────────────────
 * 它是**这一类自己的渲染模块**(§4.0 允许动的两处之一),而「从一间会话跳到它的
 * 消息」这件事只有会话这一类知道该跳到哪儿。骨架(面板 / tab 条 / 分组 / 分页 /
 * 过滤片)仍然一个能力 id 都不认识,`__tests__/no-capability-literals.test.ts`
 * 那道闸因此把 `targets/` 整个豁免、把别处钉死。
 * 真正到位的形(后端自报一条 `kind:'continue'` 的动作)要先补契约两格 ——
 * 那笔账记在 `../continuations.ts` 头上。
 */
function continuationsOf(row: SearchRow): SearchContinuation[] {
  const payload = payloadOf(row.target.payload)
  if (payload === undefined) return []
  const chip = { key: 'sessionId', value: payload.sessionId, label: row.text }
  return [
    { kind: 'scope', labelKey: 'search.continueInSession', chip },
    { kind: 'pivot', labelKey: 'search.pivotSessionMessages', capability: 'messages', query: '', chip },
  ]
}

export const chatTargetRenderer = {
  kind: 'chat',
  badge: () => ({ labelKey: 'search.badgeSession' }),
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.enterSession(payload.sessionId, payload.messageId)
  },
  continuations: continuationsOf,
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
