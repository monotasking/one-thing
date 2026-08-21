import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { getOpenRouterTTSModels, getVoiceInputConfigurationError, streamSynthesizeSpeech, synthesizeSpeech, transcribeUtterance } from '../providers.js'

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => ({
    ai: {
      providers: {
        openai: { apiKey: '' },
        openrouter: { apiKey: '' },
      },
    },
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('voice input provider configuration', () => {
  it('requires a WebSocket URL for the streaming FunASR voice input path', () => {
    const settings = createDefaultSettings().voice!

    expect(getVoiceInputConfigurationError(settings)).toBe(
      'Add a FunASR WebSocket URL in Voice settings before using streaming voice input.',
    )

    settings.asr.funasr.url = 'http://127.0.0.1:10096/transcribe'
    expect(getVoiceInputConfigurationError(settings)).toBe(
      'FunASR streaming ASR needs a ws:// or wss:// WebSocket URL.',
    )

    settings.asr.funasr.url = 'ws://127.0.0.1:10095'

    expect(getVoiceInputConfigurationError(settings)).toBeNull()
  })

  it('keeps advanced provider errors specific to the chosen provider', () => {
    const settings = createDefaultSettings().voice!

    settings.asr.provider = 'funasr-server'
    expect(getVoiceInputConfigurationError(settings)).toBe(
      'Add a FunASR server URL in Advanced settings before using voice input.',
    )

    settings.asr.provider = 'openai-transcribe'
    expect(getVoiceInputConfigurationError(settings)).toBe(
      'OpenAI transcription is selected in Advanced settings, but no OpenAI API key is configured.',
    )
  })

  it('sends OpenRouter Whisper audio to the transcription endpoint', async () => {
    const settings = createDefaultSettings().voice!
    settings.asr.provider = 'openrouter-transcribe'
    settings.asr.openrouter.apiKey = 'sk-or-test'
    settings.asr.openrouter.model = 'openai/whisper-1'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      text: 'hello from voice',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await transcribeUtterance({
      audioBase64: 'UklGRiQA',
      mimeType: 'audio/wav',
      durationMs: 1200,
    }, settings)

    expect(result.text).toBe('hello from voice')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-or-test',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          input_audio: {
            data: 'UklGRiQA',
            format: 'wav',
          },
          model: 'openai/whisper-1',
        }),
      }),
    )
  })

  it('sends OpenRouter TTS through the speech endpoint and can reuse the ASR key', async () => {
    const settings = createDefaultSettings().voice!
    settings.asr.openrouter.apiKey = 'sk-or-test'
    settings.tts.provider = 'openrouter-tts'
    settings.tts.openrouter.model = 'openai/gpt-4o-mini-tts-2025-12-15'
    settings.tts.openrouter.voice = 'alloy'

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))

    const result = await synthesizeSpeech('hello from voice', settings)

    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.audioBase64).toBe('AQID')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-or-test',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini-tts-2025-12-15',
          input: 'hello from voice',
          voice: 'alloy',
          response_format: 'mp3',
        }),
      }),
    )
  })

  it('streams OpenRouter TTS chunks as they arrive', async () => {
    const settings = createDefaultSettings().voice!
    settings.asr.openrouter.apiKey = 'sk-or-test'
    settings.tts.provider = 'openrouter-tts'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]))
        controller.enqueue(new Uint8Array([3, 4]))
        controller.close()
      },
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    const chunks: number[][] = []
    const starts: string[] = []

    const result = await streamSynthesizeSpeech('hello stream', settings, {
      onStart: ({ mimeType }) => {
        starts.push(mimeType)
      },
      onChunk: chunk => {
        chunks.push(Array.from(chunk))
      },
    })

    expect(result.mimeType).toBe('audio/mpeg')
    expect(starts).toEqual(['audio/mpeg'])
    expect(chunks).toEqual([[1, 2], [3, 4]])
  })

  it('loads OpenRouter TTS models with supported voices', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{
        id: 'hexgrad/kokoro-82m',
        name: 'hexgrad: Kokoro 82M',
        description: 'Lightweight TTS',
        pricing: { prompt: '0.00000062', completion: '0' },
        supported_voices: ['zf_xiaobei', 'af_alloy'],
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const result = await getOpenRouterTTSModels(true)

    expect(result.models).toEqual([{
      id: 'hexgrad/kokoro-82m',
      name: 'hexgrad: Kokoro 82M',
      description: 'Lightweight TTS',
      pricing: { prompt: '0.00000062', completion: '0' },
      supportedVoices: ['zf_xiaobei', 'af_alloy'],
    }])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models?output_modalities=speech',
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: 'application/json',
        }),
      }),
    )
  })
})
