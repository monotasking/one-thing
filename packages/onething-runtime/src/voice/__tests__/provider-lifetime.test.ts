import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { streamSynthesizeOnethingSpeech } from '../providers.js'

const sockets = vi.hoisted(() => ({ created: [] as Array<{ closed: boolean }> }))
vi.mock('../volcano/tts-session.js', () => ({
  getOnethingDoubaoTTSMimeType: () => 'audio/mpeg',
  OnethingDoubaoTTSConnection: class {
    closed = false
    get isUsable() { return !this.closed }
    constructor() { sockets.created.push(this) }
    async connect() {}
    async synthesize() {}
    close() { this.closed = true }
  },
}))

afterEach(() => { vi.useRealTimers(); sockets.created.length = 0 })

it('owns reusable Doubao sockets and idle timers by calling lifetime, even with the same credentials', async () => {
  vi.useFakeTimers()
  const settings = createDefaultSettings().voice!
  settings.tts.provider = 'doubao'
  settings.doubao.apiKey = 'test'
  const a = new AbortController()
  const b = new AbortController()
  try {
    await streamSynthesizeOnethingSpeech('a', settings, {}, { signal: a.signal })
    await streamSynthesizeOnethingSpeech('a again', settings, {}, { signal: a.signal })
    expect(sockets.created).toHaveLength(1)
    await streamSynthesizeOnethingSpeech('b', settings, {}, { signal: b.signal })
    expect(sockets.created).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(2)
    a.abort()
    expect(sockets.created.map(socket => socket.closed)).toEqual([true, false])
    expect(vi.getTimerCount()).toBe(1)
    await expect(streamSynthesizeOnethingSpeech('late a', settings, {}, { signal: a.signal })).rejects.toThrow()
    expect(sockets.created).toHaveLength(2)
    b.abort()
    expect(sockets.created.every(socket => socket.closed)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  } finally { a.abort(); b.abort() }
})
