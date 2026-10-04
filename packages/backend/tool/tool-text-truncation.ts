export const DEFAULT_TEXT_MAX_BYTES = 50 * 1024

export interface TextTruncationResult {
  content: string
  truncated: boolean
  truncatedBy: 'bytes' | 'lines' | null
  outputLines: number
  totalLines: number
  maxBytes: number
  maxLines: number
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Number.isInteger(kb) ? kb : kb.toFixed(1)}KB`
  const mb = kb / 1024
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`
}

export function truncateTextHead(
  text: string,
  options: { maxLines?: number; maxBytes?: number } = {},
): TextTruncationResult {
  const maxLines = options.maxLines ?? Number.MAX_SAFE_INTEGER
  const maxBytes = options.maxBytes ?? DEFAULT_TEXT_MAX_BYTES
  const lines = text.split('\n')
  const selected: string[] = []
  let selectedBytes = 0
  let truncatedBy: TextTruncationResult['truncatedBy'] = null

  for (const line of lines) {
    if (selected.length >= maxLines) {
      truncatedBy = 'lines'
      break
    }
    const separatorBytes = selected.length > 0 ? 1 : 0
    const nextBytes = separatorBytes + utf8Bytes(line)
    if (selectedBytes + nextBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }
    selected.push(line)
    selectedBytes += nextBytes
  }

  return {
    content: selected.join('\n'),
    truncated: truncatedBy !== null,
    truncatedBy,
    outputLines: selected.length,
    totalLines: lines.length,
    maxBytes,
    maxLines,
  }
}

export function truncateLine(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, Math.max(0, maxChars))}...`, truncated: true }
}
