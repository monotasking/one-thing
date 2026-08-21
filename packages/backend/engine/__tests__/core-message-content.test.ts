import { describe, expect, it, vi } from 'vitest'
import {
  buildMessageContent,
  formatMessagesForLog,
  getTextFromContent,
} from '@onething/core/engine'

describe('core message content helpers', () => {
  it('redacts image payloads in log messages', () => {
    const longImage = 'data:image/png;base64,' + 'x'.repeat(120)

    expect(formatMessagesForLog([{
      role: 'user',
      content: [{ type: 'image', image: longImage }],
    }])).toEqual([{
      role: 'user',
      content: [{
        type: 'image',
        image: expect.stringContaining('(142 chars)'),
      }],
    }])
  })

  it('builds multimodal provider content from attachments', () => {
    const onImageAttachment = vi.fn()
    const pdfBase64 = Buffer.from('%PDF-1.4').toString('base64')
    const content = buildMessageContent({
      content: 'see attached',
      attachments: [
        {
          fileName: 'image.png',
          mimeType: 'image/png',
          mediaType: 'image',
          base64Data: 'abc123',
        },
        {
          // Text attachments are decoded and inlined so every provider can
          // actually read them ('ZmlsZQ==' is base64 for 'file').
          fileName: 'notes.txt',
          mimeType: 'text/plain',
          mediaType: 'file',
          base64Data: 'ZmlsZQ==',
        },
        {
          // Binary attachments stay as file parts and carry the filename
          // that provider payloads (e.g. Codex input_file) require.
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          mediaType: 'file',
          base64Data: pdfBase64,
        },
      ],
    }, { onImageAttachment })

    expect(content).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'image', image: 'data:image/png;base64,abc123' },
      {
        type: 'text',
        text: '<attachment filename="notes.txt" media_type="text/plain">\nfile\n</attachment>',
      },
      { type: 'file', data: pdfBase64, mediaType: 'application/pdf', filename: 'report.pdf' },
    ])
    expect(onImageAttachment).toHaveBeenCalledWith({
      mimeType: 'image/png',
      base64Length: 6,
      dataUrlPrefix: 'data:image/png;base64,abc123...',
    })
  })

  it('extracts text from string and multimodal content', () => {
    expect(getTextFromContent('plain')).toBe('plain')
    expect(getTextFromContent([
      { type: 'text', text: 'hello' },
      { type: 'image', image: 'data:image/png;base64,x' },
      { type: 'text', text: 'world' },
    ])).toBe('hello\nworld')
  })
})
