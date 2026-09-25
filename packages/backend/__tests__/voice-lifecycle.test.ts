import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ tts: vi.fn(), asr: vi.fn() }))
vi.mock('../wiring/voice/providers.js', async importOriginal => ({
  ...await importOriginal<typeof import('../wiring/voice/providers.js')>(),
  streamSynthesizeSpeech: calls.tts,
  transcribeUtterance: calls.asr,
}))

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

let root: string
let backend: Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>> | undefined
let previous: string | undefined
const releases: Array<() => void> = []
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-lifecycle-'))
  previous = process.env.ONETHING_STORE_PATH
  vi.resetModules()
})
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  await backend?.dispose()
  backend = undefined
  if (previous === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previous
  await fs.rm(root, { recursive: true, force: true })
})

async function assemble(storePath: string, sendCommand: (command: import('@shared/ipc.js').VoiceRuntimeCommand) => void) {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({ storePath, owner: 'daemon', toolRegistry: 'headless', host: {
    storePath: {}, sandbox: {}, auth: null, logging: null, shell: null,
    voice: { runtimeWindow: { sendCommand } }, terminal: null, skillsEnvironment: null,
    todoPlan: null, scratchpad: null, plugins: null, gateway: null, settings: null,
    evals: null, mcp: null, localTrust: null, speechOutput: null, dialog: null,
  } })
}

it('owns real ASR/TTS completion through Backend shutdown and fences retained callbacks from the next host', { timeout: 60000 }, async () => {
  const oldCommands = vi.fn()
  const newCommands = vi.fn()
  const a = path.join(root, 'a')
  backend = await assemble(a, oldCommands)
  const { createSession } = await import('../stores/sessions.js')
  const { getSettings, saveSettings } = await import('../stores/settings.js')
  createSession('voice-session', 'Voice')
  const settings = getSettings()
  saveSettings({ ...settings, voice: { ...settings.voice!, enabled: true, tts: { ...settings.voice!.tts, autoSpeak: true, provider: 'openrouter-tts' } } })
  const { getVoiceService } = await import('../wiring/voice/service.js')
  const first = getVoiceService()
  const tts = barrier()
  const asr = barrier()
  const aborted = barrier()
  releases.push(tts.release, asr.release)
  let ttsSignal!: AbortSignal
  let asrSignal!: AbortSignal
  let retainedChunk!: (chunk: Uint8Array) => void
  calls.tts.mockImplementation(async (_text, _settings, handlers, signal: AbortSignal) => {
    ttsSignal = signal
    retainedChunk = handlers.onChunk
    signal.addEventListener('abort', aborted.release, { once: true })
    await tts.promise // Deliberately ignore abort: the owner must retain this work.
    handlers.onChunk(new Uint8Array([1, 2, 3]))
    return { mimeType: 'audio/mpeg' }
  })
  calls.asr.mockImplementation(async (_request, _settings, signal: AbortSignal) => {
    asrSignal = signal
    await asr.promise
    return { text: 'late recognized words', transcriptId: 'late', provider: 'openrouter-transcribe', model: 'whisper' }
  })
  const speaking = first.synthesize({ text: 'test speech' })
  const recognizing = first.submitUtterance({ sessionId: 'voice-session', audioBase64: 'AA==', mimeType: 'audio/wav' })
  const stopping = backend.dispose()
  await aborted.promise
  expect(ttsSignal.aborted).toBe(true)
  expect(asrSignal.aborted).toBe(true)
  const { inspectStoreLock } = await import('@onething/runtime/storage/store-lock')
  expect(inspectStoreLock({ storePath: a }).status).toBe('held')
  await expect(first.synthesize({ text: 'new work' })).resolves.toMatchObject({ success: false })
  tts.release()
  await speaking
  expect(inspectStoreLock({ storePath: a }).status).toBe('held')
  asr.release()
  await expect(recognizing).resolves.toMatchObject({ success: false })
  await stopping
  expect(inspectStoreLock({ storePath: a }).status).toBe('absent')
  backend = await assemble(path.join(root, 'b'), newCommands)
  expect(getVoiceService()).not.toBe(first)
  const oldCount = oldCommands.mock.calls.length
  const newCount = newCommands.mock.calls.length
  retainedChunk(new Uint8Array([4]))
  first.handleRuntimeEvent({ type: 'wake-detected', sessionId: 'voice-session' })
  await first.shutdown()
  expect(oldCommands).toHaveBeenCalledTimes(oldCount)
  expect(newCommands).toHaveBeenCalledTimes(newCount)
})
