import { describe, expect, it } from 'vitest'
import {
  isCanonicalToolResult,
  summarizeToolFailureParameters,
  textFromToolResult,
  toolFailureResultForAI,
  toolFailureText,
  toolResultToStructured,
} from '../tool-result.js'
import type { ToolFailureParameterSummary } from '../tool-result.js'

describe('core tool result helpers', () => {
  it('normalizes text and attachments into canonical tool results', () => {
    expect(toolResultToStructured('hello')).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      details: undefined,
    })

    const structured = toolResultToStructured({
      output: 'see file',
      metadata: { phase: 'done' },
      attachments: [{ type: 'file', path: '/tmp/a.txt', content: 'file text' }],
    })

    expect(isCanonicalToolResult(structured)).toBe(true)
    expect(textFromToolResult(structured)).toBe('see file\n[File: /tmp/a.txt]')
    expect(structured.details).toEqual({ phase: 'done' })
  })

  it('formats permission rejection and AI failure summaries in core', () => {
    expect(toolFailureText({ rejected: true, rejectionReason: 'not now' }))
      .toBe('The user rejected permission for this tool. Reason: not now')

    expect(summarizeToolFailureParameters('edit', {
      path: '/repo/src/main.ts',
      edits: [{ oldText: 'a', newText: 'b' }],
    }) satisfies ToolFailureParameterSummary | null).toMatchObject({
      summary: 'path: src/main.ts · edits: 1',
    })

    expect(toolFailureResultForAI({
      toolName: 'bash',
      arguments: { command: 'rm file.txt' },
      status: 'failed',
    })).toEqual({
      error: 'Tool execution failed.',
      parameterSummary: 'command: rm file.txt',
      parameters: { command: 'rm file.txt' },
      status: 'failed',
    })
  })
})
