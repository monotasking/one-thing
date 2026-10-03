import { describe, expect, it } from 'vitest'
import {
  MarkdownSafeOutboundBuffer,
  splitMarkdownText,
} from '../markdown-safe-outbound-buffer.js'

describe('MarkdownSafeOutboundBuffer', () => {
  it('holds short plain text until idle', () => {
    const buffer = new MarkdownSafeOutboundBuffer()

    buffer.append('第一句。')

    expect(buffer.takeReadySegments()).toEqual([])
    expect(buffer.takeReadySegments({ idle: true })).toEqual(['第一句。'])
  })

  it('flushes non-idle text only after the soft segment length', () => {
    const buffer = new MarkdownSafeOutboundBuffer({ softSegmentLength: 18 })

    buffer.append('短句。')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('继续补到超过阈值，并在这里结束。尾巴')

    expect(buffer.takeReadySegments()).toEqual(['短句。继续补到超过阈值，并在这里结束。'])
    expect(buffer.flushFinal()).toEqual(['尾巴'])
  })

  it('does not split unclosed inline markdown', () => {
    const buffer = new MarkdownSafeOutboundBuffer()

    buffer.append('这是 **粗')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('体**，看 [文档](https://example.com)。')
    expect(buffer.takeReadySegments()).toEqual([])
    expect(buffer.takeReadySegments({ idle: true })).toEqual(['这是 **粗体**，看 [文档](https://example.com)。'])
  })

  it('holds fenced code blocks until they are closed', () => {
    const buffer = new MarkdownSafeOutboundBuffer()

    buffer.append('```ts\nconst answer = 42\n')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('```\n')
    expect(buffer.takeReadySegments()).toEqual([])
    expect(buffer.takeReadySegments({ idle: true })).toEqual(['```ts\nconst answer = 42\n```'])
  })

  it('splits oversized fenced code blocks into independently closed fences', () => {
    const body = Array.from({ length: 12 }, (_, index) => `console.log(${index})\n`).join('')
    const segments = splitMarkdownText('```ts\n' + body + '```\n', 120)

    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every(segment => segment.startsWith('```ts\n'))).toBe(true)
    expect(segments.every(segment => segment.endsWith('\n```'))).toBe(true)
    expect(segments.every(segment => segment.length <= 120)).toBe(true)
  })

  it('waits for a complete table block before flushing', () => {
    const buffer = new MarkdownSafeOutboundBuffer()

    buffer.append('| Name | Value |\n| --- | --- |\n')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('| alpha | 1 |\n')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('\n后续。')
    expect(buffer.takeReadySegments()).toEqual([])
    expect(buffer.takeReadySegments({ idle: true })).toEqual(['| Name | Value |\n| --- | --- |\n| alpha | 1 |', '后续。'])
    expect(buffer.flushFinal()).toEqual([])
  })

  it('flushes list and quote content only at full line boundaries', () => {
    const buffer = new MarkdownSafeOutboundBuffer()

    buffer.append('- item')
    expect(buffer.takeReadySegments()).toEqual([])

    buffer.append('\n> quoted\n')
    expect(buffer.takeReadySegments()).toEqual([])
    expect(buffer.takeReadySegments({ idle: true })).toEqual(['- item\n> quoted'])
  })

  it('does not split links when segmenting long text', () => {
    const text = `${'前缀 '.repeat(80)}[link](https://example.com/${'a'.repeat(80)}) 结束。`
    const segments = splitMarkdownText(text, 120)

    expect(segments.join('')).toBe(text)
    for (const segment of segments) {
      if (segment.includes('[link](')) {
        expect(segment).toContain(')')
      }
    }
  })
})
