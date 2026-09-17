/**
 * 主持人声音的**缺省实现**(宠物 P3,正本 `docs/design/pet-system-2026-09.md` §10.2 / §10.7)。
 *
 * 钉四件事:
 *  ① 没有出声端口、也没有语音宿主 → `speak` **立刻** resolve(回归:从前推给没人听的渲染进程,
 *     空等 30 秒回执);
 *  ② 有出声端口 → 在进程里放,`onVoiceStart` 排在放之前;
 *  ③ 口播缓存只有一份:预取之后再说不重复合成;带调法(宠物的嗓子)是另一段录音;
 *  ④ 中止信号一路递到出声端口。
 *
 * 合成是假的(`synthesizeSpeech` 被换掉),出声端口是假的 —— 这份测试从不出声。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceSettings } from '@shared/ipc.js'

const mocks = vi.hoisted(() => ({
  synthesize: vi.fn(),
  broadcast: vi.fn(),
}))

vi.mock('../../voice/providers.js', () => ({ synthesizeSpeech: mocks.synthesize }))
vi.mock('../../../stores/settings.js', () => ({
  getSettings: () => ({ voice: { tts: { provider: 'openai-tts', system: { rate: 1, pitch: 1 } } } }),
}))
vi.mock('@onething/runtime/voice/host-ports.wiring', async importOriginal => ({
  ...(await importOriginal<typeof import('@onething/runtime/voice/host-ports.wiring')>()),
  broadcastVoiceHostMessage: mocks.broadcast,
}))

import { configureSpeechOutputHost, resetSpeechOutputHost } from '@onething/runtime/voice/speech-output'
import { resetVoiceHost } from '@onething/runtime/voice/host-ports.wiring'
import { createDjVoiceScope } from '../dj-voice.js'
import { createHostVoiceKit } from '../host-voice.js'

type Scope = ReturnType<typeof createDjVoiceScope>
let scope: Scope | undefined

beforeEach(() => {
  mocks.synthesize.mockReset()
  mocks.synthesize.mockResolvedValue({ audioBase64: 'QUJD', mimeType: 'audio/mpeg' })
  mocks.broadcast.mockReset()
  resetSpeechOutputHost()
  resetVoiceHost()
})

afterEach(async () => {
  await scope?.drain()
  scope = undefined
  resetSpeechOutputHost()
  resetVoiceHost()
})

describe('default host voice (dj-voice)', () => {
  it('① 无出声端口、无语音宿主:立刻说完,不推送、不空等', async () => {
    scope = createDjVoiceScope()
    const kit = createHostVoiceKit(scope)
    const started = Date.now()
    const onVoiceStart = vi.fn(async () => {})
    await kit.fallback.speak('下一首是一首老歌。', { title: 'song', overMusic: false, onVoiceStart })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(mocks.synthesize).toHaveBeenCalledTimes(1)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('② 有出声端口:在进程里放,压音量的钩子排在放之前', async () => {
    const order: string[] = []
    const play = vi.fn(async (audio: { base64: string; mimeType: string }) => {
      order.push(`play:${audio.base64}:${audio.mimeType}`)
    })
    configureSpeechOutputHost({ play })
    scope = createDjVoiceScope()
    const kit = createHostVoiceKit(scope)
    await kit.fallback.speak('下一首。', {
      title: 'song',
      overMusic: true,
      onVoiceStart: async () => {
        order.push('duck')
      },
    })
    expect(order).toEqual(['duck', 'play:QUJD:audio/mpeg'])
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('② 合成失败(没配语音 / 网络):不放、不压音量', async () => {
    const play = vi.fn(async () => {})
    configureSpeechOutputHost({ play })
    mocks.synthesize.mockRejectedValue(new Error('no network'))
    scope = createDjVoiceScope()
    const onVoiceStart = vi.fn(async () => {})
    await createHostVoiceKit(scope).fallback.speak('下一首。', { title: 'song', overMusic: true, onVoiceStart })
    expect(play).not.toHaveBeenCalled()
    expect(onVoiceStart).not.toHaveBeenCalled()
  })

  it('③ 一份缓存:预取之后再说不重复合成;带调法是另一段录音', async () => {
    configureSpeechOutputHost({ play: async () => {} })
    scope = createDjVoiceScope()
    const kit = createHostVoiceKit(scope)
    kit.fallback.prefetch('同一句。', 'song')
    await kit.fallback.speak('同一句。', { title: 'song', overMusic: false })
    expect(mocks.synthesize).toHaveBeenCalledTimes(1)

    const style = {
      key: 'pet:heidou',
      apply: (settings: VoiceSettings) => ({ ...settings, tts: { ...settings.tts, system: { ...settings.tts.system, rate: 1.1 } } }),
    }
    await kit.synthesize('同一句。', 'song', style)
    await kit.synthesize('同一句。', 'song', style)
    expect(mocks.synthesize).toHaveBeenCalledTimes(2)
    expect((mocks.synthesize.mock.calls[1]?.[1] as VoiceSettings).tts.system.rate).toBe(1.1)
  })

  it('④ 中止信号递到出声端口', async () => {
    let seen: AbortSignal | undefined
    configureSpeechOutputHost({
      play: (_audio, signal) => {
        seen = signal
        return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      },
    })
    scope = createDjVoiceScope()
    const abort = new AbortController()
    const speaking = createHostVoiceKit(scope).fallback.speak('长长的一句。', { title: 'song', overMusic: false, signal: abort.signal })
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect(seen?.aborted).toBe(false)
    abort.abort()
    await speaking
    expect(seen?.aborted).toBe(true)
  })
})
