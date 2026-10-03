import { describe, expect, it } from 'vitest'
import { createDefaultSettings, mergeWithDefaults } from '../settings'

describe('voice settings defaults', () => {
  it('creates voice settings disabled by default', () => {
    const settings = createDefaultSettings()
    expect(settings.voice?.enabled).toBe(false)
    expect(settings.voice?.alwaysOn).toBe(false)
    expect(settings.voice?.wake.enabled).toBe(false)
    expect(settings.voice?.wake.provider).toBe('sherpa-kws')
    expect(settings.voice?.wake.sensitivity).toBe('medium')
    expect(settings.voice?.doubao.asrResourceId).toBe('volc.seedasr.sauc.duration')
    expect(settings.voice?.doubao.ttsResourceId).toBe('volc.service_type.10029')
    expect(settings.voice?.conversation.defaultAgentId).toBe('default')
    expect(settings.voice?.conversation.endpointing).toBe('fast')
    expect(settings.voice?.asr.provider).toBe('funasr-stream')
    expect(settings.voice?.tts.provider).toBe('system-tts')
    expect(settings.voice?.tts.openrouter.model).toBe('openai/gpt-4o-mini-tts-2025-12-15')
  })

  it('backfills voice settings for old settings files', () => {
    const settings = mergeWithDefaults({
      ai: createDefaultSettings().ai,
      theme: 'dark',
      general: createDefaultSettings().general,
      tools: createDefaultSettings().tools,
    })

    expect(settings.voice?.wake.phrase).toBe('你好小一')
    expect(settings.voice?.doubao.endWindowMs).toBe(800)
  })

  it('migrates the old seed-tts-2.0 resource id to the voice-list-compatible one', () => {
    const base = createDefaultSettings()
    base.voice!.doubao.ttsResourceId = 'seed-tts-2.0'
    const settings = mergeWithDefaults(base)
    expect(settings.voice?.doubao.ttsResourceId).toBe('volc.service_type.10029')
    expect(settings.voice?.conversation.endpointing).toBe('fast')
    expect(settings.voice?.vad.silenceMs).toBe(650)
    expect(settings.voice?.asr.openrouter.model).toBe('openai/whisper-1')
    expect(settings.voice?.asr.funasr.mode).toBe('2pass')
    expect(settings.voice?.asr.funasr.chunkInterval).toBe(10)
    expect(settings.voice?.tts.openrouter.voice).toBe('alloy')
  })
})
