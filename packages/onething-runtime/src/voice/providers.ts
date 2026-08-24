import { randomUUID } from 'node:crypto'

export interface OnethingVoiceSubmitUtteranceRequest {
  sessionId?: string
  audioBase64: string
  mimeType: string
  durationMs?: number
}

export interface OnethingVoiceTTSModel {
  id: string
  name: string
  description?: string
  pricing?: {
    prompt?: string
    completion?: string
  }
  supportedVoices: string[]
}

export interface OnethingVoiceSettingsLike {
  asr: {
    provider: string
    openai: {
      apiKey?: string
      model?: string
      language?: string
    }
    openrouter: {
      apiKey?: string
      model?: string
      language?: string
    }
    funasr: {
      url: string
      language?: string
      hotwords?: string
    }
  }
  doubao?: {
    apiKey?: string
    appId?: string
    accessToken?: string
    asrResourceId?: string
    ttsResourceId?: string
    endpoint?: string
    endWindowMs?: number
    speaker?: string
    format?: string
  }
  tts: {
    provider: string
    openai: {
      apiKey?: string
      model?: string
      voice?: string
    }
    openrouter?: {
      apiKey?: string
      model?: string
      voice?: string
    }
    qwen: {
      baseUrl: string
      apiKey?: string
      model: string
      voice: string
    }
  }
}

export interface OnethingVoiceTranscriptionResult {
  text: string
  transcriptId: string
  provider: string
  model: string
}

export interface OnethingVoiceSpeechResult {
  audioBase64: string
  mimeType: string
}

export interface OnethingVoiceSpeechStreamResult {
  mimeType: string
}

export interface OnethingVoiceSpeechStreamHandlers {
  onStart?: (metadata: { mimeType: string }) => void | Promise<void>
  onChunk?: (chunk: Uint8Array) => void | Promise<void>
}

export interface OnethingVoiceProviderApiKeys {
  openai?: string
  openrouter?: string
}

export type OnethingVoiceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface OnethingVoiceProviderRuntimeAdapters {
  fetch?: OnethingVoiceFetch
  providerApiKeys?: OnethingVoiceProviderApiKeys
  createId?: () => string
  now?: () => number
  createAbortSignal?: (timeoutMs: number) => AbortSignal | undefined
}

interface OpenRouterSpeechModel {
  id: string
  name?: string
  description?: string
  pricing?: {
    prompt?: string
    completion?: string
  }
  supported_voices?: string[]
}

let openRouterTTSModelsCache: { fetchedAt: number; models: OnethingVoiceTTSModel[] } | null = null
const OPENROUTER_TTS_MODELS_CACHE_MS = 10 * 60 * 1000

function trim(value?: string): string {
  return (value || '').trim()
}

function getOpenAIKey(
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): string {
  const voiceKey = settings.asr.openai.apiKey || settings.tts.openai.apiKey
  return trim(voiceKey || adapters.providerApiKeys?.openai)
}

function getTTSOpenAIKey(
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): string {
  return trim(settings.tts.openai.apiKey || adapters.providerApiKeys?.openai)
}

function getOpenRouterKey(
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): string {
  return trim(settings.asr.openrouter.apiKey || adapters.providerApiKeys?.openrouter)
}

function getOpenRouterTTSKey(
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): string {
  return trim(
    settings.tts.openrouter?.apiKey
    || settings.asr.openrouter.apiKey
    || adapters.providerApiKeys?.openrouter,
  )
}

function getVoiceFetch(adapters: OnethingVoiceProviderRuntimeAdapters = {}): OnethingVoiceFetch {
  const fetchImpl = adapters.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('A fetch implementation is required for voice provider requests.')
  return fetchImpl
}

function createAbortSignal(
  timeoutMs: number,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): AbortSignal | undefined {
  if (adapters.createAbortSignal) return adapters.createAbortSignal(timeoutMs)
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
}

function createRequestInit(
  init: RequestInit,
  timeoutMs: number,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): RequestInit {
  const signal = createAbortSignal(timeoutMs, adapters)
  return signal ? { ...init, signal } : init
}

function createTranscriptId(adapters: OnethingVoiceProviderRuntimeAdapters = {}): string {
  return adapters.createId?.() ?? randomUUID()
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const bytes = Buffer.from(base64, 'base64')
  return new Blob([bytes], { type: mimeType })
}

function audioFormatFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes('wav')) return 'wav'
  if (normalized.includes('webm')) return 'webm'
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3'
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'mp4'
  if (normalized.includes('ogg')) return 'ogg'
  return 'wav'
}

export async function transcribeOnethingUtterance(
  request: OnethingVoiceSubmitUtteranceRequest,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): Promise<OnethingVoiceTranscriptionResult> {
  if (settings.asr.provider === 'funasr-stream') {
    throw new Error('FunASR streaming ASR submits transcripts from the voice runtime.')
  }
  if (settings.asr.provider === 'openrouter-transcribe') {
    return transcribeWithOpenRouter(request, settings, adapters)
  }
  if (settings.asr.provider === 'funasr-server') {
    return transcribeWithFunASR(request, settings, adapters)
  }
  if (settings.asr.provider === 'doubao') {
    return transcribeWithDoubao(request, settings, adapters)
  }
  return transcribeWithOpenAI(request, settings, adapters)
}

export function getOnethingVoiceInputConfigurationError(
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): string | null {
  if (settings.asr.provider === 'funasr-stream') {
    const url = settings.asr.funasr.url.trim()
    if (!url) return 'Add a FunASR WebSocket URL in Voice settings before using streaming voice input.'
    return /^wss?:\/\//i.test(url)
      ? null
      : 'FunASR streaming ASR needs a ws:// or wss:// WebSocket URL.'
  }
  if (settings.asr.provider === 'openrouter-transcribe') {
    return getOpenRouterKey(settings, adapters)
      ? null
      : 'Add an OpenRouter API key in Voice settings before using voice input.'
  }
  if (settings.asr.provider === 'funasr-server') {
    return settings.asr.funasr.url.trim()
      ? null
      : 'Add a FunASR server URL in Advanced settings before using voice input.'
  }
  if (settings.asr.provider === 'doubao') {
    return getDoubaoConfigurationError(settings)
  }
  return getOpenAIKey(settings, adapters)
    ? null
    : 'OpenAI transcription is selected in Advanced settings, but no OpenAI API key is configured.'
}

export async function getOnethingOpenRouterTTSModels(
  force = false,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): Promise<{ models: OnethingVoiceTTSModel[]; fetchedAt: number }> {
  const now = adapters.now?.() ?? Date.now()
  if (!force && openRouterTTSModelsCache && now - openRouterTTSModelsCache.fetchedAt < OPENROUTER_TTS_MODELS_CACHE_MS) {
    return openRouterTTSModelsCache
  }

  const response = await getVoiceFetch(adapters)(
    'https://openrouter.ai/api/v1/models?output_modalities=speech',
    createRequestInit({
      headers: {
        accept: 'application/json',
        'HTTP-Referer': 'https://onething.app',
        'X-Title': 'onething',
      },
    }, 20000, adapters),
  )

  if (!response.ok) {
    throw new Error(`OpenRouter TTS model list failed (${response.status}): ${await response.text()}`)
  }

  const json = await response.json() as { data?: OpenRouterSpeechModel[] }
  const models = (json.data || [])
    .filter(model => model?.id)
    .map(model => ({
      id: model.id,
      name: model.name || model.id,
      description: model.description || '',
      pricing: model.pricing,
      supportedVoices: Array.isArray(model.supported_voices) ? model.supported_voices : [],
    }))
  openRouterTTSModelsCache = { fetchedAt: now, models }
  return openRouterTTSModelsCache
}

async function transcribeWithOpenAI(
  request: OnethingVoiceSubmitUtteranceRequest,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceTranscriptionResult> {
  const apiKey = getOpenAIKey(settings, adapters)
  if (!apiKey) {
    throw new Error('OpenAI API key is required for voice transcription.')
  }

  const model = settings.asr.openai.model || 'gpt-4o-transcribe'
  const form = new FormData()
  form.set('model', model)
  if (settings.asr.openai.language?.trim()) {
    form.set('language', settings.asr.openai.language.trim())
  }
  form.set('file', base64ToBlob(request.audioBase64, request.mimeType), 'utterance.webm')

  const response = await getVoiceFetch(adapters)('https://api.openai.com/v1/audio/transcriptions', createRequestInit({
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form as any,
  }, 60000, adapters))

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${await response.text()}`)
  }

  const json = await response.json() as { text?: string }
  const text = (json.text || '').trim()
  if (!text) throw new Error('OpenAI transcription returned an empty transcript.')
  return {
    text,
    transcriptId: createTranscriptId(adapters),
    provider: 'openai-transcribe',
    model,
  }
}

async function transcribeWithOpenRouter(
  request: OnethingVoiceSubmitUtteranceRequest,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceTranscriptionResult> {
  const apiKey = getOpenRouterKey(settings, adapters)
  if (!apiKey) {
    throw new Error('OpenRouter API key is required for voice transcription.')
  }

  const model = settings.asr.openrouter.model || 'openai/whisper-1'

  const response = await getVoiceFetch(adapters)('https://openrouter.ai/api/v1/audio/transcriptions', createRequestInit({
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://onething.app',
      'X-Title': 'onething',
    },
    body: JSON.stringify({
      input_audio: {
        data: request.audioBase64,
        format: audioFormatFromMimeType(request.mimeType),
      },
      model,
      ...(settings.asr.openrouter.language?.trim()
        ? { language: settings.asr.openrouter.language.trim() }
        : {}),
    }),
  }, 60000, adapters))

  if (!response.ok) {
    throw new Error(`OpenRouter transcription failed (${response.status}): ${await response.text()}`)
  }

  const json = await response.json() as { text?: string }
  const text = (json.text || '').trim()
  if (!text) throw new Error('OpenRouter transcription returned an empty transcript.')
  return {
    text,
    transcriptId: createTranscriptId(adapters),
    provider: 'openrouter-transcribe',
    model,
  }
}

async function transcribeWithFunASR(
  request: OnethingVoiceSubmitUtteranceRequest,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceTranscriptionResult> {
  const url = settings.asr.funasr.url.trim()
  if (!url) throw new Error('FunASR server URL is required.')

  const payload = {
    audio: request.audioBase64,
    mimeType: request.mimeType,
    language: settings.asr.funasr.language || 'auto',
    hotwords: settings.asr.funasr.hotwords || '',
  }

  const response = await getVoiceFetch(adapters)(url, createRequestInit({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 60000, adapters))

  if (!response.ok) {
    throw new Error(`FunASR transcription failed (${response.status}): ${await response.text()}`)
  }

  const json = await response.json() as { text?: string; transcript?: string; result?: string }
  const text = (json.text || json.transcript || json.result || '').trim()
  if (!text) throw new Error('FunASR transcription returned an empty transcript.')
  return {
    text,
    transcriptId: createTranscriptId(adapters),
    provider: 'funasr-server',
    model: 'funasr-server',
  }
}

function getDoubaoConfigurationError(settings: OnethingVoiceSettingsLike): string | null {
  const doubao = settings.doubao
  const apiKey = (doubao?.apiKey || '').trim()
  const appId = (doubao?.appId || '').trim()
  const accessToken = (doubao?.accessToken || '').trim()
  if (apiKey || (appId && accessToken)) return null
  return 'Add a Doubao (Volcano Engine) API key in Voice settings before using Doubao speech.'
}

async function transcribeWithDoubao(
  request: OnethingVoiceSubmitUtteranceRequest,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceTranscriptionResult> {
  const configurationError = getDoubaoConfigurationError(settings)
  if (configurationError) throw new Error(configurationError)

  const { transcribeOnethingDoubaoUtterance } = await import('./volcano/asr-session.js')
  const text = (await transcribeOnethingDoubaoUtterance({
    audio: Buffer.from(request.audioBase64, 'base64'),
    mimeType: request.mimeType,
    settings: settings.doubao!,
  })).trim()
  if (!text) throw new Error('Doubao transcription returned an empty transcript.')
  return {
    text,
    transcriptId: createTranscriptId(adapters),
    provider: 'doubao',
    model: 'bigmodel',
  }
}

export async function synthesizeOnethingSpeech(
  text: string,
  settings: OnethingVoiceSettingsLike,
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): Promise<OnethingVoiceSpeechResult> {
  const chunks: Uint8Array[] = []
  const voiceSpeechStreamHandlers: OnethingVoiceSpeechStreamHandlers = {
    onChunk: chunk => {
      chunks.push(chunk)
    },
  };
  const result = await streamSynthesizeOnethingSpeech(text, settings, voiceSpeechStreamHandlers, adapters)
  return {
    audioBase64: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('base64'),
    mimeType: result.mimeType,
  }
}

export async function streamSynthesizeOnethingSpeech(
  text: string,
  settings: OnethingVoiceSettingsLike,
  handlers: OnethingVoiceSpeechStreamHandlers = {},
  adapters: OnethingVoiceProviderRuntimeAdapters = {},
): Promise<OnethingVoiceSpeechStreamResult> {
  if (settings.tts.provider === 'system-tts') {
    throw new Error('System TTS is played by the voice runtime and does not need a cloud API.')
  }
  if (settings.tts.provider === 'openrouter-tts') {
    return streamWithOpenRouter(text, settings, handlers, adapters)
  }
  if (settings.tts.provider === 'qwen-tts') {
    return streamWithQwen(text, settings, handlers, adapters)
  }
  if (settings.tts.provider === 'doubao') {
    return streamWithDoubao(text, settings, handlers)
  }
  return streamWithOpenAI(text, settings, handlers, adapters)
}

// One cached bidirectional connection per credential set so consecutive reply
// sentences skip the WebSocket handshake.
let doubaoTTSConnectionCache: { key: string; connection: any; idleTimer?: ReturnType<typeof setTimeout> } | null = null
const DOUBAO_TTS_IDLE_MS = 30000

async function streamWithDoubao(
  text: string,
  settings: OnethingVoiceSettingsLike,
  handlers: OnethingVoiceSpeechStreamHandlers,
): Promise<OnethingVoiceSpeechStreamResult> {
  const doubao = settings.doubao
  if (!doubao?.apiKey?.trim() && !(doubao?.appId?.trim() && doubao?.accessToken?.trim())) {
    throw new Error('Add a Doubao (Volcano Engine) API key in Voice settings before using Doubao speech.')
  }

  const { OnethingDoubaoTTSConnection, getOnethingDoubaoTTSMimeType } = await import('./volcano/tts-session.js')
  const key = JSON.stringify([doubao.apiKey, doubao.appId, doubao.accessToken, doubao.ttsResourceId, doubao.endpoint])

  let connection = doubaoTTSConnectionCache?.key === key && doubaoTTSConnectionCache.connection.isUsable
    ? doubaoTTSConnectionCache.connection
    : null
  if (!connection) {
    doubaoTTSConnectionCache?.connection.close()
    connection = new OnethingDoubaoTTSConnection(doubao)
    doubaoTTSConnectionCache = { key, connection }
    await connection.connect()
  }
  if (doubaoTTSConnectionCache?.idleTimer) clearTimeout(doubaoTTSConnectionCache.idleTimer)

  const mimeType = getOnethingDoubaoTTSMimeType(doubao)
  await handlers.onStart?.({ mimeType })
  try {
    await connection.synthesize(text, {
      onChunk: (chunk: Uint8Array) => handlers.onChunk?.(chunk),
    })
  } catch (error) {
    if (doubaoTTSConnectionCache?.connection === connection) {
      doubaoTTSConnectionCache = null
    }
    connection.close()
    throw error
  }

  const cache = doubaoTTSConnectionCache
  if (cache && cache.connection === connection) {
    cache.idleTimer = setTimeout(() => {
      if (doubaoTTSConnectionCache?.connection === connection) {
        doubaoTTSConnectionCache = null
      }
      connection.close()
    }, DOUBAO_TTS_IDLE_MS)
  }
  return { mimeType }
}

async function streamWithOpenRouter(
  text: string,
  settings: OnethingVoiceSettingsLike,
  handlers: OnethingVoiceSpeechStreamHandlers,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceSpeechStreamResult> {
  const apiKey = getOpenRouterTTSKey(settings, adapters)
  if (!apiKey) throw new Error('OpenRouter API key is required for voice TTS.')

  return streamSpeechEndpoint('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://onething.app',
      'X-Title': 'onething',
    },
    body: JSON.stringify({
      model: settings.tts.openrouter?.model || 'openai/gpt-4o-mini-tts-2025-12-15',
      input: text,
      voice: settings.tts.openrouter?.voice || 'alloy',
      response_format: 'mp3',
    }),
  }, 60000, 'OpenRouter TTS', handlers, adapters)
}

async function streamWithOpenAI(
  text: string,
  settings: OnethingVoiceSettingsLike,
  handlers: OnethingVoiceSpeechStreamHandlers,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceSpeechStreamResult> {
  const apiKey = getTTSOpenAIKey(settings, adapters)
  if (!apiKey) throw new Error('OpenAI API key is required for voice TTS.')

  return streamSpeechEndpoint('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.tts.openai.model || 'gpt-4o-mini-tts',
      voice: settings.tts.openai.voice || 'alloy',
      input: text,
      response_format: 'mp3',
    }),
  }, 60000, 'OpenAI TTS', handlers, adapters)
}

async function streamWithQwen(
  text: string,
  settings: OnethingVoiceSettingsLike,
  handlers: OnethingVoiceSpeechStreamHandlers,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceSpeechStreamResult> {
  const baseUrl = settings.tts.qwen.baseUrl.trim().replace(/\/$/, '')
  const apiKey = (settings.tts.qwen.apiKey || '').trim()
  if (!baseUrl) throw new Error('Qwen/CosyVoice base URL is required.')
  if (!apiKey) throw new Error('Qwen/CosyVoice API key is required.')

  return streamSpeechEndpoint(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: settings.tts.qwen.model,
      voice: settings.tts.qwen.voice,
      input: text,
      response_format: 'mp3',
    }),
  }, 60000, 'Qwen/CosyVoice TTS', handlers, adapters)
}

async function streamSpeechEndpoint(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
  handlers: OnethingVoiceSpeechStreamHandlers,
  adapters: OnethingVoiceProviderRuntimeAdapters,
): Promise<OnethingVoiceSpeechStreamResult> {
  const response = await getVoiceFetch(adapters)(url, createRequestInit(init, timeoutMs, adapters))
  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${await response.text()}`)
  }

  const mimeType = normalizeAudioMimeType(response.headers.get('content-type') || 'audio/mpeg')
  await handlers.onStart?.({ mimeType })

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > 0) await handlers.onChunk?.(buffer)
    return { mimeType }
  }

  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.byteLength) {
      await handlers.onChunk?.(value)
    }
  }

  return { mimeType }
}

export function normalizeOnethingAudioMimeType(mimeType: string): string {
  const normalized = mimeType.split(';')[0].trim().toLowerCase()
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'audio/mpeg'
  if (normalized.includes('wav')) return 'audio/wav'
  if (normalized.includes('pcm')) return 'audio/mpeg'
  if (normalized.includes('ogg')) return 'audio/ogg'
  return normalized || 'audio/mpeg'
}

function normalizeAudioMimeType(mimeType: string): string {
  return normalizeOnethingAudioMimeType(mimeType)
}
