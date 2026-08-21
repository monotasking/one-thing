import { describe, expect, it } from 'vitest'
import { buildResumeHistoryAfterToolConfirmation } from '../resume-history.js'
import type { HistoryMessage } from '../message-helpers.js'

describe('resume history after tool confirmation', () => {
  it('appends the paused assistant tool call and confirmed tool results for agent-loop resume', () => {
    const history: HistoryMessage[] = [
      { role: 'user', content: 'delete tmp' },
    ]

    expect(buildResumeHistoryAfterToolConfirmation(history, {
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
          timestamp: 1,
        },
        {
          id: 'call_2',
          toolId: 'write',
          toolName: 'Write',
          arguments: { path: '/tmp/a.txt' },
          status: 'failed',
          error: 'Denied',
          timestamp: 2,
        },
      ],
    })).toEqual([
      { role: 'user', content: 'delete tmp' },
      {
        role: 'assistant',
        content: 'I need to run a command.',
        reasoningContent: 'The user asked for cleanup.',
        toolCalls: [
          {
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { cmd: 'rm -rf tmp' },
          },
          {
            toolCallId: 'call_2',
            toolName: 'write',
            args: { path: '/tmp/a.txt' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'bash',
            result: { output: 'removed' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call_2',
            toolName: 'write',
            // status marks the tool_result as an error for providers that
            // carry an explicit failure flag (Anthropic is_error).
            result: { error: 'Denied', status: 'failed' },
          },
        ],
      },
    ])
  })
})
