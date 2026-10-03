import { isCollabChainResetMessage } from './classify.js'
import { isCollabPassMessage } from './pass.js'
import { isCollabSayMessage, isCollabThinkingMessage } from './say.js'
import { isCollabDriveMessage, isCollabHarvestMessage, type CollabMessageLike } from './types.js'

/**
 * Chain accounting (§6.2):
 *  - counts:  an agent's actual speech — a `say` message (W14b), or in a
 *             pre-W14b transcript the non-pass turn message that WAS speech
 *  - ignores: drive messages, thinking records, pass turns, harvest posts,
 *             display-only roles
 *  - resets:  a real human message (non-drive user message) — 活的那侧由
 *             `handleRoomUserMessage` 在收到消息的第一时间清零。
 *             Steered messages satisfy this predicate too, so a transcript
 *             replay reaches the same count. (曾经还有一个 `steering:consumed`
 *             订阅做同一件事;它从 W18 起就没生效过,已删 —— 见 coordinator.ts。)
 *             **以及**带 `collabChainReset` 标记的外部注入(跨房 dm、wake poke):
 *             那两处 live 侧照旧就地清零,标记是它们**可重放**的那一半 ——
 *             没有它,无人类在场的 pair 房重启后重算值必然 ≥ live 值,顶格冻死
 *             (A2)。旧转录没有标记,行为与今天逐字相同。
 *
 * W14b epoch discipline: a turn that says three things counts three, because
 * the LIVE coordinator counts one per say and the boot recompute walks the
 * same messages — the two numbers must be identical or a restart silently
 * moves the chain gate. A thinking record counts zero no matter how long the
 * agent thought: thinking is not talking, and gating a room on it would punish
 * the very separation this工单 introduced.
 *
 * Harvest posts (delivery/progress reports) are work-pipeline output, not chat:
 * live accounting skips them (coordinator noteAgentSpoke is a noop for them),
 * so the replay must skip them too or a restart would inflate the count and
 * gate the room early (W12). Pre-W12 transcripts carry no marker and are still
 * over-counted on replay — a one-off that heals at the next human message.
 */
export function collabMessageCountsTowardChain(message: CollabMessageLike): boolean {
  if (message.role !== 'assistant' || !message.agentId) return false
  if (isCollabHarvestMessage(message)) return false
  // W14b epoch: the markers ARE the answer, both ways.
  if (isCollabThinkingMessage(message)) return false
  if (isCollabSayMessage(message)) return true
  // Pre-W14b transcript: the turn message was the speech.
  return !isCollabPassMessage(message.content)
}

export function collabMessageResetsChain(message: CollabMessageLike): boolean {
  // 外部注入(跨房 dm / wake poke)与人类插话同语义:由头来自这间房之外,
  // 讨论被推到了新的地方。判定收在 classify.ts —— 这里不比字符串。
  if (isCollabChainResetMessage(message)) return true
  if (message.role !== 'user') return false
  return !isCollabDriveMessage(message)
}

/** Recompute the chain count from a transcript tail (boot reconciliation).
 *
 *  清零优先于计数(if / else if):带标记的那条注入**自己也不计一格** ——
 *  live 侧同样如此(它不是这间房某个回合的产物,`noteAgentSpoke` 走不到它),
 *  两个数因此仍然逐条对得上。 */
export function computeCollabChainCount(messages: readonly CollabMessageLike[]): number {
  let count = 0
  for (const message of messages) {
    if (collabMessageResetsChain(message)) {
      count = 0
    } else if (collabMessageCountsTowardChain(message)) {
      count += 1
    }
  }
  return count
}
