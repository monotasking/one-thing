import { describe, expect, it } from 'vitest'
import { agentContentToText } from '@onething/core/agent-loop'
import type {
  CoreHistoryChatMessage,
  CoreHistoryToolCall,
} from '@onething/core/engine'
import {
  buildOnethingHistoryMessages,
  buildOnethingResumeHistoryAfterToolConfirmation,
  filterOnethingHistoryForNonToolAPI,
} from '../history-messages.js'

interface TestMessage extends CoreHistoryChatMessage {
  role: 'user' | 'assistant'
  content: string
  toolCalls?: CoreHistoryToolCall[]
  contentParts?: Array<{
    type: string
    provider?: string
    encryptedReasoning?: string
  }>
}

function message(index: number, role: 'user' | 'assistant'): TestMessage {
  return {
    id: `${role}-${index}`,
    role,
    content: `${role} ${index}`,
  }
}

describe('onething history messages', () => {
  it('builds summary-backed history from runtime adapters', () => {
    const history = buildOnethingHistoryMessages(
      [
        message(1, 'user'),
        message(2, 'assistant'),
        message(3, 'user'),
      ],
      {
        id: 's1',
        summary: 'Earlier context',
        summaryUpToMessageId: 'assistant-2',
      },
    )

    // C5(2026-08-14):摘要注入只剩单条 user,没有伪造的 assistant 握手。
    expect(history).toEqual([
      {
        role: 'user',
        content: expect.stringContaining('<summary>\nEarlier context\n</summary>'),
      },
      {
        role: 'user',
        content: 'user 3',
      },
    ])
  })

  it('normalizes failed tool calls and provider data for provider history', () => {
    const history = buildOnethingHistoryMessages([
      message(1, 'user'),
      {
        ...message(2, 'assistant'),
        reasoning: 'visible reasoning',
        contentParts: [
          {
            type: 'provider-data',
            provider: 'codex',
            encryptedReasoning: 'encrypted',
          },
        ],
        toolCalls: [
          {
            id: 'call_1',
            toolId: 'web_search',
            toolName: 'web_search',
            arguments: { query: 'docs' },
            status: 'failed',
            error: 'Network failed',
          },
        ],
      },
    ])

    expect(history).toMatchObject([
      { role: 'user', content: 'user 1' },
      {
        role: 'assistant',
        content: 'assistant 2',
        reasoningContent: 'visible reasoning',
        providerData: [
          {
            provider: 'codex',
            type: 'encrypted-reasoning',
            encryptedContent: 'encrypted',
          },
        ],
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'web_search',
            args: { query: 'docs' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'web_search',
            result: {
              error: 'Network failed',
              status: 'failed',
              parameterSummary: 'parameters',
              parameters: { query: 'docs' },
            },
          },
        ],
      },
    ])
  })

  it('builds resume history and filters non-tool history', () => {
    const resumed = buildOnethingResumeHistoryAfterToolConfirmation(
      [{ role: 'user', content: 'delete tmp' }],
      {
        content: 'I need to run a command.',
        reasoning: 'The user asked for cleanup.',
        toolCalls: [
          {
            id: 'call_1',
            toolId: 'bash',
            toolName: 'Bash',
            arguments: { cmd: 'rm -rf tmp' },
            status: 'completed',
            result: { output: 'removed' },
          },
        ],
      },
    )

    expect(resumed).toMatchObject([
      { role: 'user', content: 'delete tmp' },
      {
        role: 'assistant',
        content: 'I need to run a command.',
        reasoningContent: 'The user asked for cleanup.',
      },
      {
        role: 'tool',
        content: [
          {
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { output: 'removed' },
          },
        ],
      },
    ])
    expect(filterOnethingHistoryForNonToolAPI(resumed)).toEqual([
      { role: 'user', content: 'delete tmp' },
      {
        role: 'assistant',
        content: 'I need to run a command.',
        reasoningContent: 'The user asked for cleanup.',
      },
    ])
  })
})

/**
 * An uploaded file is only reachable if the model is told where it lives —
 * and it has to stay told on every later turn, because history is rebuilt
 * from the stored messages each time.
 */
describe('attachment paths in rebuilt history', () => {
  function messageWithUpload(): TestMessage {
    return {
      id: 'user-1',
      role: 'user',
      content: '看看这个',
      attachments: [
        {
          id: 'att-1',
          fileName: 'shot.png',
          filePath: '/Users/me/.onething/media/images/asset-1.png',
          mimeType: 'image/png',
          mediaType: 'image',
          size: 4096,
          base64Data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        },
      ],
    } as unknown as TestMessage
  }

  it('carries the path line into every rebuild of the history', () => {
    const [entry] = buildOnethingHistoryMessages([messageWithUpload()])

    expect(entry.role).toBe('user')
    const content = entry.content
    if (typeof content === 'string') throw new Error('expected multimodal content')
    expect(content).toContainEqual({
      type: 'text',
      text: '[附件] shot.png → /Users/me/.onething/media/images/asset-1.png (image/png, 4.0 KB)',
    })
    // Supplement, not replacement: the picture still goes to a vision model.
    expect(content.some(part => part.type === 'image')).toBe(true)
  })

  it('reaches an external agent, which reads only the text parts', () => {
    const [entry] = buildOnethingHistoryMessages([messageWithUpload()])

    const text = agentContentToText(
      entry.content as unknown as Parameters<typeof agentContentToText>[0],
    )

    expect(text).toContain('看看这个')
    expect(text).toContain('[附件] shot.png → /Users/me/.onething/media/images/asset-1.png')
  })

  it('leaves a message without attachments exactly as it was', () => {
    const [entry] = buildOnethingHistoryMessages([message(1, 'user')])

    expect(entry).toEqual({ role: 'user', content: 'user 1' })
  })
})
