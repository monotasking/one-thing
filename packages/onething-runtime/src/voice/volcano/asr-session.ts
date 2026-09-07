import { randomUUID } from 'node:crypto'
import {
  VolcanoMessageType,
  decodeVolcanoFrame,
  encodeVolcanoAudioOnlyRequest,
  encodeVolcanoFullClientRequest,
  getVolcanoErrorMessage,
  parseVolcanoJsonPayload,
} from './protocol.js'

export interface OnethingDoubaoSettingsLike {
  apiKey?: string
  appId?: string
  accessToken?: string
  asrResourceId?: string
  endpoint?: string
  endWindowMs?: number
  twoPass?: boolean
}

export interface OnethingDoubaoUtterance {
  text: string
  definite: boolean
  startTime?: number
  endTime?: number
}

interface DoubaoASRResponsePayload {
  audio_info?: { duration?: number }
  result?: {
    text?: string
    utterances?: Array<{
      text?: string
      definite?: boolean
      start_time?: number
      end_time?: number
    }>
  }
}

export interface OnethingDoubaoWebSocketLike {
  readyState: number
  send(data: Uint8Array): void
  close(): void
  on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): void
}

export type OnethingDoubaoWebSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => OnethingDoubaoWebSocketLike | Promise<OnethingDoubaoWebSocketLike>

export interface OnethingDoubaoASRSessionOptions {
  settings: OnethingDoubaoSettingsLike
  uid?: string
  /** Injectable for tests and hosts that bring their own socket. Defaults to the `ws` package. */
  createWebSocket?: OnethingDoubaoWebSocketFactory
  onOpen?: (logId?: string) => void
  onPartial?: (text: string) => void
  onUtterance?: (utterance: OnethingDoubaoUtterance) => void
  onError?: (error: Error) => void
  onClose?: () => void
}

export const DOUBAO_ASR_DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
export const DOUBAO_DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com'
const DOUBAO_ASR_PATH = '/api/v3/sauc/bigmodel_async'
const WS_OPEN = 1

export function getOnethingDoubaoConfigurationError(
  settings: OnethingDoubaoSettingsLike | undefined,
): string | null {
  const apiKey = (settings?.apiKey || '').trim()
  const appId = (settings?.appId || '').trim()
  const accessToken = (settings?.accessToken || '').trim()
  if (apiKey || (appId && accessToken)) return null
  return 'Add a Doubao (Volcano Engine) API key in Voice settings before using Doubao speech.'
}

export function buildOnethingDoubaoHeaders(
  settings: OnethingDoubaoSettingsLike,
  resourceId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': randomUUID(),
  }
  const apiKey = (settings.apiKey || '').trim()
  if (apiKey) {
    headers['X-Api-Key'] = apiKey
  } else {
    headers['X-Api-App-Key'] = (settings.appId || '').trim()
    headers['X-Api-Access-Key'] = (settings.accessToken || '').trim()
  }
  return headers
}

async function defaultCreateWebSocket(
  url: string,
  headers: Record<string, string>,
): Promise<OnethingDoubaoWebSocketLike> {
  const { default: WebSocketImpl } = await import('ws')
  return new WebSocketImpl(url, { headers }) as unknown as OnethingDoubaoWebSocketLike
}

/**
 * One streaming-ASR turn against Doubao (Volcano big-model sauc). Feed 16 kHz
 * mono int16 PCM via pushAudio(); the server segments utterances itself
 * (end_window_size) and marks finished sentences with definite: true.
 */
export class OnethingDoubaoASRSession {
  private readonly options: OnethingDoubaoASRSessionOptions
  private socket: OnethingDoubaoWebSocketLike | null = null
  private sequence = 1
  private closed = false
  private finishing = false
  private lastText = ''
  private definiteTexts: string[] = []
  private finalResolvers: Array<(text: string) => void> = []
  private finalTimers: Array<ReturnType<typeof setTimeout>> = []

  constructor(options: OnethingDoubaoASRSessionOptions) {
    this.options = options
  }

  get latestText(): string {
    return this.lastText
  }

  get definiteText(): string {
    return this.definiteTexts.join('')
  }

  async connect(audioFormat: { format: string; codec?: string; rate?: number } = { format: 'pcm', codec: 'raw' }): Promise<void> {
    if (this.closed) throw new Error('Doubao ASR session is closed')
    const settings = this.options.settings
    const configurationError = getOnethingDoubaoConfigurationError(settings)
    if (configurationError) throw new Error(configurationError)

    const endpoint = (settings.endpoint || DOUBAO_DEFAULT_ENDPOINT).trim().replace(/\/$/, '')
    const resourceId = (settings.asrResourceId || '').trim() || DOUBAO_ASR_DEFAULT_RESOURCE_ID
    const headers = buildOnethingDoubaoHeaders(settings, resourceId)
    const factory = this.options.createWebSocket ?? defaultCreateWebSocket
    const socket = await factory(`${endpoint}${DOUBAO_ASR_PATH}`, headers)
    if (this.closed) { socket.close(); throw new Error('Doubao ASR session is closed') }
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false
      socket.on('open', () => {
        if (settled) return
        settled = true
        try {
          socket.send(encodeVolcanoFullClientRequest(this.buildRequestPayload(audioFormat), {
            sequence: this.sequence,
          }))
          this.options.onOpen?.()
          resolve()
        } catch (error) {
          reject(error as Error)
        }
      })
      socket.on('error', (error: Error) => {
        if (!settled) {
          settled = true
          reject(new Error(`Doubao ASR connection failed: ${error?.message || String(error)}`))
          return
        }
        this.fail(new Error(`Doubao ASR socket error: ${error?.message || String(error)}`))
      })
      socket.on('message', (data: Uint8Array) => this.handleMessage(data))
      socket.on('close', () => {
        if (!settled) { settled = true; reject(new Error('Doubao ASR connection closed before opening')) }
        this.handleClose()
      })
    })
  }

  pushAudio(pcm: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN || this.finishing || this.closed) return
    this.sequence += 1
    this.socket.send(encodeVolcanoAudioOnlyRequest(pcm, { sequence: this.sequence }))
  }

  /** Sends the final (negative-sequence) packet and resolves with the final transcript. */
  finish(timeoutMs = 5000): Promise<string> {
    if (this.closed) return Promise.resolve(this.definiteText || this.lastText)
    if (!this.finishing) {
      this.finishing = true
      if (this.socket && this.socket.readyState === WS_OPEN) {
        this.sequence += 1
        this.socket.send(encodeVolcanoAudioOnlyRequest(new Uint8Array(0), {
          sequence: this.sequence,
          last: true,
        }))
      } else {
        this.close()
        return Promise.resolve(this.definiteText || this.lastText)
      }
    }
    return new Promise<string>(resolve => {
      this.finalResolvers.push(resolve)
      this.finalTimers.push(setTimeout(() => this.resolveFinal(), timeoutMs))
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.resolveFinal()
    try {
      this.socket?.close()
    } catch {
      // The socket may already be closing; nothing to release beyond this.
    }
    this.socket = null
  }

  private buildRequestPayload(audioFormat: { format: string; codec?: string; rate?: number }) {
    return {
      user: { uid: this.options.uid || 'onething' },
      audio: {
        format: audioFormat.format,
        codec: audioFormat.codec || 'raw',
        rate: audioFormat.rate || 16000,
        bits: 16,
        channel: 1,
      },
      request: {
        model_name: 'bigmodel',
        enable_punc: true,
        enable_itn: true,
        show_utterances: true,
        result_type: 'full',
        end_window_size: this.options.settings.endWindowMs || 800,
        // Two-pass: each utterance is re-recognized with the non-streaming
        // model before its definite result, trading a little end-of-turn
        // latency for accuracy.
        enable_nonstream: this.options.settings.twoPass !== false,
      },
    }
  }

  private handleMessage(data: Uint8Array): void {
    let frameSequence: number | undefined
    try {
      const frame = decodeVolcanoFrame(data)
      if (frame.type === VolcanoMessageType.Error) {
        this.fail(new Error(`Doubao ASR error ${frame.errorCode}: ${getVolcanoErrorMessage(frame)}`))
        return
      }
      if (frame.type !== VolcanoMessageType.FullServerResponse || frame.payload.length === 0) return
      frameSequence = frame.sequence

      const payload = parseVolcanoJsonPayload<DoubaoASRResponsePayload>(frame)
      const text = (payload.result?.text || '').trim()
      if (text) {
        this.lastText = text
        this.options.onPartial?.(text)
      }
      for (const utterance of payload.result?.utterances || []) {
        if (!utterance?.definite) continue
        const utteranceText = (utterance.text || '').trim()
        if (!utteranceText) continue
        this.definiteTexts.push(utteranceText)
        this.options.onUtterance?.({
          text: utteranceText,
          definite: true,
          startTime: utterance.start_time,
          endTime: utterance.end_time,
        })
      }
    } catch (error: any) {
      this.fail(new Error(`Doubao ASR response parsing failed: ${error?.message || String(error)}`))
      return
    }
    // The server negates the sequence on its last packet of the turn.
    if (frameSequence !== undefined && frameSequence < 0) {
      this.resolveFinal()
    }
  }

  private handleClose(): void {
    const wasClosed = this.closed
    this.close()
    if (!wasClosed) this.options.onClose?.()
  }

  private resolveFinal(): void {
    for (const timer of this.finalTimers) clearTimeout(timer)
    this.finalTimers = []
    if (this.finalResolvers.length === 0) return
    const resolvers = this.finalResolvers
    this.finalResolvers = []
    const finalText = this.definiteText || this.lastText
    for (const resolve of resolvers) resolve(finalText)
  }

  private fail(error: Error): void {
    this.options.onError?.(error)
    this.close()
  }
}

const DOUBAO_UPLOAD_SLICE_BYTES = 32000 // 1s of 16 kHz mono int16 per packet

export async function transcribeOnethingDoubaoUtterance(input: {
  audio: Uint8Array
  mimeType: string
  settings: OnethingDoubaoSettingsLike
  uid?: string
  createWebSocket?: OnethingDoubaoWebSocketFactory
  signal?: AbortSignal
}): Promise<string> {
  input.signal?.throwIfAborted()
  const format = doubaoFormatFromMimeType(input.mimeType)
  if (!format) {
    throw new Error(`Doubao ASR does not accept "${input.mimeType}" audio. Use wav, pcm, ogg/opus or mp3.`)
  }

  let failure: Error | null = null
  const session = new OnethingDoubaoASRSession({
    settings: input.settings,
    uid: input.uid,
    createWebSocket: input.createWebSocket,
    onError: error => {
      failure = failure || error
    },
  })
  const abort = () => session.close()
  input.signal?.addEventListener('abort', abort, { once: true })
  try {
    await session.connect(format)
    input.signal?.throwIfAborted()
    for (let offset = 0; offset < input.audio.length; offset += DOUBAO_UPLOAD_SLICE_BYTES) {
      session.pushAudio(input.audio.subarray(offset, offset + DOUBAO_UPLOAD_SLICE_BYTES))
    }
    const text = await session.finish(15000)
    input.signal?.throwIfAborted()
    if (failure) throw failure
    return text
  } finally {
    input.signal?.removeEventListener('abort', abort)
    session.close()
  }
}

function doubaoFormatFromMimeType(mimeType: string): { format: string; codec?: string } | null {
  const normalized = (mimeType || '').toLowerCase()
  if (normalized.includes('wav')) return { format: 'wav', codec: 'raw' }
  if (normalized.includes('pcm')) return { format: 'pcm', codec: 'raw' }
  if (normalized.includes('ogg')) return { format: 'ogg', codec: 'opus' }
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return { format: 'mp3', codec: 'raw' }
  return null
}
