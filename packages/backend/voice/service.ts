import { randomUUID } from 'crypto'
import {
  IPC_CHANNELS,
  type AppSettings,
  type VoiceAudioChunkPayload,
  type VoiceEvent,
  type VoiceLatencyMilestone,
  type VoiceLatencyMilestoneName,
  type VoiceRuntimeCommand,
  type VoiceRuntimeEvent,
  type VoiceRuntimeState,
  type VoiceRuntimeStatus,
  type VoiceSettings,
  type VoiceStartRequest,
  type VoiceStopRequest,
  type VoiceSubmitTranscriptRequest,
  type VoiceSubmitUtteranceRequest,
  type VoiceSynthesizeRequest,
} from '@shared/ipc.js'
import { VoiceAudioRouter } from './audio-router.js'
import { WakeWordEngine } from './kws.js'
import { getEventBus, getStreamChannel } from '../events/index.js'
import type { StreamChunk } from '@shared/events/index.js'
import type { Unsubscribe } from '../events/types.js'
import { getStreamEngineSafe } from '../engine/index.js'
import { getCurrentSessionId } from '../stores/app-state.js'
import { getSettings, saveSettings } from '../stores/settings.js'
import { agentExists } from '../wiring/agents/index.js'
import { updateSessionAgent } from '../stores/sessions.js'
import { getVoiceInputConfigurationError, streamSynthesizeSpeech, transcribeUtterance } from './providers.js'
import {
  applyOnethingVoiceRuntimeError,
  applyOnethingVoiceRuntimeMilestone,
  applyOnethingVoiceRuntimeStatus,
  applyOnethingVoiceWakeFailureFallback,
  createOnethingVoiceLatencyMilestone,
  getOnethingSpeakableTextFromDelta,
  getOnethingTTSModelName,
  isOnethingMissingCloudTTSConfiguration,
  normalizeOnethingVoiceError,
  splitOnethingSpeakableSentences,
} from '@onething/runtime/voice'
import {
  broadcastVoiceHostMessage,
  getVoiceHostPorts,
  sendVoiceHostMessageToWindow,
  type VoiceHostWebContents,
  type VoiceHostWindow,
} from './host-ports.js'

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from '@shared/events/index.js'

// Host-surface delegates: the audio runtime window and tray are Electron
// concepts injected via configureVoiceHost; headless hosts no-op them.
const ensureVoiceRuntimeWindow = (): void => getVoiceHostPorts().runtimeWindow?.ensure?.()
const destroyVoiceRuntimeWindow = (): void => getVoiceHostPorts().runtimeWindow?.destroy?.()
const sendVoiceRuntimeCommand = (command: VoiceRuntimeCommand): void =>
  getVoiceHostPorts().runtimeWindow?.sendCommand?.(command)
const markVoiceRuntimeReady = (): void => getVoiceHostPorts().runtimeWindow?.markReady?.()
const isVoiceRuntimeReady = (): boolean => getVoiceHostPorts().runtimeWindow?.isReady?.() ?? false
const flushVoiceRuntimeCommands = (): void => getVoiceHostPorts().runtimeWindow?.flushCommands?.()
const updateVoiceTray = (): void => getVoiceHostPorts().updateTray?.()
const voiceWebContentsId = (webContents: { id: number } | null | undefined): number | undefined =>
  webContents?.id

interface VoiceReplyPlaybackTurn {
  id: number
  sessionId: string
  buffer: string
  flushTimer?: ReturnType<typeof setTimeout>
  unsubscribeStream?: Unsubscribe
  unsubscribeEvents?: Unsubscribe
}

type VoiceWebContents = VoiceHostWebContents
type VoiceWindow = VoiceHostWindow

class VoiceService {
  private state: VoiceRuntimeState = {
    status: 'disabled',
    enabled: false,
    runtimeReady: false,
    updatedAt: Date.now(),
  }
  private replyPlayback: VoiceReplyPlaybackTurn | null = null
  private replyPlaybackId = 0
  private speechChain: Promise<void> = Promise.resolve()
  private audioRouter: VoiceAudioRouter | null = null
  private doubaoTranscriptId = ''
  private doubaoFirstPartialSeen = false
  private wakeEngine: WakeWordEngine | null = null
  private currentTurnReason: VoiceStartRequest['reason'] = 'manual'
  private pendingSpeechCount = 0
  private resumeChainCount = 0
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  private callActive = false

  private getAudioRouter(): VoiceAudioRouter {
    if (!this.audioRouter) {
      this.audioRouter = new VoiceAudioRouter({
        onPartialTranscript: (text, sessionId) => {
          this.state.lastTranscript = text
          if (!this.doubaoFirstPartialSeen) {
            this.doubaoFirstPartialSeen = true
            this.emitMilestone('asr-first-partial', {
              sessionId,
              transcriptId: this.doubaoTranscriptId,
              provider: 'doubao',
              model: 'bigmodel',
            })
          }
          this.emit({
            type: 'partial-transcript',
            sessionId,
            transcriptId: this.doubaoTranscriptId,
            text,
          })
        },
        onFinalTranscript: ({ text, sessionId, durationMs }) => {
          sendVoiceRuntimeCommand({ type: 'stop-recording', reason: 'asr-finalized' })
          this.emitMilestone('asr-finalized', {
            sessionId,
            transcriptId: this.doubaoTranscriptId,
            elapsedMs: durationMs,
            provider: 'doubao',
            model: 'bigmodel',
          })
          const finalText = this.currentTurnReason === 'wake'
            ? stripWakePhrasePrefix(text, getSettings().voice?.wake.phrase)
            : text
          const meaningfulChars = finalText.replace(/[\s\p{P}]+/gu, '')
          const emptyTurn = !finalText.trim()
            // Follow-up windows drop one-character fragments (echo tails,
            // breath noise) instead of turning them into chat messages.
            || (this.currentTurnReason === 'resume' && meaningfulChars.length < 2)
          if (emptyTurn) {
            const settings = getSettings().voice
            this.setStatus(settings?.enabled && settings.alwaysOn ? 'wake-listening' : 'idle')
            if (this.callActive) this.maybeStartResumeWindow()
            return
          }
          void this.submitTranscript({
            sessionId,
            transcriptId: this.doubaoTranscriptId || undefined,
            text: finalText,
            asrProvider: 'doubao',
            asrModel: 'bigmodel',
            durationMs,
          })
        },
        onRecordingError: (error, _sessionId) => {
          sendVoiceRuntimeCommand({ type: 'stop-recording', reason: 'asr-error' })
          if (this.currentTurnReason === 'resume') {
            // A silent resume window simply falls back to wake listening.
            const settings = getSettings().voice
            this.setStatus(settings?.enabled && settings.alwaysOn ? 'wake-listening' : 'idle')
            if (this.callActive) this.maybeStartResumeWindow()
            return
          }
          this.setError(error)
        },
        onWakeAudio: (pcm, sampleRate) => {
          this.wakeEngine?.pushAudio(pcm, sampleRate)
        },
      })
    }
    return this.audioRouter
  }

  private syncWakeEngine(settings: VoiceSettings | undefined): void {
    const useSherpaWake = Boolean(
      settings?.enabled
      && settings.alwaysOn
      && settings.wake.enabled
      && settings.wake.provider === 'sherpa-kws',
    )
    if (!useSherpaWake) {
      this.wakeEngine?.stop()
      return
    }
    if (!this.wakeEngine) this.wakeEngine = new WakeWordEngine()
    this.getAudioRouter()
    this.wakeEngine.start({
      phrase: settings!.wake.phrase,
      sensitivity: settings!.wake.sensitivity,
      onDetected: keyword => {
        if (this.state.status === 'recording' || this.state.status === 'transcribing') return
        this.emit({ type: 'wake-detected', phrase: keyword, sessionId: this.state.currentSessionId })
        void this.start({ reason: 'wake' })
      },
      onError: error => {
        if (this.fallbackToMicButtonForWakeError(error)) {
          this.setStatus('idle')
          return
        }
        this.setError(error)
      },
    })
  }

  applySettings(settings: AppSettings = getSettings()): void {
    const voice = settings.voice
    this.state.enabled = Boolean(voice?.enabled)
    this.syncWakeEngine(voice)

    if (!voice?.enabled) {
      this.setStatus('disabled')
      destroyVoiceRuntimeWindow()
      updateVoiceTray()
      return
    }

    ensureVoiceRuntimeWindow()
    const status: VoiceRuntimeStatus = voice.alwaysOn ? 'wake-listening' : 'idle'
    this.setStatus(status)
    sendVoiceRuntimeCommand({
      type: voice.alwaysOn ? 'start-wake' : 'configure',
      settings: voice,
      sessionId: getCurrentSessionId() || undefined,
    })
    updateVoiceTray()
  }

  attachMainWindow(window: VoiceWindow): void {
    if (this.state.enabled) {
      ensureVoiceRuntimeWindow()
    }
    this.broadcastState(window)
  }

  getState(): VoiceRuntimeState {
    return { ...this.state, callActive: this.callActive }
  }

  async start(request: VoiceStartRequest = {}): Promise<{ success: boolean; error?: string }> {
    const settings = getSettings().voice!
    if (!settings?.enabled) {
      return { success: false, error: 'Voice is disabled.' }
    }

    const sessionId = request.sessionId || getCurrentSessionId()
    if (!sessionId) {
      return { success: false, error: 'No active session for voice input.' }
    }
    const configurationError = getVoiceInputConfigurationError(settings)
    if (configurationError) {
      this.setError(configurationError)
      return { success: false, error: configurationError }
    }

    ensureVoiceRuntimeWindow()
    if (settings.bargeIn) {
      this.cancelReplyPlayback()
      sendVoiceRuntimeCommand({ type: 'stop-playback' })
      getStreamEngineSafe()?.abort(sessionId)
    }

    this.state.currentSessionId = sessionId
    this.currentTurnReason = request.reason || 'manual'
    if (this.currentTurnReason === 'call') {
      this.callActive = true
    }
    if (this.currentTurnReason === 'resume') {
      this.resumeChainCount += 1
    } else {
      this.resumeChainCount = 0
    }
    this.clearResumeTimer()
    this.setStatus('recording')
    if (settings.asr.provider === 'doubao') {
      this.doubaoTranscriptId = randomUUID()
      this.doubaoFirstPartialSeen = false
      void this.getAudioRouter().startDoubaoRecording(settings, sessionId, {
        shouldIgnoreDefinite: request.reason === 'wake'
          ? text => stripWakePhrasePrefix(text, settings.wake.phrase).length === 0
          : undefined,
      })
    }
    sendVoiceRuntimeCommand({
      type: 'start-recording',
      settings,
      sessionId,
      reason: request.reason || 'manual',
    })
    return { success: true }
  }

  handleAudioChunk(payload: VoiceAudioChunkPayload): void {
    this.getAudioRouter().handleChunk(payload)
  }

  stop(request: VoiceStopRequest = {}): { success: boolean } {
    this.clearResumeTimer()
    this.resumeChainCount = 0
    this.callActive = false
    const submit = request.submit ?? request.reason === 'mic-button'
    if (this.audioRouter?.isRecording) {
      if (submit) {
        void this.audioRouter.finishRecording()
      } else {
        this.audioRouter.abortRecording(request.reason || 'stopped')
      }
    }
    sendVoiceRuntimeCommand({
      type: 'stop',
      reason: request.reason,
      submit,
    })
    const settings = getSettings().voice
    this.setStatus(settings?.enabled && settings.alwaysOn ? 'wake-listening' : settings?.enabled ? 'idle' : 'disabled')
    return { success: true }
  }

  async submitUtterance(request: VoiceSubmitUtteranceRequest): Promise<{ success: boolean; transcript?: string; transcriptId?: string; error?: string }> {
    const settings = getSettings().voice
    if (!settings?.enabled) return { success: false, error: 'Voice is disabled.' }

    const sessionId = request.sessionId || this.state.currentSessionId || getCurrentSessionId()
    if (!sessionId) return { success: false, error: 'No active session for voice transcript.' }

    this.setStatus('transcribing')
    try {
      const transcript = await transcribeUtterance({ ...request, sessionId }, settings)
      return await this.submitRecognizedTranscript({
        sessionId,
        transcriptId: transcript.transcriptId,
        text: transcript.text,
        asrProvider: transcript.provider as any,
        asrModel: transcript.model,
        durationMs: request.durationMs,
      })
    } catch (error: any) {
      const message = normalizeOnethingVoiceError(error, 'Voice transcription failed.')
      this.setError(message)
      return { success: false, error: message }
    }
  }

  async submitTranscript(request: VoiceSubmitTranscriptRequest): Promise<{ success: boolean; transcript?: string; transcriptId?: string; error?: string }> {
    const settings = getSettings().voice
    if (!settings?.enabled) return { success: false, error: 'Voice is disabled.' }
    const sessionId = request.sessionId || this.state.currentSessionId || getCurrentSessionId()
    if (!sessionId) return { success: false, error: 'No active session for voice transcript.' }
    return this.submitRecognizedTranscript({ ...request, sessionId })
  }

  private async submitRecognizedTranscript(request: VoiceSubmitTranscriptRequest & { sessionId: string }): Promise<{ success: boolean; transcript?: string; transcriptId?: string; error?: string }> {
    const settings = getSettings().voice!
    const text = request.text.trim()
    if (!text) return { success: false, error: 'Voice transcription returned an empty transcript.' }

    this.setStatus('transcribing')
    try {
      const transcriptId = request.transcriptId || randomUUID()
      const voiceAgentId = settings.conversation?.defaultAgentId?.trim()
      if (voiceAgentId && agentExists(voiceAgentId)) {
        updateSessionAgent(request.sessionId, voiceAgentId)
      }
      this.state.lastTranscript = text
      this.emit({
        type: 'transcript',
        sessionId: request.sessionId,
        transcriptId,
        text,
        durationMs: request.durationMs,
      })

      this.beginReplyPlayback(request.sessionId)
      await getEventBus().emit(request.sessionId, {
        type: SESSION_COMMAND_TYPES.SEND_MESSAGE,
        channel: 'voice',
        source: 'voice',
        content: text,
        voice: {
          transcriptId,
          asrProvider: request.asrProvider,
          asrModel: request.asrModel,
          durationMs: request.durationMs,
        },
      })

      this.setStatus('thinking')
      this.emit({ type: 'submitted', sessionId: request.sessionId, transcriptId, text })
      return { success: true, transcript: text, transcriptId }
    } catch (error: any) {
      const message = normalizeOnethingVoiceError(error, 'Voice transcript submission failed.')
      this.setError(message)
      return { success: false, error: message }
    }
  }

  async synthesize(request: VoiceSynthesizeRequest): Promise<{ success: boolean; requestId?: string; mimeType?: string; error?: string }> {
    const settings = getSettings().voice
    if (!settings?.enabled) return { success: false, error: 'Voice is disabled.' }
    if (!settings.tts.autoSpeak && !this.callActive) return { success: false, error: 'Voice auto speak is disabled.' }

    const text = request.text.trim()
    if (!text) return { success: true, requestId: request.requestId }

    try {
      this.setStatus('speaking')
      const requestId = request.requestId || randomUUID()
      const startedAt = Date.now()
      ensureVoiceRuntimeWindow()
      this.emitMilestone('tts-request-start', {
        requestId,
        provider: settings.tts.provider,
        model: getOnethingTTSModelName(settings),
      })

      if (settings.tts.provider === 'system-tts') {
        this.speakWithSystemRuntime(text, requestId, settings)
        this.emitMilestone('tts-system-dispatched', {
          requestId,
          elapsedMs: Date.now() - startedAt,
          provider: 'system-tts',
          model: settings.tts.system.voice || 'system',
        })
        return { success: true, requestId, mimeType: 'text/plain' }
      }

      let streamStarted = false
      let streamMimeType = 'audio/mpeg'
      let firstChunkSent = false
      try {
        await streamSynthesizeSpeech(text, settings, {
          onStart: ({ mimeType }) => {
            streamStarted = true
            streamMimeType = mimeType
            this.emitMilestone('tts-audio-stream-start', {
              requestId,
              elapsedMs: Date.now() - startedAt,
              provider: settings.tts.provider,
              model: getOnethingTTSModelName(settings),
            })
            sendVoiceRuntimeCommand({
              type: 'play-audio-stream-start',
              requestId,
              mimeType,
            })
          },
          onChunk: chunk => {
            if (!streamStarted) {
              streamStarted = true
              sendVoiceRuntimeCommand({
                type: 'play-audio-stream-start',
                requestId,
                mimeType: 'audio/mpeg',
              })
            }
            if (!firstChunkSent) {
              firstChunkSent = true
              this.emitMilestone('tts-first-audio-chunk', {
                requestId,
                elapsedMs: Date.now() - startedAt,
                provider: settings.tts.provider,
                model: getOnethingTTSModelName(settings),
              })
            }
            sendVoiceRuntimeCommand({
              type: 'play-audio-stream-chunk',
              requestId,
              chunkBase64: Buffer.from(chunk).toString('base64'),
            })
          },
        })
        if (streamStarted) {
          sendVoiceRuntimeCommand({ type: 'play-audio-stream-end', requestId })
          this.emitMilestone('tts-audio-stream-end', {
            requestId,
            elapsedMs: Date.now() - startedAt,
            provider: settings.tts.provider,
            model: getOnethingTTSModelName(settings),
          })
        }
      } catch (error: any) {
        if (streamStarted) {
          sendVoiceRuntimeCommand({
            type: 'play-audio-stream-end',
            requestId,
            error: error?.message || 'Voice synthesis stream failed.',
          })
        }
        if (isOnethingMissingCloudTTSConfiguration(error)) {
          this.speakWithSystemRuntime(text, requestId, settings)
          return { success: true, requestId, mimeType: 'text/plain' }
        }
        throw error
      }
      return { success: true, requestId, mimeType: streamMimeType }
    } catch (error: any) {
      const message = normalizeOnethingVoiceError(error, 'Voice synthesis failed.')
      this.setError(message)
      return { success: false, error: message }
    }
  }

  private speakWithSystemRuntime(text: string, requestId: string, settings: VoiceSettings): void {
    sendVoiceRuntimeCommand({
      type: 'speak-text',
      requestId,
      text,
      voice: settings.tts.system.voice,
      language: settings.tts.system.language,
      rate: settings.tts.system.rate,
      pitch: settings.tts.system.pitch,
    })
  }

  handleRuntimeReady(sender: VoiceWebContents): void {
    markVoiceRuntimeReady()
    this.state.runtimeReady = true
    this.emit({ type: 'runtime-ready' }, sender)
    this.applySettings()
    flushVoiceRuntimeCommands()
  }

  handleRuntimeEvent(event: VoiceRuntimeEvent | VoiceEvent): void {
    switch (event.type) {
      case 'wake-detected':
        this.emit(event)
        void this.start({ sessionId: event.sessionId, reason: 'wake' })
        break
      case 'recording-started':
        this.setStatus('recording')
        this.emit(event)
        break
      case 'recording-stopped': {
        // Doubao finalizes in the main process before the runtime window
        // reports the mic stop; don't downgrade transcribing/thinking.
        if (this.state.status === 'recording') {
          const settings = getSettings().voice
          this.setStatus(settings?.enabled && settings.alwaysOn ? 'wake-listening' : 'idle')
          // A silent turn ended without a transcript; on a call the loop
          // keeps listening until the user hangs up.
          if (this.callActive) this.maybeStartResumeWindow()
        }
        this.emit(event)
        break
      }
      case 'partial-transcript':
        this.state.lastTranscript = event.text
        this.emit(event)
        break
      case 'latency-milestone':
        this.state = applyOnethingVoiceRuntimeMilestone(this.state, event.milestone)
        this.emit(event)
        break
      case 'playback-start':
        this.setStatus('speaking')
        this.emit(event)
        break
      case 'playback-end': {
        const settings = getSettings().voice
        this.setStatus(settings?.enabled && settings.alwaysOn ? 'wake-listening' : 'idle')
        this.emit(event)
        break
      }
      case 'playback-idle':
        this.emit(event)
        this.maybeStartResumeWindow()
        break
      case 'error':
        if (this.fallbackToMicButtonForWakeError(event.error)) {
          this.setStatus('idle')
          break
        }
        this.setError(event.error)
        break
      default:
        this.emit(event as VoiceEvent)
    }
  }

  shutdown(): void {
    this.cancelReplyPlayback()
    this.clearResumeTimer()
    this.audioRouter?.shutdown()
    this.wakeEngine?.stop()
    sendVoiceRuntimeCommand({ type: 'stop', reason: 'shutdown' })
    destroyVoiceRuntimeWindow()
    this.state.runtimeReady = false
    this.setStatus('disabled')
  }

  private setStatus(status: VoiceRuntimeStatus): void {
    this.state = applyOnethingVoiceRuntimeStatus(this.state, {
      status,
      voiceEnabled: Boolean(getSettings().voice?.enabled),
      runtimeReady: isVoiceRuntimeReady(),
    })
    this.emit({ type: 'state', state: this.getState() })
  }

  private setError(error: string): void {
    this.state = applyOnethingVoiceRuntimeError(this.state, {
      error,
      voiceEnabled: Boolean(getSettings().voice?.enabled),
      runtimeReady: isVoiceRuntimeReady(),
    })
    this.emit({ type: 'state', state: this.getState() })
    this.emit({ type: 'error', error, recoverable: true })
  }

  private emitMilestone(
    name: VoiceLatencyMilestoneName,
    milestone: Omit<VoiceLatencyMilestone, 'name' | 'at'> = {},
  ): void {
    const nextMilestone: VoiceLatencyMilestone = createOnethingVoiceLatencyMilestone(name, milestone)
    this.state = applyOnethingVoiceRuntimeMilestone(this.state, nextMilestone)
    this.emit({ type: 'latency-milestone', milestone: nextMilestone })
  }

  private beginReplyPlayback(sessionId: string): void {
    this.cancelReplyPlayback()
    const settings = getSettings().voice
    // On a call the reply is always spoken; the autoSpeak toggle only
    // affects mic-button / wake-word input turns.
    if (!settings?.enabled || (!settings.tts.autoSpeak && !this.callActive)) return

    const turn: VoiceReplyPlaybackTurn = {
      id: ++this.replyPlaybackId,
      sessionId,
      buffer: '',
    }

    turn.unsubscribeStream = getStreamChannel().subscribe(sessionId, chunk => {
      this.handleReplyStreamChunk(turn, chunk)
    })
    turn.unsubscribeEvents = getEventBus().onAny(sessionId, envelope => {
      if (envelope.event.type === SESSION_EVENT_TYPES.STREAM_COMPLETE
        || envelope.event.type === SESSION_EVENT_TYPES.STREAM_ERROR
        || envelope.event.type === SESSION_EVENT_TYPES.STREAM_ABORTED) {
        this.finishReplyPlayback(turn.id, true)
      }
    }, 'VoiceService:TTS')
    this.replyPlayback = turn
  }

  private handleReplyStreamChunk(turn: VoiceReplyPlaybackTurn, chunk: StreamChunk): void {
    if (this.replyPlayback?.id !== turn.id) return
    if (chunk.type !== 'text-delta') return
    if (!getSettings().voice?.tts.autoSpeak && !this.callActive) return

    const speakText = getOnethingSpeakableTextFromDelta(chunk)
    if (!speakText) return

    turn.buffer += speakText
    this.flushReplySpeech(turn, false)
    this.scheduleReplySpeechFlush(turn)
  }

  private flushReplySpeech(turn: VoiceReplyPlaybackTurn, force: boolean): void {
    if (this.replyPlayback?.id !== turn.id || !turn.buffer) return

    const result = splitOnethingSpeakableSentences(turn.buffer, {
      force,
      lowLatency: !force,
      minSoftChars: 12,
      maxChars: 72,
    })
    turn.buffer = result.remainder

    for (const sentence of result.ready) {
      const text = sentence.trim()
      if (!text) continue
      const turnId = turn.id
      this.pendingSpeechCount += 1
      this.speechChain = this.speechChain
        .then(async () => {
          if (this.replyPlaybackId !== turnId && this.replyPlayback?.id !== turnId) return
          const response = await this.synthesize({ text })
          if (!response.success && response.error) this.setError(response.error)
        })
        .catch((error: any) => {
          this.setError(error?.message || 'Voice synthesis failed.')
        })
        .finally(() => {
          this.pendingSpeechCount = Math.max(0, this.pendingSpeechCount - 1)
        })
    }
  }

  private scheduleReplySpeechFlush(turn: VoiceReplyPlaybackTurn): void {
    this.clearReplyFlushTimer(turn)
    if (!turn.buffer.trim()) return

    turn.flushTimer = setTimeout(() => {
      if (this.replyPlayback?.id !== turn.id) return
      if (turn.buffer.trim().length < 8) return
      this.flushReplySpeech(turn, true)
    }, 650)
  }

  private finishReplyPlayback(turnId: number, force: boolean): void {
    const turn = this.replyPlayback
    if (!turn || turn.id !== turnId) return
    this.clearReplyFlushTimer(turn)
    this.flushReplySpeech(turn, force)
    turn.unsubscribeStream?.()
    turn.unsubscribeEvents?.()
    this.replyPlayback = null
  }

  private cancelReplyPlayback(): void {
    this.replyPlaybackId++
    const turn = this.replyPlayback
    if (!turn) return
    this.clearReplyFlushTimer(turn)
    turn.unsubscribeStream?.()
    turn.unsubscribeEvents?.()
    this.replyPlayback = null
  }

  private clearReplyFlushTimer(turn: VoiceReplyPlaybackTurn): void {
    if (!turn.flushTimer) return
    clearTimeout(turn.flushTimer)
    turn.flushTimer = undefined
  }

  // After the reply has fully played, keep the mic open for one follow-up
  // window so multi-turn conversations don't need the wake phrase again.
  // On an active call this is the core loop: it always re-opens.
  private maybeStartResumeWindow(): void {
    const settings = getSettings().voice
    if (!settings?.enabled) return
    if (!this.callActive) {
      if (!settings.alwaysOn || !settings.wake.enabled) return
      if (settings.wake.provider !== 'sherpa-kws') return
      // Runaway-loop bound: after several back-to-back follow-up turns the
      // wake phrase is required again.
      if (this.resumeChainCount >= 5) return
    }
    if (this.replyPlayback || this.pendingSpeechCount > 0) return
    if (this.state.status === 'recording' || this.state.status === 'transcribing' || this.state.status === 'thinking') return

    // Let the speaker tail / room reverb of the reply die down before the
    // mic re-opens, or the ASR transcribes our own TTS into a new turn.
    this.clearResumeTimer()
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      const current = getSettings().voice
      if (!current?.enabled) return
      if (!this.callActive && (!current.alwaysOn || !current.wake.enabled)) return
      if (this.replyPlayback || this.pendingSpeechCount > 0) return
      if (this.state.status !== 'wake-listening' && this.state.status !== 'idle') return
      void this.start({ sessionId: this.state.currentSessionId, reason: 'resume' })
    }, 900)
  }

  private clearResumeTimer(): void {
    if (!this.resumeTimer) return
    clearTimeout(this.resumeTimer)
    this.resumeTimer = null
  }

  private fallbackToMicButtonForWakeError(error: string): boolean {
    const settings = getSettings()
    const fallback = applyOnethingVoiceWakeFailureFallback(settings, error)
    if (!fallback.applied) return false
    const nextSettings = fallback.settings

    saveSettings(nextSettings)
    sendVoiceRuntimeCommand({ type: 'stop', reason: 'wake-unavailable' })
    broadcastVoiceHostMessage({
      channel: IPC_CHANNELS.SETTINGS_CHANGED,
      payload: nextSettings,
    })
    updateVoiceTray()
    return true
  }

  private emit(event: VoiceEvent, exceptSender?: VoiceWebContents): void {
    const exceptWebContentsId = voiceWebContentsId(exceptSender)
    if (event.type !== 'state') {
      broadcastVoiceHostMessage({
        channel: IPC_CHANNELS.VOICE_EVENT,
        payload: event,
        exceptWebContentsId,
      })
    }

    const stateEvent: VoiceEvent = { type: 'state', state: this.getState() }
    broadcastVoiceHostMessage({
      channel: IPC_CHANNELS.VOICE_EVENT,
      payload: event.type === 'state' ? event : stateEvent,
      exceptWebContentsId,
    })
  }

  private broadcastState(target?: VoiceWindow): void {
    const event: VoiceEvent = { type: 'state', state: this.getState() }
    if (sendVoiceHostMessageToWindow(target, IPC_CHANNELS.VOICE_EVENT, event)) {
      return
    }
    broadcastVoiceHostMessage({
      channel: IPC_CHANNELS.VOICE_EVENT,
      payload: event,
    })
  }
}

function stripWakePhrasePrefix(text: string, phrase?: string): string {
  const trimmed = text.trim()
  const normalizedPhrase = (phrase || '').trim()
  if (!normalizedPhrase || !trimmed.startsWith(normalizedPhrase)) return trimmed
  return trimmed.slice(normalizedPhrase.length).replace(/^[\s,,。.!!??、::;;]+/, '')
}

let service: VoiceService | null = null

export function getVoiceService(): VoiceService {
  if (!service) service = new VoiceService()
  return service
}

export function getVoiceServiceSafe(): VoiceService | null {
  return service
}

export type { VoiceService }
