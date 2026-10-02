import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  VolcanoCompression,
  VolcanoEvent,
  VolcanoFlags,
  VolcanoMessageType,
  VolcanoSerialization,
  decodeVolcanoFrame,
  encodeVolcanoAudioOnlyRequest,
  encodeVolcanoFullClientRequest,
  getVolcanoErrorMessage,
  parseVolcanoJsonPayload,
} from '../volcano/protocol'

describe('volcano protocol', () => {
  it('round-trips a gzipped full client request with positive sequence', () => {
    const payload = { user: { uid: 'u1' }, request: { model_name: 'bigmodel' } }
    const frame = decodeVolcanoFrame(encodeVolcanoFullClientRequest(payload, { sequence: 1 }))

    expect(frame.type).toBe(VolcanoMessageType.FullClientRequest)
    expect(frame.flags).toBe(VolcanoFlags.PositiveSequence)
    expect(frame.serialization).toBe(VolcanoSerialization.Json)
    expect(frame.compression).toBe(VolcanoCompression.Gzip)
    expect(frame.sequence).toBe(1)
    expect(parseVolcanoJsonPayload(frame)).toEqual(payload)
  })

  it('round-trips audio-only packets and negates the last sequence', () => {
    const audio = new Uint8Array([1, 2, 3, 4, 5])

    const mid = decodeVolcanoFrame(encodeVolcanoAudioOnlyRequest(audio, { sequence: 7 }))
    expect(mid.type).toBe(VolcanoMessageType.AudioOnlyRequest)
    expect(mid.sequence).toBe(7)
    expect(mid.payload).toEqual(audio)

    const last = decodeVolcanoFrame(
      encodeVolcanoAudioOnlyRequest(audio, { sequence: 8, last: true }),
    )
    expect(last.flags).toBe(VolcanoFlags.NegativeSequence)
    expect(last.sequence).toBe(-8)
  })

  it('marks a last packet without sequence via the LastNoSequence flag', () => {
    const frame = decodeVolcanoFrame(
      encodeVolcanoAudioOnlyRequest(new Uint8Array([9]), { last: true }),
    )
    expect(frame.flags).toBe(VolcanoFlags.LastNoSequence)
    expect(frame.sequence).toBeUndefined()
  })

  it('supports uncompressed audio payloads', () => {
    const audio = new Uint8Array([0, 255, 128])
    const frame = decodeVolcanoFrame(
      encodeVolcanoAudioOnlyRequest(audio, { sequence: 2, gzip: false }),
    )
    expect(frame.compression).toBe(VolcanoCompression.None)
    expect(frame.payload).toEqual(audio)
  })

  it('round-trips event frames with a session id', () => {
    const encoded = encodeVolcanoFullClientRequest(
      { event: 'start' },
      { event: VolcanoEvent.StartSession, sessionId: 'session-abc' },
    )
    const frame = decodeVolcanoFrame(encoded)
    expect(frame.flags).toBe(VolcanoFlags.Event)
    expect(frame.event).toBe(VolcanoEvent.StartSession)
    expect(frame.sessionId).toBe('session-abc')
    expect(parseVolcanoJsonPayload(frame)).toEqual({ event: 'start' })
  })

  it('omits the session id field for connection-level events', () => {
    const encoded = encodeVolcanoFullClientRequest({}, { event: VolcanoEvent.StartConnection })
    const frame = decodeVolcanoFrame(encoded)
    expect(frame.event).toBe(VolcanoEvent.StartConnection)
    expect(frame.sessionId).toBeUndefined()
  })

  it('decodes server error frames with code and message', () => {
    const message = gzipSync(Buffer.from(JSON.stringify({ error: 'quota exceeded' })))
    const data = new Uint8Array(4 + 4 + 4 + message.length)
    const view = new DataView(data.buffer)
    data[0] = 0x11
    data[1] = (VolcanoMessageType.Error << 4) | VolcanoFlags.None
    data[2] = (VolcanoSerialization.Json << 4) | VolcanoCompression.Gzip
    view.setUint32(4, 45000001, false)
    view.setUint32(8, message.length, false)
    data.set(message, 12)

    const frame = decodeVolcanoFrame(data)
    expect(frame.type).toBe(VolcanoMessageType.Error)
    expect(frame.errorCode).toBe(45000001)
    expect(getVolcanoErrorMessage(frame)).toBe('quota exceeded')
  })

  it('skips extended headers according to the declared header size', () => {
    const base = encodeVolcanoAudioOnlyRequest(new Uint8Array([1, 2]), {
      sequence: 3,
      gzip: false,
    })
    const extended = new Uint8Array(base.length + 4)
    extended.set(base.subarray(0, 4), 0)
    extended[0] = (0x1 << 4) | 0x2 // header size 2 -> 8 bytes
    extended.set(base.subarray(4), 8)

    const frame = decodeVolcanoFrame(extended)
    expect(frame.sequence).toBe(3)
    expect(frame.payload).toEqual(new Uint8Array([1, 2]))
  })

  it('rejects truncated frames', () => {
    const good = encodeVolcanoAudioOnlyRequest(new Uint8Array([1, 2, 3]), { sequence: 1 })
    expect(() => decodeVolcanoFrame(good.subarray(0, good.length - 1))).toThrow(/truncated/)
    expect(() => decodeVolcanoFrame(new Uint8Array([0x11]))).toThrow(/too short/)
  })
})
