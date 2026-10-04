/**
 * Who is behind this turn — decided ONCE, here, at the engine boundary.
 *
 * Two rules make this the authority rather than a passthrough:
 *
 *  1. A claim on the command is only honoured when the sender can PROVE it may
 *     make one. Today the single prover is the collab drive token
 *     (collab/collab-drive-guard.ts, handed in by the caller as `proveCollabDrive`), because the coordinator is the only thing
 *     entitled to say "this turn runs as agent X". Everything else gets its
 *     principal computed here and any claim it carried is discarded — apps/backend-server
 *     forwards commands whole (`no field is destructured away`), so a trusted
 *     `principal` field would be a chosen identity for anyone who can POST.
 *
 *  2. When nothing can be proven the answer is `system`, not the default agent.
 *     A fallback that inherits the default agent's reach is not a fallback, it
 *     is a bypass: `createCoreSessionRecord` stamps `agentId` on EVERY session,
 *     so "look up session.agentId" always answers, and always plausibly.
 *     collab/collab-history-tool.ts:69-91 records where that road ends.
 *
 * See docs/design/agent-permission-system-2026-08.md §4.1 / §10 P0.
 */
import {
  localUserPrincipal,
  parsePrincipal,
  systemPrincipal,
  type Principal,
} from '@shared/permission/principal'
import { isSystemInternalSource } from './agent-loop-message-sources.js'
import type { EngineMessageOrigin } from './agent-loop-engine-ports.js'

/**
 * 「这条命令是不是在世的协作协调者发来的」的判据。内核不认识协作功能,所以由调用方交进来:
 * 引擎从它的 `collabDrive` 端口取(装配时填的是 `collab/collab-drive-guard.ts` 的 `isTrustedCollabDrive`)。
 * 没交 = 谁也证明不了,与协调者没起来时的答案相同。
 */
export type CollabDriveProver = (command: { collabDriveToken?: unknown }) => boolean

const COLLAB_MESSAGE_SOURCE = 'collab'

/**
 * Turns with no human behind them, for PRINCIPAL purposes only.
 *
 * Deliberately NOT reusing SYSTEM_INTERNAL_MESSAGE_SOURCES (message-sources.ts):
 * that set answers "should this bypass routing", and widening it would change
 * routing behaviour. This one answers "who is acting".
 *
 * The scheduler is the case that makes the two differ — it drives turns with
 * `channel: 'scheduler'` and no `source` at all (scheduler/scheduler-agent-task-runner.ts),
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
 * @param proveCollabDrive 协作驱动令牌的验票函数(见 `CollabDriveProver`);缺席时一律不采信。
 */
export function mintTurnPrincipal(
  command: PrincipalClaimingCommand,
  origin?: EngineMessageOrigin,
  proveCollabDrive?: CollabDriveProver,
): Principal {
  if (command.source === COLLAB_MESSAGE_SOURCE && proveCollabDrive?.(command) === true) {
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
