import { describe, expect, it } from 'vitest'
import type { MusicRuntimeState } from '@shared/ipc/music'
import { zh } from '../../../i18n/zh'
import { en } from '../../../i18n/en'
import { deriveMusicStatus, MUSIC_STATUS_TABLE } from '../status'
import type { MusicStatusInput } from '../status'
import { MUSIC_SECTIONS } from '../sections'

/**
 * 状态单产地(音乐面 v9)的用例:优先序逐格一条,外加两条「表是数据」的反证 ——
 * 每一行的文案两种语言都有,每一个「去哪一格」都指得到分区表上真有的一格。
 */

const READY: MusicRuntimeState = {
  setupStage: 'ready',
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv',
  source: 'daily',
  login: { status: 'ok' },
}

function input(patch: Partial<MusicStatusInput> = {}): MusicStatusInput {
  return { runtime: READY, runtimeUnreachable: false, restored: false, opening: false, refilling: false, ...patch }
}

const PLAYING = { playing: true, status: 'playing' as const, title: '晴天 - 周杰伦', position: 3, queueLength: 0, currentIndex: 0 }
const STOPPED = { ...PLAYING, playing: false, status: 'paused' as const }
const ON = { active: true, intent: '雨天', programmeLength: 3, canResume: true }

describe('deriveMusicStatus:优先序', () => {
  it('state 还没读回来 → 连接中;读完了没读到 → 连不上', () => {
    expect(deriveMusicStatus(input({ runtime: undefined })).kind).toBe('connecting')
    expect(deriveMusicStatus(input({ runtime: undefined, runtimeUnreachable: true })).kind).toBe('unreachable')
  })

  it('没装好 / 没凭据 / 没登录 / 等扫码,各是各的一格,而且压过一切播放状态', () => {
    const with_ = (patch: Partial<MusicRuntimeState>) =>
      deriveMusicStatus(input({ runtime: { ...READY, ...patch }, nowPlaying: PLAYING, error: '坏了' })).kind
    expect(with_({ setupStage: 'env' })).toBe('setupEnv')
    expect(with_({ setupStage: 'credentials' })).toBe('setupCredentials')
    expect(with_({ setupStage: 'login', login: { status: 'idle' } })).toBe('setupLogin')
    expect(with_({ setupStage: 'login', login: { status: 'waiting', url: 'x' } })).toBe('loginWaiting')
  })

  it('出错压过在放,错话原文带在 vars 上', () => {
    const status = deriveMusicStatus(input({ nowPlaying: PLAYING, error: '电台没开' }))
    expect(status.kind).toBe('error')
    expect(status.vars.message).toBe('电台没开')
  })

  it('开台中 → opening;简报说在换歌 → starting(带歌名)', () => {
    expect(deriveMusicStatus(input({ opening: true, nowPlaying: PLAYING })).kind).toBe('opening')
    const starting = deriveMusicStatus(input({ brief: { ...ON, starting: '下一首 - 谁' } }))
    expect(starting.kind).toBe('starting')
    expect(starting.vars.title).toBe('下一首 - 谁')
  })

  it('在放 → playing;在放时 DJ 在补歌单也还是 playing(那件事归黑豆,09-18 裁定)', () => {
    expect(deriveMusicStatus(input({ nowPlaying: PLAYING })).kind).toBe('playing')
    expect(deriveMusicStatus(input({ nowPlaying: PLAYING, refilling: true })).kind).toBe('playing')
  })

  it('没在放:DJ 在补 → refilling;停着 → paused;画的是上次 → resumable', () => {
    expect(deriveMusicStatus(input({ refilling: true, brief: ON })).kind).toBe('refilling')
    expect(deriveMusicStatus(input({ nowPlaying: STOPPED })).kind).toBe('paused')
    expect(deriveMusicStatus(input({ nowPlaying: STOPPED, restored: true })).kind).toBe('resumable')
  })

  it('电台开着但什么都没在放:续得上 → stationIdle(带「接着放」);续不上 → DJ 在补', () => {
    const idle = deriveMusicStatus(input({ brief: ON }))
    expect(idle.kind).toBe('stationIdle')
    expect(idle.row.action?.kind).toBe('resume')
    expect(deriveMusicStatus(input({ brief: { ...ON, canResume: false } })).kind).toBe('refilling')
  })

  it('什么都没有 → off,指引去电台那一格', () => {
    const off = deriveMusicStatus(input({ brief: { active: false, intent: '', programmeLength: 0, canResume: false } }))
    expect(off.kind).toBe('off')
    expect(off.row.action).toEqual({ kind: 'section', section: 'radio', labelKey: 'music.status.goRadio' })
  })
})

describe('状态表是数据', () => {
  it('每一行的名字 / 指引 / 钮上的字,中英两份字典都有', () => {
    for (const row of Object.values(MUSIC_STATUS_TABLE)) {
      for (const key of [row.labelKey, row.hintKey, row.action?.labelKey]) {
        if (key === undefined) continue
        expect(zh[key]).toBeTruthy()
        expect(en[key]).toBeTruthy()
      }
    }
  })

  it('每一个「去哪一格」都指向分区表上真有的一格', () => {
    const ids = new Set(MUSIC_SECTIONS.map((row) => row.id))
    for (const row of Object.values(MUSIC_STATUS_TABLE)) {
      if (row.action?.kind === 'section') expect(ids.has(row.action.section)).toBe(true)
    }
  })

  it('要人注意的状态才上状态条:在放 / 暂停 / 关着不占一条横幅', () => {
    expect(MUSIC_STATUS_TABLE.playing.banner).toBe(false)
    expect(MUSIC_STATUS_TABLE.paused.banner).toBe(false)
    expect(MUSIC_STATUS_TABLE.off.banner).toBe(false)
    expect(MUSIC_STATUS_TABLE.unreachable.banner).toBe(true)
    expect(MUSIC_STATUS_TABLE.error.banner).toBe(true)
  })
})

describe('分区表', () => {
  it('id 不重;恰有一格住着接入向导,而且它不要登录', () => {
    const ids = MUSIC_SECTIONS.map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const setup = MUSIC_SECTIONS.filter((row) => row.hostsSetup)
    expect(setup).toHaveLength(1)
    expect(setup[0].requiresLogin).toBe(false)
  })

  it('每一格的名字中英两份都有', () => {
    for (const row of MUSIC_SECTIONS) {
      expect(zh[row.labelKey]).toBeTruthy()
      expect(en[row.labelKey]).toBeTruthy()
    }
  })
})
