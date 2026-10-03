import { describe, expect, it, vi } from 'vitest'
import {
  getOnethingOpenRouterTTSModels,
  getOnethingVoiceInputConfigurationError,
  streamSynthesizeOnethingSpeech,
  transcribeOnethingUtterance,
  type OnethingVoiceFetch,
  type OnethingVoiceSettingsLike,
} from '../providers.js'

function createVoiceSettings(overrides: Partial<OnethingVoiceSettingsLike> = {}): OnethingVoiceSettingsLike {
  return {
    asr: {
      provider: 'openai-transcribe',
      openai: { apiKey: '', model: 'gpt-4o-transcribe', language: '' },
      openrouter: { apiKey: '', model: 'openai/whisper-1', language: '' },
      funasr: { url: '', language: 'auto', hotwords: '' },
      ...overrides.asr,
    },
    tts: {
      provider: 'openai-tts',
      openai: { apiKey: '', model: 'gpt-4o-mini-tts', voice: 'alloy' },
      openrouter: { apiKey: '', model: 'openai/gpt-4o-mini-tts-2025-12-15', voice: 'alloy' },
      qwen: { baseUrl: '', apiKey: '', model: 'cosyvoice-v1', voice: 'longxiaochun' },
      ...overrides.tts,
    },
  }
}

describe('voice provider runtime', () => {
  it('validates input configuration with host-provided provider keys', () => {
    const settings = createVoiceSettings({
      asr: {
        provider: 'openrouter-transcribe',
        openai: { apiKey: '', model: '', language: '' },
        openrouter: { apiKey: '', model: 'openai/whisper-1', language: '' },
        funasr: { url: '', language: 'auto', hotwords: '' },
      },
    })

    expect(getOnethingVoiceInputConfigurationError(settings)).toBe(
      'Add an OpenRouter API key in Voice settings before using voice input.',
    )
    expect(getOnethingVoiceInputConfigurationError(settings, {
      providerApiKeys: { openrouter: 'provider-openrouter-key' },
    })).toBeNull()
  })

  it('loads and caches OpenRouter speech models', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        {
          id: 'openai/gpt-4o-mini-tts',
          name: 'GPT 4o Mini TTS',
          description: 'speech model',
          pricing: { prompt: '1', completion: '2' },
          supported_voices: ['alloy', 'verse'],
        },
      ],
    }), { status: 200 })) as unknown as OnethingVoiceFetch

    const first = await getOnethingOpenRouterTTSModels(true, {
      fetch: fetchImpl,
      now: () => 1000,
      createAbortSignal: () => undefined,
    })
    const second = await getOnethingOpenRouterTTSModels(false, {
      fetch: vi.fn(async () => {
        throw new Error('cache should be used')
      }) as unknown as OnethingVoiceFetch,
      now: () => 1001,
      createAbortSignal: () => undefined,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first.models).toEqual([{
      id: 'openai/gpt-4o-mini-tts',
      name: 'GPT 4o Mini TTS',
      description: 'speech model',
      pricing: { prompt: '1', completion: '2' },
      supportedVoices: ['alloy', 'verse'],
    }])
  })

  it('transcribes with provider fallback keys and injected ids', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer provider-openai-key' })
      expect(init?.method).toBe('POST')
      return new Response(JSON.stringify({ text: ' hello from voice ' }), { status: 200 })
    }) as unknown as OnethingVoiceFetch

    const result = await transcribeOnethingUtterance({
      audioBase64: Buffer.from('audio').toString('base64'),
      mimeType: 'audio/webm',
    }, createVoiceSettings(), {
      fetch: fetchImpl,
      providerApiKeys: { openai: 'provider-openai-key' },
      createId: () => 'transcript-1',
      createAbortSignal: () => undefined,
    })

    expect(result).toEqual({
      text: 'hello from voice',
      transcriptId: 'transcript-1',
      provider: 'openai-transcribe',
      model: 'gpt-4o-transcribe',
    })
  })

  it('streams TTS audio through runtime provider handlers', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mp3' },
    })) as unknown as OnethingVoiceFetch
    const started: string[] = []
    const chunks: number[] = []

    const result = await streamSynthesizeOnethingSpeech('hello', createVoiceSettings(), {
      onStart: metadata => {
        started.push(metadata.mimeType)
      },
      onChunk: chunk => {
        chunks.push(...chunk)
      },
    }, {
      fetch: fetchImpl,
      providerApiKeys: { openai: 'provider-openai-key' },
      createAbortSignal: () => undefined,
    })

    expect(result).toEqual({ mimeType: 'audio/mpeg' })
    expect(started).toEqual(['audio/mpeg'])
    expect(chunks).toEqual([1, 2, 3])
  })
})
