export type VoiceRuntimeStatus =
  | 'disabled'
  | 'idle'
  | 'wake-listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error'

export type VoiceASRProvider = 'funasr-stream' | 'openai-transcribe' | 'openrouter-transcribe' | 'funasr-server' | 'doubao'
export type VoiceTTSProvider = 'system-tts' | 'openrouter-tts' | 'openai-tts' | 'qwen-tts' | 'doubao'
export type VoiceEndpointingMode = 'fast' | 'balanced' | 'patient' | 'custom'
export type VoiceWakeSensitivity = 'low' | 'medium' | 'high'

export interface VoiceWakeSettings {
  enabled: boolean
  phrase: string
  provider: 'porcupine-web' | 'web-speech' | 'sherpa-kws'
  sensitivity?: VoiceWakeSensitivity
  accessKey?: string
  keywordPath?: string
  modelPath?: string
}

// Shared Volcano Engine (Doubao) credentials and tuning for both ASR and TTS.
// Only apiKey (or the legacy appId+accessToken pair) is surfaced in the UI;
// the rest is normalized to defaults and editable via settings.json.
export interface VoiceDoubaoSettings {
  apiKey?: string
  appId?: string
  accessToken?: string
  asrResourceId?: string
  ttsResourceId?: string
  endpoint?: string
  endWindowMs?: number
  /** Two-pass recognition: stream partials, re-recognize each utterance for the final. */
  twoPass?: boolean
  speaker?: string
  format?: 'mp3' | 'ogg_opus' | 'pcm'
}

export interface VoiceVADSettings {
  provider: 'silero-web' | 'energy'
  silenceMs: number
  maxRecordingMs: number
  energyThreshold: number
}

export interface VoiceASRSettings {
  provider: VoiceASRProvider
  openai: {
    apiKey?: string
    model: 'gpt-4o-transcribe' | 'whisper-1' | string
    language?: string
  }
  openrouter: {
    apiKey?: string
    model: 'openai/whisper-1' | 'openai/whisper-large-v3' | string
    language?: string
  }
  funasr: {
    url: string
    language?: string
    hotwords?: string
    mode?: '2pass' | 'online'
    chunkSize?: [number, number, number]
    chunkInterval?: number
  }
}

export interface VoiceTTSSettings {
  provider: VoiceTTSProvider
  autoSpeak: boolean
  system: {
    voice?: string
    language?: string
    rate: number
    pitch: number
  }
  openrouter: {
    apiKey?: string
    model: 'openai/gpt-4o-mini-tts-2025-12-15' | 'hexgrad/kokoro-82m' | string
    voice: string
  }
  openai: {
    apiKey?: string
    model: 'gpt-4o-mini-tts' | 'tts-1' | 'tts-1-hd' | string
    voice: string
  }
  qwen: {
    apiKey?: string
    baseUrl: string
    model: string
    voice: string
  }
}

export interface VoiceConversationSettings {
  defaultAgentId: string
  endpointing: VoiceEndpointingMode
  speakProtocol: 'speak-blocks'
}

export interface VoiceSettings {
  enabled: boolean
  alwaysOn: boolean
  bargeIn: boolean
  conversation: VoiceConversationSettings
  wake: VoiceWakeSettings
  vad: VoiceVADSettings
  asr: VoiceASRSettings
  tts: VoiceTTSSettings
  doubao: VoiceDoubaoSettings
}

// Raw PCM uplink from the voice runtime window to the main process
// (used by main-process ASR/KWS providers such as Doubao and sherpa-kws).
export interface VoiceAudioChunkPayload {
  sessionId?: string
  /** int16 little-endian mono PCM. */
  chunkBase64?: string
  sampleRate?: number
  /** wake: feed keyword spotting + pre-roll; recording: feed the active ASR session. */
  phase?: 'wake' | 'recording'
  /** Marks the end of the utterance; main finalizes the ASR session. */
  last?: boolean
  /** With last: drop the session without submitting a transcript. */
  abort?: boolean
}

export interface VoiceTranscriptMetadata {
  transcriptId: string
  asrProvider: VoiceASRProvider
  asrModel: string
  durationMs?: number
}

export type VoiceLatencyMilestoneName =
  | 'asr-socket-open'
  | 'asr-first-audio-chunk'
  | 'asr-first-partial'
  | 'asr-finalized'
  | 'tts-request-start'
  | 'tts-audio-stream-start'
  | 'tts-first-audio-chunk'
  | 'tts-audio-stream-end'
  | 'tts-system-dispatched'

export interface VoiceLatencyMilestone {
  name: VoiceLatencyMilestoneName
  at: number
  elapsedMs?: number
  sessionId?: string
  requestId?: string
  transcriptId?: string
  provider?: VoiceASRProvider | VoiceTTSProvider
  model?: string
}

export interface VoiceRuntimeState {
  status: VoiceRuntimeStatus
  enabled: boolean
  runtimeReady: boolean
  /** A hands-free voice call is connected (continuous listen/reply loop). */
  callActive?: boolean
  currentSessionId?: string
  lastTranscript?: string
  lastMilestone?: VoiceLatencyMilestone
  lastError?: string
  updatedAt: number
}

export type VoiceEvent =
  | { type: 'state'; state: VoiceRuntimeState }
  | { type: 'runtime-ready' }
  | { type: 'wake-detected'; phrase?: string; sessionId?: string }
  | { type: 'recording-started'; sessionId?: string; reason?: string }
  | { type: 'recording-stopped'; sessionId?: string; durationMs?: number }
  | { type: 'partial-transcript'; sessionId?: string; transcriptId: string; text: string; durationMs?: number }
  | { type: 'transcript'; sessionId: string; transcriptId: string; text: string; durationMs?: number }
  | { type: 'submitted'; sessionId: string; transcriptId: string; text: string }
  | { type: 'latency-milestone'; milestone: VoiceLatencyMilestone }
  | { type: 'playback-start'; requestId?: string }
  | { type: 'playback-end'; requestId?: string }
  | { type: 'playback-idle' }
  | { type: 'error'; error: string; recoverable?: boolean }

export type VoiceRuntimeEvent = VoiceEvent

export type VoiceRuntimeCommand =
  | { type: 'configure'; settings: VoiceSettings; sessionId?: string }
  | { type: 'start-wake'; settings: VoiceSettings; sessionId?: string }
  | { type: 'start-recording'; settings: VoiceSettings; sessionId?: string; reason?: string }
  | { type: 'stop'; reason?: string; submit?: boolean }
  | { type: 'stop-recording'; reason?: string }
  | { type: 'stop-playback' }
  | { type: 'play-audio'; requestId?: string; audioBase64: string; mimeType: string }
  | { type: 'play-audio-stream-start'; requestId: string; mimeType: string }
  | { type: 'play-audio-stream-chunk'; requestId: string; chunkBase64: string }
  | { type: 'play-audio-stream-end'; requestId: string; error?: string }
  | { type: 'speak-text'; requestId?: string; text: string; voice?: string; language?: string; rate?: number; pitch?: number }

export interface VoiceStartRequest {
  sessionId?: string
  reason?: 'manual' | 'wake' | 'resume' | 'call'
}

export interface VoiceStopRequest {
  reason?: string
  submit?: boolean
}

export interface VoiceSubmitUtteranceRequest {
  sessionId?: string
  audioBase64: string
  mimeType: string
  durationMs?: number
}

export interface VoiceSubmitTranscriptRequest {
  sessionId?: string
  transcriptId?: string
  text: string
  asrProvider: VoiceASRProvider
  asrModel: string
  durationMs?: number
}

export interface VoiceSynthesizeRequest {
  text: string
  requestId?: string
}

export interface VoiceTestASRRequest {
  audioBase64?: string
  mimeType?: string
}

export interface VoiceTestTTSRequest {
  text?: string
}

export interface VoiceTTSModel {
  id: string
  name: string
  description?: string
  pricing?: {
    prompt?: string
    completion?: string
  }
  supportedVoices: string[]
}

export interface VoiceBaseResponse {
  success: boolean
  error?: string
}

export interface VoiceGetStateResponse extends VoiceBaseResponse {
  state?: VoiceRuntimeState
}

export interface VoiceSubmitUtteranceResponse extends VoiceBaseResponse {
  transcript?: string
  transcriptId?: string
}

export interface VoiceSynthesizeResponse extends VoiceBaseResponse {
  requestId?: string
  mimeType?: string
}

export interface VoiceTTSModelsResponse extends VoiceBaseResponse {
  models?: VoiceTTSModel[]
  fetchedAt?: number
}

// ============================================================================
// Router
// ============================================================================

/**
 * voice(语音:状态 / 起停 / 上行 / 合成 / 自检 / 运行时窗)域 —— 结构债 P4c
 * 第十一批,十一条数据面整只从手写 IPC 通道迁到通用 `rpc:invoke` /
 * `POST /api/rpc`。
 *
 * 十一条逐条对应从前 `IPC_CHANNELS` 上那些 `voice:*` invoke 通道 —— 旧线是
 * `apps/electron/src/voice/ipc.ts` 那只裸 `ipcMain.handle` 工厂 +
 * `@main/ipc/voice.ts` 的壳适配(这一域同样没有 `apps/electron/src/ipc/*` 那层)。
 * 请求/响应形状一字未改;变的只是通道。
 *
 * **两条推送留在原地**(router 今天没有推送面):`VOICE_EVENT` 与
 * `VOICE_RUNTIME_COMMAND`。这两条早就是端口形状(`configureVoiceHost` 的
 * `broadcastMessage` / `runtimeWindow.sendCommand`),所以本批一行都不用动它们;
 * server 那侧的 `/api/voice/events` 与 `/api/voice/runtime-commands` 两条 SSE
 * 同样保留。
 *
 * **`VOICE_AUDIO_CHUNK` 不在这条 router 上**(拍板 #10 的「流式单向残留集」):
 * 它是运行时窗往主进程灌的高频 PCM 上行,从来就是 `ipcRenderer.send` 的单向通道,
 * 不带回执。router 只有请求/响应面,搬过去等于给每一块音频加一条空回执 ——
 * 那是性能面的变化,不是通道收敛。常量、preload 的 `send` 包装与主进程那条
 * `ipcMain.on` 因此原样留着(`apps/electron/src/main/ipc/voice.ts` 的终态小文件)。
 *
 * `runtimeReady` 从前从 `event.sender` 取发起窗(用来在 `runtime-ready` 事件上
 * 做回声抑制)。信封里没有那一格,所以它改由宿主回答:`configureVoiceHost` 的
 * `runtimeWindow.getWebContents` —— 语音运行时窗是**唯一**会调这条的窗口,
 * 宿主自己认得它,抑制口径逐字不变。
 *
 * 无参的两条(`getState` / `runtimeReady`)按本仓惯例递 `{}`。
 */
import { defineRouter } from './router.js'

export type VoiceRoutes = {
  getState: { input: Record<string, never>; output: VoiceGetStateResponse }
  start: { input: VoiceStartRequest; output: VoiceBaseResponse & { state?: VoiceRuntimeState } }
  stop: { input: VoiceStopRequest; output: { success: boolean } }
  submitUtterance: { input: VoiceSubmitUtteranceRequest; output: VoiceSubmitUtteranceResponse }
  submitTranscript: { input: VoiceSubmitTranscriptRequest; output: VoiceSubmitUtteranceResponse }
  synthesize: { input: VoiceSynthesizeRequest; output: VoiceSynthesizeResponse }
  testASR: { input: VoiceTestASRRequest; output: VoiceSubmitUtteranceResponse }
  testTTS: { input: VoiceTestTTSRequest; output: VoiceBaseResponse & { mimeType?: string } }
  getTTSModels: { input: { force?: boolean }; output: VoiceTTSModelsResponse }
  runtimeReady: { input: Record<string, never>; output: VoiceBaseResponse }
  runtimeEvent: { input: VoiceRuntimeEvent; output: VoiceBaseResponse }
}

export const voiceRouter = defineRouter<VoiceRoutes>('voice', [
  'getState',
  'start',
  'stop',
  'submitUtterance',
  'submitTranscript',
  'synthesize',
  'testASR',
  'testTTS',
  'getTTSModels',
  'runtimeReady',
  'runtimeEvent',
])
