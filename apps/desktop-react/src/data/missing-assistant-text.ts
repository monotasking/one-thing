interface TextPart {
  type?: string
  content?: string
  turnIndex?: number
}

interface TextMessage {
  role: string
  content?: string
  steps?: readonly {
    turnIndex?: number
    toolCallId?: string
    toolCall?: { id?: string; status?: string }
    status?: string
  }[]
  toolCalls?: readonly { id?: string; status?: string }[]
}

/**
 * Aborted / in-flight requests may have text in `content` but no settled parts.
 * Share this display fallback between the live overlay and cold history reads.
 * Only supplement a matching assistant prefix: user content can contain hidden
 * model context, and divergent strings cannot safely be combined.
 */
export function missingAssistantText(
  message: TextMessage,
  parts: readonly TextPart[],
  liveTurns: readonly { turnIndex?: number }[] = [],
  /** The latest text part's ledger turn, including an unsettled request. */
  knownTextTurn?: number,
): { type: 'text'; content: string; turnIndex: number } | undefined {
  if (message.role !== 'assistant') return
  const drawn = parts.filter(part => part.type === 'text').map(part => part.content ?? '').join('')
  const content = message.content ?? ''
  if (content.length <= drawn.length || !content.startsWith(drawn)) return
  // A ledger part is authoritative, even when the current request has already
  // started a tool. For older flat messages, put the unseen continuation after
  // earlier tool rounds; sharing their turn would put those tools below it.
  // A cancelled last call (e.g. stopping at ask_user) is a different boundary:
  // its unpersisted narration was produced before the interrupted call.
  const steps = message.steps ?? []
  const lastToolTurn = Math.max(-1, ...steps.map(step => step.turnIndex ?? 0))
  const interrupted = steps.some(step => {
    if ((step.turnIndex ?? 0) !== lastToolTurn) return false
    const id = step.toolCallId ?? step.toolCall?.id
    const status = (id ? message.toolCalls?.find(call => call.id === id)?.status : undefined)
      ?? step.toolCall?.status ?? step.status
    return status === 'cancelled' || status === 'canceled' || status === 'aborted'
  })
  const turnIndex = knownTextTurn ?? Math.max(0,
    ...parts.map(part => part.turnIndex ?? 0),
    lastToolTurn + (interrupted ? 0 : 1),
    ...liveTurns.map(part => part.turnIndex ?? 0),
  )
  return { type: 'text', content: content.slice(drawn.length), turnIndex }
}
