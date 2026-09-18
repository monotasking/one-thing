/**
 * The radio's paper trail: brief (why), programme (what's next), and the
 * inbox (what the DJ just curated).
 *
 * Single-writer rule: the DJ writes ONLY the inbox; the conductor is the only
 * writer of the programme. The first design had the DJ read-modify-write the
 * programme itself, and a DJ turn takes minutes — while it curated, the
 * conductor popped entries to feed the player, and the DJ's stale write
 * resurrected them (one song played three times) or dropped whole batches.
 * With the inbox, the DJ overwrites a file nobody else owns, and the conductor
 * merges it in with dedupe against what already played.
 *
 * A model is not a schema validator, so every read here assumes the file may
 * be missing, truncated, or creatively wrong, and normalizes instead of
 * throwing: a malformed file must degrade to "nothing", never crash the
 * conductor that keeps music flowing.
 */

import path from 'node:path'
import { readJsonFile, writeJsonFile } from '@onething/core/storage'
import { ncmIdSchema } from './providers/ncm/ids.js'
import type { MusicIdSchema } from './providers/types.js'

export interface OnethingRadioBrief {
  active: boolean
  /** The user's intent in plain words, e.g. 「下雨天,安静的中文民谣」. */
  intent: string
  startedAt?: string
  /** The dedicated DJ session; filled in by the host once it exists. */
  sessionId?: string
  /** Recently played, newest last. Context for the DJ's next batch. */
  played: OnethingRadioSpin[]
  /** Songs the user skipped — the strongest negative signal the DJ gets. */
  skipped: OnethingRadioSpin[]
  /** Songs the user hearted from the bar — the strongest positive signal. */
  loved: OnethingRadioSpin[]
  /** Last conductor-level failure, surfaced to the music variable. */
  lastError?: string
  /**
   * When the model's intent was last applied to this brief (ISO). The
   * conductor compares it against its own wake clock to know it owes an
   * immediate curation — works no matter WHO ran the merge (conductor tick or
   * the radio tool applying synchronously).
   */
  intentAppliedAt?: string
  /**
   * When the user last SET the intent — an open/retune that wrote a non-empty
   * direction (mergeIntent). Distinct from intentAppliedAt (a play-press
   * re-stamps that) and startedAt (re-arm): this ages ONLY on a real intent
   * statement, so a stale direction expires on its own even while the user
   * keeps pressing play the same station. Cleared when the intent is cleared.
   */
  intentSetAt?: string
  /**
   * The last song the conductor put into the player, ids and all. Fed songs
   * live only in the daemon's memory (queue.json is not a mirror — measured),
   * so when the daemon dies with the programme already drained, this is the
   * only playable thing left to resume the radio from.
   */
  onDeck?: OnethingRadioProgrammeEntry
  /**
   * Where playback last was, sampled while the player daemon was alive
   * (`LastPlaybackRecorder`). The daemon forgets everything when it exits;
   * this is what lets the panel show "that song, stopped at 1:42" and ⏯ pick
   * up from there.
   */
  lastPlayback?: OnethingRadioLastPlayback
}

export interface OnethingRadioLastPlayback {
  /** The player's own title string. */
  title: string
  /** Only when the radio started this song — the id resume needs. */
  encryptedId?: string
  /** Seconds. */
  position: number
  /** Seconds, when known. */
  duration?: number
  /** ISO time of the sample. */
  at: string
}

export interface OnethingRadioSpin {
  /** Display only — never a join key. LLM-written titles drift ('早春的树' vs
   * '早春的树 - 陈鸿宇' broke every title-keyed feature at once). */
  title: string
  at: string
  /** The real key, when known (radio-started spins always know it). */
  encryptedId?: string
  /** Track length in seconds, when the programme entry or the player knew it. */
  durationS?: number
}

export interface OnethingRadioProgrammeEntry {
  /** 32-hex API id — what `queue add --encrypted-id` wants. */
  encryptedId: string
  /** Plain numeric id — `queue add` wants both. */
  originalId: string
  title: string
  /** The DJ's own programming note. Not read by code; kept for the audit trail. */
  note?: string
  /**
   * The DJ's spoken patter for this song — a sentence or two the host says as
   * the track comes on (the 串词). Synthesized to speech and played in the gap
   * before the song by the conductor's speak hook. Optional: no patter just
   * means the song plays without an intro.
   */
  say?: string
  /**
   * Copied verbatim from the search record at curation time. `false` means
   * NetEase will not play this song for this account (rights/region): `play`
   * on it exits 0 with no sound, so the conductor skips such entries outright
   * — no patter, no 12s verify wait (2026-07-17: the host kept introducing
   * songs that never came). Absent = unknown, play normally.
   */
  playFlag?: boolean
  /**
   * Track length in seconds, copied from the search record at curation time
   * (the DJ copies ncm's `duration` in ms; `normalizeEntry` converts). The
   * panel sizes each song's groove on the record by it. Absent = unknown.
   */
  durationS?: number
}

export interface OnethingRadioProgramme {
  entries: OnethingRadioProgrammeEntry[]
}

/** How much played/skipped history the brief keeps (and feeds back to the DJ). */
const SPIN_HISTORY_LIMIT = 50

export interface OnethingRadioStore {
  readBrief(): OnethingRadioBrief
  writeBrief(brief: OnethingRadioBrief): void
  readProgramme(): OnethingRadioProgramme
  writeProgramme(programme: OnethingRadioProgramme): void
  /** Pop the next entry off the programme, persisting the shorter list. */
  takeNextEntry(): OnethingRadioProgrammeEntry | null
  /**
   * Move the DJ's inbox into the programme, skipping songs already in the
   * programme or recently played (by id and by title). Returns how many
   * entries were merged; 0 when the inbox is empty or all duplicates.
   */
  mergeInbox(): number
  /**
   * Apply the model's intent file (open/retune/close the station) into the
   * brief, then clear it. The model never writes the brief itself — it holds
   * the conductor's bookkeeping (onDeck, markers, history), and a whole-file
   * write from a model would race it exactly like the old programme races.
   * Returns true when something was applied.
   */
  mergeIntent(): boolean
  /**
   * Age out a stale intent: if a non-empty intent has gone unrefreshed for
   * longer than ttlMs (measured from intentSetAt — the last real set/open, NOT
   * a play-press), clear it so the next DJ wake degrades to "self-direct" (by
   * time + history) instead of quoting last session's direction. A pre-feature
   * intent with no intentSetAt counts as expired. Returns true when it cleared.
   */
  expireStaleIntent(ttlMs: number): boolean
  recordPlayed(title: string, encryptedId?: string, durationS?: number): void
  recordSkipped(title: string, encryptedId?: string): void
  recordLoved(title: string, encryptedId?: string): void
  recordError(message: string | undefined): void
  /**
   * A user gesture on the bar (resume, skip) is re-engagement, same weight as
   * re-stating intent: stamp intentAppliedAt so the conductor owes the DJ a
   * wake and any tripped breaker resets. Intent text is untouched.
   */
  noteUserEngagement(): void
  /** Remember the song that just went into the player (see brief.onDeck). */
  setOnDeck(entry: OnethingRadioProgrammeEntry): void
  briefPath: string
  programmePath: string
  inboxPath: string
  intentPath: string
}

function emptyBrief(): OnethingRadioBrief {
  return { active: false, intent: '', played: [], skipped: [], loved: [] }
}

function normalizeSpins(raw: unknown, ids: MusicIdSchema): OnethingRadioSpin[] {
  if (!Array.isArray(raw)) return []
  const spins: OnethingRadioSpin[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { title, at, encryptedId } = item as Record<string, unknown>
    if (typeof title !== 'string' || !title) continue
    spins.push({
      title,
      at: typeof at === 'string' ? at : '',
      encryptedId:
        typeof encryptedId === 'string' && ids.validateSpinId(encryptedId)
          ? encryptedId
          : undefined,
    })
  }
  return spins.slice(-SPIN_HISTORY_LIMIT)
}

function normalizeBrief(raw: unknown, ids: MusicIdSchema): OnethingRadioBrief {
  if (!raw || typeof raw !== 'object') return emptyBrief()
  const record = raw as Record<string, unknown>
  return {
    active: record.active === true,
    intent: typeof record.intent === 'string' ? record.intent : '',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    sessionId: typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : undefined,
    played: normalizeSpins(record.played, ids),
    skipped: normalizeSpins(record.skipped, ids),
    loved: normalizeSpins(record.loved, ids),
    lastError: typeof record.lastError === 'string' && record.lastError ? record.lastError : undefined,
    intentAppliedAt:
      typeof record.intentAppliedAt === 'string' && record.intentAppliedAt
        ? record.intentAppliedAt
        : undefined,
    intentSetAt:
      typeof record.intentSetAt === 'string' && record.intentSetAt
        ? record.intentSetAt
        : undefined,
    onDeck: normalizeEntry(record.onDeck, ids) ?? undefined,
    lastPlayback: normalizeLastPlayback(record.lastPlayback),
  }
}

function normalizeLastPlayback(raw: unknown): OnethingRadioLastPlayback | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.title !== 'string' || !r.title) return undefined
  if (typeof r.position !== 'number' || !Number.isFinite(r.position) || r.position < 0) return undefined
  return {
    title: r.title,
    ...(typeof r.encryptedId === 'string' && r.encryptedId ? { encryptedId: r.encryptedId } : {}),
    position: r.position,
    ...(typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration > 0 ? { duration: r.duration } : {}),
    at: typeof r.at === 'string' ? r.at : '',
  }
}

/** Id validation is the provider's (ncm: dual-id, 32-hex + numeric). */
function normalizeEntry(item: unknown, ids: MusicIdSchema): OnethingRadioProgrammeEntry | null {
  if (!item || typeof item !== 'object') return null
  return ids.normalizeEntry(item as Record<string, unknown>)
}

function normalizeProgramme(raw: unknown, ids: MusicIdSchema): OnethingRadioProgramme {
  if (!raw || typeof raw !== 'object') return { entries: [] }
  const rawEntries = (raw as Record<string, unknown>).entries
  if (!Array.isArray(rawEntries)) return { entries: [] }

  const entries: OnethingRadioProgrammeEntry[] = []
  for (const item of rawEntries) {
    const entry = normalizeEntry(item, ids)
    if (entry) entries.push(entry)
  }
  return { entries }
}

export interface CreateOnethingRadioStoreOptions {
  /** The active provider's id validation. Defaults to ncm (the founding CLI). */
  ids?: MusicIdSchema
  /**
   * Stamped on the programme file. Entries hold provider-specific ids, so a
   * programme written under another provider is unplayable debris: on read,
   * a mismatched stamp discards it (absent stamp = 'ncm-cli', the founding
   * default — existing files keep working). The brief's taste history stays;
   * titles are provider-neutral.
   */
  providerId?: string
}

export function createOnethingRadioStore(
  directory: string,
  options: CreateOnethingRadioStoreOptions = {},
): OnethingRadioStore {
  const ids = options.ids ?? ncmIdSchema
  const providerId = options.providerId ?? 'ncm-cli'
  const briefPath = path.join(directory, 'radio-brief.json')
  const programmePath = path.join(directory, 'programme.json')
  const inboxPath = path.join(directory, 'programme-inbox.json')
  const intentPath = path.join(directory, 'radio-intent.json')

  const readBrief = () => normalizeBrief(readJsonFile<unknown>(briefPath, null), ids)
  const writeBrief = (brief: OnethingRadioBrief) => writeJsonFile(briefPath, brief)
  const readProgramme = () => {
    const raw = readJsonFile<Record<string, unknown> | null>(programmePath, null)
    const stampedProvider =
      raw && typeof raw.providerId === 'string' && raw.providerId ? raw.providerId : 'ncm-cli'
    if (raw && stampedProvider !== providerId) return { entries: [] }
    return normalizeProgramme(raw, ids)
  }
  const writeProgrammeFile = (programme: OnethingRadioProgramme) =>
    writeJsonFile(programmePath, { providerId, entries: programme.entries })

  return {
    briefPath,
    programmePath,
    inboxPath,
    intentPath,
    readBrief,
    writeBrief,
    readProgramme,
    writeProgramme: writeProgrammeFile,
    takeNextEntry() {
      const programme = readProgramme()
      const next = programme.entries.shift() ?? null
      if (next) writeProgrammeFile(programme)
      return next
    },
    mergeInbox() {
      const inbox = normalizeProgramme(readJsonFile<unknown>(inboxPath, null), ids)
      if (inbox.entries.length === 0) return 0

      const programme = readProgramme()
      const played = readBrief().played
      // Ids are the real cross-batch key: radio-started spins carry them, so a
      // song the station already played cannot come back no matter how the DJ
      // spells its title this time. Exact-title match stays as a weak fallback
      // for historic spins that predate ids.
      const knownIds = new Set([
        ...programme.entries.map(entry => entry.encryptedId.toLowerCase()),
        ...played.flatMap(spin => (spin.encryptedId ? [spin.encryptedId.toLowerCase()] : [])),
      ])
      const knownTitles = new Set([
        ...programme.entries.map(entry => entry.title),
        ...played.map(spin => spin.title),
      ])

      const fresh = inbox.entries.filter(entry => {
        if (knownIds.has(entry.encryptedId.toLowerCase())) return false
        if (knownTitles.has(entry.title)) return false
        knownIds.add(entry.encryptedId.toLowerCase())
        knownTitles.add(entry.title)
        return true
      })

      if (fresh.length > 0) {
        programme.entries.push(...fresh)
        writeProgrammeFile(programme)
      }
      writeJsonFile(inboxPath, { entries: [] })
      return fresh.length
    },
    recordPlayed(title, encryptedId, durationS) {
      const brief = readBrief()
      brief.played = [...brief.played, { title, at: new Date().toISOString(), encryptedId, durationS }].slice(
        -SPIN_HISTORY_LIMIT,
      )
      writeBrief(brief)
    },
    recordSkipped(title, encryptedId) {
      const brief = readBrief()
      brief.skipped = [...brief.skipped, { title, at: new Date().toISOString(), encryptedId }].slice(
        -SPIN_HISTORY_LIMIT,
      )
      writeBrief(brief)
    },
    recordLoved(title, encryptedId) {
      const brief = readBrief()
      brief.loved = [...brief.loved, { title, at: new Date().toISOString(), encryptedId }].slice(
        -SPIN_HISTORY_LIMIT,
      )
      writeBrief(brief)
    },
    recordError(message) {
      const brief = readBrief()
      if (brief.lastError === (message || undefined)) return
      brief.lastError = message || undefined
      writeBrief(brief)
    },
    noteUserEngagement() {
      const brief = readBrief()
      const now = new Date().toISOString()
      brief.intentAppliedAt = now
      // Also re-arms auto-advance ("opened this run"): the user just pressed
      // play — when the DJ's batch lands, it should sound without a second
      // press.
      brief.startedAt = now
      writeBrief(brief)
    },
    setOnDeck(entry) {
      const brief = readBrief()
      brief.onDeck = entry
      writeBrief(brief)
    },
    mergeIntent() {
      const raw = readJsonFile<unknown>(intentPath, null)
      if (!raw || typeof raw !== 'object') return false
      const record = raw as Record<string, unknown>
      const hasActive = typeof record.active === 'boolean'
      // Key PRESENCE, not non-emptiness. An open (radio.ts openRadioStation)
      // always writes an `intent` key — even the empty string the 新电台 button
      // sends — and a fresh open must WIPE the previous station's intent (else
      // last chat's 午睡歌曲 haunts tonight's late-night radio). A close writes
      // `{ active: false }` with NO intent key, so it still preserves intent.
      const hasIntent = 'intent' in record && typeof record.intent === 'string'
      if (!hasActive && !hasIntent) return false

      const brief = readBrief()
      if (hasActive) brief.active = record.active as boolean
      if (hasIntent) {
        const next = (record.intent as string).trim()
        brief.intent = next
        // Age the intent from THIS statement. A fresh open with an empty intent
        // clears the direction, so its set-time clears too.
        brief.intentSetAt = next ? new Date().toISOString() : undefined
      }
      if (typeof record.startedAt === 'string' && record.startedAt) {
        brief.startedAt = record.startedAt
      }
      brief.intentAppliedAt = new Date().toISOString()
      writeBrief(brief)
      writeJsonFile(intentPath, {})
      return true
    },
    expireStaleIntent(ttlMs) {
      const brief = readBrief()
      if (!brief.intent) return false
      const setAt = brief.intentSetAt ? Date.parse(brief.intentSetAt) : NaN
      // Fresh only when we have a parseable stamp AND it's within the window.
      // A missing/garbled stamp (pre-feature brief) is treated as expired.
      if (Number.isFinite(setAt) && Date.now() - setAt < ttlMs) return false
      brief.intent = ''
      brief.intentSetAt = undefined
      writeBrief(brief)
      return true
    },
  }
}
