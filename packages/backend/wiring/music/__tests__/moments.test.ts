/**
 * 听歌这件事的事实与「有人说话时压低音乐」(宠物 P4,正本 §11.1 / §11.3 / §11.5 第三条)。
 * 钟是手摇的,播放器与音量都是假的 —— 从不起播放器、从不碰真音量文件。
 */
import { describe, expect, it } from 'vitest'
import type { OnethingMusicNowPlaying } from '@onething/runtime/music/index'
import { MusicMoments, RESUME_AFTER_PAUSE_MS, SKIP_STREAK_WINDOW_MS, type MusicMomentEvent } from '../moments.js'
import { SpeechActivityDuck } from '../player-volume.js'

class Clock {
  constructor(public t = 1_000_000) {}
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}

function setup() {
  const clock = new Clock()
  const facts: Array<[MusicMomentEvent, Record<string, unknown>]> = []
  const moments = new MusicMoments({ clock, emit: (event, payload) => facts.push([event, payload]) })
  return { clock, facts, moments }
}

function np(status: OnethingMusicNowPlaying['status'], title = '晴天 - 周杰伦', position = 0): OnethingMusicNowPlaying {
  return { status, title, position, queueLength: 1, currentIndex: 0 }
}

describe('MusicMoments · skip streak', () => {
  it('every skip is a fact; the third inside 90s is a streak, and the count starts over after it', () => {
    const { clock, facts, moments } = setup()
    moments.skipped('a')
    clock.advance(30_000)
    moments.skipped('b')
    clock.advance(30_000)
    moments.skipped('c')
    expect(facts).toEqual([
      ['skipped', { title: 'a' }],
      ['skipped', { title: 'b' }],
      ['skipped', { title: 'c' }],
      ['skipStreak', { count: 3, titles: ['a', 'b', 'c'] }],
    ])
    facts.length = 0
    clock.advance(1_000)
    moments.skipped('d')
    clock.advance(1_000)
    moments.skipped('e')
    expect(facts.map(([event]) => event)).toEqual(['skipped', 'skipped'])
  })

  it('skips that fall out of the 90s window do not count', () => {
    const { clock, facts, moments } = setup()
    moments.skipped('a')
    clock.advance(SKIP_STREAK_WINDOW_MS + 1)
    moments.skipped('b')
    clock.advance(10_000)
    moments.skipped('c')
    expect(facts.filter(([event]) => event === 'skipStreak')).toEqual([])
  })
})

describe('MusicMoments · resumed after pause', () => {
  it('measures pause → play between two observed transitions; five minutes or more is a fact', () => {
    const { clock, facts, moments } = setup()
    moments.observeNowPlaying(np('playing'))
    moments.observeNowPlaying(np('paused'))
    clock.advance(RESUME_AFTER_PAUSE_MS + 60_000)
    moments.observeNowPlaying(np('playing'))
    expect(facts).toEqual([['resumedAfterPause', { pausedMs: RESUME_AFTER_PAUSE_MS + 60_000, title: '晴天 - 周杰伦' }]])
  })

  it('a short pause is nothing; a repeated paused reading does not restart the clock', () => {
    const { clock, facts, moments } = setup()
    moments.observeNowPlaying(np('paused'))
    clock.advance(RESUME_AFTER_PAUSE_MS - 1_000)
    moments.observeNowPlaying(np('paused', '晴天 - 周杰伦', 1))
    clock.advance(500)
    moments.observeNowPlaying(np('playing'))
    expect(facts).toEqual([])

    moments.observeNowPlaying(np('paused'))
    clock.advance(RESUME_AFTER_PAUSE_MS - 1_000)
    moments.observeNowPlaying(np('paused', '晴天 - 周杰伦', 2))
    clock.advance(2_000)
    moments.observeNowPlaying(np('playing'))
    expect(facts.map(([event]) => event)).toEqual(['resumedAfterPause'])
  })

  it('a pause that ends in a stop (or the player going away) is not a pause coming back', () => {
    const { clock, facts, moments } = setup()
    moments.observeNowPlaying(np('paused'))
    clock.advance(RESUME_AFTER_PAUSE_MS * 2)
    moments.observeNowPlaying(null)
    moments.observeNowPlaying(np('playing'))
    expect(facts).toEqual([])
  })
})

describe('MusicMoments · interlude', () => {
  const lyrics = {
    title: '晴天 - 周杰伦',
    lines: [
      { at: 0, text: '作词 : 周杰伦' },
      { at: 20, text: '故事的小黄花' }, // 6 chars → sung until 22
      { at: 60, text: '刮风这天' },
      { at: 63, text: '我试过握着你手' },
    ],
  }

  it('fires once per song when the position enters a mid-song break of 12s or more', () => {
    const { facts, moments } = setup()
    moments.observeSample(np('playing', lyrics.title, 5), lyrics) // intro: no
    moments.observeSample(np('playing', lyrics.title, 21), lyrics) // still singing: no
    moments.observeSample(np('playing', lyrics.title, 30), lyrics) // in the break: yes
    moments.observeSample(np('playing', lyrics.title, 40), lyrics) // same song: no again
    expect(facts).toEqual([['interlude', { title: lyrics.title, atSeconds: 22, lengthSeconds: 38 }]])
  })

  it('never fires without a timeline for THIS song, while paused, or in the break tail', () => {
    const { facts, moments } = setup()
    moments.observeSample(np('playing', lyrics.title, 30), null)
    moments.observeSample(np('playing', '别的歌', 30), lyrics)
    moments.observeSample(np('paused', lyrics.title, 30), lyrics)
    moments.observeSample(np('playing', lyrics.title, 58.5), lyrics) // < 3s before the voice returns
    moments.observeSample(np('playing', lyrics.title, 64), { ...lyrics, lines: [] })
    expect(facts).toEqual([])
  })

  it('a new song (or the same song started again) may fire again', () => {
    const { facts, moments } = setup()
    moments.observeSample(np('playing', lyrics.title, 30), lyrics)
    moments.trackStarted({ title: lyrics.title })
    moments.observeSample(np('playing', lyrics.title, 30), lyrics)
    expect(facts.map(([event]) => event)).toEqual(['interlude', 'trackStarted', 'interlude'])
  })
})

describe('SpeechActivityDuck', () => {
  function duckHarness(initial: number | undefined, playing: boolean) {
    const state = { volume: initial, playing, sets: [] as number[], warns: [] as string[] }
    const duck = new SpeechActivityDuck({
      isPlaying: () => state.playing,
      read: () => state.volume,
      set: async level => { state.sets.push(level); state.volume = level; return true },
      warn: message => state.warns.push(message),
    })
    return { state, duck }
  }

  it('ducks to 35% while something speaks over a playing player, and restores after', async () => {
    const { state, duck } = duckHarness(80, true)
    duck.onActivity(true)
    await duck.settled()
    expect(state.volume).toBe(28)
    duck.onActivity(false)
    await duck.settled()
    expect(state.sets).toEqual([28, 80])
  })

  it('counts overlapping speech: ducks once, restores once, at the last end', async () => {
    const { state, duck } = duckHarness(60, true)
    duck.onActivity(true)
    duck.onActivity(true)
    duck.onActivity(false)
    await duck.settled()
    expect(state.sets).toEqual([21])
    duck.onActivity(false)
    await duck.settled()
    expect(state.sets).toEqual([21, 60])
  })

  it('does nothing when the player is not playing at the start, and ignores a stray end', async () => {
    const { state, duck } = duckHarness(80, false)
    duck.onActivity(false)
    duck.onActivity(true)
    state.playing = true // the song came up under the voice — not ducked mid-line
    duck.onActivity(false)
    await duck.settled()
    expect(state.sets).toEqual([])
  })
})
