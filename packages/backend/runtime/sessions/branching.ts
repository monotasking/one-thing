export interface OnethingBranchSourceMessage {
  id: string
}

export interface OnethingBranchSourceSession<TMessage extends OnethingBranchSourceMessage> {
  id: string
  name: string
  messages: TMessage[]
}

export interface CreateOnethingBranchSessionAdapters<
  TSession extends OnethingBranchSourceSession<TMessage>,
  TMessage extends OnethingBranchSourceMessage,
  TBranchSession,
> {
  createId(): string
  getSession(sessionId: string): TSession | null | undefined
  createBranchSession(input: {
    branchId: string
    branchName: string
    parentSessionId: string
    branchFromMessageId: string
    inheritedMessages: TMessage[]
  }): TBranchSession
}

export type CreateOnethingBranchSessionResult<TBranchSession> =
  | { success: true; session: TBranchSession }
  | { success: false; error: string }

export function createOnethingBranchSession<
  TSession extends OnethingBranchSourceSession<TMessage>,
  TMessage extends OnethingBranchSourceMessage,
  TBranchSession,
>(input: {
  parentSessionId: string
  branchFromMessageId: string
  adapters: CreateOnethingBranchSessionAdapters<TSession, TMessage, TBranchSession>
}): CreateOnethingBranchSessionResult<TBranchSession> {
  const parentSession = input.adapters.getSession(input.parentSessionId)
  if (!parentSession) {
    return { success: false, error: 'Parent session not found' }
  }

  const messageIndex = parentSession.messages.findIndex(
    message => message.id === input.branchFromMessageId,
  )
  if (messageIndex === -1) {
    return { success: false, error: 'Message not found' }
  }

  const branchId = input.adapters.createId()
  const inheritedMessages = parentSession.messages
    .slice(0, messageIndex + 1)
    .map(message => ({
      ...message,
      id: input.adapters.createId(),
    })) as TMessage[]

  const branchName = `${parentSession.name} (Branch)`
  const branchSession = input.adapters.createBranchSession({
    branchId,
    branchName,
    parentSessionId: input.parentSessionId,
    branchFromMessageId: input.branchFromMessageId,
    inheritedMessages,
  })

  return { success: true, session: branchSession }
}
