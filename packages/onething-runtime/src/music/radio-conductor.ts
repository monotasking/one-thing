/**
 * The radio's stagehand. The conductor IS the queue: it plays the programme
 * one song at a time and advances when the current one ends.
 *
 * Two design laws, both paid for in the field:
 *
 *  1. **The player pipeline bends to measurements.** ncm-cli's daemon queue
 *     lost the sound test (play's detached child, hard 3s handshake, manifest
 *     revalidation blowing it — 0/12 one evening); what survived is legacy
 *     in-process playback plus socket transport. So the conductor starts each
 *     song itself (via the host's `playSong`) and never touches a player queue.
 *
 *  2. **No LLM-written string is ever a join key.** The DJ once wrote bare
 *     titles ('早春的树') while the player reports '早春的树 - 陈鸿宇', and every
 *     title-keyed feature broke at once (patter, lyrics, dedupe → a song played
 *     twice). Patter/lyrics/played-records therefore fire at the start we
 *     ourselves issue (the host knows the entry, ids and all); the conductor
 *     compares titles only to themselves (same source) as a change detector.
 *
 * Curation is mileage-driven: listening is the fuel. The DJ is woken only when
 * the programme is low AND real songs have played since the last wake (or the
 * user just opened/retuned the station). No listening → no curation → no
 * ghost turns.
 *
 * Ticks come from the now-playing watcher's `onSample` — every poll, not just
 * changes — so no new polling loop exists here.
 */

import type { OnethingMusicNowPlaying } from './now-playing.js'
import type { OnethingMusicReliableRunner } from './reliable-runner.js'
import type { OnethingRadioProgrammeEntry, OnethingRadioStore } from './radio-store.js'

export interface OnethingRadioConductorOptions {
  store: OnethingRadioStore
  /** Transport only (the speak-pause rescue's resume); starting songs goes through playSong. */
  runner: OnethingMusicReliableRunner
  /**
   * Start one song (legacy in-process playback) and verify it actually sounds.
   * The host owns the how — including firing patter/lyrics/play-records at the
   * verified start. Rejecting means the song did not start.
   */
  playSong(entry: OnethingRadioProgrammeEntry): Promise<void>
  /**
   * Ask the host to run a DJ turn (ensure agent + session, kick the engine).
   * Resolving means the turn was started, not that curation succeeded — the
   * inbox filling back up is the only real success signal.
   */
  wakeDj(): Promise<void>
  /**
   * A start we judged failed turned out to be a late success (music is
   * audibly playing while the brief still says 起播失败). The host compensates:
   * onDeck knows which song this was — push its lyrics, speak its patter.
   */
  onLateStart?(): void
  /**
   * Tells a broken SONG apart from a broken WORLD. "Drop the failed entry and
   * try the next" is the right move for a delisted/VIP-only song, but when the
   * failure is systemic — an expired NetEase login makes EVERY start fail the
   * same silent way — that policy burns the whole programme one entry at a
   * time (field-hit 2026-07-17: an expired login ate six curated songs while
   * the honest cause never surfaced). Called after a failed start: return the
   * user-facing message when something systemic is wrong (it becomes the
   * brief's lastError verbatim), or null for "just this song". While a
   * systemic fault stands, the conductor holds the programme (no more pops)
   * and re-probes on a slow cadence; recovery resumes playback by itself.
   */
  diagnoseStartFailure?(): Promise<string | null>
  /**
   * True while the host is already inside one start (its serializing mutex is
   * held). A start spends seconds SILENT by design — the patter TTS speaks
   * into the gap before the song — and the player samples "stopped" the whole
   * time. Without this check the conductor reads that silence as "song ended",
   * pops the next entry, and the host's mutex rejects it: one curated song
   * burned per long patter. Skipping the tick keeps the programme intact.
   */
  startInFlight?(): boolean
  logger?: { warn(message: string, ...args: unknown[]): void }
  now?(): number
  /** Wake the DJ when this many entries (or fewer) are left in the programme. */
  programmeLowThreshold?: number
  /** Minimum ms between DJ wakes, so a slow turn is not stampeded. */
  djWakeCooldownMs?: number
  /** Minimum ms between song starts — the breath between two tracks. */
  advanceCooldownMs?: number
  /** Songs that must actually play between two DJ wakes (listening is the fuel). */
  milesPerWake?: number
}

/** Consecutive wake failures after which the brief carries an honest error. */
const DJ_FAILURES_BEFORE_REPORTING = 2

/** While a systemic fault stands, re-probe it at most this often. */
const SYSTEMIC_RECHECK_MS = 30_000

/** Silence longer than this disarms auto-advance (sleep/wake protection). */
const DISARM_AFTER_SILENCE_MS = 30 * 60_000

export interface OnethingRadioConductor {
  /** Wire this to the now-playing watcher's onSample. Never throws. */
  onSample(nowPlaying: OnethingMusicNowPlaying | null): void
  /** In-flight work, for tests and for hosts that want to drain on dispose. */
  idle(): Promise<void>
  quiesce(): void
}

export function createOnethingRadioConductor(
  options: OnethingRadioConductorOptions,
): OnethingRadioConductor {
  const programmeLow = options.programmeLowThreshold ?? 3
  const djWakeCooldownMs = options.djWakeCooldownMs ?? 60_000
  const advanceCooldownMs = options.advanceCooldownMs ?? 12_000
  const milesPerWake = options.milesPerWake ?? 3
  const now = options.now ?? Date.now

  let pending: Promise<void> = Promise.resolve()
  let ticking = false
  let closed = false
  /**
   * Guards against the one sound nobody asked for: an app launch resurrecting
   * yesterday's station. Auto-advance is armed only once music has played in
   * THIS process, or the station was opened after this conductor was born
   * (brief.startedAt) — a leftover station waits for the bar's resume instead.
   */
  const bornAt = (options.now ?? Date.now)()
  let heardPlayback = false
  /** Last time a playing sample was seen; long silence disarms auto-advance. */
  let lastPlayingAt = Number.NEGATIVE_INFINITY
  /** Set on long silence; also overrides the opened-this-run exemption. */
  let disarmedBySilence = false
  let djWakeInFlight = false
  let lastDjWakeAt = Number.NEGATIVE_INFINITY
  let djFailures = 0
  let lastAdvanceAt = Number.NEGATIVE_INFINITY
  /** Consecutive DJ wakes after which the inbox delivered nothing. */
  let wakesWithoutGrowth = 0
  /**
   * Songs that audibly played since the last DJ wake. Same-source title
   * comparison only (player title vs player title) — a change detector, never
   * a join key.
   */
  let milesSinceWake = 0
  let lastPlayingTitle: string | undefined
  /**
   * Intent freshness is consumption-based: brief.intentAppliedAt is stamped by
   * whoever runs the merge (a conductor tick, or the radio tool applying
   * synchronously), and one wake is owed until this conductor consumes that
   * exact stamp. Wall clock (not the injectable test clock) gates out stamps
   * from before this process was born — yesterday's station must not owe a
   * ghost wake after a restart.
   */
  const bornWallClock = Date.now()
  let consumedIntentAppliedAt: string | undefined
  /** A diagnosed world-is-broken condition; holds the programme (see option doc). */
  let systemicFault = false
  let lastSystemicCheckAt = Number.NEGATIVE_INFINITY
  /**
   * A fresh open/retune owes a cut-over: the moment songs for the NEW
   * direction are on the shelf, the old direction's song yields mid-play —
   * without this a retune stays inaudible until the current song ends
   * (minutes), which reads as "换台没反应" (field complaint 2026-07-19).
   * Cleared by any advance actually starting a song, or by the station
   * closing.
   */
  let cutOverOwed = false
  /** The intentAppliedAt stamp already converted into an owed cut. */
  let consumedCutIntentAppliedAt: string | undefined

  const advance = async (): Promise<void> => {
    if (closed) return
    if (now() - lastAdvanceAt < advanceCooldownMs) return
    if (options.startInFlight?.()) return
    if (systemicFault) {
      if (now() - lastSystemicCheckAt < SYSTEMIC_RECHECK_MS) return
      lastSystemicCheckAt = now()
      const fault = (await options.diagnoseStartFailure?.().catch(() => null)) ?? null
      if (closed) return
      if (fault) {
        options.store.recordError(fault)
        return
      }
      // The world healed (user re-logged in, player came back): resume feeding
      // songs. The stale error clears on the first successful start below.
      systemicFault = false
    }
    // The sample that brought us here can be up to a poll interval stale, and
    // legacy sessions have no daemon arbitration — if the user or the model
    // started something in the meantime, starting ours too means two songs at
    // once. One fresh read closes most of that window.
    const fresh = await options.runner.readState().catch(() => null)
    if (closed) return
    if (fresh?.status === 'playing') return
    // No onDeck fallback here: onDeck is by construction the song that just
    // finished, and auto-replaying it is exactly the "同一首连放两遍" the field
    // test caught when the programme momentarily drained mid-run. An empty
    // programme means dead air until the DJ's batch lands; replaying the last
    // song stays reserved for the bar's explicit resume.
    // Entries flagged unplayable at curation time (playFlag: false — rights
    // gone) are skipped outright: playing one means a spoken intro for a song
    // that never comes, then a 12-second silent verify. Absent flag = unknown,
    // try normally; the start's own post-mortem still covers those.
    let entry = options.store.takeNextEntry()
    while (entry && entry.playFlag === false) {
      options.logger?.warn(`[radio] skipping rights-restricted 「${entry.title}」`)
      options.store.recordError(`「${entry.title}」版权受限,已跳过`)
      entry = options.store.takeNextEntry()
    }
    if (!entry) return
    lastAdvanceAt = now()
    cutOverOwed = false
    try {
      await options.playSong(entry)
      if (closed) return
      options.store.recordError(undefined)
    } catch (error) {
      if (closed) return
      // The host marks failures that are NOT the song's fault (station just
      // closed, another start in flight): put the entry back and stand down —
      // dropping it would burn a curated song for a reason that had nothing
      // to do with the song.
      if ((error as { entryReusable?: boolean } | null)?.entryReusable === true) {
        const programme = options.store.readProgramme()
        programme.entries.unshift(entry)
        options.store.writeProgramme(programme)
        return
      }
      const fault = (await options.diagnoseStartFailure?.().catch(() => null)) ?? null
      if (closed) return
      if (fault) {
        // Not this song's fault — the world is broken. Hold the programme and
        // put the entry back at the front: with the hold there is no re-fail
        // wedge (nothing pops until the probe clears), and the DJ's order —
        // opening patter included — survives the outage intact.
        systemicFault = true
        lastSystemicCheckAt = now()
        const programme = options.store.readProgramme()
        programme.entries.unshift(entry)
        options.store.writeProgramme(programme)
        options.logger?.warn(`[radio] systemic start failure — holding the programme: ${fault}`)
        options.store.recordError(fault)
        return
      }
      // The entry is already popped; putting a song the player rejected back
      // would wedge the radio on it forever. Log, report, move on.
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.warn(`[radio] failed to start 「${entry.title}」`, error)
      options.store.recordError(`起播失败(${entry.title}):${message}`)
    }
  }

  const maybeWakeDj = async (
    brief: { intentAppliedAt?: string },
    entriesLeft: number,
  ): Promise<void> => {
    if (closed) return
    if (entriesLeft > programmeLow) {
      djFailures = 0
      wakesWithoutGrowth = 0
      return
    }
    const appliedAtRaw = brief.intentAppliedAt
    const appliedAt = appliedAtRaw ? Date.parse(appliedAtRaw) : Number.NaN
    const intentFresh =
      !!appliedAtRaw &&
      appliedAtRaw !== consumedIntentAppliedAt &&
      Number.isFinite(appliedAt) &&
      appliedAt >= bornWallClock
    // The user re-engaging (open/retune) resets the breaker and owes a wake.
    if (intentFresh) wakesWithoutGrowth = 0
    // Listening is the fuel: without real songs played since the last wake
    // (or a fresh intent from the user), curation has no audience and no
    // budget. This is what kills ghost turns for an idle-but-active station.
    // Exception — starvation: an EMPTY shelf cannot earn miles (no songs, no
    // listening, no fuel — a deadlock, field-hit after a resume drained the
    // last entry). If this run audibly played, an empty programme qualifies
    // by itself; the backoff/breaker still pace the wakes.
    const starving = entriesLeft === 0 && heardPlayback
    if (!intentFresh && !starving && milesSinceWake < milesPerWake) return
    // Budget against a DJ that keeps "succeeding" while producing nothing
    // (quota exhausted, broken curation): backoff, then a breaker. An inbox
    // delivery or a fresh intent resets both.
    if (wakesWithoutGrowth >= 6) {
      options.store.recordError(
        'DJ 连续多轮没能补上节目单,续批已熔断——跟我说一声(重新开台/换台)即可恢复',
      )
      return
    }
    const backoffMs =
      wakesWithoutGrowth >= 5
        ? 15 * 60_000
        : wakesWithoutGrowth >= 3
          ? 5 * 60_000
          : djWakeCooldownMs
    if (djWakeInFlight || now() - lastDjWakeAt < backoffMs) return
    djWakeInFlight = true
    lastDjWakeAt = now()
    wakesWithoutGrowth += 1
    milesSinceWake = 0
    consumedIntentAppliedAt = appliedAtRaw ?? consumedIntentAppliedAt
    if (wakesWithoutGrowth === 3) {
      options.store.recordError('DJ 连续几轮没能补上节目单,已放慢唤醒节奏')
    }
    try {
      await options.wakeDj()
      if (closed) return
      djFailures = 0
    } catch (error) {
      if (closed) return
      djFailures += 1
      options.logger?.warn(`[radio] DJ wake failed (${djFailures})`, error)
      if (djFailures >= DJ_FAILURES_BEFORE_REPORTING) {
        options.store.recordError('节目单快见底,DJ 没接上——电台会在现有节目放完后安静结束')
      }
    } finally {
      djWakeInFlight = false
    }
  }

  const tick = async (sample: OnethingMusicNowPlaying | null): Promise<void> => {
    // The model's open/retune/close lands in the intent file (the model never
    // writes the brief — single-writer rule). Apply before the active check:
    // the instruction to open the station is itself in here. A fresh intent is
    // the user re-engaging — it resets the wake breaker and owes one wake.
    options.store.mergeIntent()
    const brief = options.store.readBrief()
    if (!brief.active) {
      cutOverOwed = false
      return
    }
    // Arm from the brief's stamp, not mergeIntent's return value: the host
    // applies an open/retune synchronously at the button (its own mergeIntent
    // empties the intent file), so by this tick the file is already consumed —
    // the stamp in the brief is what survives. Same freshness gate as the
    // wake-owing path: unseen stamp, from after this process was born.
    const cutStampRaw = brief.intentAppliedAt
    const cutStamp = cutStampRaw ? Date.parse(cutStampRaw) : Number.NaN
    if (
      cutStampRaw &&
      cutStampRaw !== consumedCutIntentAppliedAt &&
      Number.isFinite(cutStamp) &&
      cutStamp >= bornWallClock
    ) {
      cutOverOwed = true
      consumedCutIntentAppliedAt = cutStampRaw
    }

    // Bring in whatever the DJ curated since the last tick. The DJ only ever
    // writes its inbox; this merge (with played-history dedupe) is the single
    // writer of the programme, so a slow DJ turn cannot resurrect songs the
    // conductor already played.
    const merged = options.store.mergeInbox()
    if (merged > 0) {
      options.store.recordError(undefined)
      wakesWithoutGrowth = 0 // the DJ produced — wake budget resets
    }

    const entriesLeft = options.store.readProgramme().entries.length

    if (sample === null || sample.status === 'stopped') {
      // Long silence disarms: a laptop waking from overnight sleep with an
      // armed radio must not greet a meeting room with music. Overrides the
      // opened-this-run exemption too — the app rarely restarts across a
      // sleep. The bar's resume stays one click away.
      if (heardPlayback && now() - lastPlayingAt > DISARM_AFTER_SILENCE_MS) {
        heardPlayback = false
        disarmedBySilence = true
        options.logger?.warn('[radio] long silence — auto-advance disarmed until resumed by hand')
      }
      const startedAt = brief.startedAt ? Date.parse(brief.startedAt) : Number.NaN
      const openedThisRun = Number.isFinite(startedAt) && startedAt >= bornAt
      if (heardPlayback || (openedThisRun && !disarmedBySilence)) {
        await advance()
      }
      await maybeWakeDj(brief, entriesLeft)
      return
    }

    if (sample.status === 'playing') {
      // Music is audibly on (whoever started it): arm auto-advance, count the
      // mileage that fuels curation, and clean up leftovers.
      heardPlayback = true
      lastPlayingAt = now()
      disarmedBySilence = false
      if (sample.title && sample.title !== lastPlayingTitle) {
        lastPlayingTitle = sample.title
        milesSinceWake += 1
      }
      // A start we misjudged (verify deadline lost to a slow network) leaves a
      // stale 起播失败 — the song is audibly playing, so clear it and let the
      // host compensate (lyrics/patter for the song it knows it started).
      if (brief.lastError?.startsWith('起播失败')) {
        options.store.recordError(undefined)
        options.onLateStart?.()
      }
      // The owed cut-over: the retune's songs are on the shelf — the old
      // direction's song yields NOW instead of playing out. advance() keeps
      // its own guards (cooldown, start-in-flight); if one blocks, the owed
      // flag survives to the next tick.
      if (cutOverOwed && entriesLeft > 0) {
        await advance()
      }
    }

    await maybeWakeDj(brief, entriesLeft)
  }

  return {
    onSample(sample) {
      // Samples arrive every few seconds; one slow tick must not pile up a
      // queue of stale reactions behind it. Skip instead of buffering.
      if (closed || ticking) return
      ticking = true
      pending = tick(sample)
        .catch(error => options.logger?.warn('[radio] conductor tick failed', error))
        .finally(() => {
          ticking = false
        })
    },
    idle: () => pending,
    quiesce() { closed = true },
  }
}
