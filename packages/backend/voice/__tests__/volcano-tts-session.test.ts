import { describe, expect, it } from 'vitest'
import {
  OnethingDoubaoTTSConnection,
  getOnethingDoubaoTTSMimeType,
} from '../volcano/tts-session'
import type { OnethingDoubaoWebSocketLike } from '../volcano/asr-session'
import {
  VolcanoEvent,
  VolcanoMessageType,
  decodeVolcanoFrame,
  encodeVolcanoFullClientRequest,
  parseVolcanoJsonPayload,
} from '../volcano/protocol'

class FakeSocket implements OnethingDoubaoWebSocketLike {
  readyState = 0
  sent: Uint8Array[] = []
  listeners = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, listener: (...args: any[]) => void): void {
    const list = this.listeners.get(event) || []
    list.push(listener)
    this.listeners.set(event, list)
  }

  emit(event: string, ...args: any[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args)
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  serverEvent(event: number, payload: object, sessionId?: string): void {
    const frame = encodeVolcanoFullClientRequest(payload, { event, sessionId })
    frame[1] = (VolcanoMessageType.FullServerResponse << 4) | (frame[1] & 0x0f)
    this.emit('message', frame)
  }

  serverAudio(sessionId: string, audio: Uint8Array): void {
    // Audio-only response frame: header + event + session id + size + raw audio.
    const sessionBytes = new TextEncoder().encode(sessionId)
    const frame = new Uint8Array(4 + 4 + 4 + sessionBytes.length + 4 + audio.length)
    const view = new DataView(frame.buffer)
    frame[0] = 0x11
    frame[1] = (VolcanoMessageType.AudioOnlyResponse << 4) | 0b0100
    frame[2] = 0x00 // raw, no compression
    view.setInt32(4, VolcanoEvent.TTSResponse, false)
    view.setUint32(8, sessionBytes.length, false)
    frame.set(sessionBytes, 12)
    view.setUint32(12 + sessionBytes.length, audio.length, false)
    frame.set(audio, 16 + sessionBytes.length)
    this.emit('message', frame)
  }
}

async function connect(socket: FakeSocket) {
  const connection = new OnethingDoubaoTTSConnection(
    { apiKey: 'test-key', speaker: 'zh_female_cancan_mars_bigtts', format: 'mp3' },
    (url, headers) => {
      expect(url).toBe('wss://openspeech.bytedance.com/api/v3/tts/bidirection')
      expect(headers['X-Api-Key']).toBe('test-key')
      expect(headers['X-Api-Resource-Id']).toBe('volc.service_type.10029')
      setTimeout(() => {
        socket.readyState = 1
        socket.emit('open')
        setTimeout(() => socket.serverEvent(VolcanoEvent.ConnectionStarted, {}), 0)
      }, 0)
      return socket
    },
  )
  await connection.connect()
  return connection
}

describe('doubao tts session', () => {
  it('closes a socket whose factory resolves after the connection was stopped', async () => {
    const socket = new FakeSocket()
    let release!: (value: FakeSocket) => void
    const connection = new OnethingDoubaoTTSConnection({ apiKey: 'test' }, () => new Promise(resolve => { release = resolve }))
    const opening = connection.connect()
    connection.close()
    release(socket)
    await expect(opening).rejects.toThrow('closed')
    expect(socket.readyState).toBe(3)
    expect(socket.listeners.size).toBe(0)
  })

  it('maps output formats to playable mime types', () => {
    expect(getOnethingDoubaoTTSMimeType({ format: 'mp3' })).toBe('audio/mpeg')
    expect(getOnethingDoubaoTTSMimeType({ format: 'ogg_opus' })).toBe('audio/ogg')
    expect(getOnethingDoubaoTTSMimeType({})).toBe('audio/mpeg')
  })

  it('performs the connection and session handshake and streams audio', async () => {
    const socket = new FakeSocket()
    const connection = await connect(socket)
    expect(connection.isUsable).toBe(true)

    const startConnection = decodeVolcanoFrame(socket.sent[0])
    expect(startConnection.event).toBe(VolcanoEvent.StartConnection)

    const chunks: Uint8Array[] = []
    const synthesized = connection.synthesize('你好。', {
      onChunk: chunk => {
        chunks.push(chunk)
      },
    })
    await Promise.resolve()

    const startSession = decodeVolcanoFrame(socket.sent[1])
    expect(startSession.event).toBe(VolcanoEvent.StartSession)
    const sessionId = startSession.sessionId!
    const startPayload = parseVolcanoJsonPayload<any>(startSession)
    expect(startPayload.namespace).toBe('BidirectionalTTS')
    expect(startPayload.req_params.speaker).toBe('zh_female_cancan_mars_bigtts')

    const task = decodeVolcanoFrame(socket.sent[2])
    expect(task.event).toBe(VolcanoEvent.TaskRequest)
    expect(parseVolcanoJsonPayload<any>(task).req_params.text).toBe('你好。')
    expect(decodeVolcanoFrame(socket.sent[3]).event).toBe(VolcanoEvent.FinishSession)

    socket.serverAudio(sessionId, new Uint8Array([9, 8, 7]))
    socket.serverEvent(VolcanoEvent.SessionFinished, {}, sessionId)
    await synthesized

    expect(chunks).toEqual([new Uint8Array([9, 8, 7])])
  })

  it('rejects the active session on server error frames', async () => {
    const socket = new FakeSocket()
    const connection = await connect(socket)

    const synthesized = connection.synthesize('测试', {})
    await Promise.resolve()
    const sessionId = decodeVolcanoFrame(socket.sent[1]).sessionId!
    socket.serverEvent(VolcanoEvent.SessionFailed, { error: 'voice not ordered' }, sessionId)

    await expect(synthesized).rejects.toThrow(/session failed/i)
  })
})
