import { describe, expect, it } from 'vitest'
import {
  applyOnethingVoiceWakeFailureFallback,
  applyOnethingVoiceRuntimeError,
  applyOnethingVoiceRuntimeMilestone,
  applyOnethingVoiceRuntimeStatus,
  createOnethingVoiceLatencyMilestone,
  getOnethingTTSModelName,
  isOnethingMissingCloudTTSConfiguration,
  isOnethingWebSpeechWakeFailure,
  normalizeOnethingVoiceError,
} from '../service-runtime.js'

describe('voice service runtime policy', () => {
  it('normalizes provider and microphone errors for voice UX', () => {
    expect(normalizeOnethingVoiceError(new Error('OpenRouter transcription failed (401): bad key'), 'fallback')).toBe(
      'OpenRouter rejected the API key. Check the key in Voice settings.',
    )
    expect(normalizeOnethingVoiceError('OpenAI transcription failed (403): forbidden', 'fallback')).toBe(
      'OpenAI rejected the API key selected in Advanced voice settings.',
    )
    expect(normalizeOnethingVoiceError('Voice transcription returned an empty transcript.', 'fallback')).toBe(
      'No speech was detected. Try the mic button again.',
    )
    expect(normalizeOnethingVoiceError('TimeoutError: request timed out', 'fallback')).toBe(
      'Voice transcription timed out. Please try again.',
    )
    expect(normalizeOnethingVoiceError('NotAllowedError: getUserMedia failed', 'fallback')).toBe(
      'Microphone access was blocked. Allow microphone access and try again.',
    )
    expect(normalizeOnethingVoiceError(null, 'fallback')).toBe('fallback')
  })

  it('detects missing cloud TTS configuration errors', () => {
    expect(isOnethingMissingCloudTTSConfiguration(new Error('OpenAI API key is required for voice TTS.'))).toBe(true)
    expect(isOnethingMissingCloudTTSConfiguration('OpenRouter API key is required for voice TTS.')).toBe(true)
    expect(isOnethingMissingCloudTTSConfiguration('Qwen/CosyVoice base URL is required.')).toBe(true)
    expect(isOnethingMissingCloudTTSConfiguration('Qwen/CosyVoice API key is required.')).toBe(true)
    expect(isOnethingMissingCloudTTSConfiguration('network failed')).toBe(false)
  })

  it('projects the active TTS model name from voice settings', () => {
    expect(getOnethingTTSModelName({
      tts: {
        provider: 'openrouter-tts',
        openrouter: { model: 'openai/gpt-4o-mini-tts-2025-12-15' },
      },
    })).toBe('openai/gpt-4o-mini-tts-2025-12-15')
    expect(getOnethingTTSModelName({
      tts: {
        provider: 'openai-tts',
        openai: { model: 'gpt-4o-mini-tts' },
      },
    })).toBe('gpt-4o-mini-tts')
    expect(getOnethingTTSModelName({
      tts: {
        provider: 'qwen-tts',
        qwen: { model: 'cosyvoice-v1' },
      },
    })).toBe('cosyvoice-v1')
    expect(getOnethingTTSModelName({
      tts: {
        provider: 'system-tts',
        system: { voice: 'Samantha' },
      },
    })).toBe('Samantha')
    expect(getOnethingTTSModelName({
      tts: {
        provider: 'system-tts',
        system: {},
      },
    })).toBe('system')
  })

  it('classifies wake failures that can fall back to the mic button', () => {
    expect(isOnethingWebSpeechWakeFailure('Wake phrase microphone permission was denied')).toBe(true)
    expect(isOnethingWebSpeechWakeFailure('Local wake engine failed: missing model')).toBe(true)
    expect(isOnethingWebSpeechWakeFailure('ordinary runtime error')).toBe(false)
  })

  it('disables always-on wake after a supported wake failure', () => {
    const settings = {
      theme: 'dark',
      voice: {
        enabled: true,
        alwaysOn: true,
        wake: {
          enabled: true,
          phrase: 'hey onething',
        },
      },
    }

    const result = applyOnethingVoiceWakeFailureFallback(settings, 'Wake phrase listener could not access a microphone')

    expect(result.applied).toBe(true)
    expect(result.settings).toEqual({
      theme: 'dark',
      voice: {
        enabled: true,
        alwaysOn: false,
        wake: {
          enabled: false,
          phrase: 'hey onething',
        },
      },
    })
    expect(settings.voice.alwaysOn).toBe(true)
    expect(settings.voice.wake.enabled).toBe(true)
  })

  it('does not change settings when wake fallback is not applicable', () => {
    const settings = {
      voice: {
        enabled: true,
        alwaysOn: true,
        wake: { enabled: true },
      },
    }

    expect(applyOnethingVoiceWakeFailureFallback(settings, 'ordinary runtime error')).toEqual({
      applied: false,
      settings,
    })
    expect(applyOnethingVoiceWakeFailureFallback({
      voice: {
        enabled: true,
        alwaysOn: false,
        wake: { enabled: true },
      },
    }, 'Wake word microphone permission was denied').applied).toBe(false)
  })

  it('projects runtime status changes without host state mutation', () => {
    const state = {
      status: 'error' as 'idle' | 'error',
      enabled: false,
      runtimeReady: false,
      updatedAt: 1,
      lastError: 'previous error',
    }

    expect(applyOnethingVoiceRuntimeStatus(state, {
      status: 'idle',
      voiceEnabled: true,
      runtimeReady: true,
      now: () => 42,
    })).toEqual({
      status: 'idle',
      enabled: true,
      runtimeReady: true,
      updatedAt: 42,
      lastError: undefined,
    })
    expect(state.lastError).toBe('previous error')
  })

  it('preserves the last error only for error status', () => {
    const state = {
      status: 'idle' as 'idle' | 'error',
      enabled: true,
      runtimeReady: true,
      updatedAt: 1,
    }

    expect(applyOnethingVoiceRuntimeError(state, {
      error: 'microphone failed',
      voiceEnabled: true,
      runtimeReady: false,
      now: () => 100,
    })).toEqual({
      status: 'error',
      enabled: true,
      runtimeReady: false,
      updatedAt: 100,
      lastError: 'microphone failed',
    })
  })

  it('creates latency milestones and attaches them to runtime state', () => {
    const milestone = createOnethingVoiceLatencyMilestone('tts-request-start', {
      requestId: 'request-1',
      elapsedMs: 12,
    }, () => 200)

    expect(milestone).toEqual({
      name: 'tts-request-start',
      at: 200,
      requestId: 'request-1',
      elapsedMs: 12,
    })
    expect(applyOnethingVoiceRuntimeMilestone({
      status: 'speaking',
      enabled: true,
      runtimeReady: true,
      updatedAt: 199,
    }, milestone)).toEqual({
      status: 'speaking',
      enabled: true,
      runtimeReady: true,
      updatedAt: 199,
      lastMilestone: milestone,
    })
  })
})
