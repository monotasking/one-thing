import {
  OnethingDoubaoASRSession,
} from '@onething/runtime/voice/volcano/asr-session'
import type { VoiceAudioChunkPayload, VoiceSettings } from '@shared/ipc.js'

export interface VoiceAudioRouterHooks {
  onPartialTranscript(text: string, sessionId?: string): void
  onFinalTranscript(result: { text: string; sessionId?: string; durationMs: number }): void
  onRecordingError(error: string, sessionId?: string): void
  onWakeAudio?(pcm: Int16Array, sampleRate: number): void
}

export interface VoiceDoubaoRecordingOptions {
  /**
   * Returning true keeps the session listening instead of closing the turn —
   * used for wake turns where the first utterance is just the wake phrase
   * ("你好小一" … pause … actual question).
   */
  shouldIgnoreDefinite?: (definiteText: string) => boolean
}

interface ActiveDoubaoRecording {
  session: OnethingDoubaoASRSession
  sessionId?: string
  startedAt: number
  connected: boolean
  finalized: boolean
  pendingChunks: Uint8Array[]
  safetyTimer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
}

const PRE_ROLL_MAX_BYTES = 2 * 16000 * 2 // 2s of 16 kHz mono int16
const RECORDING_SAFETY_EXTRA_MS = 8000
// How long to keep listening after a wake-phrase-only utterance before
// giving up on the turn.
const WAKE_FOLLOW_UP_WINDOW_MS = 8000

/**
 * Main-process fan-out for the runtime window's PCM uplink: keeps a short
 * pre-roll ring buffer while wake-listening (so a wake phrase spoken in the
 * same breath as the question is not lost) and feeds the active
 * main-process ASR session while recording.
 */
export class VoiceAudioRouter {
  private readonly hooks: VoiceAudioRouterHooks
  private preRoll: Uint8Array[] = []
  private preRollBytes = 0
  private recording: ActiveDoubaoRecording | null = null

  constructor(hooks: VoiceAudioRouterHooks) {
    this.hooks = hooks
  }

  get isRecording(): boolean {
    return Boolean(this.recording && !this.recording.finalized)
  }

  handleChunk(payload: VoiceAudioChunkPayload): void {
    const bytes = payload.chunkBase64 ? Buffer.from(payload.chunkBase64, 'base64') : null

    if (payload.phase === 'wake') {
      if (bytes && bytes.length > 0) {
        this.appendPreRoll(bytes)
        if (this.hooks.onWakeAudio) {
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2))
          this.hooks.onWakeAudio(pcm.slice(), payload.sampleRate || 16000)
        }
      }
      return
    }

    const recording = this.recording
    if (!recording || recording.finalized) return

    if (bytes && bytes.length > 0) {
      if (recording.connected) {
        recording.session.pushAudio(bytes)
      } else {
        recording.pendingChunks.push(bytes)
      }
    }

    if (payload.last) {
      if (payload.abort) {
        this.abortRecording('runtime-aborted')
      } else {
        void this.finishRecording()
      }
    }
  }

  async startDoubaoRecording(
    settings: VoiceSettings,
    sessionId?: string,
    options: VoiceDoubaoRecordingOptions = {},
  ): Promise<void> {
    this.abortRecording('superseded')

    const recording: ActiveDoubaoRecording = {
      sessionId,
      startedAt: Date.now(),
      connected: false,
      finalized: false,
      pendingChunks: [],
      session: null as unknown as OnethingDoubaoASRSession,
    }

    recording.session = new OnethingDoubaoASRSession({
      settings: settings.doubao,
      onPartial: text => {
        if (this.recording !== recording || recording.finalized) return
        this.hooks.onPartialTranscript(text, sessionId)
      },
      onUtterance: () => {
        // The first server-side end-of-utterance (definite after
        // end_window_size silence) closes the turn.
        if (this.recording !== recording || recording.finalized) return
        if (options.shouldIgnoreDefinite?.(recording.session.definiteText)) {
          // Wake phrase alone: stay on this session and wait for the
          // actual question instead of closing the turn.
          if (recording.idleTimer) clearTimeout(recording.idleTimer)
          recording.idleTimer = setTimeout(() => {
            if (this.recording === recording && !recording.finalized) {
              void this.finishRecording()
            }
          }, WAKE_FOLLOW_UP_WINDOW_MS)
          return
        }
        this.finalizeRecording(recording, recording.session.definiteText)
      },
      onError: error => {
        if (this.recording !== recording || recording.finalized) return
        recording.finalized = true
        this.clearRecording(recording)
        this.hooks.onRecordingError(error.message, sessionId)
      },
      onClose: () => {
        if (this.recording !== recording || recording.finalized) return
        const text = recording.session.definiteText || recording.session.latestText
        if (text) {
          this.finalizeRecording(recording, text)
        } else {
          recording.finalized = true
          this.clearRecording(recording)
          this.hooks.onRecordingError('Doubao ASR connection closed before any transcript.', sessionId)
        }
      },
    })

    this.recording = recording
    recording.safetyTimer = setTimeout(() => {
      if (this.recording === recording && !recording.finalized) {
        void this.finishRecording()
      }
    }, settings.vad.maxRecordingMs + RECORDING_SAFETY_EXTRA_MS)

    try {
      await recording.session.connect()
    } catch (error: any) {
      if (this.recording === recording) {
        recording.finalized = true
        this.clearRecording(recording)
        this.hooks.onRecordingError(error?.message || 'Doubao ASR connection failed.', sessionId)
      }
      return
    }
    if (this.recording !== recording || recording.finalized) {
      recording.session.close()
      return
    }

    recording.connected = true
    const preRoll = this.drainPreRoll()
    if (preRoll.length > 0) recording.session.pushAudio(preRoll)
    for (const chunk of recording.pendingChunks) {
      recording.session.pushAudio(chunk)
    }
    recording.pendingChunks = []
  }

  async finishRecording(): Promise<void> {
    const recording = this.recording
    if (!recording || recording.finalized) return
    const text = await recording.session.finish()
    if (this.recording !== recording || recording.finalized) return
    this.finalizeRecording(recording, text)
  }

  abortRecording(_reason: string): void {
    const recording = this.recording
    if (!recording) return
    recording.finalized = true
    this.clearRecording(recording)
  }

  clearPreRoll(): void {
    this.preRoll = []
    this.preRollBytes = 0
  }

  shutdown(): void {
    this.abortRecording('shutdown')
    this.clearPreRoll()
  }

  private finalizeRecording(recording: ActiveDoubaoRecording, text: string): void {
    recording.finalized = true
    const durationMs = Date.now() - recording.startedAt
    this.clearRecording(recording)
    const finalText = (text || '').trim()
    if (finalText) {
      this.hooks.onFinalTranscript({ text: finalText, sessionId: recording.sessionId, durationMs })
    } else {
      this.hooks.onRecordingError('No speech was detected. Try the mic button again.', recording.sessionId)
    }
  }

  private clearRecording(recording: ActiveDoubaoRecording): void {
    if (recording.safetyTimer) {
      clearTimeout(recording.safetyTimer)
      recording.safetyTimer = undefined
    }
    if (recording.idleTimer) {
      clearTimeout(recording.idleTimer)
      recording.idleTimer = undefined
    }
    recording.session?.close()
    if (this.recording === recording) this.recording = null
  }

  private appendPreRoll(bytes: Uint8Array): void {
    this.preRoll.push(bytes)
    this.preRollBytes += bytes.length
    while (this.preRollBytes > PRE_ROLL_MAX_BYTES && this.preRoll.length > 1) {
      const evicted = this.preRoll.shift()!
      this.preRollBytes -= evicted.length
    }
  }

  private drainPreRoll(): Uint8Array {
    if (this.preRollBytes === 0) return new Uint8Array(0)
    const merged = new Uint8Array(this.preRollBytes)
    let offset = 0
    for (const chunk of this.preRoll) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    this.clearPreRoll()
    return merged
  }
}
