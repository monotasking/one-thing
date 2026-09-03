import { StringDecoder } from 'node:string_decoder'

export class NdjsonReader<T = unknown> {
  private decoder = new StringDecoder('utf8')
  private buffer = ''

  constructor(private readonly onLine: (value: T) => void, private readonly onError: (error: Error) => void) {}

  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    this.drain()
  }

  end(): void {
    this.buffer += this.decoder.end()
    this.drain()
    if (this.buffer.trim()) {
      this.parseLine(this.buffer)
      this.buffer = ''
    }
  }

  private drain(): void {
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.parseLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      this.onLine(JSON.parse(trimmed) as T)
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}
