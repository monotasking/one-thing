import { createHash } from 'node:crypto'
import type { RuntimeRequestContext } from '@onething/core'
import { DEFAULT_SESSION_OWNER } from '../../session/access.js'

/** Naming only: callers must still authorize an existing session through Access. */
export function ownedCollabSessionId(
  legacyId: string | null,
  owner: RuntimeRequestContext,
): string | null {
  if (!legacyId) return null
  if (owner.userId === DEFAULT_SESSION_OWNER.userId
    && owner.workspaceId === DEFAULT_SESSION_OWNER.workspaceId) return legacyId
  const digest = createHash('sha256')
    .update(JSON.stringify([legacyId, owner.userId, owner.workspaceId]))
    .digest('hex')
  return `collab-owned-${digest}`
}
