/**
 * R1 —— `read` 的**内容判定**纯函数(二进制嗅探、图片 MIME、头部截断)。
 *
 * 它们今天长在 `tools/builtin/read.ts` 的模块私有作用域里,而那个文件整只在 §6 的
 * 删除清单上。工具壳可以重写,这些判据不能凭记忆重打一遍 —— 所以它们搬进新树的
 * 一个**独立模块**(不是复制进工具里),口径由 `__tests__/parity/read.test.ts` 逐条
 * 钉住:同一份字节喂给新旧两条路,输出必须逐字相同。
 */

import { extnamePath } from '@onething/core/storage'
import { formatSize, utf8Bytes } from '../../tools/text-truncation.js'

export const DEFAULT_LIMIT = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024
const BINARY_CHECK_BYTES = 8192

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

export interface ReadTruncation {
  truncated: boolean
  truncatedBy: 'bytes' | 'lines' | null
  outputLines: number
  totalLines: number
  maxBytes: number
  maxLines: number
  firstLineExceedsLimit?: boolean
}

export interface TruncatedTextResult {
  content: string
  truncation: ReadTruncation
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  let nonPrintable = 0
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES)

  for (let i = 0; i < checkLength; i++) {
    const byte = buffer[i]
    if (byte === 0) return true
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) nonPrintable++
  }

  return nonPrintable / checkLength > 0.1
}

/** 头部截断:先按行,再按字节;第一行就超限时给一句可自救的 sed 提示。 */
export function truncateHead(
  text: string,
  maxLines = DEFAULT_LIMIT,
  maxBytes = DEFAULT_MAX_BYTES,
): TruncatedTextResult {
  const allLines = text.split('\n')
  const totalLines = allLines.length
  const firstLineBytes = utf8Bytes(allLines[0] ?? '')

  if (firstLineBytes > maxBytes) {
    return {
      content: '',
      truncation: {
        truncated: true,
        truncatedBy: 'bytes',
        outputLines: 0,
        totalLines,
        maxBytes,
        maxLines,
        firstLineExceedsLimit: true,
      },
    }
  }

  const selectedLines: string[] = []
  let selectedBytes = 0
  let truncatedBy: ReadTruncation['truncatedBy'] = null

  for (let i = 0; i < allLines.length; i++) {
    if (selectedLines.length >= maxLines) {
      truncatedBy = 'lines'
      break
    }

    const separatorBytes = selectedLines.length > 0 ? 1 : 0
    const nextBytes = separatorBytes + utf8Bytes(allLines[i])
    if (selectedBytes + nextBytes > maxBytes) {
      truncatedBy = 'bytes'
      break
    }

    selectedLines.push(allLines[i])
    selectedBytes += nextBytes
  }

  return {
    content: selectedLines.join('\n'),
    truncation: {
      truncated: truncatedBy !== null,
      truncatedBy,
      outputLines: selectedLines.length,
      totalLines,
      maxBytes,
      maxLines,
    },
  }
}

function getExtension(targetPath: string): string {
  return extnamePath(targetPath).toLowerCase()
}

/** 魔数优先,扩展名兜底 —— 一个改了后缀的 png 仍然是 png。 */
function detectSupportedImageMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  const header = buffer.subarray(0, 12).toString('ascii')
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif'
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp'

  return null
}

export function supportedImageMimeType(targetPath: string, buffer: Buffer): string | null {
  return (
    detectSupportedImageMimeType(buffer) ??
    IMAGE_MIME_BY_EXTENSION[getExtension(targetPath)] ??
    null
  )
}

export function isPdfFile(targetPath: string): boolean {
  return getExtension(targetPath) === '.pdf'
}

export interface ComposedTextRead {
  output: string
  lineCount: number
  metadata: {
    path: string
    lineCount: number
    offset: number
    limit: number
    truncated: boolean
    truncation: ReadTruncation
    isBinary: false
    fileSize: number
  }
}

/**
 * 文本分支的全部产物:窗口(offset/limit)→ 头部截断 → 续读提示 → 元数据。
 *
 * 它整块住在这里而不是工具壳里,是尺子① 的直接后果:一个工具的正文不该出现
 * "截断"这个词。read 的续读提示确实是**它自己的领域语义**("文件还有,接着读"),
 * 但它仍然是一段可以独立测试的纯计算,没有理由长在 apply 里。
 */
export function composeTextRead(input: {
  path: string
  inputPath: string
  content: string
  offset: number
  limit?: number
  fileSize: number
}): ComposedTextRead {
  const { path, content, offset, limit, fileSize } = input
  const allLines = content.split('\n')
  const totalLines = allLines.length
  const startIndex = Math.max(0, offset - 1)
  if (startIndex >= totalLines) {
    throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`)
  }

  const endIndex = limit !== undefined ? Math.min(totalLines, startIndex + limit) : totalLines
  const userLimitedLines = limit !== undefined ? endIndex - startIndex : undefined
  const head = truncateHead(allLines.slice(startIndex, endIndex).join('\n'))
  const cut = head.truncation
  const startLineDisplay = startIndex + 1
  let output = head.content
  let lineCount = cut.outputLines

  if (cut.firstLineExceedsLimit) {
    const firstLineSize = formatSize(utf8Bytes(allLines[startIndex] ?? ''))
    output = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.inputPath} | head -c ${DEFAULT_MAX_BYTES}]`
  } else if (cut.truncated) {
    const endLineDisplay = startLineDisplay + cut.outputLines - 1
    const nextOffset = endLineDisplay + 1
    output += cut.truncatedBy === 'lines'
      ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`
  } else if (userLimitedLines !== undefined && startIndex + userLimitedLines < totalLines) {
    const remaining = totalLines - (startIndex + userLimitedLines)
    output += `\n\n[${remaining} more lines in file. Use offset=${startIndex + userLimitedLines + 1} to continue.]`
  }

  if (totalLines === 1 && allLines[0] === '') {
    output = `[Empty file: ${path}]`
    lineCount = 0
  }

  return {
    output,
    lineCount,
    metadata: {
      path,
      lineCount,
      offset,
      limit: limit ?? DEFAULT_LIMIT,
      truncated: cut.truncated || (userLimitedLines !== undefined && startIndex + userLimitedLines < totalLines),
      truncation: cut,
      isBinary: false,
      fileSize,
    },
  }
}
