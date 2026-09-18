import { describe, expect, it } from 'vitest'
import type { OnethingRadioBrief } from '@onething/runtime/music/radio-store'
import { LAST_PLAYBACK_WRITE_EVERY_MS, LastPlaybackRecorder } from '../last-playback.js'

function harness() {
  let brief: OnethingRadioBrief = { active: true, intent: '', played: [], skipped: [], loved: [] }
  let writes = 0
  let now = 1_000_000
  const store = { readBrief: () => brief, writeBrief: (next: OnethingRadioBrief) => { brief = next; writes += 1 } }
  const clock = { now: () => now }
  const recorder = new LastPlaybackRecorder(() => store, clock)
  return { recorder, brief: () => brief, writes: () => writes, tick: (ms: number) => { now += ms } }
}

const playing = (position: number, title = '柔软 - 房东的猫') => ({ status: 'playing' as const, title, position, duration: 195, queueLength: 1, currentIndex: 0 })

describe('LastPlaybackRecorder(09-19「播放状态找上次播放的状态」)', () => {
  it('电台起播的歌带 id;采样节流写盘,放↔停立刻写', () => {
    const h = harness()
    h.recorder.songStarted('柔软 - 房东的猫', 'F64', 195)
    expect(h.brief().lastPlayback).toMatchObject({ title: '柔软 - 房东的猫', encryptedId: 'F64', position: 0 })
    h.recorder.observe(playing(3))
    const afterFirst = h.writes()
    h.recorder.observe(playing(4))
    expect(h.writes()).toBe(afterFirst)
    h.tick(LAST_PLAYBACK_WRITE_EVERY_MS)
    h.recorder.observe(playing(19))
    expect(h.brief().lastPlayback?.position).toBe(19)
    h.recorder.observe({ ...playing(20), status: 'paused' })
    expect(h.brief().lastPlayback?.position).toBe(20)
  })

  it('守护进程没了(null)/ 真停在 0 —— 不覆盖上次的位置', () => {
    const h = harness()
    h.recorder.songStarted('柔软 - 房东的猫', 'F64', 195)
    h.recorder.observe({ ...playing(102), status: 'paused' })
    h.recorder.observe(null)
    h.recorder.observe({ status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 })
    expect(h.brief().lastPlayback?.position).toBe(102)
  })

  it('续播点:同一首、没放完、不是刚开头 → 那一秒;否则从头(undefined)', () => {
    const h = harness()
    h.recorder.songStarted('柔软 - 房东的猫', 'F64', 195)
    h.recorder.observe({ ...playing(102), status: 'paused' })
    expect(h.recorder.resumePoint('F64')).toBe(102)
    expect(h.recorder.resumePoint('OTHER')).toBeUndefined()
    h.recorder.observe({ ...playing(190), status: 'playing' })
    expect(h.recorder.resumePoint('F64')).toBeUndefined()
  })

  it('不是电台起的歌:不带 id,续播接不回去(只做显示)', () => {
    const h = harness()
    h.recorder.observe({ ...playing(50, '别人放的歌'), status: 'paused' })
    expect(h.brief().lastPlayback).toMatchObject({ title: '别人放的歌', position: 50 })
    expect(h.brief().lastPlayback).not.toHaveProperty('encryptedId')
  })
})
