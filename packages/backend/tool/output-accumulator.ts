import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface OutputAccumulatorOptions {
  maxBytes?: number
  maxLines?: number
  maxRollingBytes?: number
  tempDir?: string
  tempFilePrefix?: string
}

export interface OutputTruncation {
  truncated: boolean
  truncatedBy: 'bytes' | 'lines' | null
  outputBytes: number
  totalBytes: number
  outputLines: number
  totalLines: number
  maxBytes: number
  maxLines: number
}

export interface OutputSnapshot {
  content: string
  truncation: OutputTruncation
  fullOutputPath?: string
}

export const DEFAULT_OUTPUT_MAX_BYTES = 30_000
export const DEFAULT_OUTPUT_MAX_LINES = 2_000

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

function stripAnsi(text: string): string {
  return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
}

export function sanitizeOutput(text: string): string {
  const stripped = stripAnsi(text).replace(/\r/g, '')
  return Array.from(stripped)
    .filter((char) => {
      const code = char.codePointAt(0)
      if (code === undefined) return false
      if (code === 0x09 || code === 0x0a) return true
      if (code <= 0x1f) return false
      if (code >= 0xfff9 && code <= 0xfffb) return false
      return true
    })
    .join('')
}

function makeTempFilePath(tempDir: string, prefix: string): string {
  const id = crypto.randomBytes(8).toString('hex')
  return path.join(tempDir, `${prefix}-${id}.log`)
}

function trimToLastLines(text: string, maxLines: number): { text: string; lineCount: number } {
  const lines = text.split('\n')
  const lineCount = text.length === 0 ? 0 : lines.length
  if (lineCount <= maxLines) return { text, lineCount }
  return { text: lines.slice(-maxLines).join('\n'), lineCount }
}

function trimToLastBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf-8')
  if (buffer.length <= maxBytes) return text

  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start++
  }
  return buffer.subarray(start).toString('utf-8')
}

export class OutputAccumulator {
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly maxRollingBytes: number
  private readonly tempDir: string
  private readonly tempFilePrefix: string
  private readonly decoder = new TextDecoder()

  private tailText = ''
  private tailBytes = 0
  private totalBytes = 0
  private totalLines = 0
  private hasAnyOutput = false
  private finished = false
  private fullOutputPath: string | undefined
  private tempFileStream: fs.WriteStream | undefined
  private bufferedBeforeTemp: string[] = []

  constructor(options: OutputAccumulatorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_OUTPUT_MAX_BYTES
    this.maxLines = options.maxLines ?? DEFAULT_OUTPUT_MAX_LINES
    this.maxRollingBytes = options.maxRollingBytes ?? Math.max(this.maxBytes * 2, 1)
    this.tempDir = options.tempDir ?? os.tmpdir()
    this.tempFilePrefix = options.tempFilePrefix ?? 'output'
  }

  append(data: Buffer | Uint8Array | string): void {
    if (this.finished) {
      throw new Error('Cannot append to a finished output accumulator')
    }
    if (typeof data === 'string') {
      this.appendText(data)
      return
    }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.appendText(this.decoder.decode(bytes, { stream: true }))
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.appendText(this.decoder.decode())
    if (this.isTruncated()) this.ensureTempFile()
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const truncated = this.isTruncated()
    if (truncated && options.persistIfTruncated) this.ensureTempFile()

    let content = this.tailText
    const byLines = trimToLastLines(content, this.maxLines)
    content = byLines.text
    content = trimToLastBytes(content, this.maxBytes)

    const outputBytes = byteLength(content)
    const outputLines = content.length === 0 ? 0 : content.split('\n').length
    const truncatedBy = truncated
      ? this.totalBytes > this.maxBytes ? 'bytes' : 'lines'
      : null

    return {
      content,
      truncation: {
        truncated,
        truncatedBy,
        outputBytes,
        totalBytes: this.totalBytes,
        outputLines,
        totalLines: this.totalLines,
        maxBytes: this.maxBytes,
        maxLines: this.maxLines,
      },
      fullOutputPath: this.fullOutputPath,
    }
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return
    const stream = this.tempFileStream
    this.tempFileStream = undefined
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off('finish', onFinish)
        reject(error)
      }
      const onFinish = () => {
        stream.off('error', onError)
        resolve()
      }
      stream.once('error', onError)
      stream.once('finish', onFinish)
      stream.end()
    })
  }

  private appendText(rawText: string): void {
    if (!rawText) return
    const text = sanitizeOutput(rawText)
    if (!text) return

    this.totalBytes += byteLength(text)
    if (!this.hasAnyOutput) {
      this.hasAnyOutput = true
      this.totalLines = 1
    }
    this.totalLines += (text.match(/\n/g) || []).length

    if (this.tempFileStream || this.shouldUseTempFileAfter(text)) {
      this.ensureTempFile()
      this.tempFileStream?.write(text)
    } else {
      this.bufferedBeforeTemp.push(text)
    }

    this.tailText += text
    this.tailBytes += byteLength(text)
    if (this.tailBytes > this.maxRollingBytes * 2) {
      this.tailText = trimToLastBytes(this.tailText, this.maxRollingBytes)
      this.tailBytes = byteLength(this.tailText)
    }
  }

  private shouldUseTempFileAfter(_text: string): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines
  }

  private isTruncated(): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines
  }

  private ensureTempFile(): void {
    if (this.fullOutputPath) return
    fs.mkdirSync(this.tempDir, { recursive: true })
    this.fullOutputPath = makeTempFilePath(this.tempDir, this.tempFilePrefix)
    this.tempFileStream = fs.createWriteStream(this.fullOutputPath, { encoding: 'utf-8' })
    for (const chunk of this.bufferedBeforeTemp) {
      this.tempFileStream.write(chunk)
    }
    this.bufferedBeforeTemp = []
  }
}
