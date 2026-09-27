import { describe, expect, it } from 'vitest'
import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import { zh } from '../../../i18n/zh'
import { en } from '../../../i18n/en'
import { deriveHostStatus, hostStatusText } from '../host-status'

/**
 * 黑豆头顶那块状态牌(主持人抽屉 §16.2)的用例:优先序逐格一条 —— 每一种状态一行,外加
 * 「后端那一句是数据,原样上屏」与「固定那几句两种语言都有」两条反证。
 */

const READY: MusicRuntimeState = {
  setupStage: 'ready',
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv',
  source: 'daily',
  login: { status: 'ok' },
}

const ON: MusicRadioState = { active: true, intent: '雨天', programmeLength: 3, canResume: true }
const OFF: MusicRadioState = { active: false, intent: '', programmeLength: 0, canResume: false }
const PLAYING = { playing: true, status: 'playing' as const, title: '晴天 - 周杰伦', position: 3, queueLength: 0, currentIndex: 0 }

const t = (key: string) => (zh as Record<string, string>)[key] ?? key

describe('deriveHostStatus:一格状态一行', () => {
  it('没接入 / 没登录 → 睡着', () => {
    expect(deriveHostStatus({ runtime: undefined, brief: ON }).kind).toBe('asleep')
    expect(deriveHostStatus({ runtime: { ...READY, setupStage: 'login' }, brief: ON, nowPlaying: PLAYING }).kind).toBe('asleep')
  })

  it('电台关着 → 睡着(哪怕播放器自己在放)', () => {
    const status = deriveHostStatus({ runtime: READY, brief: OFF, nowPlaying: PLAYING })
    expect(status.kind).toBe('asleep')
    expect(hostStatusText(status, t)).toBe('睡着')
  })

  it('在干活、后端说得出在干什么 → 后端那一句原样上屏,种类取 doing.kind', () => {
    const status = deriveHostStatus({
      runtime: READY,
      brief: { ...ON, host: { working: true, doing: { kind: 'search', label: '在搜「周杰伦」' } } },
      nowPlaying: PLAYING,
    })
    expect(status.kind).toBe('search')
    expect(status.label).toEqual({ text: '在搜「周杰伦」' })
    expect(hostStatusText(status, t)).toBe('在搜「周杰伦」')
  })

  it('在干活、说不出在干什么 → 在挑歌;老后端只有 djWorking 也算', () => {
    expect(deriveHostStatus({ runtime: READY, brief: { ...ON, host: { working: true } }, nowPlaying: PLAYING }).kind).toBe('picking')
    expect(deriveHostStatus({ runtime: READY, brief: { ...ON, djWorking: true } }).kind).toBe('picking')
  })

  it('开台、在放 → 在放(简报里挂着的旧错话不抢这一格)', () => {
    expect(deriveHostStatus({ runtime: READY, brief: ON, nowPlaying: PLAYING }).kind).toBe('playing')
    expect(deriveHostStatus({ runtime: READY, brief: { ...ON, lastError: 'x' }, nowPlaying: PLAYING }).kind).toBe('playing')
  })

  it('开台、出错(简报 lastError 或记录流没读到)→ 出错了', () => {
    expect(deriveHostStatus({ runtime: READY, brief: { ...ON, lastError: 'boom' } }).kind).toBe('error')
    expect(deriveHostStatus({ runtime: READY, brief: ON, logFailed: true }).kind).toBe('error')
  })

  it('开台、闲着 → 醒着', () => {
    expect(deriveHostStatus({ runtime: READY, brief: ON, nowPlaying: { ...PLAYING, playing: false, status: 'paused' } }).kind).toBe('awake')
  })

  it('固定那几句两种语言都有', () => {
    const kinds = [
      deriveHostStatus({ runtime: undefined }),
      deriveHostStatus({ runtime: READY, brief: { ...ON, djWorking: true } }),
      deriveHostStatus({ runtime: READY, brief: ON, nowPlaying: PLAYING }),
      deriveHostStatus({ runtime: READY, brief: { ...ON, lastError: 'e' } }),
      deriveHostStatus({ runtime: READY, brief: ON }),
    ]
    for (const status of kinds) {
      expect('key' in status.label).toBe(true)
      if (!('key' in status.label)) continue
      expect((zh as Record<string, string>)[status.label.key]).toBeTruthy()
      expect((en as Record<string, string>)[status.label.key]).toBeTruthy()
    }
  })
})
