/**
 * Sessions nobody is watching (the radio DJ's, background drives). A
 * permission dialog raised there hangs the turn forever — the first radio
 * field test froze exactly this way, twelve searches deep, waiting on a
 * file-write prompt in a session the user had never opened. For these
 * sessions "ask" degrades to an immediate, well-explained deny: the model
 * sees the failure and can route around it, instead of the turn silently
 * dying.
 */
const unattendedSessions = new Set<string>()

export function markSessionUnattended(sessionId: string): void {
  unattendedSessions.add(sessionId)
}

export function isSessionUnattended(sessionId: string): boolean {
  return unattendedSessions.has(sessionId)
}
