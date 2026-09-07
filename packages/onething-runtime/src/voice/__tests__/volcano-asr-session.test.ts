import { describe, expect, it } from 'vitest'
import {
  OnethingDoubaoASRSession,
  buildOnethingDoubaoHeaders,
  getOnethingDoubaoConfigurationError,
  type OnethingDoubaoWebSocketLike,
} from '../volcano/asr-session'
import {
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

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  send(data: Uint8Array): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  replyFullResponse(payload: object, sequence: number): void {
    // Server responses reuse the client framing with a different type nibble.
    const frame = encodeVolcanoFullClientRequest(payload, { sequence })
    frame[1] = (VolcanoMessageType.FullServerResponse << 4) | (frame[1] & 0x0f)
    this.emit('message', frame)
  }
}

function createSession(socket: FakeSocket, callbacks: Partial<{
  partials: string[]
  utterances: string[]
  errors: string[]
}> = {}) {
  return new OnethingDoubaoASRSession({
    settings: { apiKey: 'test-key' },
    createWebSocket: (url, headers) => {
      expect(url).toBe('wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async')
      expect(headers['X-Api-Key']).toBe('test-key')
      setTimeout(() => socket.open(), 0)
      return socket
    },
    onPartial: text => callbacks.partials?.push(text),
    onUtterance: utterance => callbacks.utterances?.push(utterance.text),
    onError: error => callbacks.errors?.push(error.message),
  })
}

describe('doubao asr session', () => {
  it('closes a socket whose factory resolves after the session was stopped', async () => {
    const socket = new FakeSocket()
    let release!: (value: FakeSocket) => void
    const session = new OnethingDoubaoASRSession({ settings: { apiKey: 'test' }, createWebSocket: () => new Promise(resolve => { release = resolve }) })
    const opening = session.connect()
    session.close()
    release(socket)
    await expect(opening).rejects.toThrow('closed')
    expect(socket.readyState).toBe(3)
    expect(socket.listeners.size).toBe(0)
  })

  it('rejects a pending handshake when stopped before open', async () => {
    const socket = new FakeSocket()
    const session = new OnethingDoubaoASRSession({ settings: { apiKey: 'test' }, createWebSocket: () => socket })
    const opening = session.connect()
    await Promise.resolve()
    session.close()
    await expect(opening).rejects.toThrow('closed before opening')
  })

  it('flags missing credentials', () => {
    expect(getOnethingDoubaoConfigurationError({})).toMatch(/API key/)
    expect(getOnethingDoubaoConfigurationError({ apiKey: 'k' })).toBeNull()
    expect(getOnethingDoubaoConfigurationError({ appId: 'a', accessToken: 't' })).toBeNull()
  })

  it('prefers the API key header and falls back to app credentials', () => {
    expect(buildOnethingDoubaoHeaders({ apiKey: 'k' }, 'res')['X-Api-Key']).toBe('k')
    const legacy = buildOnethingDoubaoHeaders({ appId: 'a', accessToken: 't' }, 'res')
    expect(legacy['X-Api-App-Key']).toBe('a')
    expect(legacy['X-Api-Access-Key']).toBe('t')
    expect(legacy['X-Api-Resource-Id']).toBe('res')
  })

  it('sends the config frame on open and sequences audio packets', async () => {
    const socket = new FakeSocket()
    const session = createSession(socket)
    await session.connect()

    const config = decodeVolcanoFrame(socket.sent[0])
    expect(config.type).toBe(VolcanoMessageType.FullClientRequest)
    expect(config.sequence).toBe(1)
    const payload = parseVolcanoJsonPayload<any>(config)
    expect(payload.audio).toMatchObject({ format: 'pcm', rate: 16000, bits: 16, channel: 1 })
    expect(payload.request).toMatchObject({ model_name: 'bigmodel', show_utterances: true })

    session.pushAudio(new Uint8Array([1, 2]))
    session.pushAudio(new Uint8Array([3, 4]))
    expect(decodeVolcanoFrame(socket.sent[1]).sequence).toBe(2)
    expect(decodeVolcanoFrame(socket.sent[2]).sequence).toBe(3)
    session.close()
  })

  it('reports partials and definite utterances', async () => {
    const socket = new FakeSocket()
    const partials: string[] = []
    const utterances: string[] = []
    const session = createSession(socket, { partials, utterances })
    await session.connect()

    socket.replyFullResponse({ result: { text: '今天', utterances: [{ text: '今天', definite: false }] } }, 1)
    socket.replyFullResponse({
      result: { text: '今天天气怎么样', utterances: [{ text: '今天天气怎么样', definite: true }] },
    }, 2)

    expect(partials).toEqual(['今天', '今天天气怎么样'])
    expect(utterances).toEqual(['今天天气怎么样'])
    expect(session.definiteText).toBe('今天天气怎么样')
    session.close()
  })

  it('finish sends a negative-sequence packet and resolves on the final response', async () => {
    const socket = new FakeSocket()
    const session = createSession(socket)
    await session.connect()
    session.pushAudio(new Uint8Array([1, 2]))

    const finalPromise = session.finish()
    const lastFrame = decodeVolcanoFrame(socket.sent.at(-1)!)
    expect(lastFrame.sequence).toBe(-3)

    socket.replyFullResponse({ result: { text: '你好', utterances: [{ text: '你好', definite: true }] } }, -3)
    await expect(finalPromise).resolves.toBe('你好')
    session.close()
  })

  it('surfaces server error frames', async () => {
    const socket = new FakeSocket()
    const errors: string[] = []
    const session = createSession(socket, { errors })
    await session.connect()

    const message = new TextEncoder().encode(JSON.stringify({ error: 'quota exceeded' }))
    const errorFrame = new Uint8Array(12 + message.length)
    const view = new DataView(errorFrame.buffer)
    errorFrame[0] = 0x11
    errorFrame[1] = VolcanoMessageType.Error << 4
    errorFrame[2] = 0x10 // JSON, no compression
    view.setUint32(4, 45000001, false)
    view.setUint32(8, message.length, false)
    errorFrame.set(message, 12)
    socket.emit('message', errorFrame)

    expect(errors).toEqual(['Doubao ASR error 45000001: quota exceeded'])
  })
})
