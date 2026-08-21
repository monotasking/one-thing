import { describe, expect, it } from 'vitest'
import {
  agentContentFromHistoryContent,
  agentMessagesFromHistory,
  agentToolCallsFromHistory,
} from '@onething/core/agent-loop'

describe('agent loop message conversion', () => {
  it('preserves multimodal user content as agent content parts', () => {
    expect(agentContentFromHistoryContent([
      { type: 'text', text: 'look' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'Zm9v', mediaType: 'text/plain', filename: 'note.txt' },
      { type: 'audio', audio: 'data:audio/wav;base64,abc', mediaType: 'audio/wav' },
      { type: 'video', data: 'data:video/mp4;base64,abc', mediaType: 'video/mp4' },
    ])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'Zm9v', mediaType: 'text/plain', filename: 'note.txt' },
      { type: 'audio', audio: 'data:audio/wav;base64,abc', mediaType: 'audio/wav' },
      { type: 'video', video: 'data:video/mp4;base64,abc', mediaType: 'video/mp4' },
    ])
  })

  it('converts assistant tool calls and tool results into agent messages', () => {
    expect(agentToolCallsFromHistory([
      { toolCallId: 'call_1', toolName: 'read', args: { path: 'a.txt' } },
      { id: 'call_2', name: 'write', arguments: '{"path":"b.txt"}' },
    ])).toEqual([
      { id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      { id: 'call_2', name: 'write', arguments: '{"path":"b.txt"}' },
    ])

    expect(agentMessagesFromHistory([
      { role: 'developer', content: 'dev prompt' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'need file',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read', args: { path: 'a.txt' } }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          result: { output: 'file text' },
        }],
      },
    ])).toEqual([
      { role: 'system', content: 'dev prompt' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'need file',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: '{"output":"file text"}' },
    ])
  })

  it('preserves Codex encrypted reasoning as provider data', () => {
    expect(agentMessagesFromHistory([
      {
        role: 'assistant',
        content: 'answer',
        reasoningContent: 'summary',
        providerData: [{
          provider: 'codex',
          type: 'encrypted-reasoning',
          encryptedContent: 'encrypted-1',
        }],
      },
    ])).toEqual([
      {
        role: 'assistant',
        content: 'answer',
        reasoningContent: 'summary',
        providerData: [{
          provider: 'codex',
          type: 'encrypted-reasoning',
          encryptedContent: 'encrypted-1',
        }],
      },
    ])
  })
})
