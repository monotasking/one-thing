/**
 * Who is acting.
 *
 * Before this existed the permission system's subject was the SESSION: every
 * judgment input was keyed on `sessionId`, and `grep agentId` over
 * core/permission, core/tools and app/tools returned nothing. That is fine
 * while one session means one actor. It stops being fine the moment several
 * agents share a process: a grant one of them was given is honoured for the
 * next, and a permission card cannot say whose request it is showing.
 *
 * A Principal is the missing dimension. It is minted ONCE per turn at the
 * engine boundary and then carried down — never re-derived. See
 * docs/design/agent-permission-system-2026-08.md §4.1.
 */

/** The actor behind a turn. */
export type Principal =
  | { kind: 'user'; userId: string; workspaceId?: string }
  | {
      kind: 'agent'
      agentId: string
      /**
       * Set when another principal caused this turn (an agent woke this one,
       * a DM asked it to act). Reserved for the confused-deputy defence in §7
       * B5 — nothing reads it yet, but the mint sites must fill it in or the
       * information is gone by the time it is needed.
       */
      invokedBy?: Principal
    }
  | { kind: 'system'; component: string }

/**
 * Stable identity string. This is what grants are keyed on and what the audit
 * ledger records — keep it stable, it outlives processes.
 */
export function principalId(principal: Principal): string {
  switch (principal.kind) {
    case 'user': return `user:${principal.userId}`
    case 'agent': return `agent:${principal.agentId}`
    case 'system': return `system:${principal.component}`
  }
}

/**
 * The minimum-privilege principal. Everything that cannot prove who it is
 * lands here rather than on the default agent — a fallback that inherits the
 * default agent's reach is not a fallback, it is a bypass (§10 P0).
 */
export function systemPrincipal(component: string): Principal {
  return { kind: 'system', component }
}

/** The desktop owner: a local turn with no channel identity behind it. */
export const LOCAL_USER_ID = 'local'

export function localUserPrincipal(): Principal {
  return { kind: 'user', userId: LOCAL_USER_ID }
}

/**
 * Narrow a value that arrived from outside the process (a forwarded command, a
 * replayed transcript) into a Principal.
 *
 * IMPORTANT: passing this check is NOT authorisation. A string is not a
 * credential — the same lesson drive-guard.ts records. Callers must have
 * already proven the sender may name a principal (e.g. a verified drive
 * token); this only rejects malformed shapes.
 */
export function parsePrincipal(value: unknown): Principal | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as { kind?: unknown; userId?: unknown; agentId?: unknown; component?: unknown; workspaceId?: unknown; invokedBy?: unknown }

  if (raw.kind === 'user' && typeof raw.userId === 'string' && raw.userId) {
    return typeof raw.workspaceId === 'string' && raw.workspaceId
      ? { kind: 'user', userId: raw.userId, workspaceId: raw.workspaceId }
      : { kind: 'user', userId: raw.userId }
  }
  if (raw.kind === 'agent' && typeof raw.agentId === 'string' && raw.agentId) {
    const invokedBy = parsePrincipal(raw.invokedBy)
    return invokedBy
      ? { kind: 'agent', agentId: raw.agentId, invokedBy }
      : { kind: 'agent', agentId: raw.agentId }
  }
  if (raw.kind === 'system' && typeof raw.component === 'string' && raw.component) {
    return { kind: 'system', component: raw.component }
  }
  return undefined
}

/** Human-readable actor, for permission cards and the audit ledger. */
export function describePrincipal(principal: Principal, displayName?: string): string {
  if (displayName) return displayName
  switch (principal.kind) {
    case 'user': return principal.userId === LOCAL_USER_ID ? '你' : principal.userId
    case 'agent': return principal.agentId
    case 'system': return `系统(${principal.component})`
  }
}
