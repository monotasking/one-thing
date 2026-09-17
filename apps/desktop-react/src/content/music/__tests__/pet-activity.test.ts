import { describe, expect, it } from 'vitest'
import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../../data/music-source'
import { MUSIC_DEFAULT_BPM, musicPetActivity, startingSay } from '../pet-activity'

/**
 * §8.1 那张表逐行钉:每一行一条用例,并且每一条都给出「下一行本来会命中」的读数,
 * 证明是**这一行**先命中(优先级就是设计)。
 */

const READY: MusicRuntimeState = {
  setupStage: 'ready',
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv',
  source: 'daily',
}
const RADIO_ON: MusicRadioState = { active: true, intent: '下雨天', programmeLength: 2, canResume: true }
const RADIO_OFF: MusicRadioState = { active: false, intent: '', programmeLength: 0, canResume: false }
const PLAYING: MusicNowPlayingView = {
  playing: true,
  status: 'playing',
  title: '雨棚下 - 旧电扇',
  position: 10,
  duration: 197,
  queueLength: 1,
  currentIndex: 0,
}
const PAUSED: MusicNowPlayingView = { ...PLAYING, playing: false, status: 'paused' }
const STOPPED: MusicNowPlayingView = { playing: false, status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
const PROGRAMME: MusicProgrammeView = { entries: [{ encryptedId: 'a', title: '慢车 - 林间录音', say: '下一张。' }] }
const EMPTY_PROGRAMME: MusicProgrammeView = { entries: [] }

describe('§8.1 活动表', () => {
  it('1 · nowPlaying 读法报错 → fault(哪怕在放)', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: PLAYING, nowError: '播放器没起来' })).toBe('fault')
  })

  it('1 · 后端 lastError 在 → fault(哪怕没配好)', () => {
    expect(musicPetActivity({ runtime: { ...READY, setupStage: 'login', lastError: '登录过期' } })).toBe('fault')
  })

  it('2 · 后端没配好 → off(哪怕电台开着)', () => {
    expect(musicPetActivity({ runtime: { ...READY, setupStage: 'login' }, brief: RADIO_ON, nowPlaying: STOPPED })).toBe('off')
  })

  it('3 · 电台关着且没在放 → off', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_OFF, nowPlaying: PAUSED })).toBe('off')
  })

  it('3 · 电台关着但播放器在放 → 不是 off(落到 rhythm)', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_OFF, nowPlaying: PLAYING })).toEqual({
      kind: 'rhythm',
      bpm: MUSIC_DEFAULT_BPM,
    })
  })

  it('3 · 简报还没读到 ≠ 关着', () => {
    expect(musicPetActivity({ runtime: READY, nowPlaying: STOPPED })).toBe('idle')
  })

  it('4 · brief.starting 在 → busy(哪怕在放)', () => {
    expect(musicPetActivity({ runtime: READY, brief: { ...RADIO_ON, starting: '慢车 - 林间录音' }, nowPlaying: PLAYING })).toBe(
      'busy',
    )
  })

  it('4 · 电台开着、节目单读到了且为空、没在放 → busy', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: STOPPED, programme: EMPTY_PROGRAMME })).toBe('busy')
  })

  it('4 · 节目单还没读到不算空', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: STOPPED })).toBe('idle')
  })

  it('4 · 节目单空但在放 → 不是 busy', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: PLAYING, programme: EMPTY_PROGRAMME })).toEqual({
      kind: 'rhythm',
      bpm: MUSIC_DEFAULT_BPM,
    })
  })

  it('5 · playing → rhythm,拍速用默认 90', () => {
    expect(MUSIC_DEFAULT_BPM).toBe(90)
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: PLAYING, programme: PROGRAMME })).toEqual({
      kind: 'rhythm',
      bpm: 90,
    })
  })

  it('6 · paused → still', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: PAUSED, programme: PROGRAMME })).toBe('still')
  })

  it('7 · 其余 → idle(电台开着、节目单有歌、播放器停着)', () => {
    expect(musicPetActivity({ runtime: READY, brief: RADIO_ON, nowPlaying: STOPPED, programme: PROGRAMME })).toBe('idle')
  })

  it('7 · 什么都还没读到 → idle', () => {
    expect(musicPetActivity({})).toBe('idle')
  })
})

describe('换歌时那一句开口', () => {
  const entries: MusicProgrammeView = {
    entries: [
      { encryptedId: 'a', title: '慢车 - 林间录音', say: '第一条的话。' },
      { encryptedId: 'b', title: '潮汐表 - 北岸电台', say: '  潮汐表那一句。 ' },
      { encryptedId: 'c', title: '十二楼的风 - 苏河' },
    ],
  }

  it('标题匹配那一条的 say(去掉首尾空白)', () => {
    expect(startingSay('潮汐表 - 北岸电台', entries)).toBe('潮汐表那一句。')
  })

  it('找不到匹配 → 第一条的 say', () => {
    expect(startingSay('不在单子上', entries)).toBe('第一条的话。')
  })

  it('匹配到了但那一条没有 say → 不说(不去借第一条的)', () => {
    expect(startingSay('十二楼的风 - 苏河', entries)).toBeUndefined()
  })

  it('节目单空 / 没读到 → 不说', () => {
    expect(startingSay('慢车 - 林间录音', { entries: [] })).toBeUndefined()
    expect(startingSay('慢车 - 林间录音', undefined)).toBeUndefined()
  })
})
