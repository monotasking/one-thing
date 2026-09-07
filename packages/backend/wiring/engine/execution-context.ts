import type { RuntimeRequestContext } from '@onething/core'
import { DEFAULT_SESSION_OWNER, SessionAccessError } from '../../session/access.js'

/** Only accepts the separate host option. Never inspect command/tool arguments for identity. */
export function fixedExecutionContext(value?: unknown): Readonly<RuntimeRequestContext> {
  if (value === undefined) return DEFAULT_SESSION_OWNER
  if (!value || typeof value !== 'object') throw new SessionAccessError()
  const context = value as Partial<RuntimeRequestContext>
  if (typeof context.userId !== 'string' || !context.userId
    || typeof context.workspaceId !== 'string' || !context.workspaceId) throw new SessionAccessError()
  return Object.freeze({ userId: context.userId, workspaceId: context.workspaceId })
}
