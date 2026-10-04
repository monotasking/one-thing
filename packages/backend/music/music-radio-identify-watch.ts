// 电台的反向识别这一段(2026-10-04 从 `music-radio.ts` 的 `createRadioScope` 闭包里拆出,拆分批 3,D227):别人起的
// 歌(模型手动 `play`)按标题精确搜回 id、补推歌词,以及播放器状态变化的取证日志。函数正文原样;从闭包里拿的东西改由
// `createRadioIdentifyWatch` 的参数递进来,读歌词那一处改走歌词段交出的只读口,另交一只读口给红心用。
import { getLogger } from '@onething/backend/logging'
import type { MusicLyrics } from '@shared/ipc/music.js'
import { matchSongFromSearch, type OnethingMusicIdentifiedSong } from './music-identify.js'
import type { OnethingMusicNowPlaying } from './music-now-playing.js'
import type { OnethingRadioProgrammeEntry } from './music-radio-store.js'
import type { OnethingMusicReliableRunner } from './music-reliable-runner.js'
import type { MusicServiceScope } from './music-service.js'
import type { MusicWorkOwner } from './music-lifetime.js'

const log = getLogger('music.radio')

/** 反向识别这一段从电台作用域里拿的东西。 */
export interface RadioIdentifyWatchPorts {
  owner: MusicWorkOwner
  getActiveMusicProvider: MusicServiceScope['getActiveMusicProvider']
  getReliableRunner: () => OnethingMusicReliableRunner
  setCurrentLyrics: (next: MusicLyrics) => void
  pushLyricsFor: (entry: OnethingRadioProgrammeEntry, playerTitle: string) => Promise<void>
  readCurrentLyrics: () => MusicLyrics | null
}

export function createRadioIdentifyWatch(ports: RadioIdentifyWatchPorts) {
  const { owner, getActiveMusicProvider, getReliableRunner, setCurrentLyrics, pushLyricsFor, readCurrentLyrics } = ports

  let lastObservedTitle: string | undefined
  /** Titles we already failed to identify — do not burn a search per poll. */
  const identifyMisses = new Set<string>()
  /** The identified currently-playing song; title is the PLAYER's own string. */
  let identifiedCurrent: (OnethingMusicIdentifiedSong & { title: string }) | null = null

  /**
   * Ceremonies follow the song, not the code path: when a song WE did not start
   * shows up (the model's manual `play`), recover its id by exact-title search
   * and push its lyrics too. Exact or nothing — captioning the wrong song is
   * worse than no caption.
   */
  async function observeUnknownSong(sample: OnethingMusicNowPlaying | null): Promise<void> {
    owner.assertActive()
    return owner.track((async () => {
    if (sample?.status !== 'playing' || !sample.title) return
    if (sample.title === lastObservedTitle) return
    lastObservedTitle = sample.title
    identifiedCurrent = null
    // Radio-started songs already had their ceremonies at start (the lyrics
    // push carries the player's title, so this same-source compare is safe).
    if (readCurrentLyrics()?.title === sample.title) return
    if (identifyMisses.has(sample.title)) {
      setCurrentLyrics({ title: sample.title, lines: [], failed: true })
      return
    }
    try {
      const provider = getActiveMusicProvider()
      const stdout = await getReliableRunner().run('server', provider.cli.build.search(sample.title, 10))
      const match = matchSongFromSearch(provider.cli.parse.searchRecords(stdout), sample.title)
      if (!match) {
        // Bounded: a long-running station observing many unidentifiable titles
        // must not leak; dropping the oldest only means one extra search someday.
        if (identifyMisses.size >= 200) {
          const oldest = identifyMisses.values().next().value
          if (oldest !== undefined) identifyMisses.delete(oldest)
        }
        identifyMisses.add(sample.title)
        // 认不出这首是谁 = 歌词没处取。说一句,别让面板一直等。
        setCurrentLyrics({ title: sample.title, lines: [], failed: true })
        return
      }
      if (owner.signal.aborted) return
      identifiedCurrent = { ...match, title: sample.title }
      void pushLyricsFor(
        { encryptedId: match.encryptedId, originalId: match.originalId, title: sample.title },
        sample.title,
      )
    } catch (error) {
      log.warn('identify current track failed', { title: sample.title }, error)
      if (!owner.signal.aborted) setCurrentLyrics({ title: sample.title, lines: [], failed: true })
    }

    })())
  }

  /**
   * Evidence log for the premature-stop investigation (2026-07-19: 「与光」
   * audibly died ~40s into a 3m40s song after a pause→seek 0→resume hold; the
   * conductor then honestly advanced). One line per player state transition,
   * stamped with WHERE in the song it happened — a stop at 40s/220s is a stream
   * death, a stop at 218s/220s is a song ending. Remove with the other probes.
   */
  let lastWatchedSample: OnethingMusicNowPlaying | null = null

  function describeSample(sample: OnethingMusicNowPlaying | null): string {
    if (!sample) return 'null'
    const pos = Math.round(sample.position)
    const dur = sample.duration !== undefined ? `/${Math.round(sample.duration)}s` : ''
    return `${sample.status}「${sample.title ?? '?'}」${pos}s${dur}`
  }

  function logSampleTransition(sample: OnethingMusicNowPlaying | null): void {
    const prev = lastWatchedSample
    const changed =
      (prev?.status ?? 'null') !== (sample?.status ?? 'null') ||
      (prev?.title ?? '') !== (sample?.title ?? '')
    // Keep the freshest position even between logged transitions, so the
    // "playing → stopped" line carries where playback actually was.
    lastWatchedSample = sample
    if (!changed) return
    log.debug('player state changed', { from: describeSample(prev), to: describeSample(sample) })
  }

  /** 认出来的那首正在放的歌(只读;红心按它取 id)。 */
  function readIdentifiedCurrent(): (OnethingMusicIdentifiedSong & { title: string }) | null {
    return identifiedCurrent
  }

    return { observeUnknownSong, logSampleTransition, readIdentifiedCurrent }
}
