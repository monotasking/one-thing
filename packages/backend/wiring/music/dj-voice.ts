/**
 * DJ patter voicing: synthesize the host's line and play it in the renderer,
 * on a track separate from mpv, resolving only once the renderer says it
 * finished. The start flow speaks into the pre-song silence and, when the
 * song loads faster than the host talks, simply lets the two overlap — the
 * round-trip ack here is what tells the start flow the voice is done (and
 * what unblocks a 停止电台 pressed mid-sentence).
 */
import { randomUUID } from 'node:crypto'
import { broadcastVoiceHostMessage } from '@onething/runtime/voice/host-ports.wiring'
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

const pending = new Map<string, () => void>()

/** Renderer → main: a patter finished (or failed) playing. */
export function resolveDjSpeakDone(id: string): void {
  pending.get(id)?.()
}

interface DjSpeech {
  audioBase64: string
  mimeType: string
}

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

/**
 * Cache-aware synthesis: joins an in-flight request for the same text instead
 * of duplicating it. Resolves null (never rejects) on failure/timeout — the
 * speak path treats that as "skip the patter", and a failed attempt is not
 * cached, so the next caller retries.
 */
function synthesizeDjPatterCached(text: string, title: string): Promise<DjSpeech | null> {
  const cached = patterCache.get(text)
  if (cached) return Promise.resolve(cached)
  let inflight = patterInflight.get(text)
  if (!inflight) {
    inflight = (async () => {
      const settings = getSettings().voice
      if (!settings) return null
      const synthStart = Date.now()
      try {
        const speech = await withTimeout(
          synthesizeSpeech(text, settings),
          DJ_SYNTH_MAX_MS,
          'DJ patter synthesis',
        )
        if (!speech.audioBase64) return null
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
        patterCache.set(text, speech)
        return speech
      } catch (error) {
        log.warn('dj patter synthesis failed, skipping', { title }, error)
        return null
      } finally {
        patterInflight.delete(text)
      }
    })()
    patterInflight.set(text, inflight)
  }
  return inflight
}

/** Fire-and-forget synthesis warm-up; speakDjPatter later joins the result. */
export function prefetchDjPatter(text: string, title: string): void {
  void synthesizeDjPatterCached(text, title)
}

/** Test/dispose seam: forget cached and in-flight synthesis. */
export function resetDjPatterCache(): void {
  patterCache.clear()
  patterInflight.clear()
}

/**
 * Synthesize `text` and play it in the renderer, resolving when playback ends.
 * Resolves (never rejects) on synth failure or timeout too — the caller's job
 * is to resume the music no matter what, so a swallowed error here beats a
 * radio stuck on pause.
 */
export async function speakDjPatter(text: string, title: string): Promise<void> {
  const speech = await synthesizeDjPatterCached(text, title)
  if (!speech) return

  const id = randomUUID()
  const payload: MusicDjSpeak = {
    id,
    audioBase64: speech.audioBase64,
    mimeType: speech.mimeType,
    text,
    title,
  }

  const playStart = Date.now()
  await new Promise<void>(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      pending.delete(id)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, DJ_SPEAK_MAX_MS)
    pending.set(id, finish)
    broadcastVoiceHostMessage({ channel: IPC_CHANNELS.MUSIC_DJ_SPEAK, payload })
  })
  log.debug('dj patter played in renderer', { title, ms: Date.now() - playStart })
}
