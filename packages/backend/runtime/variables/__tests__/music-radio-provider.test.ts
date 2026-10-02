import { describe, expect, it } from 'vitest'
import { MusicRadioProvider, type MusicRadioGateway } from '../providers/music-radio.js'

function gateway(overrides: Partial<MusicRadioGateway> = {}): MusicRadioGateway {
  return {
    getNowPlaying: () => null,
    getRadio: () => ({ active: false, intent: '' }),
    getProgrammeLength: () => 0,
    ...overrides,
  }
}

describe('music radio variable', () => {
  it('stays silent when nothing plays and the radio is off', () => {
    const provider = new MusicRadioProvider(gateway())
    expect(provider.list()).toEqual([])
  })

  it('reports the playing song', () => {
    const provider = new MusicRadioProvider(
      gateway({ getNowPlaying: () => ({ status: 'playing', title: '岁月神偷 - 金玟岐' }) }),
    )
    const [variable] = provider.list()
    expect(variable.name).toBe('music')
    expect(variable.value).toBe('播放中「岁月神偷 - 金玟岐」')
    expect(variable.state).toBe(true)
  })

  it('carries the radio intent and programme watermark', () => {
    const provider = new MusicRadioProvider(
      gateway({
        getNowPlaying: () => ({ status: 'playing', title: '歌' }),
        getRadio: () => ({ active: true, intent: '雨天民谣' }),
        getProgrammeLength: () => 6,
      }),
    )
    expect(provider.list()[0].value).toBe('播放中「歌」 · 电台:雨天民谣(节目单剩 6 首)')
  })

  it('reports honestly when the radio is active but silent', () => {
    const provider = new MusicRadioProvider(
      gateway({
        getRadio: () => ({ active: true, intent: '雨天民谣', lastError: 'DJ 没接上' }),
        getProgrammeLength: () => 0,
      }),
    )
    const value = provider.list()[0].value
    expect(value).toContain('没有在放歌')
    expect(value).toContain('⚠ DJ 没接上')
  })

  it('never leaks positions or durations into the value', () => {
    // The background-jobs lesson: live numbers in the value defeat the
    // turn-channel dedupe and inject a new block every turn.
    const provider = new MusicRadioProvider(
      gateway({ getNowPlaying: () => ({ status: 'playing', title: '歌' }) }),
    )
    expect(provider.list()[0].value).not.toMatch(/\d+:\d{2}|\d+s|position/i)
  })
})
