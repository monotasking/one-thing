import type { SessionsListRequest } from '@shared/ipc/sessions.js'
import { listOnethingSessionsForIpc } from '@onething/runtime/sessions'
import { DEFAULT_SPACE_ID } from '@onething/runtime/spaces/types'
import type { SessionAccess, SessionAccessContext } from './access.js'

/** Authorization and product-space filtering share one query boundary for every transport. */
export function createSessionListQuery<T extends object & { workspaceId?: string }>(ports: {
  listSessions(): T[]
  access: Pick<SessionAccess, 'filter'>
}) {
  return (context: SessionAccessContext, request: SessionsListRequest = {}) => listOnethingSessionsForIpc({
    listSessions: () => {
      if (request.workspaceId !== undefined && (typeof request.workspaceId !== 'string' || !request.workspaceId)) {
        throw new Error('workspaceId must be a nonempty string')
      }
      const visible = ports.access.filter(context, ports.listSessions())
      // Product workspace is a user filter; it never changes the tenant context.
      return request.workspaceId === undefined ? visible
        : visible.filter(meta => (meta.workspaceId ?? DEFAULT_SPACE_ID) === request.workspaceId)
    },
  })
}
