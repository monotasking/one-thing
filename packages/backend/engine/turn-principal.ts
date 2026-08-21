/**
 * Who is behind this turn — decided ONCE, here, at the engine boundary.
 *
 * Two rules make this the authority rather than a passthrough:
 *
 *  1. A claim on the command is only honoured when the sender can PROVE it may
 *     make one. Today the single prover is the collab drive token
 *     (app/collab/drive-guard.ts), because the coordinator is the only thing
 *     entitled to say "this turn runs as agent X". Everything else gets its
 *     principal computed here and any claim it carried is discarded — apps/server
 *     forwards commands whole (`no field is destructured away`), so a trusted
 *     `principal` field would be a chosen identity for anyone who can POST.
 *
 *  2. When nothing can be proven the answer is `system`, not the default agent.
 *     A fallback that inherits the default agent's reach is not a fallback, it
 *     is a bypass: `createCoreSessionRecord` stamps `agentId` on EVERY session,
 *     so "look up session.agentId" always answers, and always plausibly.
 *     app/collab/history-tool.ts:69-91 records where that road ends.
 *
 * See docs/design/agent-permission-system-2026-08.md §4.1 / §10 P0.
 */
import type { MessageOrigin } from '@shared/ipc.js'
import {
  localUserPrincipal,
  parsePrincipal,
  systemPrincipal,
  type Principal,
} from '@onething/core/permission'
import { isSystemInternalSource } from '../channel/origin.js'
import { isTrustedCollabDrive } from '../collab/drive-guard.js'

const COLLAB_MESSAGE_SOURCE = 'collab'

/**
 * Turns with no human behind them, for PRINCIPAL purposes only.
 *
 * Deliberately NOT reusing SYSTEM_INTERNAL_MESSAGE_SOURCES (channel/origin.ts):
 * that set answers "should this bypass routing", and widening it would change
 * routing behaviour. This one answers "who is acting".
 *
 * The scheduler is the case that makes the two differ — it drives turns with
 * `channel: 'scheduler'` and no `source` at all (scheduler/agent-task-runner.ts),
 * so the routing set never sees it. Without this line a scheduled task would
 * mint the desktop owner and inherit everything the owner may do.
 *
 * Voice (`source: 'voice'`) and the CLI daemon (`source: 'text'`) are absent on
 * purpose: those ARE the local person, just arriving by another door.
 */
const MACHINE_DRIVEN_CHANNELS: ReadonlySet<string> = new Set(['scheduler'])

interface PrincipalClaimingCommand {
  source?: string
  channel?: string
  principal?: unknown
  collabDriveToken?: unknown
}

/**
 * @param command the incoming send-message command (its `principal` is a claim,
 *   not a fact)
 * @param origin the message origin to read a channel identity from. Pass the
 *   ROUTED origin where routing happens — that is what resolves a gateway
 *   message to a person.
 */
export function mintTurnPrincipal(
  command: PrincipalClaimingCommand,
  origin?: MessageOrigin,
): Principal {
  if (command.source === COLLAB_MESSAGE_SOURCE && isTrustedCollabDrive(command)) {
    // Proven: the live coordinator is driving. Take the actor it names.
    const claimed = parsePrincipal(command.principal)
    if (claimed) return claimed
    // Token checks out but no usable claim — the drive is genuine, the actor
    // is not knowable. Least privilege, not a guess.
    return systemPrincipal('collab')
  }

  if (isSystemInternalSource(command.source)) {
    return systemPrincipal(command.source || 'internal')
  }

  if (command.channel && MACHINE_DRIVEN_CHANNELS.has(command.channel)) {
    return systemPrincipal(command.channel)
  }

  const userId = origin?.resolvedIdentity?.userId
  if (userId) {
    const workspaceId = origin?.conversation?.workspaceId ?? origin?.replyTarget?.workspaceId
    return workspaceId
      ? { kind: 'user', userId, workspaceId }
      : { kind: 'user', userId }
  }

  // No channel identity behind it: the person at the desktop.
  return localUserPrincipal()
}
