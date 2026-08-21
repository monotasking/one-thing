import { describe, expect, it } from 'vitest'
import {
  HISTORY_STRING_HARD_CAP_CHARS,
  HISTORY_TOOL_RESULT_BUDGET_CHARS,
  buildHistoryToolResultContent,
  sanitizeHistoryToolResultForAI,
  sanitizeToolResultForAI,
} from '@onething/core/engine'
import { estimateSessionInputTokens } from '@onething/core/engine'

const base64Image = 'iVBORw0KGgo'.repeat(72_000) // ~792KB, like a real read-image payload

describe('sanitizeToolResultForAI', () => {
  it('replaces attachment binary content with the live-loop placeholder wording', () => {
    const sanitized = sanitizeToolResultForAI({
      title: 'Image: shot.png',
      output: '[Image file: /tmp/shot.png]',
      attachments: [{
        type: 'image',
        path: '/tmp/shot.png',
        content: base64Image,
        mimeType: 'image/png',
      }],
    }) as { attachments: Array<Record<string, unknown>> }

    const attachment = sanitized.attachments[0]
    expect(attachment.content).toBe(`[Image: image/png data omitted: ${base64Image.length} chars]`)
    expect(attachment.path).toBe('/tmp/shot.png')
    expect(attachment.mimeType).toBe('image/png')
    expect(JSON.stringify(sanitized).length).toBeLessThan(1000)
  })

  it('keeps small attachment content inline', () => {
    const sanitized = sanitizeToolResultForAI({
      attachments: [{ type: 'file', path: '/tmp/a.txt', content: 'short text' }],
    }) as { attachments: Array<Record<string, unknown>> }
    expect(sanitized.attachments[0].content).toBe('short text')
  })

  it('hard-caps runaway strings anywhere in the result', () => {
    const runaway = 'x'.repeat(HISTORY_STRING_HARD_CAP_CHARS + 5_000)
    const sanitized = sanitizeToolResultForAI({ nested: { blob: runaway } }) as {
      nested: { blob: string }
    }
    expect(sanitized.nested.blob.length).toBeLessThan(HISTORY_STRING_HARD_CAP_CHARS + 100)
    expect(sanitized.nested.blob).toContain('…[truncated 5000 chars]')
  })

  it('still strips originalContent and passes normal results through', () => {
    const sanitized = sanitizeToolResultForAI({
      output: 'ok',
      originalContent: 'secret',
      originalContentHash: 'abc',
    })
    expect(sanitized).toEqual({ output: 'ok' })
  })
})

describe('sanitizeHistoryToolResultForAI', () => {
  it('falls back to a placeholder when a single result exceeds the budget', () => {
    const huge = { output: 'y'.repeat(60_000), rows: Array.from({ length: 10 }, () => 'z'.repeat(30_000)) }
    expect(JSON.stringify(sanitizeToolResultForAI(huge as never)).length)
      .toBeGreaterThan(HISTORY_TOOL_RESULT_BUDGET_CHARS)

    const sanitized = sanitizeHistoryToolResultForAI(huge as never) as Record<string, unknown>
    expect(sanitized.truncated).toBe(true)
    expect(String(sanitized.outputPreview)).toContain('y')
    expect(JSON.stringify(sanitized).length).toBeLessThan(10_000)
  })
})

describe('buildHistoryToolResultContent', () => {
  it('caps the per-message total so many large results cannot stack up', () => {
    // Three sub-cap strings per result (~150K total each) so the per-string
    // hard cap does not kick in — only the per-message total budget can.
    const toolCalls = Array.from({ length: 8 }, (_, index) => ({
      id: `tc${index}`,
      toolName: 'read',
      arguments: {},
      status: 'completed',
      result: { output: 'r'.repeat(50_000), extra: ['s'.repeat(50_000), 't'.repeat(50_000)] },
    }))

    const content = buildHistoryToolResultContent(toolCalls)
    const totalChars = JSON.stringify(content).length
    expect(totalChars).toBeLessThan(900_000)
    const placeholders = content.filter(entry =>
      (entry.result as Record<string, unknown>)?.truncated === true)
    expect(placeholders.length).toBeGreaterThan(0)
    // The first result always ships in full.
    expect((content[0].result as Record<string, unknown>).output).toBeTruthy()
  })
})

describe('estimateSessionInputTokens', () => {
  it('reflects the real (sanitized) tool payload size instead of a summary', () => {
    const bigTextResult = { output: 'w'.repeat(120_000) }
    const session = {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'done',
          toolCalls: [{
            toolName: 'bash',
            arguments: { command: 'ls' },
            status: 'completed',
            result: bigTextResult,
          }],
        },
      ],
    }
    const withBig = estimateSessionInputTokens(session as never, session.messages as never)
    const withoutTools = estimateSessionInputTokens({} as never, [
      { id: 'm1', role: 'assistant', content: 'done' },
    ] as never)
    // 120K chars ≈ tens of thousands of tokens; the estimate must see it.
    expect(withBig - withoutTools).toBeGreaterThan(10_000)
  })

  it('does not inflate the estimate for attachment binaries that will be stripped', () => {
    const session = {
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'done',
          toolCalls: [{
            toolName: 'read',
            arguments: { path: '/tmp/shot.png' },
            status: 'completed',
            result: {
              output: '[Image file]',
              attachments: [{ type: 'image', path: '/tmp/shot.png', content: base64Image, mimeType: 'image/png' }],
            },
          }],
        },
      ],
    }
    const estimate = estimateSessionInputTokens(session as never, session.messages as never)
    expect(estimate).toBeLessThan(2_000)
  })
})
