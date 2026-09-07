import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OnethingMusicNowPlaying } from '../now-playing.js'
import { createOnethingRadioConductor } from '../radio-conductor.js'
import { createOnethingRadioStore, type OnethingRadioStore } from '../radio-store.js'
import type { OnethingMusicReliableRunner } from '../reliable-runner.js'

const HEX = 'D71F6E90EA704F1C44183933E7E0F19'

const entry = (n: number, over: Record<string, string> = {}) => ({
  encryptedId: HEX + n,
  originalId: String(n),
  title: `song ${n}`,
  ...over,
})

const playing = (over: Partial<OnethingMusicNowPlaying> = {}): OnethingMusicNowPlaying => ({
  status: 'playing',
  title: '岁月神偷 - 金玟岐',
  position: 30,
  duration: 244,
  queueLength: 1,
  currentIndex: 0,
  ...over,
})

function harness(options: {
  store?: OnethingRadioStore
  dir: string
  entries?: number
  programmeEntries?: Array<ReturnType<typeof entry>>
  wakeDj?: () => Promise<void>
  playSong?: (item: ReturnType<typeof entry>) => Promise<void>
  diagnoseStartFailure?: () => Promise<string | null>
  startInFlight?: () => boolean
  now?: () => number
}) {
  const store = options.store ?? createOnethingRadioStore(options.dir)
  // startedAt sits comfortably after the conductor's birth, so the station
  // counts as "opened this run" and auto-advance is armed — the default for
  // most tests. (Same-millisecond timing here is a knife edge under load.)
  const startedAt = new Date((options.now?.() ?? Date.now()) + 60_000).toISOString()
  store.writeBrief({ active: true, intent: '雨天民谣', startedAt, played: [], skipped: [], loved: [] })
  store.writeProgramme({
    entries:
      options.programmeEntries ??
      Array.from({ length: options.entries ?? 6 }, (_, index) => entry(index)),
  })

  const transportRuns: string[][] = []
  const runner: OnethingMusicReliableRunner = {
    run: vi.fn(),
    // The advance pre-check reads this; null = "player silent", the default.
    readState: vi.fn().mockResolvedValue(null),
    runVerified: vi.fn(async args => {
      transportRuns.push(args)
      return playing()
    }),
  }

  const played: string[] = []
  const playSong = vi.fn(
    options.playSong ??
      (async (item: ReturnType<typeof entry>) => {
        played.push(item.title)
      }),
  )
  const wakeDj = vi.fn(options.wakeDj ?? (() => Promise.resolve()))
  const onLateStart = vi.fn()
  const conductor = createOnethingRadioConductor({
    store,
    runner,
    playSong,
    wakeDj,
    onLateStart,
    diagnoseStartFailure: options.diagnoseStartFailure,
    startInFlight: options.startInFlight,
    now: options.now,
    logger: { warn: vi.fn() },
  })

  return { store, conductor, played, playSong, wakeDj, onLateStart, transportRuns, runner }
}

describe('radio conductor', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'radio-conductor-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits for an in-flight state read and prevents late playback or DJ work after quiesce', async () => {
    const h = harness({ dir })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.mocked(h.runner.readState).mockImplementationOnce(async () => { await pending; return null })
    h.conductor.onSample(null)
    expect(h.runner.readState).toHaveBeenCalledOnce()
    h.conductor.quiesce()
    let drained = false
    const closing = h.conductor.idle().then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    release()
    await closing
    h.conductor.onSample(null)
    expect(h.runner.readState).toHaveBeenCalledOnce()
    expect(h.playSong).not.toHaveBeenCalled()
    expect(h.wakeDj).not.toHaveBeenCalled()
    expect(h.store.readProgramme().entries).toHaveLength(6)
  })

  it('does nothing while the radio is off', async () => {
    const h = harness({ dir })
    h.store.writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [] })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.playSong).not.toHaveBeenCalled()
    expect(h.wakeDj).not.toHaveBeenCalled()
  })

  it('starts the next programme entry when nothing is playing', async () => {
    const h = harness({ dir })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.played).toEqual(['song 0'])
    expect(h.store.readProgramme().entries).toHaveLength(5)
  })

  it('advances when the current song ends (stopped sample)', async () => {
    let clock = 0
    const h = harness({ dir, now: () => clock })

    h.conductor.onSample(playing())
    await h.conductor.idle()
    expect(h.played).toEqual([]) // playing: nothing to do

    clock += 13_000
    h.conductor.onSample(playing({ status: 'stopped', position: 0 }))
    await h.conductor.idle()

    expect(h.played).toEqual(['song 0'])
  })

  it('a retune cuts over mid-song once new songs are on the shelf', async () => {
    const h = harness({ dir })

    // Baseline: a playing sample alone never advances.
    h.conductor.onSample(playing())
    await h.conductor.idle()
    expect(h.played).toEqual([])

    // The user retunes at the bar: the HOST applies the intent synchronously
    // (openRadioStation writes the file, merges it, and the merge empties the
    // file) — by the next tick only the brief's intentAppliedAt stamp is left,
    // and the cut must arm from that stamp.
    writeFileSync(
      h.store.intentPath,
      JSON.stringify({ active: true, intent: '换个方向', startedAt: new Date().toISOString() }),
    )
    h.store.mergeIntent()
    h.conductor.onSample(playing())
    await h.conductor.idle()

    // The owed cut-over starts the next entry even though a song is playing.
    expect(h.played).toEqual(['song 0'])

    // One cut per retune: later playing ticks go back to doing nothing.
    h.conductor.onSample(playing())
    await h.conductor.idle()
    expect(h.played).toEqual(['song 0'])
  })

  it('leaves a breath between two starts (advance cooldown)', async () => {
    let clock = 0
    const h = harness({ dir, now: () => clock })

    h.conductor.onSample(null)
    await h.conductor.idle()
    clock += 3_000
    h.conductor.onSample(null) // still silent 3s later — do not double-start
    await h.conductor.idle()

    expect(h.played).toEqual(['song 0'])

    clock += 13_000
    h.conductor.onSample(null)
    await h.conductor.idle()
    expect(h.played).toEqual(['song 0', 'song 1'])
  })

  it('waits in silence when the programme drains — never auto-replays the last song', async () => {
    const h = harness({ dir, programmeEntries: [] })
    h.store.writeBrief({
      active: true, intent: 'x', startedAt: new Date(Date.now() + 60_000).toISOString(),
      played: [], skipped: [], loved: [],
      onDeck: entry(9),
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.played).toEqual([])
  })

  it('never auto-starts a station left over from a previous run', async () => {
    const h = harness({ dir, now: () => 100_000 })
    h.store.writeBrief({
      active: true, intent: '昨天的雨天台', startedAt: new Date(0).toISOString(),
      played: [], skipped: [], loved: [],
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.playSong).not.toHaveBeenCalled()
  })

  it('arms auto-advance once music has audibly played this run', async () => {
    let clock = 100_000
    const h = harness({ dir, now: () => clock })
    h.store.writeBrief({
      active: true, intent: '昨天的台', startedAt: new Date(0).toISOString(),
      played: [], skipped: [], loved: [],
    })

    h.conductor.onSample(playing())
    await h.conductor.idle()

    clock += 13_000
    h.conductor.onSample(playing({ status: 'stopped', position: 0 }))
    await h.conductor.idle()

    expect(h.played).toEqual(['song 0'])
  })

  it('disarms auto-advance after half an hour of silence', async () => {
    let clock = 0
    const h = harness({ dir, now: () => clock })

    h.conductor.onSample(playing())
    await h.conductor.idle()

    clock = 31 * 60_000
    h.conductor.onSample(playing({ status: 'stopped', position: 0 }))
    await h.conductor.idle()

    expect(h.playSong).not.toHaveBeenCalled()
  })

  it('moves past an entry the player rejects instead of wedging on it', async () => {
    let clock = 0
    const h = harness({
      dir,
      now: () => clock,
      playSong: async () => {
        throw new Error('歌曲无版权')
      },
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.store.readProgramme().entries).toHaveLength(5)
    expect(h.store.readBrief().lastError).toContain('起播失败')

    clock += 13_000
    h.conductor.onSample(null)
    await h.conductor.idle()
    expect(h.playSong).toHaveBeenCalledTimes(2)
  })

  it('skips its own start when a fresh read shows something already playing', async () => {
    const h = harness({ dir })
    vi.mocked(h.runner.readState).mockResolvedValue(playing())

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.playSong).not.toHaveBeenCalled()
    expect(h.store.readProgramme().entries).toHaveLength(6)
  })

  it('compensates a late start: clears the stale error and tells the host', async () => {
    const h = harness({ dir })
    h.store.writeBrief({
      active: true, intent: 'x', startedAt: new Date(Date.now() + 60_000).toISOString(),
      played: [], skipped: [], loved: [],
      lastError: '起播失败(途中 - 陈鸿宇):play 返回成功但播放器没有在放',
    })

    h.conductor.onSample(playing())
    await h.conductor.idle()

    expect(h.store.readBrief().lastError).toBeUndefined()
    expect(h.onLateStart).toHaveBeenCalledTimes(1)
  })

  // ── curation: mileage-driven ──────────────────────────────────────────────

  /** Feed n distinct playing titles — n real songs' worth of listening. */
  async function playMiles(h: ReturnType<typeof harness>, n: number, offset = 0) {
    for (let index = 0; index < n; index += 1) {
      h.conductor.onSample(playing({ title: `听过的歌 ${offset + index}` }))
      await h.conductor.idle()
    }
  }

  it('does not wake the DJ without listening mileage (ghost turns are dead)', async () => {
    let clock = 0
    const h = harness({ dir, entries: 1, now: () => clock })

    // Idle active station, hours of samples, zero playback.
    for (let index = 0; index < 5; index += 1) {
      clock += 60 * 60_000
      h.conductor.onSample(null)
      await h.conductor.idle()
    }

    expect(h.wakeDj).not.toHaveBeenCalled()
  })

  it('wakes the DJ after enough songs have actually played', async () => {
    let clock = 0
    const h = harness({ dir, entries: 1, now: () => clock })

    await playMiles(h, 2)
    expect(h.wakeDj).not.toHaveBeenCalled() // 2 miles < 3

    await playMiles(h, 1, 2)
    expect(h.wakeDj).toHaveBeenCalledTimes(1)

    // The wake consumed the mileage: more low-programme ticks alone do nothing.
    clock += 61_000
    h.conductor.onSample(playing({ title: '听过的歌 2' })) // same title, no new mile
    await h.conductor.idle()
    expect(h.wakeDj).toHaveBeenCalledTimes(1)
  })

  it('an empty shelf with real listening waives the mileage requirement (starvation)', async () => {
    // The field deadlock: a resume drained the last entry; no songs → no
    // miles → no wake → no songs, forever. Heard playback + empty programme
    // must qualify by itself.
    let clock = 0
    const h = harness({ dir, programmeEntries: [entry(0)], now: () => clock })

    h.conductor.onSample(null) // plays the last entry (armed via startedAt)
    await h.conductor.idle()
    expect(h.played).toEqual(['song 0'])

    clock += 61_000
    h.conductor.onSample(playing({ title: 'song 0' })) // 1 mile — below 3
    await h.conductor.idle()
    clock += 13_000
    h.conductor.onSample(playing({ status: 'stopped', position: 0 })) // song ended, shelf empty
    await h.conductor.idle()

    expect(h.wakeDj).toHaveBeenCalledTimes(1)
  })

  it('an empty shelf WITHOUT any listening still never wakes (ghost guard)', async () => {
    let clock = 0
    const h = harness({ dir, programmeEntries: [], now: () => clock })
    h.store.writeBrief({
      active: true, intent: '昨天的台', startedAt: new Date(0).toISOString(),
      played: [], skipped: [], loved: [],
    })

    for (let index = 0; index < 4; index += 1) {
      clock += 60 * 60_000
      h.conductor.onSample(null)
      await h.conductor.idle()
    }

    expect(h.wakeDj).not.toHaveBeenCalled()
  })

  it('a fresh intent owes one wake immediately (opening/retuning the station)', async () => {
    const h = harness({ dir, programmeEntries: [] })
    writeFileSync(
      h.store.intentPath,
      JSON.stringify({ active: true, intent: '新台', startedAt: new Date().toISOString() }),
    )

    h.conductor.onSample(null) // no mileage at all
    await h.conductor.idle()

    expect(h.wakeDj).toHaveBeenCalledTimes(1)
  })

  it('trips the breaker after six fruitless wakes; a fresh intent resets it', async () => {
    let clock = 0
    const h = harness({ dir, entries: 1, now: () => clock })

    // Six wakes, each earned by 3 miles, none delivering to the inbox.
    for (let wake = 0; wake < 6; wake += 1) {
      clock += 20 * 60_000 // clear any backoff window
      await playMiles(h, 3, wake * 10)
    }
    expect(h.wakeDj).toHaveBeenCalledTimes(6)

    // Mileage keeps accruing but the breaker holds.
    clock += 20 * 60_000
    await playMiles(h, 3, 100)
    expect(h.wakeDj).toHaveBeenCalledTimes(6)
    expect(h.store.readBrief().lastError).toContain('熔断')

    // The user re-states intent → breaker resets, wake owed and taken.
    writeFileSync(
      h.store.intentPath,
      JSON.stringify({ active: true, intent: '换个方向', startedAt: new Date(clock).toISOString() }),
    )
    clock += 61_000
    h.conductor.onSample(playing({ title: '听过的歌 200' }))
    await h.conductor.idle()
    expect(h.wakeDj).toHaveBeenCalledTimes(7)
  })

  it('an inbox delivery raises the programme and resets the wake budget', async () => {
    let clock = 0
    const h = harness({ dir, entries: 1, now: () => clock })

    clock += 61_000
    await playMiles(h, 3)
    expect(h.wakeDj).toHaveBeenCalledTimes(1)

    writeFileSync(h.store.inboxPath, JSON.stringify({ entries: [entry(7)] }))
    clock += 61_000
    h.conductor.onSample(playing({ title: '听过的歌 0' }))
    await h.conductor.idle()

    expect(h.store.readProgramme().entries.length).toBeGreaterThan(1)
  })

  it('merges the DJ inbox into the programme on tick', async () => {
    const h = harness({ dir, entries: 2 })
    writeFileSync(
      h.store.inboxPath,
      JSON.stringify({ entries: [entry(7), entry(8)] }),
    )

    h.conductor.onSample(playing())
    await h.conductor.idle()

    expect(h.store.readProgramme().entries.map(item => item.title)).toEqual([
      'song 0', 'song 1', 'song 7', 'song 8',
    ])
    expect(h.store.mergeInbox()).toBe(0)
  })

  it('never touches a pause the user chose', async () => {
    const h = harness({ dir, now: () => 999_999 })

    h.conductor.onSample(playing({ status: 'paused' }))
    await h.conductor.idle()

    expect(h.transportRuns).not.toContainEqual(['resume'])
    expect(h.playSong).not.toHaveBeenCalled()
  })
})

describe('systemic start failures (e.g. expired login)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'radio-conductor-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('holds the programme with the honest cause instead of burning it song by song', async () => {
    let clock = 0
    const diagnose = vi.fn().mockResolvedValue('网易云登录已过期')
    const h = harness({
      dir,
      now: () => clock,
      playSong: async () => {
        throw new Error('play 返回成功但播放器没有在放')
      },
      diagnoseStartFailure: diagnose,
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.playSong).toHaveBeenCalledTimes(1)
    expect(h.store.readBrief().lastError).toBe('网易云登录已过期')
    // The popped entry went back to the front — the outage loses zero songs.
    expect(h.store.readProgramme().entries.map(item => item.title)[0]).toBe('song 0')
    expect(h.store.readProgramme().entries).toHaveLength(6)

    // While the fault stands, later ticks pop nothing more.
    clock += 13_000
    h.conductor.onSample(null)
    await h.conductor.idle()
    expect(h.playSong).toHaveBeenCalledTimes(1)
  })

  it('re-probes on a slow cadence, not every tick', async () => {
    let clock = 0
    const diagnose = vi.fn().mockResolvedValue('网易云登录已过期')
    const h = harness({
      dir,
      now: () => clock,
      playSong: async () => {
        throw new Error('no sound')
      },
      diagnoseStartFailure: diagnose,
    })

    h.conductor.onSample(null)
    await h.conductor.idle() // fail → probe #1 (in the catch)

    clock += 13_000
    h.conductor.onSample(null)
    await h.conductor.idle() // inside the recheck window: silent, no probe

    expect(diagnose).toHaveBeenCalledTimes(1)

    clock += 31_000
    h.conductor.onSample(null)
    await h.conductor.idle() // window elapsed: one re-probe

    expect(diagnose).toHaveBeenCalledTimes(2)
  })

  it('resumes playback by itself once the probe clears', async () => {
    let clock = 0
    let broken = true
    const diagnose = vi.fn(async () => (broken ? '网易云登录已过期' : null))
    const playSong = vi.fn(async () => {
      if (broken) throw new Error('no sound')
    })
    const h = harness({ dir, now: () => clock, playSong, diagnoseStartFailure: diagnose })

    h.conductor.onSample(null)
    await h.conductor.idle() // fails, conductor holds

    broken = false // the user re-logged in
    clock += 31_000
    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(playSong).toHaveBeenCalledTimes(2)
    expect(h.store.readBrief().lastError).toBeUndefined()
    expect(h.store.readProgramme().entries).toHaveLength(5)
  })

  it('pops nothing while the host is inside a start (patter speaking into the gap)', async () => {
    // A start's pre-song TTS is deliberate silence: samples say "stopped" for
    // seconds while the host talks. That silence must not read as "song over".
    let inFlight = true
    const h = harness({ dir, startInFlight: () => inFlight })

    h.conductor.onSample(null)
    await h.conductor.idle()
    expect(h.playSong).not.toHaveBeenCalled()
    expect(h.store.readProgramme().entries).toHaveLength(6)

    inFlight = false
    h.conductor.onSample(null)
    await h.conductor.idle()
    expect(h.playSong).toHaveBeenCalledTimes(1)
  })

  it('skips curation-flagged unplayable entries outright — no start, honest note', async () => {
    const h = harness({ dir })
    h.store.writeProgramme({
      entries: [
        { ...entry(0), playFlag: false },
        { ...entry(1), playFlag: false },
        { ...entry(2), playFlag: true },
      ],
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    // Both grey entries fell through in ONE advance; the playable one started.
    expect(h.playSong).toHaveBeenCalledTimes(1)
    expect(h.playSong.mock.calls[0]?.[0]?.title).toBe('song 2')
    expect(h.store.readProgramme().entries).toHaveLength(0)
  })

  it('returns the entry when the host marks a failure as not the song\'s fault', async () => {
    // 停止电台 mid-start, a colliding start, a wrong player backend — none of
    // these are the song's doing, so the popped entry must survive.
    const h = harness({
      dir,
      playSong: async () => {
        const error = new Error('电台已停止') as Error & { entryReusable: boolean }
        error.entryReusable = true
        throw error
      },
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.playSong).toHaveBeenCalledTimes(1)
    expect(h.store.readProgramme().entries).toHaveLength(6)
    expect(h.store.readProgramme().entries[0]?.title).toBe('song 0')
  })

  it('keeps drop-and-move-on for genuine single-song failures', async () => {
    const diagnose = vi.fn().mockResolvedValue(null) // world is fine
    const h = harness({
      dir,
      playSong: async item => {
        if (item.title === 'song 0') throw new Error('下架了')
      },
      diagnoseStartFailure: diagnose,
    })

    h.conductor.onSample(null)
    await h.conductor.idle()

    expect(h.store.readBrief().lastError).toContain('起播失败(song 0)')
    // The bad entry is gone for good — no systemic hold, no re-queue.
    expect(h.store.readProgramme().entries.map(item => item.title)[0]).toBe('song 1')
  })
})
