/**
 * Who is allowed to drive a room (R3 / P2-8).
 *
 * Two doors in the engine are keyed on one STRING — `source === 'collab'`:
 *
 *  - the ingress gate lets a command carrying it skip the persist-only path,
 *    so it streams the room instead of being handed to the coordinator;
 *  - the system-internal branch lets it stream a room session at all.
 *
 * A string is not a credential. Anything that can put a command on the bus —
 * the server's whole-command forward, a plugin, a mis-scoped internal emitter —
 * can spell 'collab' and get the coordinator's privileges: a stream on the room
 * with whatever persona was last activated, bypassing the mention resolution,
 * the chain gate and the budget gate that exist precisely to bound it.
 *
 * So the marker keeps identifying the drive and a per-PROCESS token proves it.
 * The token is minted by the coordinator at startup and never leaves the
 * process: a forwarded command cannot carry a value it has no way to know, and
 * a command replayed from a transcript carries a token from a process that no
 * longer exists. No persistence, no rotation, nothing to expire — it is alive
 * exactly as long as the coordinator that issued it.
 */
let driveToken: string | null = null

/** Install (or, with null, retire) the current process's drive token. */
export function configureCollabDriveGuard(token: string | null): void {
  driveToken = token
}

/** The token to stamp on a drive. Null before the coordinator has started. */
export function issueCollabDriveToken(): string | null {
  return driveToken
}

/**
 * Does this command prove it came from the live coordinator?
 *
 * Fails closed: with no token installed (coordinator not started, or already
 * shut down) nothing is trusted, which is the honest answer — there is no
 * coordinator to have issued it.
 */
export function isTrustedCollabDrive(command: { collabDriveToken?: unknown }): boolean {
  if (driveToken === null) return false
  return command.collabDriveToken === driveToken
}
