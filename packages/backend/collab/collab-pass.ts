/** The sentinel an activated agent outputs to decline speaking (§6.4). */
export const COLLAB_PASS_SENTINEL = '[pass]'

/**
 * A pass turn is a message that is NOTHING BUT the sentinel (whitespace
 * tolerated). A hedge like "[pass]\n但是…" counts as normal speech by design —
 * content is never silently dropped (docs/design/multi-agent-collab.md §6.4).
 */
export function isCollabPassMessage(content: string | undefined | null): boolean {
  if (!content) return false
  return content.trim().toLowerCase() === COLLAB_PASS_SENTINEL
}
