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
import { createRequiredAppFetch } from '../providers/bound-fetch.js'
import { getSettings } from '../stores/settings.js'
import type { VoiceSettings, VoiceSubmitUtteranceRequest, VoiceTTSModel } from '@shared/ipc.js'

type TranscriptionResult = OnethingVoiceTranscriptionResult
type SpeechResult = OnethingVoiceSpeechResult
type SpeechStreamResult = OnethingVoiceSpeechStreamResult

export type SpeechStreamHandlers = OnethingVoiceSpeechStreamHandlers

function getVoiceProviderRuntimeAdapters(): OnethingVoiceProviderRuntimeAdapters {
  const appSettings = getSettings()
  return {
    fetch: createRequiredAppFetch({ policy: 'default' }),
    providerApiKeys: {
      openai: (appSettings.ai.providers.openai as any)?.apiKey,
      openrouter: (appSettings.ai.providers.openrouter as any)?.apiKey,
    },
  }
}

export async function transcribeUtterance(
  request: VoiceSubmitUtteranceRequest,
  settings: VoiceSettings,
): Promise<TranscriptionResult> {
  return transcribeOnethingUtterance(request, settings, getVoiceProviderRuntimeAdapters())
}

export function getVoiceInputConfigurationError(settings: VoiceSettings): string | null {
  return getOnethingVoiceInputConfigurationError(settings, getVoiceProviderRuntimeAdapters())
}

export async function getOpenRouterTTSModels(force = false): Promise<{ models: VoiceTTSModel[]; fetchedAt: number }> {
  return getOnethingOpenRouterTTSModels(force, getVoiceProviderRuntimeAdapters())
}

export async function synthesizeSpeech(text: string, settings: VoiceSettings): Promise<SpeechResult> {
  return synthesizeOnethingSpeech(text, settings, getVoiceProviderRuntimeAdapters())
}

export async function streamSynthesizeSpeech(
  text: string,
  settings: VoiceSettings,
  handlers: SpeechStreamHandlers = {},
): Promise<SpeechStreamResult> {
  return streamSynthesizeOnethingSpeech(text, settings, handlers, getVoiceProviderRuntimeAdapters())
}
