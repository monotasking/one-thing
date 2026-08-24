type MaybePromise<T> = T | Promise<T>

export interface OnethingSystemMessageLike {
  id: string
  role?: string
  content?: string
}

export interface OnethingSystemMessageSessionLike<
  TMessage extends OnethingSystemMessageLike = OnethingSystemMessageLike,
> {
  messages: TMessage[]
}

export interface RemoveOnethingSystemMarkerMessageResult {
  success: boolean
  removedId?: string | null
  error?: string
}

export async function removeOnethingSystemMarkerMessage<
  TMessage extends OnethingSystemMessageLike,
  TSession extends OnethingSystemMessageSessionLike<TMessage>,
>(
  options: {
    sessionId: string
    markerType: string
    getSession(sessionId: string): TSession | null | undefined
    deleteMessage(sessionId: string, messageId: string): MaybePromise<unknown>
  },
): Promise<RemoveOnethingSystemMarkerMessageResult> {
  const session = options.getSession(options.sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  const marker = `"type":"${options.markerType}"`
  const existing = session.messages.find(message =>
    message.role === 'system'
    && typeof message.content === 'string'
    && message.content.includes(marker)
  )

  if (!existing) {
    return { success: true, removedId: null }
  }

  await options.deleteMessage(options.sessionId, existing.id)
  return { success: true, removedId: existing.id }
}
