import { describe, expect, it } from 'vitest'
import { formatSize, truncateLine, truncateTextHead, utf8Bytes } from '../text-truncation.js'

describe('runtime text-truncation', () => {
  it('formats byte counts', () => {
    expect(formatSize(10)).toBe('10B')
    expect(formatSize(1024)).toBe('1KB')
    expect(formatSize(1536)).toBe('1.5KB')
  })

  it('truncates text by lines or bytes', () => {
    expect(truncateTextHead('a\nb\nc', { maxLines: 2 })).toMatchObject({
      content: 'a\nb',
      truncated: true,
      truncatedBy: 'lines',
    })
    expect(truncateTextHead('hello', { maxBytes: 4 })).toMatchObject({
      content: '',
      truncated: true,
      truncatedBy: 'bytes',
    })
  })

  it('counts utf8 bytes and truncates long lines', () => {
    expect(utf8Bytes('你好')).toBe(6)
    expect(truncateLine('abcdef', 3)).toEqual({ text: 'abc...', truncated: true })
    expect(truncateLine('abc', 3)).toEqual({ text: 'abc', truncated: false })
  })
})
