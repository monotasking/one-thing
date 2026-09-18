import type { OnethingMusicNowPlaying } from '@onething/runtime/music'
import type { OnethingRadioBrief, OnethingRadioLastPlayback } from '@onething/runtime/music/radio-store'

/**
 * **上次放到哪了**(09-19 用户:「播放状态找上次播放的状态」)。
 *
 * 播放器的守护进程一退,`ncm-cli state` 只答得出「停着、位置 0」—— 那首歌是谁、放到第几秒,
 * 随它一起没了。这只记录器在守护进程还活着的时候把这三格抄进电台简报(`brief.lastPlayback`,
 * 跟 `onDeck` 同一份文件),于是:
 *  · 面板在什么都没在放的时候,照样画得出「上次那首、停在 1:42」;
 *  · ⏯ 续播时,如果上次那首就是电台最后起播的那首、而且没放完,就从那一秒接着放。
 *
 * 写盘节流:状态变了(放 ↔ 停)立刻写,否则至少隔 `WRITE_EVERY_MS` 写一次 —— 播放器每拍都采样,
 * 每拍写一次文件是拿磁盘换一个没人看的精度。
 */
export const LAST_PLAYBACK_WRITE_EVERY_MS = 15_000
/** 离结尾不到这么多秒算「放完了」:续播不再接着这首,而是往下走。 */
const FINISHED_TAIL_S = 8
/** 刚开头几秒不值得「接着放」—— 从头放就是了。 */
const MIN_RESUME_S = 5

export interface LastPlaybackBriefStore {
  readBrief(): OnethingRadioBrief
  writeBrief(brief: OnethingRadioBrief): void
}

export class LastPlaybackRecorder {
  /** 电台最后起播的那首:播放器的标题 → 那首的 id(只有电台起的歌才接得回去)。 */
  private started: { title: string; encryptedId: string } | undefined
  private lastWriteAt = Number.NEGATIVE_INFINITY
  private lastStatus: string | undefined

  constructor(
    private readonly store: () => LastPlaybackBriefStore,
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {}

  /** 电台确认一首歌真的在放了。 */
  songStarted(playerTitle: string, encryptedId: string, duration?: number): void {
    this.started = { title: playerTitle, encryptedId }
    this.write({ title: playerTitle, encryptedId, position: 0, ...(duration ? { duration } : {}) })
  }

  /** 播放器的一拍采样。守护进程没了(`null`)/ 真停在 0 —— 不是「放到哪」,不记。 */
  observe(sample: OnethingMusicNowPlaying | null): void {
    if (!sample?.title) return
    if (sample.status === 'stopped' && sample.position <= 0) return
    const now = this.clock.now()
    const statusChanged = sample.status !== this.lastStatus
    this.lastStatus = sample.status
    if (!statusChanged && now - this.lastWriteAt < LAST_PLAYBACK_WRITE_EVERY_MS) return
    this.write({
      title: sample.title,
      ...(this.started?.title === sample.title ? { encryptedId: this.started.encryptedId } : {}),
      position: sample.position,
      ...(sample.duration ? { duration: sample.duration } : {}),
    })
  }

  /** 续播这一首(按 id 认)时从第几秒接着放;`undefined` = 从头放,或者这首不是上次那首。 */
  resumePoint(encryptedId: string): number | undefined {
    const last = this.store().readBrief().lastPlayback
    if (!last || last.encryptedId !== encryptedId) return undefined
    if (last.position < MIN_RESUME_S) return undefined
    if (last.duration !== undefined && last.position > last.duration - FINISHED_TAIL_S) return undefined
    return Math.floor(last.position)
  }

  private write(entry: Omit<OnethingRadioLastPlayback, 'at'>): void {
    this.lastWriteAt = this.clock.now()
    const store = this.store()
    const brief = store.readBrief()
    store.writeBrief({ ...brief, lastPlayback: { ...entry, at: new Date(this.lastWriteAt).toISOString() } })
  }
}
