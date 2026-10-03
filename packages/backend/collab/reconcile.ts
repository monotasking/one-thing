/**
 * W23 restart idempotence — the transcript half.
 *
 * Boot reconciliation used to have exactly ONE ledger of "which room messages
 * were already consumed": the coordinator's `state.json` activation records.
 * That ledger is bounded — `persistRoomState` keeps only the last 50 records —
 * and the watermark does NOT advance for an activation that ended in failure.
 * A busy room therefore reaches a shape where the record naming a message has
 * aged out while the watermark still sits behind it, and the boot replay
 * re-decides a message the room already answered: a second card, a second
 * worker, the same instruction executed twice (W17 验收现场).
 *
 * The fix does not make the state file bigger. It reads the OTHER ledger, the
 * one that was already durable and already uncapped: since W18 every drive is a
 * persisted user message in the agent's execution session, and W23 stamps the
 * room message that caused it onto that drive. A drive on disk is proof the
 * activation happened — proof that outlives any cap, any throttle, and the
 * state file itself.
 *
 * Pure logic: it is handed messages and returns ids. Which sessions to read,
 * and how far back, is the coordinator's call.
 */
import { isCollabDriveMessage, type CollabMessageLike } from './types.js'

/**
 * How many trailing messages of an execution session the slow path reads.
 *
 * This runs once per room at boot and only when the state records already
 * missed, so the budget buys the recent past rather than all of history: a
 * message old enough to have fallen out of this window is old enough that the
 * watermark moved past it long ago.
 */
export const COLLAB_CONSUMED_SCAN_TAIL = 100

/**
 * The room messages a transcript proves were already driven.
 *
 * Only drives carry the stamp, so this is a drive-shaped scan by construction:
 * a `say`, a thinking record or a human line can never contribute an id.
 * Pre-W23 drives carry no stamp and contribute nothing — they replay once and
 * self-heal, which is the documented compatibility position.
 */
export function collectConsumedSourceIds(
  messages: readonly CollabMessageLike[] | undefined,
  tail: number = COLLAB_CONSUMED_SCAN_TAIL,
): Set<string> {
  const consumed = new Set<string>()
  if (!messages || messages.length === 0) return consumed

  const window = tail > 0 && messages.length > tail ? messages.slice(-tail) : messages
  for (const message of window) {
    // The stamp alone is not enough: only a DRIVE means "this agent was
    // actually put to work on that message". Anything else carrying the field
    // (a copied envelope, a future reuse) must not be able to retire a message.
    if (!isCollabDriveMessage(message)) continue
    const sourceId = message.collabSourceMessageId
    if (typeof sourceId === 'string' && sourceId.length > 0) consumed.add(sourceId)
  }
  return consumed
}
