/**
 * What a room message IS — one classifier, one place (R3, 债4).
 *
 * A room transcript carries six different kinds of message under one shape,
 * and every one of them is told apart by a `source` marker that can arrive on
 * EITHER of two fields: `message.source` (what the writer stamped) or
 * `message.origin.source` (what the transport stamped). Every predicate used
 * to read both fields itself, six near-identical times, and the duplication
 * has already cost a real incident — the engine copies a drive's envelope onto
 * the message it creates, so a consumer that checked only one of the two
 * fields read a turn record as a drive.
 *
 * So the double-field read happens exactly once, here, and the predicates that
 * every caller already imports delegate to it. A seventh marker is a new arm of
 * this switch and nothing else.
 *
 * The kinds:
 *
 *  | kind              | what it is                                   | 投影 | 链长 |
 *  | drive             | the synthetic user message carrying a turn   |  ✗   |  ✗   |
 *  | say               | a real utterance (the `say` tool wrote it)   |  ✓   |  计  |
 *  | thinking          | the turn's host record: thinking + tools     |  ✗   |  ✗   |
 *  | harvest           | a report the coordinator posted for a worker |  ✓   |  ✗   |
 *  | task-line         | task lifecycle system line (projected)       |  ✓   |  ✗   |
 *  | membership-line   | 群公告 system line (projected)               |  ✓   |  ✗   |
 *  | operational-line  | budget / chain / freeze — machine bookkeeping|  ✗   |  ✗   |
 *  | plain             | pre-marker transcripts, and user messages    |  ✓   |  计  |
 *
 * `plain` is deliberately the fallback: a transcript written before a marker
 * existed keeps behaving exactly as it did when it was written. The rule is a
 * MARKER, never a migration.
 */
import { isCollabPassMessage } from './pass.js'
import type { CollabMessageLike } from './types.js'

/** The system-internal message source stamped on coordinator drives. */
export const COLLAB_MESSAGE_SOURCE = 'collab'

/**
 * Harvest posts: the delivery/progress reports the coordinator writes into the
 * room directly under a worker's name (assistant + agentId, no turn behind
 * them). Marked with their OWN source — deliberately not COLLAB_MESSAGE_SOURCE,
 * whose predicate claims every message carrying it as a drive.
 *
 * The marker exists so a boot replay can tell work-pipeline output apart from
 * real chat speech: chain accounting excludes these live (noteAgentSpoke is a
 * noop for them) and must reach the same number when recomputed (W12).
 */
export const COLLAB_HARVEST_SOURCE = 'collab-harvest'

/** Marker on an assistant message the `say` tool wrote — a real utterance. */
export const COLLAB_SAY_SOURCE = 'collab-say'

/**
 * Marker on the turn's host assistant message — the agent's thinking record,
 * not something it said. Stamped at creation (store choke point), so the marker
 * exists from birth: a crash mid-turn can never leave a thinking record looking
 * like speech, and the room UI never flashes a full bubble that collapses a
 * tick later.
 */
export const COLLAB_TURN_SOURCE = 'collab-turn'

/** Task lifecycle lines: started / delivered / halted / interrupted / review. */
export const COLLAB_SYSTEM_SOURCE_TASK = 'collab-task'
/** Membership change lines (W6): joined / left / role changed. */
export const COLLAB_SYSTEM_SOURCE_MEMBERSHIP = 'collab-membership'

/** Every system-line source that reaches the model. Extend here, nowhere else. */
export const COLLAB_PROJECTED_SYSTEM_SOURCES: readonly string[] = [
  COLLAB_SYSTEM_SOURCE_TASK,
  COLLAB_SYSTEM_SOURCE_MEMBERSHIP,
]

export type CollabRoomMessageKind =
  | 'drive'
  | 'say'
  | 'thinking'
  | 'harvest'
  | 'task-line'
  | 'membership-line'
  | 'operational-line'
  | 'plain'

type SourceMarked = Pick<CollabMessageLike, 'role' | 'source' | 'origin'>

/**
 * The double-field read, once. `origin.source` matters because the engine
 * copies a command's envelope onto the message it persists — a message can
 * therefore carry its marker on either field, and reading only one of them is
 * the bug this module exists to make impossible.
 */
function marked(message: SourceMarked, marker: string): boolean {
  return message.source === marker || message.origin?.source === marker
}

export function classifyCollabRoomMessage(message: SourceMarked): CollabRoomMessageKind {
  if (message.role === 'user') {
    return marked(message, COLLAB_MESSAGE_SOURCE) ? 'drive' : 'plain'
  }

  if (message.role === 'assistant') {
    // Precedence, not just order: a message carrying BOTH markers is thinking.
    // This used to live implicitly in each consumer's if-chain (chain.ts and
    // projection.ts both test thinking first) and is exactly the kind of rule
    // that goes missing when a seventh consumer appears — so the classifier
    // owns it. A mislabelled record must never count toward the chain or reach
    // the model; the reverse costs one utterance nobody wrote.
    if (marked(message, COLLAB_TURN_SOURCE)) return 'thinking'
    if (marked(message, COLLAB_SAY_SOURCE)) return 'say'
    if (marked(message, COLLAB_HARVEST_SOURCE)) return 'harvest'
    return 'plain'
  }

  if (message.role === 'system') {
    if (marked(message, COLLAB_SYSTEM_SOURCE_TASK)) return 'task-line'
    if (marked(message, COLLAB_SYSTEM_SOURCE_MEMBERSHIP)) return 'membership-line'
    // Budget, chain gate, freeze, permission reminders: the machine's own
    // bookkeeping, shown to the user and withheld from the model (W9.1).
    return 'operational-line'
  }

  return 'plain'
}

/** A coordinator drive: the synthetic user message that carries an activation. */
export function isCollabDriveMessage(message: SourceMarked): boolean {
  return classifyCollabRoomMessage(message) === 'drive'
}

/** A worker delivery/progress report posted by the coordinator, not spoken. */
export function isCollabHarvestMessage(message: SourceMarked): boolean {
  return classifyCollabRoomMessage(message) === 'harvest'
}

/** An utterance the `say` tool wrote — the only thing a room ever receives. */
export function isCollabSayMessage(message: SourceMarked): boolean {
  return classifyCollabRoomMessage(message) === 'say'
}

/**
 * The turn's own host message: thinking text and whatever tools it ran. Never
 * speech — excluded from the projection, the willingness window and the chain,
 * and rendered as a collapsed trace row.
 */
export function isCollabThinkingMessage(message: SourceMarked): boolean {
  return classifyCollabRoomMessage(message) === 'thinking'
}

/**
 * **外部注入的链闸清零标记**(2026-08-03,架构审查 A2)。
 *
 * 不是第八种 kind:它与 kind 正交(带标记的那条本身是一条正常的 `say`,照常
 * 投影、照常署名),说的是另一件事 —— 「这条消息的由头来自这间房**之外**」。
 *
 * 为什么必须落在消息上:跨房 dm 注入(dm-tool.ts)与 wake poke(wake-followup.ts)
 * 都在 live 侧把 `chainCount` 清零,而 boot 重算(chain.ts)只认人类消息 ——
 * 于是没有人类在场的 agent ⇄ agent 房重启一次,重算值必然 ≥ live 值,顶格
 * 冻死,只能等下一次跨房注入。标记让"清零"变成**可重放**的事实。
 *
 * 旧转录没有这个字段 → 读作 false,行为与标记存在之前逐字相同(marker 是规则,
 * 不是迁移)。
 */
export function isCollabChainResetMessage(
  message: Pick<CollabMessageLike, 'collabChainReset'>,
): boolean {
  return message.collabChainReset === true
}

/**
 * Is this a system line the model gets to read? Marked-source system messages
 * only — an unmarked system message (budget, chain gate, freeze, permission
 * reminder) is display-only, and a marked source on a non-system role is not a
 * system line at all.
 */
export function isCollabProjectedSystemLine(message: SourceMarked): boolean {
  const kind = classifyCollabRoomMessage(message)
  return kind === 'task-line' || kind === 'membership-line'
}

/**
 * **这条消息算不算「房间的事实」** —— 进模型视野的唯一判据(P5-2)。
 *
 * 上面那张 kind 表的「投影」列,现在是一个可调用的函数。存在的理由是这条判定
 * 此前被写了三遍,而三份答案不一样(collab-agent-view-p5.md §2):
 *
 * ```
 * projection.ts        收 MARKED 系统行(W9.1 要求)
 * digest-runner.ts:80  role !== user/assistant → 丢     ← 系统行进不了摘要
 * room-history-tool:102 role !== user/assistant → 丢    ← 系统行永远查不回
 * ```
 *
 * (`room-history-tool.ts` 已于 2026-08-02 退役,由 `app/collab/history-tool.ts`
 * 取代 —— 后者从第一天起就走这个函数。)
 *
 * 净效果是一条卡片流转记录**在投影里是事实、在摘要里不存在、在工具里查不到**,
 * 折叠一发生就彻底蒸发 —— 而 W9.1 那个事故的结论恰恰是"没有这些行,评审方只
 * 知道执行者**声称**了什么"。判定收在一处之后,这种漂移不再有发生的地方。
 *
 * `pass` 是这里唯一的**内容层**判定:一条只有 `[pass]` 的 assistant 消息不是
 * 发言。它在 kind 表里没有一行,因为它不靠 marker 认 —— 但它和 thinking 一样
 * 是"这条不该进任何人的视野",所以归属在这里而不是散落在各消费方。
 *
 * **空正文不在这里判**。投影里一条没有正文但带 toolCalls 的 assistant 消息仍然
 * 撑得起一行(拍平进正文),而工具与摘要都需要正文才有东西可给 —— 三方对"空"的
 * 需求本来就不同,硬统一会让投影漏掉 tool call 行。各自 `if (!content)`。
 */
export function isCollabRoomFact(
  message: SourceMarked & Pick<CollabMessageLike, 'content'>,
): boolean {
  // 三种角色之外的(error 行、遗留 tool 行)一律显示态。classify 的兜底是
  // `plain`,那对**它**是对的(marker 是规则,不是迁移),但"没有角色的东西
  // 也不该进视野"是这一层的判断,所以写在这里而不是改那个兜底。
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') {
    return false
  }
  switch (classifyCollabRoomMessage(message)) {
    case 'drive':
    case 'thinking':
    case 'operational-line':
      return false
    case 'say':
    case 'plain':
      return message.role !== 'assistant' || !isCollabPassMessage(message.content)
    default:
      // harvest / task-line / membership-line —— 房间里发生过的事实。
      return true
  }
}
