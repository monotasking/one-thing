// 电台的歌词这一段(2026-10-04 从 `music-radio.ts` 的 `createRadioScope` 闭包里拆出,拆分批 3,D227):手上那份歌词、
// 按歌缓存的时间轴、起播 / 补播时取歌词并推给读者。函数正文原样;它们从前从闭包里拿的东西改由 `createRadioLyrics`
// 的参数递进来(同一批对象与函数,解构成同名局部量),只在 `currentLyrics` 这一个 `let` 上多交一只读口给闭包里别的段。
import { broadcastVoiceHostMessage } from '@onething/backend/voice'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { MusicLyricLine, MusicLyrics } from '@shared/ipc/music.js'
import { getLogger } from '@onething/backend/logging'
import type { OnethingRadioProgrammeEntry, OnethingRadioStore } from './music-radio-store.js'
import type { OnethingMusicReliableRunner } from './music-reliable-runner.js'
import type { MusicServiceScope } from './music-service.js'
import type { MusicWorkOwner } from './music-lifetime.js'

const log = getLogger('music.radio')

/** 歌词这一段从电台作用域里拿的东西。 */
export interface RadioLyricsPorts {
  owner: MusicWorkOwner
  options: { announceLyrics?: (lyrics: MusicLyrics) => void }
  getActiveMusicProvider: MusicServiceScope['getActiveMusicProvider']
  getMusicNowPlaying: MusicServiceScope['getMusicNowPlaying']
  getRadioStore: () => OnethingRadioStore
  getReliableRunner: () => OnethingMusicReliableRunner
}

export function createRadioLyrics(ports: RadioLyricsPorts) {
  const { owner, options, getActiveMusicProvider, getMusicNowPlaying, getRadioStore, getReliableRunner } = ports

  const lyricCache = new Map<string, MusicLyricLine[]>()
  /** In-flight lyric fetches, so a prefetch and the start flow share one call. */
  const lyricInflight = new Map<string, Promise<MusicLyricLine[]>>()
  let currentLyrics: MusicLyrics | null = null

  /** 换手上那份歌词并告诉读者(推送一条给旧宿主,再报一条事实给资源订阅方)。 */
  function setCurrentLyrics(next: MusicLyrics): void {
    currentLyrics = next
    broadcastVoiceHostMessage({ channel: IPC_CHANNELS.MUSIC_LYRICS, payload: next })
    try {
      options.announceLyrics?.(next)
    } catch (error) {
      log.warn('announce lyrics failed', {}, error)
    }
  }

  function getMusicLyrics(): MusicLyrics | null {
    owner.assertActive()
    if (currentLyrics === null) fetchLastPlaybackLyrics()
    return currentLyrics
  }

  /**
   * 重新打开应用时,播放器还没起、这台进程手上没有任何歌词 —— 而面板画的是「上次放到哪」那首、停在那一秒
   * (09-19)。歌词也该是那一首的(09-25「重新打开的时候,歌词、进度等是否正常」):只要上次那首是电台起的
   * (手上有它的 id),就照起播时同一条路去取、取到了照样推一声,读者据那一声重读。
   * 播放器此刻在放别的歌就不取 —— 那时该有歌词的是正在放的那首,由它自己的起播 / 采样去推。
   * 只取一次不靠额外的记号:取到(或确认取不到)之后手上就有了一份歌词,不再是 `null`;取的路上再问,
   * `getLyricLines` 按 id 合并成同一发。
   */
  function fetchLastPlaybackLyrics(): void {
    if (getMusicNowPlaying()?.title) return
    const last = getRadioStore().readBrief().lastPlayback
    if (!last?.encryptedId) return
    void pushLyricsFor({ encryptedId: last.encryptedId, originalId: '', title: last.title }, last.title)
  }

  /**
   * Fetch (once per song, cached) and push the timed lyrics for a song the radio
   * just started. Best-effort: no lyrics is ambience missing, never an error the
   * user sees. One server call per new song — the cache keeps replays free.
   */
  /** Fetch (cached) the timed lyric lines for a song — shared by the lyric push
   * and the talk-over-the-intro timing decision. */
  async function getLyricLines(entry: OnethingRadioProgrammeEntry): Promise<MusicLyricLine[]> {
    owner.assertActive()
    return owner.track((async () => {
    const cached = lyricCache.get(entry.encryptedId)
    if (cached) return cached
    let inflight = lyricInflight.get(entry.encryptedId)
    if (!inflight) {
      inflight = (async () => {
        try {
          const provider = getActiveMusicProvider()
          const stdout = await getReliableRunner().run('server', provider.cli.build.lyric(entry))
          // The provider's parser degrades garbage to "no lyrics", never a throw.
          const lines = provider.cli.parse.lyric(stdout)
          // Evict the oldest entry, not the whole cache — clear-all used to wipe
          // the CURRENT song's lines too, forcing a refetch mid-play.
          if (lyricCache.size > 20) {
            const oldest = lyricCache.keys().next().value
            if (oldest !== undefined) lyricCache.delete(oldest)
          }
          lyricCache.set(entry.encryptedId, lines)
          return lines
        } finally {
          // Failures are not cached: the next caller retries the fetch.
          lyricInflight.delete(entry.encryptedId)
        }
      })()
      lyricInflight.set(entry.encryptedId, inflight)
    }
    return inflight

    })())
  }

  async function pushLyricsFor(entry: OnethingRadioProgrammeEntry, playerTitle: string): Promise<void> {
    owner.assertActive()
    return owner.track((async () => {
    try {
      const lines = await getLyricLines(entry)
      // The PLAYER's title, not the DJ's: the renderer guards lyrics against the
      // bar's now-playing title, and only the player agrees with itself.
      if (owner.signal.aborted) return
      setCurrentLyrics({ title: playerTitle, lines })
    } catch (error) {
      log.warn('fetch lyrics failed', { title: entry.title }, error)
      // 说出来:没取到。不说的话面板会一直等下去(「正在取歌词」永远不结束)。
      if (!owner.signal.aborted) setCurrentLyrics({ title: playerTitle, lines: [], failed: true })
    }

    })())
  }

  /** 此刻手上那份歌词(只读;换它只走 `setCurrentLyrics`)。 */
  function readCurrentLyrics(): MusicLyrics | null {
    return currentLyrics
  }

    return { lyricCache, lyricInflight, setCurrentLyrics, getMusicLyrics, getLyricLines, pushLyricsFor, readCurrentLyrics }
}
