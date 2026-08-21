import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import { buildHistoryMessages, buildMessageContent } from '../message-helpers.js'

function userMessage(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'hello',
    timestamp: 1,
    ...partial,
  }
}

describe('context-update rendering in history', () => {
  it('appends the persisted block to user message content', () => {
    const content = buildMessageContent(
      userMessage({ contextUpdate: '- datetime: 2026-07-10 10:00 +08:00' }),
    )
    expect(content).toBe(
      'hello\n\n<context-update>\n- datetime: 2026-07-10 10:00 +08:00\n</context-update>',
    )
  })

  it('leaves messages without a stored block untouched', () => {
    expect(buildMessageContent(userMessage({}))).toBe('hello')
  })

  it('replays identical bytes across repeated history rebuilds', () => {
    const messages: ChatMessage[] = [
      userMessage({ id: 'u1', contextUpdate: '- git_branch: main' }),
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 },
      userMessage({ id: 'u2', content: 'again' }),
    ]
    const first = JSON.stringify(buildHistoryMessages(messages))
    const second = JSON.stringify(buildHistoryMessages(messages))
    expect(second).toBe(first)
    expect(first).toContain('<context-update>\\n- git_branch: main\\n</context-update>')
    // The follow-up user message carries no block — nothing is invented.
    const parsed = JSON.parse(first) as Array<{ role: string; content: unknown }>
    expect(JSON.stringify(parsed[2].content)).not.toContain('context-update')
  })
})
