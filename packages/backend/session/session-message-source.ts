/**
 * 协作消息的来源标记(越层清零 A2,2026-10-04 从 `collab/collab-classify.ts` 逐字搬来)。
 *
 * 这七个常量是写在会话消息 `source` / `origin.source` 上的字符串,会话仓自己在用(`session-store.ts`
 * 的 `stampTurnSource`),所以住在 session;「这条消息算哪一类」的谓词仍是协作的事,留在
 * `collab/collab-classify.ts`,它改引这里。
 */

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
