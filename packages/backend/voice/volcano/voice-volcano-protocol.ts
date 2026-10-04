import { gzipSync, gunzipSync } from 'node:zlib'

// Volcano Engine "big-model" v3 binary WebSocket framing, shared by
// streaming ASR (sauc), bidirectional TTS and the realtime dialogue API.
// Frame = 4-byte header, optional int32 sequence, optional int32 event,
// optional session id (u32 length + utf8), then u32 payload size + payload.

export const VOLCANO_PROTOCOL_VERSION = 0b0001

export const VolcanoMessageType = {
  FullClientRequest: 0b0001,
  AudioOnlyRequest: 0b0010,
  FullServerResponse: 0b1001,
  AudioOnlyResponse: 0b1011,
  Error: 0b1111,
} as const
export type VolcanoMessageTypeValue = (typeof VolcanoMessageType)[keyof typeof VolcanoMessageType]

export const VolcanoFlags = {
  None: 0b0000,
  PositiveSequence: 0b0001,
  LastNoSequence: 0b0010,
  NegativeSequence: 0b0011,
  Event: 0b0100,
} as const

export const VolcanoSerialization = {
  Raw: 0b0000,
  Json: 0b0001,
} as const

export const VolcanoCompression = {
  None: 0b0000,
  Gzip: 0b0001,
} as const

// Event numbers used by the bidirectional TTS / realtime APIs.
export const VolcanoEvent = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  FinishSession: 102,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
} as const

// Connection-scoped events carry no session id field.
const CONNECTION_LEVEL_EVENTS = new Set<number>([
  VolcanoEvent.StartConnection,
  VolcanoEvent.FinishConnection,
  VolcanoEvent.ConnectionStarted,
  VolcanoEvent.ConnectionFailed,
  VolcanoEvent.ConnectionFinished,
])

export interface VolcanoEncodeOptions {
  sequence?: number
  /** Marks the final audio packet: sequence is written negated with the NegativeSequence flag. */
  last?: boolean
  event?: number
  sessionId?: string
  gzip?: boolean
}

export interface VolcanoFrame {
  type: VolcanoMessageTypeValue
  flags: number
  serialization: number
  compression: number
  sequence?: number
  event?: number
  sessionId?: string
  /** Decompressed payload bytes (error message bytes for error frames). */
  payload: Uint8Array
  errorCode?: number
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, value, false)
  return out
}

function encodeFrame(
  type: VolcanoMessageTypeValue,
  serialization: number,
  payload: Uint8Array,
  options: VolcanoEncodeOptions,
): Uint8Array {
  const useGzip = options.gzip !== false
  const body = useGzip ? new Uint8Array(gzipSync(payload)) : payload

  let flags: number = VolcanoFlags.None
  const chunks: Uint8Array[] = []
  if (options.event !== undefined) {
    flags |= VolcanoFlags.Event
    chunks.push(i32(options.event))
    if (options.sessionId !== undefined) {
      const sessionBytes = textEncoder.encode(options.sessionId)
      chunks.push(u32(sessionBytes.length), sessionBytes)
    }
  } else if (options.sequence !== undefined) {
    if (options.last) {
      flags = VolcanoFlags.NegativeSequence
      chunks.unshift(i32(-Math.abs(options.sequence)))
    } else {
      flags = VolcanoFlags.PositiveSequence
      chunks.unshift(i32(options.sequence))
    }
  } else if (options.last) {
    flags = VolcanoFlags.LastNoSequence
  }

  const header = new Uint8Array(4)
  header[0] = (VOLCANO_PROTOCOL_VERSION << 4) | 0b0001
  header[1] = (type << 4) | flags
  header[2] = (serialization << 4) | (useGzip ? VolcanoCompression.Gzip : VolcanoCompression.None)
  header[3] = 0

  return concatChunks([header, ...chunks, u32(body.length), body])
}

export function encodeVolcanoFullClientRequest(
  payload: object | Uint8Array,
  options: VolcanoEncodeOptions = {},
): Uint8Array {
  const bytes =
    payload instanceof Uint8Array ? payload : textEncoder.encode(JSON.stringify(payload))
  return encodeFrame(VolcanoMessageType.FullClientRequest, VolcanoSerialization.Json, bytes, options)
}

export function encodeVolcanoAudioOnlyRequest(
  audio: Uint8Array,
  options: VolcanoEncodeOptions = {},
): Uint8Array {
  return encodeFrame(VolcanoMessageType.AudioOnlyRequest, VolcanoSerialization.Raw, audio, options)
}

export function decodeVolcanoFrame(input: Uint8Array | ArrayBuffer): VolcanoFrame {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (data.length < 4) {
    throw new Error(`Volcano frame too short: ${data.length} bytes`)
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const headerSize = (data[0] & 0x0f) * 4
  const type = ((data[1] >> 4) & 0x0f) as VolcanoMessageTypeValue
  const flags = data[1] & 0x0f
  const serialization = (data[2] >> 4) & 0x0f
  const compression = data[2] & 0x0f
  if (data.length < headerSize) {
    throw new Error(`Volcano frame shorter than its header: ${data.length} < ${headerSize}`)
  }
  let offset = headerSize

  const frame: VolcanoFrame = {
    type,
    flags,
    serialization,
    compression,
    payload: new Uint8Array(0),
  }

  if (type === VolcanoMessageType.Error) {
    frame.errorCode = view.getUint32(offset, false)
    offset += 4
  } else {
    if ((flags & 0x01) !== 0) {
      frame.sequence = view.getInt32(offset, false)
      offset += 4
    }
    if ((flags & VolcanoFlags.Event) !== 0) {
      frame.event = view.getInt32(offset, false)
      offset += 4
      if (!CONNECTION_LEVEL_EVENTS.has(frame.event)) {
        const sessionLength = view.getUint32(offset, false)
        offset += 4
        frame.sessionId = textDecoder.decode(data.subarray(offset, offset + sessionLength))
        offset += sessionLength
      }
    }
  }

  const payloadSize = view.getUint32(offset, false)
  offset += 4
  const raw = data.subarray(offset, offset + payloadSize)
  if (raw.length !== payloadSize) {
    throw new Error(`Volcano frame payload truncated: expected ${payloadSize}, got ${raw.length}`)
  }
  frame.payload =
    compression === VolcanoCompression.Gzip && payloadSize > 0
      ? new Uint8Array(gunzipSync(raw))
      : raw
  return frame
}

export function parseVolcanoJsonPayload<T>(frame: VolcanoFrame): T {
  return JSON.parse(textDecoder.decode(frame.payload)) as T
}

export function getVolcanoErrorMessage(frame: VolcanoFrame): string {
  const text = textDecoder.decode(frame.payload)
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string }
    return parsed.error || parsed.message || text
  } catch {
    return text
  }
}
