/**
 * What is playing right now, for the composer's music bar.
 *
 * The model drives ncm-cli through bash, so nothing in the app knows a song
 * started — the only way to find out is to ask. `ncm-cli state` answers with
 * everything the bar needs in one local (~0.2s) command:
 *
 *     { "status": "playing", "title": "可惜没如果 - 林俊杰",
 *       "position": 241.16, "duration": 298.29, "progress": "4:01 / 4:58",
 *       "volume": null, "currentIndex": 0, "queueLength": 1 }
 *
 * Two measured facts shape this file:
 *
 *  1. `state` never starts a player daemon — running it against nothing logs
 *     nothing and spawns nothing. So polling is safe; it can never be the
 *     reason music starts.
 *  2. `state` has no `paused`: a paused player reports `stopped` with its
 *     position frozen. See {@link parseNowPlaying}.
 */

import { extractFirstJsonObject } from './cli-json.js'
import type { OnethingMusicProcessRunner } from './types.js'

export interface OnethingMusicNowPlaying {
  status: 'playing' | 'paused' | 'stopped'
  /** Display string, e.g. `可惜没如果 - 林俊杰`. Not an id — no lyrics from this. */
  title?: string
  /** Seconds. */
  position: number
  /** Seconds. */
  duration?: number
  /** ncm-cli's own formatting, e.g. `4:01 / 4:58`. */
  progress?: string
  queueLength: number
  /** Where in the queue we are; `queueLength - currentIndex - 1` songs remain. */
  currentIndex: number
}

interface RawState {
  status?: string
  title?: string
  position?: number
  duration?: number
  progress?: string
  queueLength?: number
  currentIndex?: number
}

/**
 * `state` reports a paused player as `stopped`, so "stopped" alone is
 * ambiguous. The tell is the position: a real stop resets it to 0, while a
 * pause freezes it wherever it was (measured: paused 50s at 7.0, resumed fine).
 * Getting this wrong means the bar says "nothing playing" at someone who only
 * hit pause.
 */
export function parseNowPlaying(stdout: string): OnethingMusicNowPlaying | null {
  const raw = extractFirstJsonObject<{ state?: RawState }>(stdout)?.state
  if (!raw || typeof raw.status !== 'string') return null

  const position = typeof raw.position === 'number' ? raw.position : 0
  const status: OnethingMusicNowPlaying['status'] =
    raw.status === 'playing' ? 'playing' : position > 0 ? 'paused' : 'stopped'

  return {
    status,
    title: raw.title || undefined,
    position,
    duration: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : undefined,
    progress: raw.progress || undefined,
    queueLength: typeof raw.queueLength === 'number' ? raw.queueLength : 0,
    currentIndex: typeof raw.currentIndex === 'number' ? raw.currentIndex : 0,
  }
}

function sameNowPlaying(
  a: OnethingMusicNowPlaying | null,
  b: OnethingMusicNowPlaying | null,
): boolean {
  if (a === null || b === null) return a === b
  // Position (and currentIndex, which moves with it) are deliberately
  // excluded: they change every tick, and the renderer interpolates between
  // polls anyway. Including them would push an IPC message a second for
  // something nobody reads at that resolution.
  return a.status === b.status && a.title === b.title && a.duration === b.duration
}

export interface NowPlayingWatcherOptions {
  runner: OnethingMusicProcessRunner
  /**
   * The active provider's binary + state parser. Absent = ncm-cli — the
   * founding default, kept inline so this module never imports a provider.
   */
  cli?: {
    binary: string
    parseNowPlaying(stdout: string): OnethingMusicNowPlaying | null
  }
  /**
   * Whether ncm-cli's player daemon is up. Checked before every poll so an idle
   * app spends nothing: with no daemon there is nothing to report, and asking
   * would burn a subprocess to be told "stopped".
   */
  isPlayerRunning(): boolean | Promise<boolean>
  emit(nowPlaying: OnethingMusicNowPlaying | null): void
  /**
   * Every successful poll, changed or not — `emit` is for the renderer and
   * fires on change only, but the radio conductor watches queue watermarks,
   * which move without ever tripping the change detector. Not called on read
   * failure: "could not ask" is not a sample.
   */
  onSample?(nowPlaying: OnethingMusicNowPlaying | null): void
  /** While something is playing; the bar interpolates position between these. */
  playingIntervalMs?: number
  /** While paused or stopped — nothing is moving, so ask far less often. */
  idleIntervalMs?: number
  logger?: { warn(message: string, ...args: unknown[]): void }
}

export interface NowPlayingWatcher {
  start(): void
  stop(): void
  quiesce(): void
  drain(): Promise<void>
  /**
   * Poll now instead of waiting for the next tick (e.g. right after a command).
   * A poll already in flight is reused only if it started after the last
   * `beginCommand()` — one that started before it can only answer with the
   * world as it was before the command.
   */
  refresh(): Promise<void>
  current(): OnethingMusicNowPlaying | null
  /**
   * A state-changing command is about to be sent. Every `state` read already
   * in flight is now stale and will be dropped when it lands (2026-09-25: a
   * 5s tick that spawned `ncm-cli state` just before a pause used to land just
   * after it and announce "still playing", flipping every client back).
   */
  beginCommand(): void
  /**
   * The command was accepted: publish what it did without waiting for a
   * `state` round trip (~200ms of process start-up each). Announced to
   * clients like any change, but NOT a sample — the radio conductor only
   * ever sees what the player actually said. The next `refresh()` corrects
   * it if the player disagrees.
   */
  assume(next: (previous: OnethingMusicNowPlaying | null) => OnethingMusicNowPlaying | null): void
}

export function createNowPlayingWatcher(options: NowPlayingWatcherOptions): NowPlayingWatcher {
  const playingInterval = options.playingIntervalMs ?? 5_000
  const idleInterval = options.idleIntervalMs ?? 20_000

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let latest: OnethingMusicNowPlaying | null = null
  let polling: Promise<void> | null = null
  let closed = false
  let generation = 0
  /** Bumped by `beginCommand()`; a read that started under an older value is stale. */
  let commandEpoch = 0
  /** The command epoch the in-flight poll started under. */
  let pollingCommandEpoch = 0

  const publish = (next: OnethingMusicNowPlaying | null) => {
    if (sameNowPlaying(latest, next)) {
      latest = next // Keep the fresh position even when we do not announce it.
      return
    }
    latest = next
    options.emit(next)
  }

  const sample = (next: OnethingMusicNowPlaying | null) => {
    publish(next)
    try {
      options.onSample?.(next)
    } catch (error) {
      options.logger?.warn('[music] now-playing sample handler failed', error)
    }
  }

  const pollOnce = async (epoch: number): Promise<void> => {
    const command = commandEpoch
    const current = () => !closed && epoch === generation && command === commandEpoch
    if (!(await options.isPlayerRunning())) {
      if (current()) sample(null)
      return
    }
    if (!current()) return
    try {
      const result = await options.runner.run({
        command: options.cli?.binary ?? 'ncm-cli',
        args: ['state'],
        timeoutMs: 8_000,
      })
      if (current()) sample((options.cli?.parseNowPlaying ?? parseNowPlaying)(result.stdout))
    } catch (error) {
      // Not knowing is not the same as "nothing is playing" — leave the last
      // answer standing rather than blinking the bar out on one bad read.
      options.logger?.warn('[music] could not read player state', error)
    }
  }

  const schedule = () => {
    if (!running || closed) return
    const delay = latest?.status === 'playing' ? playingInterval : idleInterval
    timer = setTimeout(() => {
      void tick()
    }, delay)
  }

  const refresh = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('Music watcher is shutting down'))
    if (polling && pollingCommandEpoch === commandEpoch) return polling
    const work = pollOnce(generation)
    polling = work
    pollingCommandEpoch = commandEpoch
    void work.then(() => { if (polling === work) polling = null }, () => { if (polling === work) polling = null })
    return work
  }

  const tick = async () => {
    const epoch = generation
    await refresh().catch(error => options.logger?.warn('[music] poll failed', error))
    if (epoch === generation) schedule()
  }

  const stop = () => {
    running = false
    ++generation
    if (timer) clearTimeout(timer)
    timer = null
    latest = null
  }

  return {
    start() {
      if (closed) throw new Error('Music watcher is shutting down')
      if (running) return
      running = true
      void tick()
    },
    stop,
    quiesce() { closed = true; stop() },
    async drain() { closed = true; stop(); await polling },
    refresh,
    current: () => latest,
    beginCommand() {
      commandEpoch += 1
    },
    assume(next) {
      if (closed) return
      publish(next(latest))
    },
  }
}
