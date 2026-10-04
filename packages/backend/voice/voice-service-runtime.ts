export interface OnethingVoiceWakeSettingsLike {
  enabled?: boolean
}

export interface OnethingVoiceTTSSettingsLike {
  provider?: string
  system?: {
    voice?: string
    language?: string
    rate?: number
    pitch?: number
  }
  openrouter?: {
    model?: string
  }
  openai?: {
    model?: string
  }
  qwen?: {
    model?: string
  }
}

export interface OnethingVoiceSettingsRuntimeLike {
  enabled?: boolean
  alwaysOn?: boolean
  wake?: OnethingVoiceWakeSettingsLike
  tts?: OnethingVoiceTTSSettingsLike
}

export interface OnethingVoiceAppSettingsRuntimeLike {
  voice?: OnethingVoiceSettingsRuntimeLike
}

export interface OnethingVoiceWakeFallbackResult<TSettings> {
  applied: boolean
  settings: TSettings
}

export interface OnethingVoiceRuntimeStateLike<TStatus extends string = string, TMilestone = unknown> {
  status: TStatus
  enabled: boolean
  runtimeReady: boolean
  updatedAt: number
  lastError?: string
  lastMilestone?: TMilestone
}

export interface OnethingVoiceRuntimeStatusOptions<TStatus extends string> {
  status: TStatus
  voiceEnabled: boolean
  runtimeReady: boolean
  now?: () => number
}

export interface OnethingVoiceRuntimeErrorOptions {
  error: string
  voiceEnabled: boolean
  runtimeReady: boolean
  now?: () => number
}

export function isOnethingWebSpeechWakeFailure(error: unknown): boolean {
  const message = voiceRuntimeMessage(error)
  return message.includes('Browser speech wake is not supported in the desktop app')
    || message.includes('Wake phrase needs the local wake engine setup first')
    || message.includes('The local wake engine does not know')
    || message.includes('Local wake engine failed')
    || message.includes('Web Speech wake phrase listener needs Chromium speech service')
    || message.includes('Wake phrase microphone permission was denied')
    || message.includes('Wake phrase listener could not access a microphone')
    || message.includes('Web Speech wake word listener needs Chromium speech service')
    || message.includes('Wake word microphone permission was denied')
    || message.includes('Wake word listener could not access a microphone')
}

export function normalizeOnethingVoiceError(error: unknown, fallback: string): string {
  const message = voiceRuntimeMessage(error, fallback)
  if (message.includes('OpenRouter transcription failed (401)') || message.includes('OpenRouter transcription failed (403)')) {
    return 'OpenRouter rejected the API key. Check the key in Voice settings.'
  }
  if (message.includes('OpenAI transcription failed (401)') || message.includes('OpenAI transcription failed (403)')) {
    return 'OpenAI rejected the API key selected in Advanced voice settings.'
  }
  if (message.includes('transcription returned an empty transcript')) {
    return 'No speech was detected. Try the mic button again.'
  }
  if (message.includes('TimeoutError') || message.includes('aborted') || message.includes('timed out')) {
    return 'Voice transcription timed out. Please try again.'
  }
  if (message.includes('getUserMedia') || message.includes('Permission denied') || message.includes('NotAllowedError')) {
    return 'Microphone access was blocked. Allow microphone access and try again.'
  }
  return message
}

export function isOnethingMissingCloudTTSConfiguration(error: unknown): boolean {
  const message = voiceRuntimeMessage(error)
  return message.includes('OpenAI API key is required for voice TTS')
    || message.includes('OpenRouter API key is required for voice TTS')
    || message.includes('Qwen/CosyVoice base URL is required')
    || message.includes('Qwen/CosyVoice API key is required')
    || message.includes('Doubao (Volcano Engine) API key')
}

export function getOnethingTTSModelName(settings: OnethingVoiceSettingsRuntimeLike): string {
  const tts = settings.tts
  if (tts?.provider === 'openrouter-tts') return tts.openrouter?.model || 'openrouter-tts'
  if (tts?.provider === 'openai-tts') return tts.openai?.model || 'openai-tts'
  if (tts?.provider === 'qwen-tts') return tts.qwen?.model || 'qwen-tts'
  if (tts?.provider === 'doubao') return 'doubao-seed-tts'
  return tts?.system?.voice || 'system'
}

export function applyOnethingVoiceWakeFailureFallback<TSettings extends OnethingVoiceAppSettingsRuntimeLike>(
  settings: TSettings,
  error: unknown,
): OnethingVoiceWakeFallbackResult<TSettings> {
  if (!isOnethingWebSpeechWakeFailure(error)) {
    return { applied: false, settings }
  }

  const voice = settings.voice
  if (!voice?.enabled || !voice.alwaysOn || !voice.wake?.enabled) {
    return { applied: false, settings }
  }

  return {
    applied: true,
    settings: {
      ...settings,
      voice: {
        ...voice,
        alwaysOn: false,
        wake: {
          ...voice.wake,
          enabled: false,
        },
      },
    } as TSettings,
  }
}

export function applyOnethingVoiceRuntimeStatus<TState extends OnethingVoiceRuntimeStateLike<string>>(
  state: TState,
  options: OnethingVoiceRuntimeStatusOptions<TState['status']>,
): TState {
  return {
    ...state,
    status: options.status,
    enabled: options.voiceEnabled,
    runtimeReady: options.runtimeReady,
    updatedAt: (options.now || Date.now)(),
    lastError: options.status === 'error' ? state.lastError : undefined,
  } as TState
}

export function applyOnethingVoiceRuntimeError<TState extends OnethingVoiceRuntimeStateLike<string>>(
  state: TState,
  options: OnethingVoiceRuntimeErrorOptions,
): TState {
  return applyOnethingVoiceRuntimeStatus({
    ...state,
    lastError: options.error,
  }, {
    status: 'error' as TState['status'],
    voiceEnabled: options.voiceEnabled,
    runtimeReady: options.runtimeReady,
    now: options.now,
  })
}

export function createOnethingVoiceLatencyMilestone<TName extends string, TDetails extends object>(
  name: TName,
  milestone: TDetails,
  now: () => number = Date.now,
): TDetails & { name: TName; at: number } {
  return {
    ...milestone,
    name,
    at: now(),
  }
}

export function applyOnethingVoiceRuntimeMilestone<TState extends object, TMilestone>(
  state: TState,
  milestone: TMilestone,
): TState & { lastMilestone: TMilestone } {
  return {
    ...state,
    lastMilestone: milestone,
  }
}

function voiceRuntimeMessage(error: unknown, fallback = ''): string {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message?: unknown }).message || fallback)
  }
  return String(error || fallback)
}
