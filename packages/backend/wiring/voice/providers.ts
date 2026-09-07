import {
  getOnethingOpenRouterTTSModels,
  getOnethingVoiceInputConfigurationError,
  streamSynthesizeOnethingSpeech,
  synthesizeOnethingSpeech,
  transcribeOnethingUtterance,
  type OnethingVoiceProviderRuntimeAdapters,
  type OnethingVoiceSpeechStreamHandlers,
  type OnethingVoiceSpeechStreamResult,
  type OnethingVoiceSpeechResult,
  type OnethingVoiceTranscriptionResult,
} from '@onething/runtime/voice/providers'
import { createRequiredAppFetch } from '../../provider-binding/bound-fetch.js'
import { getSettings } from '../../stores/settings.js'
import type { VoiceSettings, VoiceSubmitUtteranceRequest, VoiceTTSModel } from '@shared/ipc.js'

type TranscriptionResult = OnethingVoiceTranscriptionResult
type SpeechResult = OnethingVoiceSpeechResult
type SpeechStreamResult = OnethingVoiceSpeechStreamResult

export type SpeechStreamHandlers = OnethingVoiceSpeechStreamHandlers

function getVoiceProviderRuntimeAdapters(signal?: AbortSignal): OnethingVoiceProviderRuntimeAdapters {
  const appSettings = getSettings()
  const fetch = createRequiredAppFetch({ policy: 'default' })
  return {
    signal,
    fetch: signal ? (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }) : fetch,
    providerApiKeys: {
      openai: (appSettings.ai.providers.openai as any)?.apiKey,
      openrouter: (appSettings.ai.providers.openrouter as any)?.apiKey,
    },
  }
}

export async function transcribeUtterance(
  request: VoiceSubmitUtteranceRequest,
  settings: VoiceSettings,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  return transcribeOnethingUtterance(request, settings, getVoiceProviderRuntimeAdapters(signal))
}

export function getVoiceInputConfigurationError(settings: VoiceSettings): string | null {
  return getOnethingVoiceInputConfigurationError(settings, getVoiceProviderRuntimeAdapters())
}

export async function getOpenRouterTTSModels(force = false): Promise<{ models: VoiceTTSModel[]; fetchedAt: number }> {
  return getOnethingOpenRouterTTSModels(force, getVoiceProviderRuntimeAdapters())
}

export async function synthesizeSpeech(text: string, settings: VoiceSettings, signal?: AbortSignal): Promise<SpeechResult> {
  return synthesizeOnethingSpeech(text, settings, getVoiceProviderRuntimeAdapters(signal))
}

export async function streamSynthesizeSpeech(
  text: string,
  settings: VoiceSettings,
  handlers: SpeechStreamHandlers = {},
  signal?: AbortSignal,
): Promise<SpeechStreamResult> {
  return streamSynthesizeOnethingSpeech(text, settings, handlers, getVoiceProviderRuntimeAdapters(signal))
}
