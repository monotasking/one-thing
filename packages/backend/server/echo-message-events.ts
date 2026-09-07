import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import { createSessionProjectionState, reduceSessionProjection, materializeNode } from '@onething/core/session'
import type { SessionCommandEvents } from '../session/command-events.js'

/** Explicit echo-host adapter. Its transcript is independent of the production ledger. */
export function createEchoMessageEvents(getSession: (id: string) => ChatSession | undefined): SessionCommandEvents {
  const replace = (id: string, transform: (messages: ChatMessage[]) => readonly ChatMessage[]) => {
    const session = getSession(id)
    if (!session) return
    const messages = transform(session.messages)
    let projection = createSessionProjectionState()
    for (const [index, message] of messages.entries()) projection = reduceSessionProjection(projection, {
      type: 'message/imported', seq: index + 1, time: message.timestamp,
      surfaceOp: 'append', data: { message: structuredClone(message) as never },
    })
    // Echo snapshots are the authority; they are never fed to production readers.
    session.messages = projection.nodes.filter(node => !node.hidden).map(node => materializeNode(node) as ChatMessage)
  }
  return {
    appendMessage: (id, message) => replace(id, messages => [...messages, message]),
    upsertMessage: (id, message, existed) => replace(id, messages => existed
      ? messages.map(value => value.id === message.id ? message : value) : [...messages, message]),
    patchMessage: (id, messageId, patch) => replace(id, messages => messages.map(message =>
      message.id === messageId ? { ...message, ...patch, id: messageId } : message)),
    deleteMessage: (id, messageId) => replace(id, messages => messages.filter(message => message.id !== messageId)),
    truncateFrom: (id, payload, context) => replace(id, messages => {
      const index = messages.findIndex(message => message.id === payload.messageId)
      if (index < 0) return messages
      if (payload.inclusive) return messages.slice(0, index)
      const before = messages[index]!
      return [...messages.slice(0, index), {
        ...before, timestamp: context.now,
        ...(payload.newContent !== undefined ? { content: payload.newContent } : {}),
        ...(Object.hasOwn(payload, 'contentParts') ? { contentParts: payload.contentParts ?? undefined } : {}),
      }]
    }),
    replaceAll: (id, messages) => replace(id, () => messages),
    patchSession: () => {},
  }
}
