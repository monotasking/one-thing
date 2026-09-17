/**
 * DJ patter voicing: synthesize the host's line and play it on a track separate
 * from mpv, resolving only once it finished. Where it sounds (宠物 P3, §10.2):
 * in this process through the host's `speechOutput` port when there is one;
 * otherwise pushed to a renderer when the host has voice; otherwise nowhere —
 * resolved at once instead of waiting 30s for an ack nobody will send. The start flow speaks into the pre-song silence and, when the
 * song loads faster than the host talks, simply lets the two overlap — the
 * round-trip ack here is what tells the start flow the voice is done (and
 * what unblocks a 停止电台 pressed mid-sentence).
 */
import { randomUUID } from 'node:crypto'
import { broadcastVoiceHostMessage, hasVoiceHost } from '@onething/runtime/voice/host-ports.wiring'
import { getSpeechOutput } from '@onething/runtime/voice/speech-output'
import type { PatterSpeech, PatterVoiceStyle } from './host-voice.js'
import { synthesizeSpeech } from '../voice/providers.js'
import { getSettings } from '../../stores/settings.js'
import { IPC_CHANNELS, type MusicDjSpeak } from '@shared/ipc.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('music.radio')


/**
 * Ceiling on how long one line may block the start flow. A lost ack
 * (renderer reload mid-play, no audio device) must not park the radio's
 * start pipeline forever — past this we proceed regardless.
 */
const DJ_SPEAK_MAX_MS = 30_000

/**
 * Ceiling on the synthesis call itself. This is a bare network round-trip to
 * the TTS provider, and a hung request here once froze the whole radio: the
 * caller had already paused the music and was awaiting us before resuming
 * (field-measured: paused at 0:10 of a song, forever, with no error anywhere).
 */
const DJ_SYNTH_MAX_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

import { MusicWorkOwner } from './lifetime.js'
import { getCurrentBackend } from '../../current.js'

export function createDjVoiceScope(assertOwned?: () => void) {
  const owner = new MusicWorkOwner(assertOwned)
const pending = new Map<string, () => void>()

/** Renderer → main: a patter finished (or failed) playing. */
function resolveDjSpeakDone(id: string): void {
  pending.get(id)?.()
}

type DjSpeech = PatterSpeech

/**
 * Synthesized patter, keyed by text: a prefetch (fired while the previous song
 * plays, or in parallel with the start flow's lyric wait) makes the speak call
 * hit this instead of paying the ~2.4s network synthesis on the critical path.
 * Small and bounded — a patter is per-entry one-shot; the cache mostly serves
 * prefetch→speak handoffs and the ⏮ replay of the same entry.
 */
const patterCache = new Map<string, DjSpeech>()
const patterInflight = new Map<string, Promise<DjSpeech | null>>()
const PATTER_CACHE_MAX = 10

/** The same line in two voices is two recordings: the style key joins the text. */
function patterCacheKey(text: string, style: PatterVoiceStyle | undefined): string {
  return style ? `${style.key}\u0000${text}` : text
}

/**
 * Cache-aware synthesis: joins an in-flight request for the same text instead
 * of duplicating it. Resolves null (never rejects) on failure/timeout — the
 * speak path treats that as "skip the patter", and a failed attempt is not
 * cached, so the next caller retries.
 */
function synthesizeDjPatterCached(text: string, title: string, style?: PatterVoiceStyle): Promise<DjSpeech | null> {
  const key = patterCacheKey(text, style)
  const cached = patterCache.get(key)
  if (cached) return Promise.resolve(cached)
  let inflight = patterInflight.get(key)
  if (!inflight) {
    inflight = (async () => {
      const base = getSettings().voice
      if (!base) return null
      const settings = style ? style.apply(base) : base
      const synthStart = Date.now()
      try {
        const speech = await withTimeout(
          owner.track(synthesizeSpeech(text, settings, owner.signal)),
          DJ_SYNTH_MAX_MS,
          'DJ patter synthesis',
        )
        if (owner.signal.aborted || !speech.audioBase64) return null
        log.debug('dj patter synthesized', {
          title,
          ms: Date.now() - synthStart,
          chars: text.length,
          audioKB: Math.round(speech.audioBase64.length / 1024),
        })
        if (patterCache.size >= PATTER_CACHE_MAX) {
          const oldest = patterCache.keys().next().value
          if (oldest !== undefined) patterCache.delete(oldest)
        }
        patterCache.set(key, speech)
        return speech
      } catch (error) {
        log.warn('dj patter synthesis failed, skipping', { title }, error)
        return null
      } finally {
        patterInflight.delete(key)
      }
    })()
    patterInflight.set(key, inflight)
  }
  return inflight
}

/** Fire-and-forget synthesis warm-up; speakDjPatter later joins the result. */
function prefetchDjPatter(text: string, title: string, style?: PatterVoiceStyle): void {
  owner.assertActive()
  void owner.track(synthesizeDjPatterCached(text, title, style))
}

/** Test/dispose seam: forget cached and in-flight synthesis. */
function resetDjPatterCache(): void {
  patterCache.clear()
  patterInflight.clear()
}

/**
 * Play one synthesized line and resolve when it has ended — played out,
 * aborted, or failed. Never rejects: the caller resumes the music no matter
 * what, so a swallowed error here beats a radio stuck on pause.
 *
 * Three honest routes, first match wins:
 *  1. `speechOutput` (the host plays audio in this process — the React shell);
 *  2. a voice host (a renderer that plays the push and acks it, 30s ceiling);
 *  3. neither — nothing can sound here, so the line is over right now. The old
 *     code broadcast into the void and waited the full 30s for an ack.
 */
async function playPatter(
  speech: DjSpeech,
  options: { text: string; title: string; signal?: AbortSignal },
): Promise<void> {
  const { text, title, signal } = options
  if (owner.signal.aborted || signal?.aborted) return
  const stop = signal ? AbortSignal.any([signal, owner.signal]) : owner.signal
  const playStart = Date.now()

  const output = getSpeechOutput()
  if (output) {
    try {
      await output.play({ base64: speech.audioBase64, mimeType: speech.mimeType }, stop)
    } catch (error) {
      log.warn('dj patter playback failed', { title }, error)
    }
    log.debug('dj patter played in process', { title, ms: Date.now() - playStart, aborted: stop.aborted })
    return
  }

  if (!hasVoiceHost()) {
    log.debug('dj patter has nowhere to sound; skipped', { title })
    return
  }

  const id = randomUUID()
  const payload: MusicDjSpeak = {
    id,
    audioBase64: speech.audioBase64,
    mimeType: speech.mimeType,
    text,
    title,
  }
  await new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      pending.delete(id)
      clearTimeout(timer)
      stop.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, DJ_SPEAK_MAX_MS)
    pending.set(id, finish)
    stop.addEventListener('abort', finish, { once: true })
    broadcastVoiceHostMessage({ channel: IPC_CHANNELS.MUSIC_DJ_SPEAK, payload })
  })
  log.debug('dj patter played in renderer', { title, ms: Date.now() - playStart })
}

/** Synthesize `text` (cache-aware) and play it; see `playPatter`. */
async function speakDjPatter(text: string, title: string, signal?: AbortSignal): Promise<void> {
  const speech = await synthesizeDjPatterCached(text, title)
  if (owner.signal.aborted || signal?.aborted || !speech) return
  await playPatter(speech, { text, title, ...(signal ? { signal } : {}) })
}

  function quiesce(): void {
    owner.quiesce()
    for (const finish of pending.values()) finish()
  }
  async function drain(): Promise<void> {
    quiesce()
    await owner.drain()
    patterCache.clear()
    patterInflight.clear()
  }
  return { quiesce, drain,
    resolveDjSpeakDone: owner.wrap(resolveDjSpeakDone),
    prefetchDjPatter: owner.wrap(prefetchDjPatter),
    synthesizePatter: owner.wrap(synthesizeDjPatterCached),
    playPatter: owner.wrap(playPatter),
    resetDjPatterCache: owner.wrap(resetDjPatterCache),
    speakDjPatter: owner.wrap(speakDjPatter),
  }
}
export type DjVoiceScope = ReturnType<typeof createDjVoiceScope>
export const resolveDjSpeakDone: DjVoiceScope['resolveDjSpeakDone'] = (...args) => getCurrentBackend('music').music.djVoice.resolveDjSpeakDone(...args)
export const prefetchDjPatter: DjVoiceScope['prefetchDjPatter'] = (...args) => getCurrentBackend('music').music.djVoice.prefetchDjPatter(...args)
export const resetDjPatterCache: DjVoiceScope['resetDjPatterCache'] = (...args) => getCurrentBackend('music').music.djVoice.resetDjPatterCache(...args)
export const speakDjPatter: DjVoiceScope['speakDjPatter'] = (...args) => getCurrentBackend('music').music.djVoice.speakDjPatter(...args)
