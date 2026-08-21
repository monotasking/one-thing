import { describe, expect, it } from 'vitest'
import {
  agentToolMessageContentForCapabilities,
  agentToolMessageContentToText,
  agentToolMessageContentToStructuredPayload,
  agentToolResultToMessageContent,
  agentToolResultToMessageContentForCapabilities,
} from '@onething/core/agent-loop'

describe('agent tool result message content', () => {
  it('keeps plain text tool results as text', () => {
    expect(agentToolResultToMessageContent({ content: 'plain output' }))
      .toBe('plain output')
  })

  it('keeps tool errors compatible with text-only provider tool messages', () => {
    expect(agentToolResultToMessageContent({ content: '', error: 'failed' }))
      .toBe('{"success":false,"error":"failed"}')
  })

  it('preserves structured media returned by tools as agent content parts', () => {
    expect(agentToolResultToMessageContent({
      content: 'screenshot captured',
      data: {
        content: [
          { type: 'image', data: 'data:image/png;base64,abc' },
          { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
        ],
      },
    })).toEqual([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
    ])
  })

  it('turns media tool message content into short text fallback when a provider requires text', () => {
    expect(agentToolMessageContentToText([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
    ])).toBe([
      'screenshot captured',
      '[Image: image/png data omitted: 25 chars]',
      '[File: report.pdf; application/pdf data omitted: 9 chars]',
    ].join('\n'))
  })

  it('keeps image content structured for providers that support rich tool-result payloads', () => {
    expect(agentToolMessageContentToStructuredPayload([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file', data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
    ])).toEqual({
      content: [
        { type: 'text', text: 'screenshot captured' },
        { type: 'image', data: 'data:image/png;base64,abc', mediaType: 'image/png' },
        { type: 'text', text: '[File: report.pdf; application/pdf data omitted: 9 chars]' },
      ],
    })
  })

  it('filters structured tool-result content through provider capabilities', () => {
    const content = [
      { type: 'text' as const, text: 'screenshot captured' },
      { type: 'image' as const, image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'file' as const, data: 'pdfbase64', mediaType: 'application/pdf', filename: 'report.pdf' },
    ]

    expect(agentToolMessageContentForCapabilities(content, {
      capabilities: ['text-input', 'text-output', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    })).toBe([
      'screenshot captured',
      '[Image: image/png data omitted: 25 chars]',
      '[File: report.pdf; application/pdf data omitted: 9 chars]',
    ].join('\n'))

    expect(agentToolMessageContentForCapabilities(content, {
      capabilities: ['text-input', 'text-output', 'tool-calls', 'structured-tool-results'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolResultModalities: ['text', 'image'],
    })).toEqual([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
      { type: 'text', text: '[File: report.pdf; application/pdf data omitted: 9 chars]' },
    ])
  })

  it('formats tool results for text-only or rich tool-result providers', () => {
    const result = {
      content: 'screenshot captured',
      data: {
        content: [
          { type: 'image', data: 'data:image/png;base64,abc' },
        ],
      },
    }

    expect(agentToolResultToMessageContentForCapabilities(result, {
      capabilities: ['text-input', 'text-output', 'tool-calls'],
      inputModalities: ['text'],
      outputModalities: ['text'],
    })).toBe([
      'screenshot captured',
      '[Image: image/png data omitted: 25 chars]',
    ].join('\n'))

    expect(agentToolResultToMessageContentForCapabilities(result, {
      capabilities: ['text-input', 'text-output', 'tool-calls', 'structured-tool-results'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      toolResultModalities: ['text', 'image'],
    })).toEqual([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', image: 'data:image/png;base64,abc', mediaType: 'image/png' },
    ])
  })
})
