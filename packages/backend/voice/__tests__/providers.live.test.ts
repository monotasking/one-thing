import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { describe, expect, it } from 'vitest'
import { getSettings } from '../../stores/settings.js'
import { transcribeUtterance } from '../providers.js'

const runLiveASR = process.env.ONETHING_LIVE_ASR_TEST === '1'

describe.skipIf(!runLiveASR)('voice ASR live integration', () => {
  it('transcribes generated speech through the configured OpenRouter ASR adapter', async () => {
    if (process.platform !== 'darwin') {
      throw new Error('Live ASR fixture generation currently uses macOS say/afconvert.')
    }

    const appSettings = getSettings()
    const voice = structuredClone(appSettings.voice!)
    const globalOpenRouterKey = (appSettings.ai.providers.openrouter as any)?.apiKey?.trim()
    const voiceOpenRouterKey = voice.asr.openrouter.apiKey?.trim()
    if (!globalOpenRouterKey && !voiceOpenRouterKey) {
      throw new Error('OpenRouter API key is required for the live ASR test.')
    }

    voice.asr.provider = 'openrouter-transcribe'
    voice.asr.openrouter.model = voice.asr.openrouter.model || 'openai/whisper-1'

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-live-asr-'))
    const aiffPath = path.join(tempDir, 'fixture.aiff')
    const wavPath = path.join(tempDir, 'fixture.wav')

    try {
      execFileSync('say', ['-o', aiffPath, 'hello one thing voice test'])
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiffPath, wavPath])

      const result = await transcribeUtterance({
        audioBase64: fs.readFileSync(wavPath).toString('base64'),
        mimeType: 'audio/wav',
        durationMs: 2000,
      }, voice)

      const normalized = result.text.toLowerCase().replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
      expect(result.provider).toBe('openrouter-transcribe')
      expect(result.model).toBe(voice.asr.openrouter.model)
      expect(normalized).toContain('voice test')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }, 90000)
})
