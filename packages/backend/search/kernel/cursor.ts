/**
 * 不透明游标的编解码。
 *
 * 设计:docs/design/search-index-2026-09.md §7.3 / §4.2 分页那一列
 *
 * 契约上 `cursor` 缺席 = 取尽,`total` 缺席 = 不知道;壳只认这两条,不再用
 * 「回来的比要的少」猜。串里装什么由能力的基座定(索引型 `{queryHash, offset}`、
 * 扫描型 `{position}`、静态型没有游标),core 只负责它是**不透明**的、往返恒等的、
 * 坏串抛类型化错误的。
 *
 * base64url 是自己实现的:core 零依赖,连 node 内建也不许 —— `Buffer` 与
 * `node:buffer` 都在禁令里。`TextEncoder` / `TextDecoder` 是语言的全局,不是内建模块。
 */

export interface CursorPayload<T = unknown> {
  capability: string
  /** 游标形的名字,由基座定(core 不在它上面 switch) */
  kind: string
  payload: T
}

export class CursorDecodeError extends Error {
  readonly cursor: string

  constructor(cursor: string, cause?: string) {
    super(`invalid search cursor${cause === undefined ? '' : `: ${cause}`}`)
    this.name = 'CursorDecodeError'
    this.cursor = cursor
  }
}

export interface CursorCodec {
  encode<T>(payload: CursorPayload<T>): string
  decode<T = unknown>(cursor: string): CursorPayload<T>
  /** 坏串不抛的那一路:壳收到过期游标时当「从头来」处理 */
  tryDecode<T = unknown>(cursor: string): CursorPayload<T> | undefined
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function bytesToBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === undefined) break
    out += ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === undefined) break
    out += ALPHABET[b2 & 0b111111]
  }
  return out
}

function base64UrlToBytes(input: string): Uint8Array {
  const bytes: number[] = []
  let accumulator = 0
  let bits = 0
  for (const char of input) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) throw new CursorDecodeError(input, 'illegal character')
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((accumulator >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

export function createCursorCodec(): CursorCodec {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const decode = <T,>(cursor: string): CursorPayload<T> => {
    if (cursor.length === 0) throw new CursorDecodeError(cursor, 'empty')
    let text: string
    try {
      text = decoder.decode(base64UrlToBytes(cursor))
    } catch (error) {
      if (error instanceof CursorDecodeError) throw error
      throw new CursorDecodeError(cursor, 'not utf-8')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new CursorDecodeError(cursor, 'not json')
    }
    if (
      parsed === null
      || typeof parsed !== 'object'
      || typeof (parsed as { c?: unknown }).c !== 'string'
      || typeof (parsed as { k?: unknown }).k !== 'string'
    ) {
      throw new CursorDecodeError(cursor, 'wrong shape')
    }
    const record = parsed as { c: string; k: string; p: T }
    return { capability: record.c, kind: record.k, payload: record.p }
  }

  return {
    encode(payload) {
      // 短键:游标要进 URL 与 SSE,少几十字节是白捡的。
      const json = JSON.stringify({ c: payload.capability, k: payload.kind, p: payload.payload })
      return bytesToBase64Url(encoder.encode(json))
    },
    decode,
    tryDecode(cursor) {
      try {
        return decode(cursor)
      } catch {
        return undefined
      }
    },
  }
}

/** 索引型基座的游标形(§4.2):索引变了 queryHash 就变,游标自然失效。 */
export interface OffsetCursor {
  queryHash: string
  offset: number
}

/** 扫描型基座的游标形:扫描器从这个位置继续(目录变了接受微漂)。 */
export interface PositionCursor {
  position: string
}

/**
 * 逐层键排序的稳定序列化 —— `{a:1,b:2}` 与 `{b:2,a:1}` 必须折出同一个指纹,
 * 否则壳把过滤片换个顺序传上来,游标就白白失效一次。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/**
 * 查询指纹。它必须把「换了这个就不该沿用上一页」的东西全折进去 ——
 * 查询串、意图、过滤片、放宽档、以及**索引代次**(索引一变,代次变)。
 * 纯函数、稳定、与字段顺序无关(键排序后再折)。
 */
export function hashQueryShape(parts: Record<string, unknown>): string {
  const stable = stableStringify(parts)
  // FNV-1a 32 位:够短、够稳、不引依赖。
  let hash = 0x811c9dc5
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}
