import { describe, expect, it } from 'vitest'
import { reconcilePlayback, withPlaying } from '../music-playback'
import type { MusicNowPlayingView } from '../music-source'

const PLAYING: MusicNowPlayingView = {
  playing: true,
  status: 'playing',
  title: '晴天 - 周杰伦',
  position: 30,
  queueLength: 0,
  currentIndex: 0,
}

describe('reconcilePlayback(09-25「前后端一致、点击及时响应」)', () => {
  it('没有意图:读数原样', () => {
    expect(reconcilePlayback(PLAYING, 1, null)).toEqual({ view: PLAYING, intent: null, disagreed: false })
  })

  it('还在发(没有 ackTicket):「在放」那一格听人的,哪怕读数说还在放', () => {
    const r = reconcilePlayback(PLAYING, 5, { playing: false })
    expect(r.view.playing).toBe(false)
    expect(r.view.status).toBe('paused')
    expect(r.view.title).toBe(PLAYING.title)
    expect(r.intent).toEqual({ playing: false })
  })

  it('确认之前发出去的读数(票号 ≤ ackTicket)不是权威:照样听人的', () => {
    const r = reconcilePlayback(PLAYING, 7, { playing: false, ackTicket: 7 })
    expect(r.view.playing).toBe(false)
    expect(r.intent).not.toBeNull()
  })

  it('确认之后的读数与意图一致:意图功成身退,不出声', () => {
    const r = reconcilePlayback(withPlaying(PLAYING, false), 8, { playing: false, ackTicket: 7 })
    expect(r).toEqual({ view: withPlaying(PLAYING, false), intent: null, disagreed: false })
  })

  it('确认之后的读数与意图不一致:照读数画,并且要说一句(不许静默改回去)', () => {
    const r = reconcilePlayback(PLAYING, 8, { playing: false, ackTicket: 7 })
    expect(r.view.playing).toBe(true)
    expect(r.intent).toBeNull()
    expect(r.disagreed).toBe(true)
  })

  it('播放器那边已经没歌了:意图作废,听读数', () => {
    const gone: MusicNowPlayingView = { playing: false, status: 'stopped', position: 0, queueLength: 0, currentIndex: 0 }
    expect(reconcilePlayback(gone, 3, { playing: true })).toEqual({ view: gone, intent: null, disagreed: false })
  })
})
