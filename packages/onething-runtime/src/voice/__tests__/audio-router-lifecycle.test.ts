import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { VoiceAudioRouter } from '../audio-router.wiring.js'

const state = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn() }))
vi.mock('../volcano/asr-session.js', () => ({
  OnethingDoubaoASRSession: class {
    connect = state.connect
    close = state.close
  },
}))

afterEach(() => vi.useRealTimers())

it('clears native recording timers immediately and drains a real pending connection before releasing the router', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const connected = new Promise<void>(resolve => { release = resolve })
  state.connect.mockReturnValue(connected)
  const hooks = { onPartialTranscript: vi.fn(), onFinalTranscript: vi.fn(), onRecordingError: vi.fn(), onWakeAudio: vi.fn() }
  const router = new VoiceAudioRouter(hooks)
  const opening = router.startDoubaoRecording(createDefaultSettings().voice!, 'session')
  expect(vi.getTimerCount()).toBe(1)
  const closing = router.shutdown()
  expect(vi.getTimerCount()).toBe(0)
  expect(state.close).toHaveBeenCalledOnce()
  let closed = false
  void closing.then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  await expect(router.startDoubaoRecording(createDefaultSettings().voice!, 'new')).rejects.toThrow('closed')
  release()
  await opening
  await closing
  expect(hooks.onFinalTranscript).not.toHaveBeenCalled()
  expect(hooks.onRecordingError).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
