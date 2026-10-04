/**
 * messages.jsonl 行编解码与恢复扫描(纯函数,无 fs)。
 *
 * 文件格式(docs/design/session-storage-jsonl.md §4.2):
 * - 第 1 行 header:{"t":"h","v":2,"sessionId":"…"}
 * - 其后每行一条消息:{"t":"m","seq":N,"m":{…}},单行紧凑 JSON,\n 结尾
 * - 不变量:行序 = seq 序(1 起连续递增),每条消息只出现一次(最终版本)
 *
 * 恢复语义:尾部不完整行(崩溃截断)静默丢弃;seq 断序视为损坏点,
 * 其后的行全部丢弃,只保留合法前缀。
 */

export const JSONL_LOG_VERSION = 2

const NEWLINE = 0x0a

export interface JsonlLogHeader {
  t: 'h'
  v: number
  sessionId: string
}

export interface JsonlMessageEntry<TMessage> {
  seq: number
  message: TMessage
  /** 该行(含结尾 \n)在文件中的字节区间 */
  byteOffset: number
  byteLength: number
}

export function encodeJsonlHeaderLine(sessionId: string): string {
  return JSON.stringify({ t: 'h', v: JSONL_LOG_VERSION, sessionId }) + '\n'
}

export function encodeJsonlMessageLine(seq: number, message: unknown): string {
  return JSON.stringify({ t: 'm', seq, m: message }) + '\n'
}

export type DecodedJsonlLine<TMessage> =
  | { t: 'h'; header: JsonlLogHeader }
  | { t: 'm'; seq: number; message: TMessage }

export function decodeJsonlLine<TMessage>(line: string): DecodedJsonlLine<TMessage> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as { t?: unknown; v?: unknown; sessionId?: unknown; seq?: unknown; m?: unknown }

  if (record.t === 'h') {
    if (typeof record.v !== 'number' || typeof record.sessionId !== 'string') return null
    return { t: 'h', header: { t: 'h', v: record.v, sessionId: record.sessionId } }
  }

  if (record.t === 'm') {
    if (typeof record.seq !== 'number' || !Number.isInteger(record.seq) || record.seq < 1) return null
    if (record.m === undefined || record.m === null) return null
    return { t: 'm', seq: record.seq, message: record.m as TMessage }
  }

  return null
}

export interface JsonlLogScanResult<TMessage> {
  /** header 缺失或非法时为 undefined;调用方应视为损坏并全量重写 */
  header?: JsonlLogHeader
  entries: JsonlMessageEntry<TMessage>[]
  /**
   * 合法前缀的字节长度。恢复写盘时 truncate 到这里即可:
   * 尾部不完整行、断序行、非法行都在此之后。
   */
  validByteLength: number
  /** 扫描中丢弃了内容(截断尾行/断序/非法行)时为 true */
  recovered: boolean
}

/**
 * 顺序扫描整个日志 buffer,返回合法前缀内的全部消息与字节偏移。
 * 按字节(0x0A)切行——UTF-8 多字节序列不含 0x0A,直接按字节切安全。
 */
export function scanJsonlLog<TMessage>(buffer: Uint8Array): JsonlLogScanResult<TMessage> {
  const decoder = new TextDecoder()
  const entries: JsonlMessageEntry<TMessage>[] = []
  let header: JsonlLogHeader | undefined
  let validByteLength = 0
  let expectedSeq = 1
  let lineStart = 0
  let isFirstLine = true

  const finish = (recoveredAt: number | null): JsonlLogScanResult<TMessage> => ({
    header,
    entries,
    validByteLength,
    recovered: recoveredAt !== null && recoveredAt < buffer.length,
  })

  for (let i = 0; i <= buffer.length; i++) {
    const atEnd = i === buffer.length
    if (!atEnd && buffer[i] !== NEWLINE) continue

    if (atEnd) {
      // 文件末尾没有 \n:最后一段是截断的不完整行,丢弃
      return finish(lineStart)
    }

    const lineBytes = buffer.subarray(lineStart, i)
    const lineEnd = i + 1

    if (lineBytes.length === 0) {
      // 空行视为损坏点
      return finish(lineStart)
    }

    const decoded = decodeJsonlLine<TMessage>(decoder.decode(lineBytes))

    if (isFirstLine) {
      if (!decoded || decoded.t !== 'h') {
        return finish(0)
      }
      header = decoded.header
      isFirstLine = false
      validByteLength = lineEnd
      lineStart = lineEnd
      continue
    }

    if (!decoded || decoded.t !== 'm' || decoded.seq !== expectedSeq) {
      return finish(lineStart)
    }

    entries.push({
      seq: decoded.seq,
      message: decoded.message,
      byteOffset: lineStart,
      byteLength: lineEnd - lineStart,
    })
    expectedSeq += 1
    validByteLength = lineEnd
    lineStart = lineEnd
  }

  return finish(null)
}
