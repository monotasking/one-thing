import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'

const mocks = {
  settings: null as any,
  commands: [] as any[],
  windows: [] as any[],
  eventHandler: null as any,
  streamHandler: null as any,
  sendVoiceRuntimeCommand: vi.fn(),
  transcribeUtterance: vi.fn(),
  streamSynthesizeSpeech: vi.fn(),
  getVoiceInputConfigurationError: vi.fn(() => null),
}

mocks.sendVoiceRuntimeCommand.mockImplementation((command: any) => {
  mocks.commands.push(command)
})

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => mocks.windows),
  },
}))

vi.mock('../../stores/settings.js', () => ({
  getSettings: () => mocks.settings,
  saveSettings: vi.fn(),
}))

vi.mock('../../stores/app-state.js', () => ({
  getCurrentSessionId: () => 'session-1',
}))

vi.mock('../../events/index.js', () => ({
  getEventBus: () => ({
    emit: vi.fn(),
    onAny: vi.fn((_sessionId: string, handler: any) => {
      mocks.eventHandler = handler
      return vi.fn()
    }),
  }),
  getStreamChannel: () => ({
    subscribe: vi.fn((_sessionId: string, handler: any) => {
      mocks.streamHandler = handler
      return vi.fn()
    }),
  }),
}))

vi.mock('../../engine/index.js', () => ({
  getStreamEngineSafe: () => null,
}))

vi.mock('../../wiring/agents/index.js', () => ({
  agentExists: () => false,
}))

vi.mock('../../stores/sessions.js', () => ({
  updateSessionAgent: vi.fn(),
}))

// The service reaches the runtime window/tray through late-bound host ports —
// configure the real port module with test doubles instead of module mocks.
import { configureVoiceHost } from '../host-ports.js'

configureVoiceHost({
  broadcastMessage: ({ channel, payload, exceptWebContentsId }) => {
    for (const window of mocks.windows) {
      if (window.isDestroyed()) continue
      if (window.webContents.id === exceptWebContentsId) continue
      window.webContents.send(channel, payload)
    }
  },
  runtimeWindow: {
    ensure: vi.fn(),
    destroy: vi.fn(),
    flushCommands: vi.fn(),
    isReady: () => true,
    markReady: vi.fn(),
    sendCommand: mocks.sendVoiceRuntimeCommand,
  },
  updateTray: vi.fn(),
})

vi.mock('../providers.js', () => ({
  getVoiceInputConfigurationError: mocks.getVoiceInputConfigurationError,
  streamSynthesizeSpeech: mocks.streamSynthesizeSpeech,
  transcribeUtterance: mocks.transcribeUtterance,
}))

describe('voice service TTS', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.commands = []
    mocks.windows = []
    mocks.eventHandler = null
    mocks.streamHandler = null
    mocks.settings = createDefaultSettings()
    mocks.settings.voice.enabled = true
    mocks.settings.voice.tts.provider = 'system-tts'
    mocks.settings.voice.tts.autoSpeak = true
    mocks.transcribeUtterance.mockResolvedValue({
      transcriptId: 'transcript-1',
      text: 'hello',
      provider: 'openrouter-transcribe',
      model: 'openai/whisper-1',
    })
    mocks.streamSynthesizeSpeech.mockImplementation(async (_text: string, _settings: any, handlers: any) => {
      await handlers.onStart?.({ mimeType: 'audio/mpeg' })
      await handlers.onChunk?.(new Uint8Array([1, 2, 3]))
      return { mimeType: 'audio/mpeg' }
    })
    const { getVoiceServiceSafe } = await import('../service.js')
    getVoiceServiceSafe()?.shutdown()
    mocks.commands = []
    mocks.eventHandler = null
    mocks.streamHandler = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends system TTS text to the voice runtime', async () => {
    const { getVoiceService } = await import('../service.js')

    const result = await getVoiceService().synthesize({ text: 'Hello TTS.' })

    expect(result.success).toBe(true)
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith({
      type: 'speak-text',
      requestId: expect.any(String),
      text: 'Hello TTS.',
      voice: '',
      language: '',
      rate: 1,
      pitch: 1,
    })
  })

  it('falls back to system TTS when selected cloud TTS has no API key', async () => {
    mocks.settings.voice.tts.provider = 'openai-tts'
    mocks.streamSynthesizeSpeech.mockRejectedValueOnce(new Error('OpenAI API key is required for voice TTS.'))
    const { getVoiceService } = await import('../service.js')

    const result = await getVoiceService().synthesize({ text: 'Fallback voice.' })

    expect(result.success).toBe(true)
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith({
      type: 'speak-text',
      requestId: expect.any(String),
      text: 'Fallback voice.',
      voice: '',
      language: '',
      rate: 1,
      pitch: 1,
    })
  })

  it('falls back to system TTS when selected OpenRouter TTS has no key', async () => {
    mocks.settings.voice.tts.provider = 'openrouter-tts'
    mocks.streamSynthesizeSpeech.mockRejectedValueOnce(new Error('OpenRouter API key is required for voice TTS.'))
    const { getVoiceService } = await import('../service.js')

    const result = await getVoiceService().synthesize({ text: 'OpenRouter fallback voice.' })

    expect(result.success).toBe(true)
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
      text: 'OpenRouter fallback voice.',
    }))
  })


  it('returns TTS errors that are not configuration fallbacks', async () => {
    mocks.settings.voice.tts.provider = 'openai-tts'
    mocks.streamSynthesizeSpeech.mockRejectedValueOnce(new Error('OpenAI TTS failed (500): unavailable'))
    const { getVoiceService } = await import('../service.js')

    const result = await getVoiceService().synthesize({ text: 'Cloud voice.' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('OpenAI TTS failed')
  })

  it('streams cloud TTS chunks to the voice runtime', async () => {
    mocks.settings.voice.tts.provider = 'openrouter-tts'
    mocks.streamSynthesizeSpeech.mockImplementationOnce(async (_text: string, _settings: any, handlers: any) => {
      await handlers.onStart?.({ mimeType: 'audio/mpeg' })
      await handlers.onChunk?.(new Uint8Array([1, 2]))
      await handlers.onChunk?.(new Uint8Array([3]))
      return { mimeType: 'audio/mpeg' }
    })
    const { getVoiceService } = await import('../service.js')

    const result = await getVoiceService().synthesize({ text: 'Cloud voice.' })

    expect(result.success).toBe(true)
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-start',
      mimeType: 'audio/mpeg',
    }))
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-chunk',
      chunkBase64: 'AQI=',
    }))
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-chunk',
      chunkBase64: 'Aw==',
    }))
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-end',
    }))
    expect(mocks.sendVoiceRuntimeCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio',
    }))
  })

  it('forwards cloud TTS chunks before the provider stream finishes', async () => {
    mocks.settings.voice.tts.provider = 'openrouter-tts'
    const send = vi.fn()
    mocks.windows = [{
      isDestroyed: () => false,
      webContents: { id: 7, send },
    }]
    let resolveStream!: () => void
    mocks.streamSynthesizeSpeech.mockImplementationOnce(async (_text: string, _settings: any, handlers: any) => {
      await handlers.onStart?.({ mimeType: 'audio/mpeg' })
      await handlers.onChunk?.(new Uint8Array([9, 8]))
      await new Promise<void>(resolve => {
        resolveStream = resolve
      })
      return { mimeType: 'audio/mpeg' }
    })
    const { getVoiceService } = await import('../service.js')

    const resultPromise = getVoiceService().synthesize({ text: 'Cloud voice.' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-start',
      mimeType: 'audio/mpeg',
    }))
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-chunk',
      chunkBase64: 'CQg=',
    }))
    const milestoneNamesBeforeEnd = send.mock.calls
      .map((call: any[]) => call[1])
      .filter((event: any) => event?.type === 'latency-milestone')
      .map((event: any) => event.milestone.name)
    expect(milestoneNamesBeforeEnd).toEqual(expect.arrayContaining([
      'tts-request-start',
      'tts-audio-stream-start',
      'tts-first-audio-chunk',
    ]))
    expect(milestoneNamesBeforeEnd).not.toContain('tts-audio-stream-end')

    let settled = false
    void resultPromise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveStream()
    const result = await resultPromise

    expect(result.success).toBe(true)
    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'play-audio-stream-end',
    }))
    const milestoneNamesAfterEnd = send.mock.calls
      .map((call: any[]) => call[1])
      .filter((event: any) => event?.type === 'latency-milestone')
      .map((event: any) => event.milestone.name)
    expect(milestoneNamesAfterEnd).toContain('tts-audio-stream-end')
  })

  it('speaks assistant stream text for a voice-originated turn', async () => {
    const { getVoiceService } = await import('../service.js')

    await getVoiceService().submitUtterance({
      sessionId: 'session-1',
      audioBase64: 'audio',
      mimeType: 'audio/wav',
      durationMs: 500,
    })

    expect(mocks.streamHandler).toEqual(expect.any(Function))
    expect(mocks.eventHandler).toEqual(expect.any(Function))

    mocks.streamHandler({ type: 'text-delta', text: 'Hello from voice.' })
    mocks.eventHandler({
      sessionId: 'session-1',
      event: { type: 'stream:complete', data: {} },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith({
      type: 'speak-text',
      requestId: expect.any(String),
      text: 'Hello from voice.',
      voice: '',
      language: '',
      rate: 1,
      pitch: 1,
    })
  })

  it('starts speaking a completed streamed sentence before the assistant turn completes', async () => {
    const { getVoiceService } = await import('../service.js')

    await getVoiceService().submitUtterance({
      sessionId: 'session-1',
      audioBase64: 'audio',
      mimeType: 'audio/wav',
      durationMs: 500,
    })

    mocks.streamHandler({ type: 'text-delta', text: 'First sentence.' })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
      text: 'First sentence.',
    }))
  })

  it('flushes buffered assistant text after a short streaming pause', async () => {
    vi.useFakeTimers()
    const { getVoiceService } = await import('../service.js')

    await getVoiceService().submitUtterance({
      sessionId: 'session-1',
      audioBase64: 'audio',
      mimeType: 'audio/wav',
      durationMs: 500,
    })

    mocks.streamHandler({
      type: 'text-delta',
      text: 'I can start speaking before punctuation arrives',
    })
    expect(mocks.sendVoiceRuntimeCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
    }))

    vi.advanceTimersByTime(650)
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
      text: 'I can start speaking before punctuation arrives',
    }))
  })

  it('speaks visible assistant text even if a legacy speak protocol field is present', async () => {
    const { getVoiceService } = await import('../service.js')

    await getVoiceService().submitUtterance({
      sessionId: 'session-1',
      audioBase64: 'audio',
      mimeType: 'audio/wav',
      durationMs: 500,
    })

    mocks.streamHandler({ type: 'text-delta', text: 'Visible details.', voiceSpeakText: 'Spoken summary.' })
    mocks.eventHandler({
      sessionId: 'session-1',
      event: { type: 'stream:complete', data: {} },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(mocks.sendVoiceRuntimeCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
      text: 'Visible details.',
    }))
    expect(mocks.sendVoiceRuntimeCommand).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'speak-text',
      text: 'Spoken summary.',
    }))
  })
})
