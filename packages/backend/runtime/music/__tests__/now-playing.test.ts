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

/**
 * 2026-09-25「点击及时响应 / 前后端一致」:按了暂停的那一刻,5 秒一拍的 `state` 可能正在路上 ——
 * 它是暂停之前起的,落地时带的是「还在放」。从前它照样被公布,于是每一个客户端都被打回「在放」,
 * 等暂停的回读到了再翻回来(屏幕上 播放 → 暂停 → 播放 跳一下)。
 */
describe('createNowPlayingWatcher · commands', () => {
  function heldWatcher() {
    const replies: Array<{ release: (stdout: string) => void }> = []
    const emit = vi.fn()
    const onSample = vi.fn()
    const run = vi.fn(
      () =>
        new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
          replies.push({ release: stdout => resolve({ code: 0, stdout, stderr: '' }) })
        }),
    )
    const watcher = createNowPlayingWatcher({ runner: { run, spawn: vi.fn() }, isPlayerRunning: () => true, emit, onSample })
    return { watcher, replies, emit, onSample, run }
  }

  it('drops a read that started before the command, even though it lands after it', async () => {
    const h = heldWatcher()
    const stale = h.watcher.refresh() // the 5s tick, spawned just before the click
    await Promise.resolve()
    h.watcher.beginCommand() // the pause goes out
    h.replies[0].release(PLAYING) // …and the old read lands saying "playing"
    await stale
    expect(h.emit).not.toHaveBeenCalled()
    expect(h.onSample).not.toHaveBeenCalled()
  })

  it('refresh() after a command starts a fresh read instead of reusing the stale one in flight', async () => {
    const h = heldWatcher()
    void h.watcher.refresh()
    await Promise.resolve()
    h.watcher.beginCommand()
    const fresh = h.watcher.refresh()
    await Promise.resolve()
    expect(h.run).toHaveBeenCalledTimes(2)
    h.replies[0].release(PLAYING)
    h.replies[1].release(PAUSED)
    await fresh
    expect(h.emit).toHaveBeenCalledTimes(1)
    expect(h.watcher.current()?.status).toBe('paused')
  })

  it('assume() announces the effect at once, and is not a sample', async () => {
    const h = heldWatcher()
    const first = h.watcher.refresh()
    await Promise.resolve()
    h.replies[0].release(PLAYING)
    await first
    h.emit.mockClear()
    h.onSample.mockClear()

    h.watcher.assume(previous => (previous ? { ...previous, status: 'paused' } : previous))
    expect(h.emit).toHaveBeenCalledTimes(1)
    expect(h.emit.mock.calls[0][0].status).toBe('paused')
    expect(h.onSample).not.toHaveBeenCalled()
    expect(h.watcher.current()?.status).toBe('paused')
  })

  it('the read-back that agrees with the assumption announces nothing more; one that disagrees corrects it', async () => {
    const h = heldWatcher()
    const first = h.watcher.refresh()
    await Promise.resolve()
    h.replies[0].release(PLAYING)
    await first
    h.watcher.beginCommand()
    h.watcher.assume(previous => (previous ? { ...previous, status: 'paused' } : previous))
    h.emit.mockClear()

    const agree = h.watcher.refresh()
    await Promise.resolve()
    h.replies[1].release(JSON.stringify({ success: true, state: { status: 'stopped', title: '可惜没如果 - 林俊杰', position: 241.2, duration: 298.293333, volume: null, currentIndex: 0, queueLength: 1 } }))
    await agree
    expect(h.emit).not.toHaveBeenCalled()

    const disagree = h.watcher.refresh()
    await Promise.resolve()
    h.replies[2].release(PLAYING) // the daemon never took it
    await disagree
    expect(h.emit).toHaveBeenCalledTimes(1)
    expect(h.watcher.current()?.status).toBe('playing')
  })
})

/** 2026-09-25「暂停播放时的状态衔接」。 */
describe('createNowPlayingWatcher · position and cadence', () => {
  it('current() carries the position forward from the moment it was read, while playing', async () => {
    let clock = 1_000_000
    const run = vi.fn(async () => ({ code: 0, stdout: PLAYING, stderr: '' }))
    const watcher = createNowPlayingWatcher({
      runner: { run, spawn: vi.fn() },
      isPlayerRunning: () => true,
      emit: vi.fn(),
      now: () => clock,
    })
    await watcher.refresh()
    expect(watcher.current()?.position).toBeCloseTo(241.162071)
    clock += 4_000
    expect(watcher.current()?.position).toBeCloseTo(245.162071)
    // 推到总长为止。
    clock += 600_000
    expect(watcher.current()?.position).toBeCloseTo(298.293333)
  })

  it('a pause assumed 4s after the read freezes at the carried-forward second, not the stale one', async () => {
    let clock = 1_000_000
    const run = vi.fn(async () => ({ code: 0, stdout: PLAYING, stderr: '' }))
    const watcher = createNowPlayingWatcher({ runner: { run, spawn: vi.fn() }, isPlayerRunning: () => true, emit: vi.fn(), now: () => clock })
    await watcher.refresh()
    clock += 4_000
    watcher.assume(previous => (previous ? { ...previous, status: 'paused' } : previous))
    clock += 10_000
    expect(watcher.current()?.status).toBe('paused')
    expect(watcher.current()?.position).toBeCloseTo(245.162071)
  })

  it('paused → playing re-arms the poll at the playing cadence (a resumed song is not watched at the idle pace)', async () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn(async () => ({ code: 0, stdout: PAUSED, stderr: '' }))
      const watcher = createNowPlayingWatcher({
        runner: { run, spawn: vi.fn() },
        isPlayerRunning: () => true,
        emit: vi.fn(),
        playingIntervalMs: 1_000,
        idleIntervalMs: 60_000,
      })
      watcher.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(run).toHaveBeenCalledTimes(1) // paused: next tick 60s out
      watcher.assume(previous => (previous ? { ...previous, status: 'playing' } : previous))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(run).toHaveBeenCalledTimes(2) // re-armed at 1s, not 60s
      watcher.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
