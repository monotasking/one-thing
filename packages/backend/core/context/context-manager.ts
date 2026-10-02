import type { ToolCall } from '../tools/types.js'

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AgentMessage {
  id?: string
  role: AgentMessageRole
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export class ContextManager {
  private readonly histories = new Map<string, AgentMessage[]>()

  getMessages(sessionId: string): AgentMessage[] {
    return [...(this.histories.get(sessionId) ?? [])]
  }

  appendMessage(sessionId: string, message: AgentMessage): void {
    const history = this.histories.get(sessionId) ?? []
    history.push(message)
    this.histories.set(sessionId, history)
  }

  replaceMessages(sessionId: string, messages: AgentMessage[]): void {
    this.histories.set(sessionId, [...messages])
  }

  clearSession(sessionId: string): void {
    this.histories.delete(sessionId)
  }

  clear(): void {
    this.histories.clear()
  }
}
