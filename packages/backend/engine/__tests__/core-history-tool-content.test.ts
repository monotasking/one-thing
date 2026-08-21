import { describe, expect, it } from 'vitest'
import {
  agentMessagesFromHistory,
  agentToolMessageContentFromHistoryResult,
  type AgentHistoryMessage,
  type AgentModelCapabilities,
} from '@onething/core/agent-loop'

const textOnly: AgentModelCapabilities = {
  capabilities: ['tool-calls', 'structured-tool-results'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  toolResultModalities: ['text'],
}

const vision: AgentModelCapabilities = {
  capabilities: ['tool-calls', 'structured-tool-results'],
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  toolResultModalities: ['text', 'image'],
}

const base64Png = 'iVBORw0KGgoAAAANSUhEUg'.repeat(100) // >1000 chars, no whitespace/brackets

const imageReadResult = {
  title: 'Image: shot.png',
  output: '[Image file: /tmp/shot.png]\nMIME type: image/png',
  metadata: { path: '/tmp/shot.png' },
  attachments: [{ type: 'image', path: '/tmp/shot.png', content: base64Png, mimeType: 'image/png' }],
}

function contentToComparable(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

describe('agentToolMessageContentFromHistoryResult', () => {
  it('degrades images to the live-loop placeholder for text-only models', () => {
    const content = agentToolMessageContentFromHistoryResult(imageReadResult as never, textOnly)
    const text = contentToComparable(content)
    expect(text).toContain('[Image file: /tmp/shot.png]')
    expect(text).toContain(`[Image: image/png data omitted: ${base64Png.length} chars]`)
    expect(text).not.toContain(base64Png.slice(0, 40))
    // No JSON wrapper — same plain text the live loop produced.
    expect(text).not.toContain('"metadata"')
  })

  it('keeps a real image part for vision-capable models', () => {
    const content = agentToolMessageContentFromHistoryResult(imageReadResult as never, vision)
    expect(Array.isArray(content)).toBe(true)
    const parts = content as Array<{ type: string; image?: string; data?: string }>
    const media = parts.find(part => part.type === 'image' || part.type === 'file')
    expect(media).toBeTruthy()
    expect(media?.image ?? media?.data).toContain('iVBORw0KGgo')
  })

  it('treats sanitizer placeholders as text even for vision models', () => {
    const sanitized = {
      output: '[Image file: /tmp/shot.png]',
      attachments: [{
        type: 'image',
        path: '/tmp/shot.png',
        content: '[Image: image/png data omitted: 789504 chars]',
        mimeType: 'image/png',
      }],
    }
    const content = agentToolMessageContentFromHistoryResult(sanitized as never, vision)
    const text = contentToComparable(content)
    expect(text).toContain('data omitted: 789504 chars')
    const parts = Array.isArray(content) ? content as Array<{ type: string }> : []
    expect(parts.some(part => part.type === 'image' || part.type === 'file')).toBe(false)
  })

  it('falls back to JSON text for non-tool-shaped results', () => {
    expect(agentToolMessageContentFromHistoryResult({ error: 'boom' } as never, textOnly))
      .toBe('{"error":"boom"}')
    expect(agentToolMessageContentFromHistoryResult('plain', textOnly)).toBe('plain')
    expect(agentToolMessageContentFromHistoryResult(undefined, textOnly)).toBe('')
  })
})

describe('agentMessagesFromHistory with capabilities', () => {
  const history: AgentHistoryMessage[] = [
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'read', result: imageReadResult as never }],
    },
  ]

  it('routes tool results through the capability-aware conversion', () => {
    const [message] = agentMessagesFromHistory(history, textOnly)
    expect(message.role).toBe('tool')
    const text = contentToComparable((message as { content: unknown }).content)
    expect(text).toContain('data omitted')
    expect(text).not.toContain(base64Png.slice(0, 40))
  })

  it('keeps the legacy JSON form without capabilities', () => {
    const [message] = agentMessagesFromHistory(history)
    const text = contentToComparable((message as { content: unknown }).content)
    expect(text).toContain('"attachments"')
  })
})
