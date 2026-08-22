<template>
  <div class="voice-runtime" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import type { VoiceRuntimeCommand, VoiceSettings } from '@/types'
import { playSystemSpeech } from './system-speech'
import { configureSileroOrt, VAD_ASSET_BASE_PATH } from './vad-assets'
import {
  FUNASR_CHUNK_SAMPLES,
  FUNASR_SAMPLE_RATE,
  calculateRms,
  createFunASREndMessage,
  drainPcmChunks,
  downsampleFloat32,
  float32ToInt16,
  int16ToExactArrayBuffer,
  openFunASRSocketConnection,
  parseFunASRMessage,
} from './funasr-streaming'
import { platformApi } from '@/platform'
import { voiceApi } from '@/platform/voice-client'
import { getLogger } from '@/services/log'

const log = getLogger('renderer.voice')

type SpeechRecognitionCtor = new () => SpeechRecognition
type PorcupineBuiltinKeyword = typeof import('@picovoice/porcupine-web')['BuiltInKeyword']

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
}

let unsubscribeCommand: (() => void) | null = null
let recognition: SpeechRecognition | null = null
let wakeRunId = 0
let webSpeechFatalError = false
let suppressWebSpeechRestart = false
let porcupineWorker: any = null
let mediaRecorder: MediaRecorder | null = null
let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let analyser: AnalyserNode | null = null
let monitorTimer: number | null = null
let sileroVad: any = null
let sileroTimer: number | null = null
let sileroStartedAt = 0
let sileroFinished = false
type PlaybackItem =
  | { type: 'audio'; requestId?: string; audioBase64: string; mimeType: string }
  | {
    type: 'audio-stream'
    requestId: string
    mimeType: string
    chunks: Uint8Array[]
    ended: boolean
    sourceBuffer?: SourceBuffer
    mediaSource?: MediaSource
    objectUrl?: string
  }
  | { type: 'speech'; requestId?: string; text: string; voice?: string; language?: string; rate?: number; pitch?: number }

let playbackQueue: PlaybackItem[] = []
let isPlaying = false
let currentAudio: HTMLAudioElement | null = null
let currentUtterance: SpeechSynthesisUtterance | null = null
let currentStreamItem: Extract<PlaybackItem, { type: 'audio-stream' }> | null = null
const streamPlaybackItems = new Map<string, Extract<PlaybackItem, { type: 'audio-stream' }>>()
let latestSettings: VoiceSettings | null = null
let latestSessionId: string | undefined
let streamingAsrSocket: WebSocket | null = null
let streamingAsrTransport: 'funasr' | 'doubao' | null = null
let streamingAsrReason: string | undefined
let streamingAsrProcessor: ScriptProcessorNode | null = null
let wakeStream: MediaStream | null = null
let wakeAudioContext: AudioContext | null = null
let wakeSource: MediaStreamAudioSourceNode | null = null
let wakeProcessor: ScriptProcessorNode | null = null
let wakePendingPcm: Int16Array<ArrayBufferLike> = new Int16Array(0)
let streamingAsrSource: MediaStreamAudioSourceNode | null = null
let streamingAsrPendingPcm: Int16Array<ArrayBufferLike> = new Int16Array(0)
let streamingAsrStartedAt = 0
let streamingAsrFinalizing = false
let streamingAsrSubmitted = false
let streamingAsrTranscriptId = ''
let streamingAsrLatestText = ''
let streamingAsrFinalText = ''
let streamingAsrVoiceStarted = false
let streamingAsrSilenceStartedAt = 0
let streamingAsrSpeechFrames = 0
let streamingAsrNoiseFloor = 0
let streamingAsrFirstAudioSent = false
let streamingAsrFirstPartialReceived = false
let streamingAsrTimeout: number | null = null
let streamingAsrNoSpeechTimer: number | null = null

// 200ms per uplink packet at 16 kHz, the packet size Doubao recommends.
const DOUBAO_CHUNK_SAMPLES = 3200

const ENERGY_SAMPLE_INTERVAL_MS = 80
const ENERGY_MIN_SPEECH_FRAMES = 2
const ENERGY_MIN_RECORDING_MS = 450
const ENERGY_NO_SPEECH_TIMEOUT_MS = 6500
const ENERGY_MIN_SPEECH_THRESHOLD = 0.008
const ENERGY_MIN_SILENCE_THRESHOLD = 0.006

onMounted(() => {
  unsubscribeCommand = platformApi.onVoiceRuntimeCommand(handleCommand)
  void voiceApi.runtimeReady()
})

onUnmounted(() => {
  unsubscribeCommand?.()
  stopWake()
  stopRecording(false)
  stopPlayback()
})

function handleCommand(command: VoiceRuntimeCommand) {
  switch (command.type) {
    case 'configure':
      latestSettings = command.settings
      latestSessionId = command.sessionId
      break
    case 'start-wake':
      latestSettings = command.settings
      latestSessionId = command.sessionId
      startWake(command.settings, command.sessionId)
      break
    case 'start-recording':
      latestSettings = command.settings
      latestSessionId = command.sessionId
      stopWake()
      void startRecording(command.settings, command.sessionId, command.reason).catch(error => {
        void voiceApi.runtimeEvent({
          type: 'error',
          error: error?.message || 'Microphone recording failed.',
          recoverable: true,
        })
        if (latestSettings?.enabled && latestSettings.alwaysOn) {
          startWake(latestSettings, latestSessionId)
        }
      })
      break
    case 'stop':
      stopWake()
      stopRecording(Boolean(command.submit))
      stopPlayback()
      break
    case 'stop-recording':
      stopRecording(false)
      break
    case 'stop-playback':
      stopPlayback()
      break
    case 'play-audio':
      playbackQueue.push({ ...command, type: 'audio' })
      void playNext()
      break
    case 'play-audio-stream-start': {
      const item: Extract<PlaybackItem, { type: 'audio-stream' }> = {
        type: 'audio-stream',
        requestId: command.requestId,
        mimeType: command.mimeType,
        chunks: [],
        ended: false,
      }
      streamPlaybackItems.set(command.requestId, item)
      playbackQueue.push(item)
      void playNext()
      break
    }
    case 'play-audio-stream-chunk':
      appendAudioStreamChunk(command.requestId, base64ToUint8Array(command.chunkBase64))
      break
    case 'play-audio-stream-end':
      finishAudioStream(command.requestId, command.error)
      break
    case 'speak-text':
      playbackQueue.push({ ...command, type: 'speech' })
      void playNext()
      break
  }
}

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  const win = window as any
  return win.SpeechRecognition || win.webkitSpeechRecognition || null
}

function startWake(settings: VoiceSettings, sessionId?: string) {
  stopWake()
  if (!settings.wake.enabled) return
  const runId = ++wakeRunId

  if (settings.wake.provider === 'sherpa-kws') {
    void startSherpaWakeStreaming(sessionId, runId)
    return
  }

  if (settings.wake.provider === 'porcupine-web') {
    void startPorcupineWake(settings, sessionId, runId)
    return
  }

  void voiceApi.runtimeEvent({
    type: 'error',
    error: 'Browser speech wake is not supported in the desktop app. Switched back to the mic button.',
    recoverable: true,
  })
}

// sherpa-kws wake detection runs in the main process; this window only
// streams wake-phase 16 kHz PCM over the audio-chunk uplink.
async function startSherpaWakeStreaming(sessionId: string | undefined, runId: number) {
  try {
    wakeStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: true,
      },
    })
    if (wakeRunId !== runId) {
      stopSherpaWakeStreaming()
      return
    }
    wakeAudioContext = new AudioContext()
    wakeSource = wakeAudioContext.createMediaStreamSource(wakeStream)
    wakeProcessor = wakeAudioContext.createScriptProcessor(4096, 1, 1)
    wakePendingPcm = new Int16Array(0)
    wakeProcessor.onaudioprocess = event => {
      const input = event.inputBuffer.getChannelData(0)
      const downsampled = downsampleFloat32(input, wakeAudioContext?.sampleRate || FUNASR_SAMPLE_RATE, FUNASR_SAMPLE_RATE)
      const result = drainPcmChunks(wakePendingPcm, float32ToInt16(downsampled), DOUBAO_CHUNK_SAMPLES)
      wakePendingPcm = result.pending
      for (const buffer of result.ready) {
        voiceApi.audioChunk({
          sessionId,
          chunkBase64: arrayBufferToBase64(buffer),
          sampleRate: FUNASR_SAMPLE_RATE,
          phase: 'wake',
        })
      }
    }
    wakeSource.connect(wakeProcessor)
    wakeProcessor.connect(wakeAudioContext.destination)
  } catch (error: any) {
    stopSherpaWakeStreaming()
    await voiceApi.runtimeEvent({
      type: 'error',
      error: `Wake listening could not access the microphone: ${error?.message || String(error)}. Use the mic button to talk.`,
      recoverable: true,
    })
  }
}

function stopSherpaWakeStreaming() {
  if (wakeProcessor) {
    wakeProcessor.onaudioprocess = null
    wakeProcessor.disconnect()
    wakeProcessor = null
  }
  wakeSource?.disconnect()
  wakeSource = null
  wakeStream?.getTracks().forEach(track => track.stop())
  wakeStream = null
  void wakeAudioContext?.close()
  wakeAudioContext = null
  wakePendingPcm = new Int16Array(0)
}

async function startPorcupineWake(settings: VoiceSettings, sessionId: string | undefined, runId: number) {
  if (!settings.wake.accessKey || !settings.wake.modelPath) {
    await voiceApi.runtimeEvent({
      type: 'error',
      error: 'Wake phrase needs the local wake engine setup first. Switched back to the mic button.',
      recoverable: true,
    })
    return false
  }

  const keywordPath = (settings.wake.keywordPath || '').trim()
  try {
    const [{ PorcupineWorker, BuiltInKeyword }, { WebVoiceProcessor }] = await Promise.all([
      import('@picovoice/porcupine-web'),
      import('@picovoice/web-voice-processor'),
    ])
    if (wakeRunId !== runId) return true

    const builtin = resolveBuiltinKeyword(BuiltInKeyword, settings.wake.phrase)
    const keyword = keywordPath
      ? {
        publicPath: keywordPath,
        label: settings.wake.phrase || 'onething',
        sensitivity: 0.6,
      }
      : builtin
        ? { builtin, sensitivity: 0.6 }
        : null

    if (!keyword) {
      await voiceApi.runtimeEvent({
        type: 'error',
        error: `The local wake engine does not know "${settings.wake.phrase}". Add a .ppn keyword file or use a built-in phrase.`,
        recoverable: true,
      })
      return false
    }

    const model = {
      publicPath: settings.wake.modelPath,
      customWritePath: 'onething_porcupine_params.pv',
      version: 1,
    }

    porcupineWorker = await PorcupineWorker.create(
      settings.wake.accessKey,
      keyword as any,
      detection => {
        void voiceApi.runtimeEvent({
          type: 'wake-detected',
          phrase: detection.label || settings.wake.phrase,
          sessionId,
        })
        stopWake()
      },
      model,
      {
        processErrorCallback: error => {
          void voiceApi.runtimeEvent({
            type: 'error',
            error: error?.message || 'Porcupine wake listener failed.',
            recoverable: true,
          })
        },
      },
    )
    if (wakeRunId !== runId) {
      await releasePorcupineWorker(porcupineWorker, WebVoiceProcessor)
      return true
    }

    WebVoiceProcessor.setOptions({
      frameLength: porcupineWorker.frameLength,
      outputSampleRate: porcupineWorker.sampleRate,
    })
    await WebVoiceProcessor.subscribe(porcupineWorker)
    return true
  } catch (error: any) {
    await voiceApi.runtimeEvent({
      type: 'error',
      error: `Local wake engine failed: ${error?.message || String(error)}. Switched back to the mic button.`,
      recoverable: true,
    })
    porcupineWorker = null
    return false
  }
}

function resolveBuiltinKeyword(BuiltInKeyword: PorcupineBuiltinKeyword, phrase: string) {
  const normalized = phrase.trim().toLowerCase().replace(/[\s_-]+/g, ' ')
  const entries: Array<[string, string]> = Object.values(BuiltInKeyword).map(keyword => [
    String(keyword).toLowerCase().replace(/[\s_-]+/g, ' '),
    String(keyword),
  ])
  return entries.find(([label]) => label === normalized)?.[1] ?? null
}

function startWebSpeechWake(settings: VoiceSettings, sessionId?: string) {
  const Recognition = getSpeechRecognition()
  if (!Recognition) {
    void voiceApi.runtimeEvent({
      type: 'error',
      error: 'Wake word is unavailable in this Electron runtime. Use the mic button to talk.',
      recoverable: true,
    })
    return
  }

  webSpeechFatalError = false
  recognition = new Recognition()
  recognition.continuous = true
  recognition.interimResults = false
  recognition.lang = getRecognitionLanguage(settings)
  recognition.onresult = (event: any) => {
    const phrase = settings.wake.phrase.toLowerCase()
    for (const result of Array.from(event.results || [])) {
      const transcript = String((result as any)[0]?.transcript || '').trim().toLowerCase()
      if (transcript.includes(phrase)) {
        void voiceApi.runtimeEvent({ type: 'wake-detected', phrase, sessionId })
        stopWake()
        break
      }
    }
  }
  recognition.onerror = (event: any) => {
    const error = String(event?.error || '')
    if (isFatalWebSpeechError(error)) {
      webSpeechFatalError = true
    }
    void voiceApi.runtimeEvent({
      type: 'error',
      error: formatWebSpeechError(error),
      recoverable: true,
    })
  }
  recognition.onend = () => {
    if (suppressWebSpeechRestart) {
      suppressWebSpeechRestart = false
      return
    }
    if (webSpeechFatalError) return
    if (latestSettings?.enabled && latestSettings.alwaysOn && !mediaRecorder && !sileroVad) {
      window.setTimeout(() => {
        if (latestSettings) startWake(latestSettings, latestSessionId)
      }, 500)
    }
  }
  recognition.start()
}

function getRecognitionLanguage(settings: VoiceSettings) {
  if (settings.asr.provider === 'openrouter-transcribe') {
    return settings.asr.openrouter.language || 'en-US'
  }
  return settings.asr.openai.language || 'en-US'
}

function isFatalWebSpeechError(error: string) {
  return ['network', 'not-allowed', 'service-not-allowed', 'audio-capture'].includes(error)
}

function formatWebSpeechError(error: string) {
  if (error === 'network') {
    return 'Browser speech wake is not supported in the desktop app. Switched back to the mic button.'
  }
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Wake phrase microphone permission was denied. Enable microphone access or use the mic button.'
  }
  if (error === 'audio-capture') {
    return 'Wake phrase listener could not access a microphone. Check the input device or use the mic button.'
  }
  return error ? `Wake phrase listener error: ${error}` : 'Wake phrase listener failed.'
}

function stopWake() {
  wakeRunId++
  stopSherpaWakeStreaming()
  if (recognition) {
    suppressWebSpeechRestart = true
  }
  recognition?.stop()
  recognition = null
  webSpeechFatalError = false
  if (porcupineWorker) {
    const worker = porcupineWorker
    porcupineWorker = null
    void import('@picovoice/web-voice-processor')
      .then(({ WebVoiceProcessor }) => releasePorcupineWorker(worker, WebVoiceProcessor))
      .catch(() => worker?.terminate?.())
  }
}

async function releasePorcupineWorker(worker: any, WebVoiceProcessor: any) {
  try {
    await WebVoiceProcessor.unsubscribe(worker)
  } catch {
    // The processor may already have been reset by a previous stop.
  }
  try {
    await worker?.release?.()
  } catch {
    worker?.terminate?.()
  }
}

// Audible cue that the wake phrase was heard — the only feedback available
// when the main window is hidden or in the background.
function playWakeEarcon() {
  try {
    const context = new AudioContext()
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.28)
    gain.connect(context.destination)
    const oscillator = context.createOscillator()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, context.currentTime)
    oscillator.frequency.setValueAtTime(1320, context.currentTime + 0.12)
    oscillator.connect(gain)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.3)
    oscillator.onended = () => {
      void context.close()
    }
  } catch {
    // A missing output device shouldn't break the recording flow.
  }
}

async function startRecording(settings: VoiceSettings, sessionId?: string, reason?: string) {
  stopRecording(false)
  if (reason === 'wake' || reason === 'call') playWakeEarcon()
  if (settings.asr.provider === 'funasr-stream') {
    await startFunASRStreamingRecording(settings, sessionId, reason)
    return
  }
  if (settings.asr.provider === 'doubao') {
    await startDoubaoStreamingRecording(settings, sessionId, reason)
    return
  }
  if (settings.vad.provider === 'silero-web') {
    try {
      await startSileroRecording(settings, sessionId, reason)
      return
    } catch (error: any) {
      log.warn('silero vad failed, falling back to energy vad', {}, error)
      await stopSileroRecording(false)
    }
  }
  await startEnergyRecording(settings, sessionId, reason)
}

async function startSileroRecording(settings: VoiceSettings, sessionId?: string, reason?: string) {
  sileroStartedAt = Date.now()
  sileroFinished = false

  const { MicVAD } = await import('@ricky0123/vad-web')
  sileroVad = await MicVAD.new({
    model: 'v5',
    startOnLoad: false,
    processorType: 'ScriptProcessor',
    baseAssetPath: VAD_ASSET_BASE_PATH,
    onnxWASMBasePath: VAD_ASSET_BASE_PATH,
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.3,
    redemptionMs: settings.vad.silenceMs,
    preSpeechPadMs: 250,
    minSpeechMs: 180,
    submitUserSpeechOnPause: true,
    getStream: async () => {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      })
      return mediaStream
    },
    pauseStream: async stream => {
      stream.getTracks().forEach(track => track.stop())
    },
    resumeStream: async () => {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      })
      return mediaStream
    },
    ortConfig: configureSileroOrt,
    onSpeechStart: () => {},
    onSpeechRealStart: () => {},
    onVADMisfire: () => {},
    onFrameProcessed: () => {},
    onSpeechEnd: audio => {
      void finishSileroRecording(audio, sessionId)
    },
  })

  await sileroVad.start()
  await voiceApi.runtimeEvent({ type: 'recording-started', sessionId, reason })
  sileroTimer = window.setTimeout(() => {
    void stopSileroRecording(true)
  }, settings.vad.maxRecordingMs)
}

async function finishSileroRecording(audio: Float32Array, sessionId?: string) {
  if (sileroFinished) return
  sileroFinished = true
  const durationMs = Math.max(1, Math.round((audio.length / 16000) * 1000))
  await voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId, durationMs })
  const vad = sileroVad
  sileroVad = null
  clearSileroTimer()
  try {
    await vad?.pause?.()
  } catch {
    // pause can race with speech end; destroy below still releases resources.
  }
  try {
    await vad?.destroy?.()
  } catch {
    // Ignore cleanup races from stopped media tracks.
  }
  mediaStream = null

  if (audio.length > 0) {
    const blob = float32ToWavBlob(audio, 16000)
    const audioBase64 = await blobToBase64(blob)
    await voiceApi.submitUtterance({
      sessionId,
      audioBase64,
      mimeType: 'audio/wav',
      durationMs,
    })
  }
  if (latestSettings?.enabled && latestSettings.alwaysOn) {
    startWake(latestSettings, latestSessionId)
  }
}

async function stopSileroRecording(submit: boolean) {
  const vad = sileroVad
  if (!vad) {
    clearSileroTimer()
    return
  }
  if (!submit) {
    sileroFinished = true
  }
  clearSileroTimer()
  if (submit) {
    await vad.pause().catch(() => {})
    await waitForSileroFlush()
    if (!sileroFinished) {
      sileroFinished = true
      const durationMs = Date.now() - sileroStartedAt
      await voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId: latestSessionId, durationMs })
      await voiceApi.runtimeEvent({
        type: 'error',
        error: 'No speech was detected. Try the mic button again.',
        recoverable: true,
      })
    }
  }
  sileroVad = null
  await vad.destroy().catch(() => {})
  mediaStream = null
  if (submit && latestSettings?.enabled && latestSettings.alwaysOn) {
    startWake(latestSettings, latestSessionId)
  }
}

async function startDoubaoStreamingRecording(settings: VoiceSettings, sessionId?: string, reason?: string) {
  streamingAsrStartedAt = Date.now()
  streamingAsrTransport = 'doubao'
  streamingAsrReason = reason
  streamingAsrFinalizing = false
  streamingAsrPendingPcm = new Int16Array(0)
  streamingAsrVoiceStarted = false
  streamingAsrSilenceStartedAt = 0
  streamingAsrSpeechFrames = 0
  streamingAsrNoiseFloor = 0
  streamingAsrFirstAudioSent = false

  try {
    await startStreamingMicrophone(settings, sessionId)
  } catch (error) {
    streamingAsrTransport = null
    resetStreamingASRState()
    throw error
  }
  await voiceApi.runtimeEvent({ type: 'recording-started', sessionId, reason })

  streamingAsrTimeout = window.setTimeout(() => {
    stopDoubaoStreamingRecording(true)
  }, settings.vad.maxRecordingMs)
  streamingAsrNoSpeechTimer = window.setTimeout(() => {
    if (!streamingAsrVoiceStarted) {
      const silentResume = streamingAsrReason === 'resume' || streamingAsrReason === 'wake' || streamingAsrReason === 'call'
      stopDoubaoStreamingRecording(false)
      if (!silentResume) {
        void voiceApi.runtimeEvent({
          type: 'error',
          error: 'No speech was detected. Try the mic button again.',
          recoverable: true,
        })
      }
    }
  }, Math.min(ENERGY_NO_SPEECH_TIMEOUT_MS, settings.vad.maxRecordingMs))
}

function sendDoubaoAudioChunk(chunk: Int16Array, sessionId?: string) {
  const result = drainPcmChunks(streamingAsrPendingPcm, chunk, DOUBAO_CHUNK_SAMPLES)
  streamingAsrPendingPcm = result.pending
  for (const buffer of result.ready) {
    voiceApi.audioChunk({
      sessionId,
      chunkBase64: arrayBufferToBase64(buffer),
      sampleRate: FUNASR_SAMPLE_RATE,
      phase: 'recording',
    })
    if (!streamingAsrFirstAudioSent) {
      streamingAsrFirstAudioSent = true
      void emitStreamingASRMilestone('asr-first-audio-chunk', sessionId ?? latestSessionId)
    }
  }
}

function stopDoubaoStreamingRecording(submit: boolean) {
  if (streamingAsrTransport !== 'doubao' || streamingAsrFinalizing) return
  streamingAsrFinalizing = true
  clearFunASRTimers()

  const sessionId = latestSessionId
  if (submit && streamingAsrPendingPcm.length > 0) {
    voiceApi.audioChunk({
      sessionId,
      chunkBase64: arrayBufferToBase64(int16ToExactArrayBuffer(streamingAsrPendingPcm)),
      sampleRate: FUNASR_SAMPLE_RATE,
      phase: 'recording',
    })
  }
  voiceApi.audioChunk({
    sessionId,
    phase: 'recording',
    last: true,
    abort: !submit,
  })

  stopStreamingMicrophone()
  const durationMs = Date.now() - streamingAsrStartedAt
  streamingAsrTransport = null
  resetStreamingASRState()
  void voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId, durationMs })

  if (latestSettings?.enabled && latestSettings.alwaysOn) {
    startWake(latestSettings, latestSessionId)
  }
}

async function startFunASRStreamingRecording(settings: VoiceSettings, sessionId?: string, reason?: string) {
  const url = settings.asr.funasr.url.trim()
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error('FunASR streaming ASR needs a ws:// or wss:// WebSocket URL.')
  }

  streamingAsrStartedAt = Date.now()
  streamingAsrTransport = 'funasr'
  streamingAsrReason = reason
  streamingAsrFinalizing = false
  streamingAsrSubmitted = false
  streamingAsrTranscriptId = createRuntimeId()
  streamingAsrLatestText = ''
  streamingAsrFinalText = ''
  streamingAsrPendingPcm = new Int16Array(0)
  streamingAsrVoiceStarted = false
  streamingAsrSilenceStartedAt = 0
  streamingAsrSpeechFrames = 0
  streamingAsrNoiseFloor = 0
  streamingAsrFirstAudioSent = false
  streamingAsrFirstPartialReceived = false

  streamingAsrSocket = await openFunASRSocket(url, settings, sessionId)
  try {
    await startStreamingMicrophone(settings, sessionId)
  } catch (error) {
    cleanupFunASRSocket()
    resetStreamingASRState()
    throw error
  }
  await voiceApi.runtimeEvent({ type: 'recording-started', sessionId, reason })

  streamingAsrTimeout = window.setTimeout(() => {
    stopFunASRStreamingRecording(true)
  }, settings.vad.maxRecordingMs)
  streamingAsrNoSpeechTimer = window.setTimeout(() => {
    if (!streamingAsrVoiceStarted) {
      const silentResume = streamingAsrReason === 'resume' || streamingAsrReason === 'wake' || streamingAsrReason === 'call'
      stopFunASRStreamingRecording(false)
      void voiceApi.runtimeEvent({
        type: 'recording-stopped',
        sessionId,
        durationMs: Date.now() - streamingAsrStartedAt,
      })
      if (!silentResume) {
        void voiceApi.runtimeEvent({
          type: 'error',
          error: 'No speech was detected. Try the mic button again.',
          recoverable: true,
        })
      }
    }
  }, Math.min(ENERGY_NO_SPEECH_TIMEOUT_MS, settings.vad.maxRecordingMs))
}

function openFunASRSocket(url: string, settings: VoiceSettings, sessionId?: string): Promise<WebSocket> {
  return openFunASRSocketConnection({
    url,
    settings,
    wavName: `onething-${Date.now()}`,
    WebSocketCtor: WebSocket as any,
    onOpen: () => emitStreamingASRMilestone('asr-socket-open', sessionId),
    onTranscript: (_message, raw) => handleFunASRMessage(raw, sessionId),
    onClose: socket => {
      if (streamingAsrSocket === socket) streamingAsrSocket = null
      if (streamingAsrFinalizing && !streamingAsrSubmitted) {
        void finalizeFunASRStreamingRecording(true, sessionId)
      }
    },
  }) as Promise<WebSocket>
}

async function startStreamingMicrophone(settings: VoiceSettings, sessionId?: string) {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: true,
    },
  })
  audioContext = new AudioContext()
  streamingAsrSource = audioContext.createMediaStreamSource(mediaStream)
  streamingAsrProcessor = audioContext.createScriptProcessor(4096, 1, 1)
  streamingAsrProcessor.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0)
    const rms = calculateRms(input)
    monitorStreamingASRSilence(settings, rms, sessionId)

    if (streamingAsrFinalizing) return
    if (streamingAsrTransport === 'doubao') {
      const downsampled = downsampleFloat32(input, audioContext?.sampleRate || FUNASR_SAMPLE_RATE, FUNASR_SAMPLE_RATE)
      sendDoubaoAudioChunk(float32ToInt16(downsampled), sessionId)
      return
    }
    if (streamingAsrSocket?.readyState !== WebSocket.OPEN) return
    const downsampled = downsampleFloat32(input, audioContext?.sampleRate || FUNASR_SAMPLE_RATE, FUNASR_SAMPLE_RATE)
    appendStreamingASRChunk(float32ToInt16(downsampled))
  }
  streamingAsrSource.connect(streamingAsrProcessor)
  streamingAsrProcessor.connect(audioContext.destination)
}

async function handleFunASRMessage(raw: unknown, sessionId?: string) {
  const message = parseFunASRMessage(raw)
  if (!message) return

  streamingAsrLatestText = message.text
  if (message.isFinal) {
    streamingAsrFinalText = message.text
  }

  const durationMs = Date.now() - streamingAsrStartedAt
  if (!streamingAsrFirstPartialReceived) {
    streamingAsrFirstPartialReceived = true
    await emitStreamingASRMilestone('asr-first-partial', sessionId, {
      transcriptId: streamingAsrTranscriptId,
      elapsedMs: durationMs,
    })
  }
  await voiceApi.runtimeEvent({
    type: 'partial-transcript',
    sessionId,
    transcriptId: streamingAsrTranscriptId,
    text: message.text,
    durationMs,
  })

  if (streamingAsrFinalizing && (streamingAsrFinalText || message.isFinal)) {
    await finalizeFunASRStreamingRecording(true, sessionId)
  }
}

function appendStreamingASRChunk(chunk: Int16Array) {
  const result = drainPcmChunks(streamingAsrPendingPcm, chunk, FUNASR_CHUNK_SAMPLES)
  streamingAsrPendingPcm = result.pending
  for (const buffer of result.ready) {
    streamingAsrSocket?.send(buffer)
    if (!streamingAsrFirstAudioSent) {
      streamingAsrFirstAudioSent = true
      void emitStreamingASRMilestone('asr-first-audio-chunk', latestSessionId, {
        transcriptId: streamingAsrTranscriptId,
      })
    }
  }
}

function stopFunASRStreamingRecording(submit: boolean) {
  clearFunASRTimers()
  stopStreamingMicrophone()

  if (!submit) {
    cleanupFunASRSocket()
    resetStreamingASRState()
    if (latestSettings?.enabled && latestSettings.alwaysOn) {
      startWake(latestSettings, latestSessionId)
    }
    return
  }

  if (streamingAsrFinalizing) return
  streamingAsrFinalizing = true
  if (streamingAsrSocket?.readyState === WebSocket.OPEN) {
    if (streamingAsrPendingPcm.length > 0) {
      streamingAsrSocket.send(int16ToExactArrayBuffer(streamingAsrPendingPcm))
      streamingAsrPendingPcm = new Int16Array(0)
    }
    streamingAsrSocket.send(JSON.stringify(createFunASREndMessage()))
  }

  window.setTimeout(() => {
    void finalizeFunASRStreamingRecording(true, latestSessionId)
  }, 900)
}

async function finalizeFunASRStreamingRecording(submit: boolean, sessionId?: string) {
  if (streamingAsrSubmitted) return
  streamingAsrSubmitted = true
  clearFunASRTimers()
  const durationMs = Date.now() - streamingAsrStartedAt
  await voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId, durationMs })
  await emitStreamingASRMilestone('asr-finalized', sessionId, {
    transcriptId: streamingAsrTranscriptId,
    elapsedMs: durationMs,
  })

  const text = (streamingAsrFinalText || streamingAsrLatestText).trim()
  cleanupFunASRSocket()
  resetStreamingASRState()

  if (submit && text) {
    const response = await voiceApi.submitTranscript({
      sessionId,
      transcriptId: streamingAsrTranscriptId || createRuntimeId(),
      text,
      asrProvider: 'funasr-stream',
      asrModel: 'funasr-websocket',
      durationMs,
    })
    if (!response.success && response.error) {
      await voiceApi.runtimeEvent({ type: 'error', error: response.error, recoverable: true })
    }
  } else if (submit) {
    await voiceApi.runtimeEvent({
      type: 'error',
      error: 'FunASR streaming ASR returned no transcript.',
      recoverable: true,
    })
  }

  if (latestSettings?.enabled && latestSettings.alwaysOn) {
    startWake(latestSettings, latestSessionId)
  }
}

function monitorStreamingASRSilence(settings: VoiceSettings, rms: number, sessionId?: string) {
  const now = Date.now()
  if (!streamingAsrVoiceStarted) {
    streamingAsrNoiseFloor = streamingAsrNoiseFloor === 0 ? rms : streamingAsrNoiseFloor * 0.92 + rms * 0.08
  }

  const configuredThreshold = settings.vad.energyThreshold
  const speechThreshold = Math.max(
    ENERGY_MIN_SPEECH_THRESHOLD,
    Math.min(configuredThreshold, Math.max(configuredThreshold * 0.5, streamingAsrNoiseFloor * 2.6)),
  )
  const silenceThreshold = Math.max(
    ENERGY_MIN_SILENCE_THRESHOLD,
    Math.min(configuredThreshold, Math.max(speechThreshold * 0.75, streamingAsrNoiseFloor * 1.6)),
  )

  if (rms > speechThreshold) {
    streamingAsrSpeechFrames += 1
  } else {
    streamingAsrSpeechFrames = Math.max(0, streamingAsrSpeechFrames - 1)
  }

  if (!streamingAsrVoiceStarted && streamingAsrSpeechFrames >= ENERGY_MIN_SPEECH_FRAMES) {
    streamingAsrVoiceStarted = true
    streamingAsrSilenceStartedAt = 0
  } else if (streamingAsrVoiceStarted && rms < silenceThreshold && streamingAsrSilenceStartedAt === 0) {
    streamingAsrSilenceStartedAt = now
  } else if (streamingAsrVoiceStarted && rms >= silenceThreshold) {
    streamingAsrSilenceStartedAt = 0
  }

  // Doubao end-of-speech is decided server-side (end_window_size); the
  // renderer only keeps the max-duration and no-speech timers armed in
  // startDoubaoStreamingRecording.
  if (streamingAsrTransport === 'doubao') return

  if (
    streamingAsrVoiceStarted
    && now - streamingAsrStartedAt > ENERGY_MIN_RECORDING_MS
    && streamingAsrSilenceStartedAt > 0
    && now - streamingAsrSilenceStartedAt > settings.vad.silenceMs
  ) {
    stopFunASRStreamingRecording(true)
  } else if (now - streamingAsrStartedAt > settings.vad.maxRecordingMs) {
    stopFunASRStreamingRecording(true)
  } else if (!streamingAsrVoiceStarted && now - streamingAsrStartedAt > Math.min(ENERGY_NO_SPEECH_TIMEOUT_MS, settings.vad.maxRecordingMs)) {
    const silentResume = streamingAsrReason === 'resume' || streamingAsrReason === 'wake' || streamingAsrReason === 'call'
    stopFunASRStreamingRecording(false)
    void voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId, durationMs: now - streamingAsrStartedAt })
    if (!silentResume) {
      void voiceApi.runtimeEvent({
        type: 'error',
        error: 'No speech was detected. Try the mic button again.',
        recoverable: true,
      })
    }
  }
}

function stopStreamingMicrophone() {
  if (streamingAsrProcessor) {
    streamingAsrProcessor.onaudioprocess = null
    streamingAsrProcessor.disconnect()
    streamingAsrProcessor = null
  }
  streamingAsrSource?.disconnect()
  streamingAsrSource = null
  mediaStream?.getTracks().forEach(track => track.stop())
  mediaStream = null
  void audioContext?.close()
  audioContext = null
}

function cleanupFunASRSocket() {
  const socket = streamingAsrSocket
  streamingAsrSocket = null
  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.close()
  }
}

function clearFunASRTimers() {
  if (streamingAsrTimeout) {
    clearTimeout(streamingAsrTimeout)
    streamingAsrTimeout = null
  }
  if (streamingAsrNoSpeechTimer) {
    clearTimeout(streamingAsrNoSpeechTimer)
    streamingAsrNoSpeechTimer = null
  }
}

function resetStreamingASRState() {
  streamingAsrTransport = null
  streamingAsrReason = undefined
  streamingAsrFinalizing = false
  streamingAsrPendingPcm = new Int16Array(0)
  streamingAsrLatestText = ''
  streamingAsrFinalText = ''
  streamingAsrVoiceStarted = false
  streamingAsrSilenceStartedAt = 0
  streamingAsrSpeechFrames = 0
  streamingAsrNoiseFloor = 0
  streamingAsrFirstAudioSent = false
  streamingAsrFirstPartialReceived = false
}

async function emitStreamingASRMilestone(
  name: 'asr-socket-open' | 'asr-first-audio-chunk' | 'asr-first-partial' | 'asr-finalized',
  sessionId?: string,
  extra: { transcriptId?: string; elapsedMs?: number } = {},
) {
  await voiceApi.runtimeEvent({
    type: 'latency-milestone',
    milestone: {
      name,
      at: Date.now(),
      elapsedMs: extra.elapsedMs ?? Date.now() - streamingAsrStartedAt,
      sessionId,
      transcriptId: extra.transcriptId || streamingAsrTranscriptId || undefined,
      provider: 'funasr-stream',
      model: 'funasr-websocket',
    },
  })
}

function uint8ToExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function createRuntimeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function waitForSileroFlush(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 120))
}

function clearSileroTimer() {
  if (sileroTimer) {
    clearTimeout(sileroTimer)
    sileroTimer = null
  }
}

async function startEnergyRecording(settings: VoiceSettings, sessionId?: string, reason?: string) {
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  audioContext = new AudioContext()
  const source = audioContext.createMediaStreamSource(mediaStream)
  analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)

  const chunks: BlobPart[] = []
  const startedAt = Date.now()
  const mimeType = preferredMimeType()
  mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined)
  mediaRecorder.ondataavailable = event => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  mediaRecorder.onstop = async () => {
    const durationMs = Date.now() - startedAt
    await voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId, durationMs })
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'audio/webm' })
    cleanupRecording()
    if (blob.size === 0) {
      await voiceApi.runtimeEvent({
        type: 'error',
        error: 'No microphone audio was captured. Check the selected input device and try again.',
        recoverable: true,
      })
    } else {
      const audioBase64 = await blobToBase64(blob)
      const response = await voiceApi.submitUtterance({
        sessionId,
        audioBase64,
        mimeType: blob.type || 'audio/webm',
        durationMs,
      })
      if (!response.success && response.error) {
        await voiceApi.runtimeEvent({
          type: 'error',
          error: response.error,
          recoverable: true,
        })
      }
    }
    if (latestSettings?.enabled && latestSettings.alwaysOn) {
      startWake(latestSettings, latestSessionId)
    }
  }
  mediaRecorder.start()
  await voiceApi.runtimeEvent({ type: 'recording-started', sessionId, reason })
  monitorSilence(settings, startedAt)
}

function monitorSilence(settings: VoiceSettings, startedAt: number) {
  const data = new Uint8Array(analyser?.fftSize || 1024)
  let voiceStarted = false
  let silenceStartedAt = 0
  let speechFrames = 0
  let noiseFloor = 0
  const configuredThreshold = settings.vad.energyThreshold
  monitorTimer = window.setInterval(() => {
    if (!analyser || !mediaRecorder) return
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const value of data) {
      const normalized = (value - 128) / 128
      sum += normalized * normalized
    }
    const rms = Math.sqrt(sum / data.length)
    const now = Date.now()
    if (!voiceStarted) {
      noiseFloor = noiseFloor === 0 ? rms : noiseFloor * 0.92 + rms * 0.08
    }

    const speechThreshold = Math.max(
      ENERGY_MIN_SPEECH_THRESHOLD,
      Math.min(configuredThreshold, Math.max(configuredThreshold * 0.5, noiseFloor * 2.6)),
    )
    const silenceThreshold = Math.max(
      ENERGY_MIN_SILENCE_THRESHOLD,
      Math.min(configuredThreshold, Math.max(speechThreshold * 0.75, noiseFloor * 1.6)),
    )
    const loudEnoughForSpeech = rms > speechThreshold
    const quietEnoughToStop = rms < silenceThreshold

    if (loudEnoughForSpeech) {
      speechFrames += 1
    } else {
      speechFrames = Math.max(0, speechFrames - 1)
    }

    if (!voiceStarted && speechFrames >= ENERGY_MIN_SPEECH_FRAMES) {
      voiceStarted = true
      silenceStartedAt = 0
    } else if (voiceStarted && quietEnoughToStop && silenceStartedAt === 0) {
      silenceStartedAt = now
    } else if (voiceStarted && !quietEnoughToStop) {
      silenceStartedAt = 0
    }

    if (
      now - startedAt > settings.vad.maxRecordingMs ||
      (voiceStarted && now - startedAt > ENERGY_MIN_RECORDING_MS && silenceStartedAt > 0 && now - silenceStartedAt > settings.vad.silenceMs)
    ) {
      stopRecording(true)
    } else if (!voiceStarted && now - startedAt > Math.min(ENERGY_NO_SPEECH_TIMEOUT_MS, settings.vad.maxRecordingMs)) {
      stopRecording(false)
      void voiceApi.runtimeEvent({ type: 'recording-stopped', sessionId: latestSessionId, durationMs: now - startedAt })
      void voiceApi.runtimeEvent({
        type: 'error',
        error: 'No speech was detected. Try the mic button again.',
        recoverable: true,
      })
    }
  }, ENERGY_SAMPLE_INTERVAL_MS)
}

function stopRecording(submit: boolean) {
  if (streamingAsrTransport === 'doubao') {
    stopDoubaoStreamingRecording(submit)
    return
  }
  if (streamingAsrSocket || streamingAsrProcessor) {
    stopFunASRStreamingRecording(submit)
    return
  }
  if (sileroVad) {
    void stopSileroRecording(submit)
    return
  }
  if (monitorTimer) {
    clearInterval(monitorTimer)
    monitorTimer = null
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    if (submit) {
      mediaRecorder.stop()
      return
    }
    mediaRecorder.onstop = null
    mediaRecorder.stop()
  }
  cleanupRecording()
}

function cleanupRecording() {
  mediaRecorder = null
  mediaStream?.getTracks().forEach(track => track.stop())
  mediaStream = null
  void audioContext?.close()
  audioContext = null
  analyser = null
}

function float32ToWavBlob(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)
  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }
  return new Blob([view], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index++) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function preferredMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return ''
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return candidates.find(type => MediaRecorder.isTypeSupported(type)) || ''
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function playNext() {
  if (isPlaying) return
  const item = playbackQueue.shift()
  if (!item) return
  isPlaying = true
  await voiceApi.runtimeEvent({ type: 'playback-start', requestId: item.requestId })
  if (item.type === 'speech') {
    currentUtterance = playSystemSpeech(item, finishPlayback)
    return
  }
  if (item.type === 'audio-stream') {
    playAudioStream(item)
    return
  }
  currentAudio = new Audio(`data:${item.mimeType};base64,${item.audioBase64}`)
  currentAudio.onended = () => finishPlayback(item.requestId)
  currentAudio.onerror = () => finishPlayback(item.requestId, 'Audio playback failed.')
  await currentAudio.play().catch(error => finishPlayback(item.requestId, error.message))
}

function playAudioStream(item: Extract<PlaybackItem, { type: 'audio-stream' }>) {
  if (typeof MediaSource === 'undefined') {
    item.ended = true
    const blob = new Blob(item.chunks.map(uint8ToExactArrayBuffer), { type: item.mimeType })
    currentAudio = new Audio(URL.createObjectURL(blob))
    currentAudio.onended = () => finishPlayback(item.requestId)
    currentAudio.onerror = () => finishPlayback(item.requestId, 'Audio stream playback failed.')
    void currentAudio.play().catch(error => finishPlayback(item.requestId, error.message))
    return
  }

  currentStreamItem = item
  const mediaSource = new MediaSource()
  item.mediaSource = mediaSource
  item.objectUrl = URL.createObjectURL(mediaSource)
  currentAudio = new Audio(item.objectUrl)
  currentAudio.onended = () => finishPlayback(item.requestId)
  currentAudio.onerror = () => finishPlayback(item.requestId, 'Audio stream playback failed.')
  mediaSource.addEventListener('sourceopen', () => {
    try {
      const mimeType = MediaSource.isTypeSupported(item.mimeType) ? item.mimeType : 'audio/mpeg'
      item.sourceBuffer = mediaSource.addSourceBuffer(mimeType)
      item.sourceBuffer.mode = 'sequence'
      item.sourceBuffer.addEventListener('updateend', () => flushAudioStream(item))
      flushAudioStream(item)
    } catch (error: any) {
      finishPlayback(item.requestId, error?.message || 'Audio stream playback failed.')
    }
  }, { once: true })
  void currentAudio.play().catch(error => finishPlayback(item.requestId, error.message))
}

function appendAudioStreamChunk(requestId: string, chunk: Uint8Array) {
  const item = streamPlaybackItems.get(requestId)
  if (!item || item.ended) return
  item.chunks.push(chunk)
  flushAudioStream(item)
}

function finishAudioStream(requestId: string, error?: string) {
  const item = streamPlaybackItems.get(requestId)
  if (!item) return
  if (error) {
    void voiceApi.runtimeEvent({ type: 'error', error, recoverable: true })
  }
  item.ended = true
  flushAudioStream(item)
}

function flushAudioStream(item: Extract<PlaybackItem, { type: 'audio-stream' }>) {
  if (currentStreamItem !== item || !item.mediaSource || !item.sourceBuffer) return
  if (item.sourceBuffer.updating) return

  const chunk = item.chunks.shift()
  if (chunk) {
    const buffer = uint8ToExactArrayBuffer(chunk)
    item.sourceBuffer.appendBuffer(buffer)
    return
  }

  if (item.ended && item.mediaSource.readyState === 'open') {
    try {
      item.mediaSource.endOfStream()
    } catch {
      // endOfStream can race if Chromium has already closed the source.
    }
  }
}

function finishPlayback(requestId?: string, error?: string) {
  if (error) {
    void voiceApi.runtimeEvent({ type: 'error', error, recoverable: true })
  }
  void voiceApi.runtimeEvent({ type: 'playback-end', requestId })
  currentAudio = null
  currentUtterance = null
  if (currentStreamItem) {
    streamPlaybackItems.delete(currentStreamItem.requestId)
    if (currentStreamItem.objectUrl) URL.revokeObjectURL(currentStreamItem.objectUrl)
    currentStreamItem = null
  }
  isPlaying = false
  if (playbackQueue.length === 0) {
    void voiceApi.runtimeEvent({ type: 'playback-idle' })
    return
  }
  void playNext()
}

function stopPlayback() {
  playbackQueue = []
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  if (currentUtterance) {
    window.speechSynthesis.cancel()
    currentUtterance = null
  }
  if (currentStreamItem?.objectUrl) {
    URL.revokeObjectURL(currentStreamItem.objectUrl)
  }
  currentStreamItem = null
  streamPlaybackItems.clear()
  isPlaying = false
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step))
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}
</script>

<style scoped>
.voice-runtime {
  width: 1px;
  height: 1px;
}
</style>
