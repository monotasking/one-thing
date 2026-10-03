import { describe, expect, it } from 'vitest'
import type { AgentTurnRequest } from '@onething/backend/runtime/agent-loop/loop-primitives'
import { createClaudeAgentProvider } from '../../providers/vendors/claude/agent-provider.js'
import { createCodexAgentProvider } from '../../providers/vendors/codex/agent-provider.js'
import { createOpenAICompatibleAgentProvider } from '../../providers/openai-compatible.js'

const PDF_BASE64 = Buffer.from('%PDF-1.4 fake').toString('base64')
const ZIP_BASE64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]).toString('base64')

const userMessageWithFiles = {
  role: 'user' as const,
  content: [
    { type: 'text' as const, text: 'look at these' },
    {
      type: 'file' as const,
      data: PDF_BASE64,
      mediaType: 'application/pdf',
      filename: 'report.pdf',
    },
    {
      type: 'file' as const,
      data: ZIP_BASE64,
      mediaType: 'application/zip',
      filename: 'bundle.zip',
      path: '/Users/me/downloads/bundle.zip',
    },
  ],
}

function sseResponse(lines: string[]): Response {
  return new Response([...lines, 'data: [DONE]', ''].join('\n\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _event of events) {
      // drain
    }
  } catch {
    // The mocked SSE body may not satisfy every parser; the request body
    // has been captured by then, which is all these tests assert on.
  }
}

describe('claude attachment parts', () => {
  it('maps PDF file parts to document blocks and other binaries to placeholders', async () => {
    let captured: { messages: Array<{ role: string; content: unknown }> } | undefined
    const provider = createClaudeAgentProvider({
      apiKey: 'test',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return sseResponse([
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}',
        ])
      },
    })

    await drain(
      provider.streamTurn!({
        turn: 0,
        model: 'claude-sonnet-5',
        messages: [userMessageWithFiles],
      } as AgentTurnRequest),
    )

    expect(captured).toBeDefined()
    const blocks = captured!.messages[0].content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'text', text: 'look at these' })
    expect(blocks[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: PDF_BASE64 },
    })
    expect(blocks[2].type).toBe('text')
    expect(String(blocks[2].text)).toContain('bundle.zip')
    expect(String(blocks[2].text)).toContain('could not be delivered')
    expect(String(blocks[2].text)).toContain('/Users/me/downloads/bundle.zip')
  })
})

describe('codex attachment parts', () => {
  it('sends PDFs as input_file with a filename and placeholders for other binaries', async () => {
    let captured: { input: Array<{ type?: string; role?: string; content?: unknown }> } | undefined
    const provider = createCodexAgentProvider({
      oauthToken: { accessToken: 'test-token' } as never,
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return sseResponse([])
      },
    })

    await drain(
      provider.streamTurn!({
        turn: 0,
        model: 'gpt-5.5',
        messages: [userMessageWithFiles],
      } as AgentTurnRequest),
    )

    expect(captured).toBeDefined()
    const userItem = captured!.input.find(item => item.role === 'user')
    expect(userItem).toBeDefined()
    const parts = userItem!.content as Array<Record<string, unknown>>

    const filePart = parts.find(part => part.type === 'input_file')
    expect(filePart).toBeDefined()
    expect(filePart!.filename).toBe('report.pdf')
    expect(String(filePart!.file_data)).toBe(`data:application/pdf;base64,${PDF_BASE64}`)

    const placeholder = parts.find(
      part => part.type === 'input_text' && String(part.text).includes('bundle.zip'),
    )
    expect(placeholder).toBeDefined()
    expect(String(placeholder!.text)).toContain('could not be delivered')
  })

  it('sends tool-result images as data-URL input_image parts', async () => {
    const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    let captured: { input: Array<{ type?: string; call_id?: string; output?: unknown }> } | undefined
    const provider = createCodexAgentProvider({
      oauthToken: { accessToken: 'test-token' } as never,
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return sseResponse([])
      },
    })

    await drain(
      provider.streamTurn!({
        turn: 1,
        model: 'gpt-5.5',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_read', name: 'read', arguments: '{"path":"pixel.png"}' }],
          },
          {
            role: 'tool',
            toolCallId: 'call_read',
            content: [
              { type: 'text', text: '[Image file: /tmp/pixel.png]' },
              // Tools return bare base64 with `mediaType` (the structured
              // payload field name); this must never reach the API verbatim.
              { type: 'image', image: PNG_BASE64, mediaType: 'image/png' },
            ],
          },
        ],
      } as unknown as AgentTurnRequest),
    )

    expect(captured).toBeDefined()
    const outputItem = captured!.input.find(item => item.type === 'function_call_output')
    expect(outputItem).toBeDefined()
    expect(outputItem!.output).toEqual([
      { type: 'input_text', text: '[Image file: /tmp/pixel.png]' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG_BASE64}`, detail: 'auto' },
    ])
  })
})

describe('openai-compatible attachment parts', () => {
  it('keeps image files as image_url and turns other binaries into placeholders', async () => {
    let captured: { messages: Array<{ role: string; content: unknown }> } | undefined
    const provider = createOpenAICompatibleAgentProvider({
      providerId: 'test-provider',
      apiKey: 'test',
      baseUrl: 'https://example.test/v1',
      defaultBaseUrl: 'https://example.test/v1',
      fetchImpl: async (_url, init) => {
        captured = JSON.parse(String(init?.body))
        return sseResponse([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        ])
      },
    })

    await drain(
      provider.streamTurn!({
        turn: 0,
        model: 'test-model',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
                mediaType: 'image/png',
                filename: 'shot.png',
              },
              {
                type: 'file',
                data: ZIP_BASE64,
                mediaType: 'application/zip',
                filename: 'bundle.zip',
              },
            ],
          },
        ],
      } as AgentTurnRequest),
    )

    expect(captured).toBeDefined()
    const userMessage = captured!.messages.find(message => message.role === 'user')
    const parts = userMessage!.content as Array<Record<string, unknown>>

    expect(parts[0].type).toBe('image_url')
    expect(parts[1].type).toBe('text')
    expect(String(parts[1].text)).toContain('bundle.zip')
    expect(String(parts[1].text)).toContain('could not be delivered')
  })
})
