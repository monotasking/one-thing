export type CoreChatLogValue = string | number | boolean | null | undefined | object
export type CoreChatLogRecord = { [key: string]: CoreChatLogValue }

export type CoreChatLogToolCall = {
  toolCallId?: string
  toolName?: string
  args?: CoreChatLogValue
}

export type CoreChatLogToolResult = {
  type?: string
  toolCallId?: string
  toolName?: string
  result?: CoreChatLogValue
}

export type CoreChatLogMessageShape = {
  role: string
  content: CoreChatLogValue
  toolCalls?: CoreChatLogToolCall[]
  reasoningContent?: string
}

export type CoreChatLogRow = {
  index: number
  role: string
  contentChars: number
  toolCalls?: number
  toolArgChars?: number
  toolResults?: number
  resultChars?: number
  reasoningChars?: number
}

export type CoreChatLogTotals = {
  contentChars: number
  toolCalls: number
  toolArgChars: number
  toolResults: number
  toolResultChars: number
  reasoningChars: number
}

export function chatLogJsonLength(value: CoreChatLogValue): number {
  try {
    return JSON.stringify(value ?? '').length
  } catch {
    return String(value ?? '').length
  }
}

export function chatLogContentTextLength(content: CoreChatLogValue): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (!part || typeof part !== 'object') return total
      const item = part as CoreChatLogRecord
      if (typeof item.text === 'string') return total + item.text.length
      if (typeof item.content === 'string') return total + item.content.length
      if (typeof item.data === 'string') return total + item.data.length
      if (typeof item.image === 'string') return total + item.image.length
      return total + chatLogJsonLength(item)
    }, 0)
  }
  return chatLogJsonLength(content)
}

export function buildMessageBodyShapePayload(
  messages: CoreChatLogMessageShape[],
  extra: Record<string, CoreChatLogValue> = {},
): {
  messageCount: number
  roleCounts: Record<string, number>
  totals: CoreChatLogTotals
  rows: CoreChatLogRow[]
} & Record<string, CoreChatLogValue> {
  const roleCounts = messages.reduce<Record<string, number>>((counts, message) => {
    const role = typeof message.role === 'string' ? message.role : 'unknown'
    counts[role] = (counts[role] ?? 0) + 1
    return counts
  }, {})

  const rows: CoreChatLogRow[] = messages.map((message, index) => {
    const base = {
      index,
      role: message.role,
      contentChars: chatLogContentTextLength(message.content),
    }

    if (message.role === 'assistant') {
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
      return {
        ...base,
        toolCalls: toolCalls.length,
        toolArgChars: toolCalls.reduce((sum, call) => sum + chatLogJsonLength(call.args ?? {}), 0),
        reasoningChars: typeof message.reasoningContent === 'string' ? message.reasoningContent.length : 0,
      }
    }

    if (message.role === 'tool') {
      const toolResults = Array.isArray(message.content) ? message.content : []
      return {
        ...base,
        toolResults: toolResults.length,
        resultChars: toolResults.reduce((sum, result) => {
          const record = result && typeof result === 'object' ? result as CoreChatLogToolResult : undefined
          return sum + chatLogJsonLength(record?.result ?? null)
        }, 0),
      }
    }

    return base
  })

  const totals = rows.reduce<CoreChatLogTotals>((acc, row) => {
    acc.contentChars += row.contentChars ?? 0
    acc.toolCalls += row.toolCalls ?? 0
    acc.toolArgChars += row.toolArgChars ?? 0
    acc.toolResults += row.toolResults ?? 0
    acc.toolResultChars += row.resultChars ?? 0
    acc.reasoningChars += row.reasoningChars ?? 0
    return acc
  }, {
    contentChars: 0,
    toolCalls: 0,
    toolArgChars: 0,
    toolResults: 0,
    toolResultChars: 0,
    reasoningChars: 0,
  })

  return {
    ...extra,
    messageCount: messages.length,
    roleCounts,
    totals,
    rows,
  }
}
