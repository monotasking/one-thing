import { randomUUID } from 'node:crypto'
import {
  VolcanoEvent,
  VolcanoMessageType,
  decodeVolcanoFrame,
  encodeVolcanoFullClientRequest,
  getVolcanoErrorMessage,
} from './protocol.js'
import {
  buildOnethingDoubaoHeaders,
  getOnethingDoubaoConfigurationError,
  DOUBAO_DEFAULT_ENDPOINT,
  type OnethingDoubaoWebSocketFactory,
  type OnethingDoubaoWebSocketLike,
} from './asr-session.js'

export interface OnethingDoubaoTTSSettingsLike {
  apiKey?: string
  appId?: string
  accessToken?: string
  ttsResourceId?: string
  endpoint?: string
  speaker?: string
  format?: string
}

export interface OnethingDoubaoTTSSynthesizeHandlers {
  onChunk?: (chunk: Uint8Array) => void | Promise<void>
}

// 大模型语音合成 — pairs with the mars/moon bigtts voice list.
export const DOUBAO_TTS_DEFAULT_RESOURCE_ID = 'volc.service_type.10029'
export const DOUBAO_TTS_DEFAULT_SPEAKER = 'zh_female_cancan_mars_bigtts'
const DOUBAO_TTS_PATH = '/api/v3/tts/bidirection'
const WS_OPEN = 1
const SESSION_TIMEOUT_MS = 30000

async function defaultCreateWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<OnethingDoubaoWebSocketLike> {
  const { default: WebSocketImpl } = await import('ws')
  return new WebSocketImpl(url, { headers }) as unknown as OnethingDoubaoWebSocketLike
}

interface PendingSynthesis {
  sessionId: string
  handlers: OnethingDoubaoTTSSynthesizeHandlers
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function getOnethingDoubaoTTSMimeType(settings: OnethingDoubaoTTSSettingsLike): string {
  const format = (settings.format || 'mp3').toLowerCase()
  if (format === 'ogg_opus') return 'audio/ogg'
  if (format === 'pcm') return 'audio/pcm'
  return 'audio/mpeg'
}

/**
 * One bidirectional-TTS WebSocket connection; each synthesize() call runs a
 * session (StartSession → TaskRequest → FinishSession → audio frames). The
 * connection is reusable across sentences of a reply.
 */
export class OnethingDoubaoTTSConnection {
  private readonly settings: OnethingDoubaoTTSSettingsLike
  private readonly createWebSocket: OnethingDoubaoWebSocketFactory
  private socket: OnethingDoubaoWebSocketLike | null = null
  private connectPromise: Promise<void> | null = null
  private connectionStarted = false
  private connectionResolve: (() => void) | null = null
  private connectionReject: ((error: Error) => void) | null = null
  private pending: PendingSynthesis | null = null
  private queue: Promise<void> = Promise.resolve()
  private closed = false

  constructor(settings: OnethingDoubaoTTSSettingsLike, createWebSocket?: OnethingDoubaoWebSocketFactory) {
    this.settings = settings
    this.createWebSocket = createWebSocket ?? defaultCreateWebSocket
  }

  get isUsable(): boolean {
    return !this.closed && this.socket?.readyState === WS_OPEN && this.connectionStarted
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('Doubao TTS connection is closed')
    if (this.connectPromise) return this.connectPromise
    const configurationError = getOnethingDoubaoConfigurationError(this.settings)
    if (configurationError) throw new Error(configurationError)

    this.connectPromise = (async () => {
      const endpoint = (this.settings.endpoint || DOUBAO_DEFAULT_ENDPOINT).trim().replace(/\/$/, '')
      const resourceId = (this.settings.ttsResourceId || '').trim() || DOUBAO_TTS_DEFAULT_RESOURCE_ID
      const headers = buildOnethingDoubaoHeaders(this.settings, resourceId)
      const socket = await this.createWebSocket(`${endpoint}${DOUBAO_TTS_PATH}`, headers)
      if (this.closed) { socket.close(); throw new Error('Doubao TTS connection is closed') }
      this.socket = socket

      await new Promise<void>((resolve, reject) => {
        this.connectionResolve = resolve
        this.connectionReject = reject
        socket.on('open', () => {
          try {
            socket.send(encodeVolcanoFullClientRequest({}, { event: VolcanoEvent.StartConnection }))
          } catch (error) {
            reject(error as Error)
          }
        })
        socket.on('message', (data: Uint8Array) => this.handleMessage(data))
        socket.on('error', (error: Error) => {
          const wrapped = new Error(`Doubao TTS socket error: ${error?.message || String(error)}`)
          this.failAll(wrapped)
        })
        socket.on('close', () => {
          this.failAll(new Error('Doubao TTS connection closed.'))
        })
      })
    })()
    try {
      await this.connectPromise
    } catch (error) {
      this.close()
      throw error
    }
  }

  /** Serializes sessions on this connection; resolves when the sentence finished streaming. */
  synthesize(text: string, handlers: OnethingDoubaoTTSSynthesizeHandlers): Promise<void> {
    const run = this.queue.then(() => this.runSession(text, handlers))
    this.queue = run.catch(() => {})
    return run
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState === WS_OPEN) {
      try {
        socket.send(encodeVolcanoFullClientRequest({}, { event: VolcanoEvent.FinishConnection }))
      } catch {
        // Best-effort goodbye; the close below still tears the socket down.
      }
    }
    try {
      socket?.close()
    } catch {
      // Already closing.
    }
    this.failAll(new Error('Doubao TTS connection closed.'))
  }

  private async runSession(text: string, handlers: OnethingDoubaoTTSSynthesizeHandlers): Promise<void> {
    if (!this.isUsable || !this.socket) {
      throw new Error('Doubao TTS connection is not open.')
    }
    const sessionId = randomUUID()
    const socket = this.socket

    return new Promise<void>((resolve, reject) => {
      const pending: PendingSynthesis = {
        sessionId,
        handlers,
        resolve: () => {
          clearTimeout(pending.timer)
          if (this.pending === pending) this.pending = null
          resolve()
        },
        reject: error => {
          clearTimeout(pending.timer)
          if (this.pending === pending) this.pending = null
          reject(error)
        },
        timer: setTimeout(() => {
          pending.reject(new Error('Doubao TTS timed out.'))
        }, SESSION_TIMEOUT_MS),
      }
      this.pending = pending

      try {
        const speaker = (this.settings.speaker || '').trim() || DOUBAO_TTS_DEFAULT_SPEAKER
        const format = (this.settings.format || 'mp3').toLowerCase()
        socket.send(encodeVolcanoFullClientRequest({
          user: { uid: 'onething' },
          event: VolcanoEvent.StartSession,
          namespace: 'BidirectionalTTS',
          req_params: {
            speaker,
            audio_params: {
              format,
              sample_rate: 24000,
            },
          },
        }, { event: VolcanoEvent.StartSession, sessionId }))
        socket.send(encodeVolcanoFullClientRequest({
          user: { uid: 'onething' },
          event: VolcanoEvent.TaskRequest,
          namespace: 'BidirectionalTTS',
          req_params: {
            text,
            speaker,
          },
        }, { event: VolcanoEvent.TaskRequest, sessionId }))
        socket.send(encodeVolcanoFullClientRequest({}, { event: VolcanoEvent.FinishSession, sessionId }))
      } catch (error: any) {
        pending.reject(new Error(`Doubao TTS send failed: ${error?.message || String(error)}`))
      }
    })
  }

  private handleMessage(data: Uint8Array): void {
    let frame
    try {
      frame = decodeVolcanoFrame(data)
    } catch (error: any) {
      this.failAll(new Error(`Doubao TTS frame parsing failed: ${error?.message || String(error)}`))
      return
    }

    if (frame.type === VolcanoMessageType.Error) {
      this.failAll(new Error(`Doubao TTS error ${frame.errorCode}: ${getVolcanoErrorMessage(frame)}`))
      return
    }

    switch (frame.event) {
      case VolcanoEvent.ConnectionStarted:
        this.connectionStarted = true
        this.connectionResolve?.()
        this.connectionResolve = null
        this.connectionReject = null
        return
      case VolcanoEvent.ConnectionFailed:
        this.failAll(new Error(`Doubao TTS connection failed: ${getVolcanoErrorMessage(frame)}`))
        return
      case VolcanoEvent.TTSResponse:
        if (this.pending && frame.sessionId === this.pending.sessionId && frame.payload.length > 0) {
          void this.pending.handlers.onChunk?.(frame.payload)
        }
        return
      case VolcanoEvent.SessionFinished:
        if (this.pending && frame.sessionId === this.pending.sessionId) {
          this.pending.resolve()
        }
        return
      case VolcanoEvent.SessionFailed:
        if (this.pending && frame.sessionId === this.pending.sessionId) {
          this.pending.reject(new Error(`Doubao TTS session failed: ${getVolcanoErrorMessage(frame)}`))
        }
        return
      default:
        // SessionStarted / TTSSentenceStart / TTSSentenceEnd are informational.
    }
  }

  private failAll(error: Error): void {
    this.closed = true
    this.connectionReject?.(error)
    this.connectionReject = null
    this.connectionResolve = null
    this.pending?.reject(error)
    this.pending = null
    try {
      this.socket?.close()
    } catch {
      // Already closed.
    }
    this.socket = null
  }
}
