import path from 'node:path'
import { createHash } from 'node:crypto'
import type { RuntimeRequestContext } from '@onething/backend/server/runtime-facade.js'
import { getOnethingStorePath } from '@onething/backend/runtime/storage'
import { collabAgentNotebookPath } from '@onething/backend/runtime/collab/actors/agent-mailbox'
import { createCollabNotebookFileStore, type CollabNotebookStore } from '@onething/backend/runtime/collab/actors/notebook-store'
import { DEFAULT_SESSION_OWNER, SessionAccessError } from '@onething/backend/session/access.js'
import { fixedExecutionContext } from '@onething/backend/runtime/engine/execution-context'
import type { CollabActorAuthorization } from './execution-authorization.js'

/** The default owner's existing files stay at agents-v3/<agentId>/notebook.md. */
export function createOwnedCollabNotebookStore(owner: RuntimeRequestContext): CollabNotebookStore {
  const context = fixedExecutionContext(owner)
  const root = getOnethingStorePath()
  return createCollabNotebookFileStore({
    pathForAgent: agentId => {
      if (context.userId === DEFAULT_SESSION_OWNER.userId
        && context.workspaceId === DEFAULT_SESSION_OWNER.workspaceId) return collabAgentNotebookPath(agentId)
      const key = createHash('sha256')
        .update(JSON.stringify([context.userId, context.workspaceId, agentId])).digest('hex')
      return path.join(root, 'owned-collab-notebooks', key, 'notebook.md')
    },
  })
}

/** Room context comes from the actor's immutable activation, never a tool argument. */
export function createCollabActorNotebookStore(authorization: CollabActorAuthorization): CollabNotebookStore {
  const forRoom = (roomId?: string) => {
    if (!roomId) throw new SessionAccessError()
    return createOwnedCollabNotebookStore(authorization.contextForRoom(roomId))
  }
  return {
    append: input => forRoom(input.roomId).append(input),
    read: (agentId, scope) => forRoom(scope?.roomId).read(agentId),
  }
}
