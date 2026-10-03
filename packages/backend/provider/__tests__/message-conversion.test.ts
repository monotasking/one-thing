import { describe, expect, it } from 'vitest'
import {
  convertOnethingToolDefinitionsForProvider,
  onethingAgentContentFromAIMessageContent,
  onethingAgentMessagesFromToolChatMessages,
  onethingUtilityAgentMessagesFromMessages,
  stringifyOnethingToolOutput,
  onethingToolChatMessagesFromUIMessages,
} from '../message-conversion.js'

describe('onething provider message conversion', () => {
  it('converts multimodal message content to agent content parts', () => {
    expect(onethingAgentContentFromAIMessageContent([
      { type: 'text', text: 'look' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'Zm9v', mediaType: 'text/plain', filename: 'note.txt' },
    ])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'Zm9v', mediaType: 'text/plain', filename: 'note.txt' },
    ])
  })

  it('converts tool chat messages into agent messages', () => {
    expect(onethingAgentMessagesFromToolChatMessages([
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

  it('converts utility agent messages without host dependencies', () => {
    expect(onethingUtilityAgentMessagesFromMessages([
      { role: 'system', content: 'rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
        ],
      },
      { role: 'assistant', content: 'answer', reasoningContent: 'thought' },
    ])).toEqual([
      { role: 'system', content: 'rules' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
        ],
      },
      { role: 'assistant', content: 'answer', reasoningContent: 'thought' },
    ])
  })

  it('stringifies tool output for the wire', () => {
    expect(stringifyOnethingToolOutput({ output: 'file' })).toBe('{"output":"file"}')
    expect(stringifyOnethingToolOutput(null)).toBe('')
  })

  it('converts UI message tool parts into assistant and tool result messages', () => {
    expect(onethingToolChatMessagesFromUIMessages([
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'done' },
          { type: 'reasoning', text: 'checking' },
          {
            type: 'tool-read',
            toolCallId: 'call_1',
            toolName: 'read',
            input: { path: 'a.txt' },
            state: 'output-available',
            output: { text: 'file' },
          },
        ],
      },
    ])).toEqual([
      {
        role: 'assistant',
        content: 'done',
        reasoningContent: 'checking',
        toolCalls: [{ toolCallId: 'call_1', toolName: 'read', args: { path: 'a.txt' } }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'read',
          result: { text: 'file' },
        }],
      },
    ])
  })

  it('aliases provider tool names and preserves JSON schemas', () => {
    expect(convertOnethingToolDefinitionsForProvider([
      {
        id: 'project/read file',
        name: 'read',
        description: 'Read file',
        parameters: [],
        parameterSchema: { type: 'object' },
      },
    ])).toEqual({
      'project-read-file': {
        description: 'Read file',
        parameters: [],
        parameterSchema: { type: 'object' },
      },
    })
  })
})
