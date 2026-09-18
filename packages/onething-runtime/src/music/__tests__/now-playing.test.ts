import { describe, expect, it, vi } from 'vitest'
import { createNowPlayingWatcher, parseNowPlaying, type OnethingMusicNowPlaying } from '../now-playing.js'
import type { OnethingMusicProcessRunner } from '../types.js'

/** A real `ncm-cli state` reply, captured 2026-07-16 while 可惜没如果 played. */
const PLAYING = JSON.stringify({
  success: true,
  state: {
    status: 'playing',
    title: '可惜没如果 - 林俊杰',
    position: 241.162071,
    duration: 298.293333,
    progress: '4:01 / 4:58',
    volume: null,
    currentIndex: 0,
    queueLength: 1,
  },
})

/** Paused. Note ncm-cli says "stopped" — the frozen position is the only tell. */
const PAUSED = JSON.stringify({
  success: true,
  state: { status: 'stopped', title: '秋风 - 徐化文', position: 7, volume: null, currentIndex: 0, queueLength: 1 },
})

const STOPPED = JSON.stringify({
  success: true,
  state: { status: 'stopped', position: 0, volume: null, currentIndex: 0, queueLength: 0 },
})

describe('parseNowPlaying', () => {
  it('reads everything the bar needs out of one local command', () => {
    expect(parseNowPlaying(PLAYING)).toEqual({
      status: 'playing',
      title: '可惜没如果 - 林俊杰',
      position: 241.162071,
      duration: 298.293333,
      progress: '4:01 / 4:58',
      queueLength: 1,
      currentIndex: 0,
    })
  })

  it('calls a frozen position paused, because ncm-cli has no paused status', () => {
    // Measured: pause → status "stopped", position frozen at 7.0, daemon alive
    // 50s later, resume works. Reading that as "stopped" would blank the bar at
    // someone who only hit pause.
    expect(parseNowPlaying(PAUSED)?.status).toBe('paused')
    expect(parseNowPlaying(PAUSED)?.position).toBe(7)
  })

  it('calls position 0 a real stop', () => {
    expect(parseNowPlaying(STOPPED)?.status).toBe('stopped')
  })

  it('reads through the upgrade banner ncm-cli prints on stdout (2026-09-18)', () => {
    // Byte-for-byte what `ncm-cli state 2>/dev/null` printed once 0.1.7 was
    // published: a blank line, the banner, a blank line, then the envelope.
    // Whole-stream JSON.parse read this as null — every start "failed" while
    // the songs played, and the panel said nothing was playing.
    const banner = '\n│ 有新版本: 0.1.6 → 0.1.7  运行 ncm-cli upgrade 升级\n\n'
    expect(parseNowPlaying(banner + JSON.stringify(JSON.parse(PLAYING), null, 2))?.status).toBe('playing')
    expect(parseNowPlaying(banner + PLAYING)?.title).toBe('可惜没如果 - 林俊杰')
  })

  it('returns null for output it cannot read, rather than a fake stop', () => {
    expect(parseNowPlaying('')).toBeNull()
    expect(parseNowPlaying('daemon 无响应（3s 超时）')).toBeNull()
    expect(parseNowPlaying('{"success":false,"message":"云音乐模式下不支持 state 命令"}')).toBeNull()
  })
})

function createHarness(options: { alive?: boolean; reply?: string } = {}) {
  const emitted: (OnethingMusicNowPlaying | null)[] = []
  let alive = options.alive ?? true
  let reply = options.reply ?? PLAYING
  const runs: string[][] = []

  const runner: OnethingMusicProcessRunner = {
    run: async ({ args }) => {
      runs.push(args)
      return { code: 0, stdout: reply, stderr: '' }
    },
    spawn: () => ({ done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }),
  }

  const watcher = createNowPlayingWatcher({
    runner,
    isPlayerRunning: () => alive,
    emit: value => emitted.push(value),
    logger: { warn: vi.fn() },
  })

  return {
    watcher,
    emitted,
    runs,
    setAlive: (value: boolean) => (alive = value),
    setReply: (value: string) => (reply = value),
  }
}

describe('createNowPlayingWatcher', () => {
  it('drains an actual in-flight poll and suppresses its sample after quiesce', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const emit = vi.fn()
    const onSample = vi.fn()
    const run = vi.fn(async () => { await held; return { code: 0, stdout: PLAYING, stderr: '' } })
    const watcher = createNowPlayingWatcher({ runner: { run, spawn: vi.fn() }, isPlayerRunning: () => true, emit, onSample })
    const first = watcher.refresh()
    const second = watcher.refresh()
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    watcher.quiesce()
    let drained = false
    const closing = watcher.drain().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(watcher.refresh()).rejects.toThrow('shutting down')
    expect(() => watcher.start()).toThrow('shutting down')
    release()
    await Promise.all([first, second, closing])
    expect(emit).not.toHaveBeenCalled()
    expect(onSample).not.toHaveBeenCalled()
    expect(watcher.current()).toBeNull()
  })
  it('reports what is playing', async () => {
    const h = createHarness()
    await h.watcher.refresh()

    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]?.title).toBe('可惜没如果 - 林俊杰')
  })

  it('spends nothing while no player is running', async () => {
    // An idle app must not burn a subprocess every few seconds to be told
    // "stopped". The daemon check is a file stat; `state` is a process.
    const h = createHarness({ alive: false })
    await h.watcher.refresh()

    expect(h.runs).toEqual([])
    // And says nothing either: the bar is already absent, so "still nothing"
    // is not news worth an IPC message.
    expect(h.emitted).toEqual([])
  })

  it('announces the player going away', async () => {
    const h = createHarness()
    await h.watcher.refresh()
    h.setAlive(false)
    await h.watcher.refresh()

    expect(h.emitted[h.emitted.length - 1]).toBeNull()
  })

  it('announces only what changed, so the bar does not get an IPC per second', async () => {
    const h = createHarness()
    await h.watcher.refresh()
    await h.watcher.refresh()
    await h.watcher.refresh()

    // Same song, three polls: the position moved but nobody needs to hear it —
    // the bar interpolates between polls.
    expect(h.emitted).toHaveLength(1)
  })

  it('announces a track change', async () => {
    const h = createHarness()
    await h.watcher.refresh()
    h.setReply(PAUSED)
    await h.watcher.refresh()

    expect(h.emitted).toHaveLength(2)
    expect(h.emitted[1]).toMatchObject({ status: 'paused', title: '秋风 - 徐化文' })
  })

  it('keeps the last answer when a read fails, instead of blinking out', async () => {
    // "I could not ask" is not "nothing is playing".
    const h = createHarness()
    await h.watcher.refresh()

    const failing = createNowPlayingWatcher({
      runner: {
        run: async () => {
          throw new Error('daemon 无响应（3s 超时）')
        },
        spawn: () => ({ done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }),
      },
      isPlayerRunning: () => true,
      emit: value => h.emitted.push(value),
      logger: { warn: vi.fn() },
    })
    await failing.refresh()

    expect(h.emitted).toHaveLength(1) // nothing new announced
  })

  it('stops polling when stopped', async () => {
    const h = createHarness()
    h.watcher.start()
    await h.watcher.refresh() // let the first tick land before measuring
    h.watcher.stop()

    const before = h.runs.length
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(h.runs.length).toBe(before)
    expect(h.watcher.current()).toBeNull()
  })
})
