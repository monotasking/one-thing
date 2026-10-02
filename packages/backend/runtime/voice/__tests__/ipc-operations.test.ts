import { describe, expect, it } from 'vitest'
import {
  acknowledgeOnethingVoiceRuntimeReadyForIpc,
  getOnethingVoiceStateForIpc,
  handleOnethingVoiceRuntimeEventForIpc,
  listOnethingVoiceTTSModelsForIpc,
  testOnethingVoiceASRForIpc,
  testOnethingVoiceTTSForIpc,
} from '../ipc-operations.js'

describe('voice IPC operations', () => {
  it('formats voice state and runtime acknowledgements', () => {
    expect(getOnethingVoiceStateForIpc({
      getState: () => ({ status: 'idle' }),
    })).toEqual({
      success: true,
      state: { status: 'idle' },
    })

    const readySenders: string[] = []
    expect(acknowledgeOnethingVoiceRuntimeReadyForIpc({
      sender: 'webcontents-1',
      handleRuntimeReady: sender => readySenders.push(sender),
    })).toEqual({ success: true })
    expect(readySenders).toEqual(['webcontents-1'])

    const events: string[] = []
    expect(handleOnethingVoiceRuntimeEventForIpc({
      event: 'state',
      handleRuntimeEvent: event => events.push(event),
    })).toEqual({ success: true })
    expect(events).toEqual(['state'])
  })

  it('validates and formats ASR test responses', async () => {
    await expect(testOnethingVoiceASRForIpc({
      request: {},
      getVoiceSettings: () => ({ enabled: true }),
      transcribeUtterance: () => ({ text: 'ignored' }),
    })).resolves.toEqual({
      success: false,
      error: 'Attach or record audio before testing ASR.',
    })

    await expect(testOnethingVoiceASRForIpc({
      request: { audioBase64: 'abc', mimeType: 'audio/webm' },
      getVoiceSettings: () => ({ provider: 'test' }),
      transcribeUtterance: (utterance, settings) => ({
        text: `${utterance.mimeType}:${(settings as { provider: string }).provider}`,
        transcriptId: 'transcript-1',
      }),
    })).resolves.toEqual({
      success: true,
      transcript: 'audio/webm:test',
      transcriptId: 'transcript-1',
    })
  })

  it('formats TTS test and model list responses', async () => {
    await expect(testOnethingVoiceTTSForIpc({
      request: {},
      synthesize: request => ({ success: true, requestId: request.text }),
    })).resolves.toEqual({
      success: true,
      requestId: 'Voice test succeeded.',
    })

    await expect(listOnethingVoiceTTSModelsForIpc({
      request: { force: true },
      getTTSModels: force => ({
        models: [{ id: force ? 'fresh' : 'cached' }],
        fetchedAt: 123,
      }),
    })).resolves.toEqual({
      success: true,
      models: [{ id: 'fresh' }],
      fetchedAt: 123,
    })
  })

  it('normalizes host adapter failures', async () => {
    await expect(listOnethingVoiceTTSModelsForIpc({
      getTTSModels: () => {
        throw new Error('models failed')
      },
    })).resolves.toEqual({
      success: false,
      error: 'models failed',
    })

    expect(acknowledgeOnethingVoiceRuntimeReadyForIpc({
      sender: 'webcontents-1',
      handleRuntimeReady: () => {
        throw new Error('runtime failed')
      },
    })).toEqual({
      success: false,
      error: 'runtime failed',
    })
  })
})
