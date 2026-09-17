/**
 * **听歌这件事的事实**(宠物 P4,正本 `docs/design/pet-system-2026-09.md` §11.1)。
 *
 * `music:player` 自述里那六条带 `moment` 的事件,判据全在这里:连跳计数、暂停计时、间奏检测。
 * 这是**音乐自己的状态**,住在音乐子系统的实例上(`MusicSubsystem.moments`,寿命 = backend 的
 * 寿命,换音乐 CLI 不清零),不开模块级 `let`。它只管「这算不算一件事」,发出去交给注入的
 * `emit`(子系统的扇出表 → `music:` provider 的 hub → 总线)。音乐不知道谁在听。
 *
 * ── 每一条从哪来、为什么这样判 ───────────────────────────────────────────
 *
 * | 事件 | 调用方 | 判据 |
 * | --- | --- | --- |
 * | `trackStarted` | 电台 `onSongStarted`(起播流程确认了「真的在放」) | 调一次发一次 |
 * | `skipped` | 电台 `recordRadioSkip` 真记下一次跳过的那一处 | 调一次发一次 |
 * | `skipStreak` | 同上,紧跟在 `skipped` 之后 | 90 秒内第 3 次 → 发,**发完清零**(第 4 次重新数) |
 * | `liked` | 电台 `likeCurrentSong` 服务端答应之后 | 调一次发一次 |
 * | `resumedAfterPause` | now-playing watcher 的「变了」扇出 | 见下 |
 * | `interlude` | 电台指挥台的每一拍采样 | 见下 |
 *
 * **暂停计时量的是 watcher 看见的两次状态变化之间的时间**,不是按钮时间戳:暂停可以来自播放条、
 * 模型的工具、播放器自己的快捷键,而这些路里没有一条留下可靠的「几点按的暂停」—— 唯一三路都
 * 经过的是 watcher 的状态轮询,误差是一次轮询间隔。`playing → paused` 记下时刻,`paused →
 * playing` 算差值,≥ 5 分钟才发;中间看到 `stopped` / 播放器没了 = 那不是一次暂停,清掉不发。
 *
 * **间奏检测只在拿得到这首歌的歌词时间轴时做**(`findInterludes`,LRC 只标每句起点,每句唱多久是
 * 估的,判据写在那只函数头上)。时间轴与正在放的歌对不上(标题不同)、没有歌词、或者这首歌中间
 * 没有 ≥ 12 秒的空档 → 不发,不猜。每首歌最多一次:`trackStarted` 与采样里的标题变化都会把
 * 「这首已经发过」清掉。位置落在空档里才发(用户拖过了就不补发 —— 那一刻已经过去了)。
 */

import { findInterludes, type OnethingMusicInterlude, type OnethingMusicLyricLine, type OnethingMusicNowPlaying } from '@onething/runtime/music/index'

/** 连跳窗口(§11.1:90 秒内第 3 次)。 */
export const SKIP_STREAK_WINDOW_MS = 90_000
export const SKIP_STREAK_COUNT = 3
/** 暂停多久之后回来才算一件事(§11.1:≥ 5 分钟)。 */
export const RESUME_AFTER_PAUSE_MS = 300_000
/** 空档尾巴上留这么多秒不发:再过一两秒人声就回来了,这时候开口一定会压到歌词。 */
const INTERLUDE_TAIL_GUARD_SECONDS = 3

export type MusicMomentEvent = 'trackStarted' | 'skipped' | 'skipStreak' | 'liked' | 'resumedAfterPause' | 'interlude'

export interface MusicMomentsOptions {
  emit(event: MusicMomentEvent, payload: Record<string, unknown>): void
  clock?: { now(): number }
}

/** 电台正在推的那份歌词(`MusicLyrics` 的形,只读两格)。 */
export interface MusicMomentLyrics {
  readonly title: string
  readonly lines: readonly OnethingMusicLyricLine[]
}

export class MusicMoments {
  private readonly emitFact: MusicMomentsOptions['emit']
  private readonly clock: { now(): number }
  private skips: Array<{ at: number; title: string }> = []
  private pausedAt: number | undefined
  private pausedTitle: string | undefined
  /** 这首歌的间奏发过没有:记的是「哪首」,换歌就不再相等。 */
  private interludeFiredFor: string | undefined
  private interludeCache: { lines: readonly OnethingMusicLyricLine[]; found: OnethingMusicInterlude[] } | undefined
  private lastSampleTitle: string | undefined

  constructor(options: MusicMomentsOptions) {
    this.emitFact = options.emit
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  trackStarted(song: { title: string; artist?: string; encryptedId?: string }): void {
    this.interludeFiredFor = undefined
    this.emitFact('trackStarted', {
      title: song.title,
      ...(song.artist ? { artist: song.artist } : {}),
      ...(song.encryptedId ? { encryptedId: song.encryptedId } : {}),
    })
  }

  skipped(title: string): void {
    const now = this.clock.now()
    this.emitFact('skipped', { title })
    this.skips = this.skips.filter(skip => now - skip.at <= SKIP_STREAK_WINDOW_MS)
    this.skips.push({ at: now, title })
    if (this.skips.length >= SKIP_STREAK_COUNT) {
      const titles = this.skips.map(skip => skip.title)
      this.skips = []
      this.emitFact('skipStreak', { count: titles.length, titles })
    }
  }

  liked(title: string): void {
    this.emitFact('liked', { title })
  }

  /** watcher 的「变了」扇出(标题 / 状态 / 时长任一变了才来)。 */
  observeNowPlaying(nowPlaying: OnethingMusicNowPlaying | null): void {
    const status = nowPlaying?.status
    if (status === 'paused') {
      if (this.pausedAt === undefined) {
        this.pausedAt = this.clock.now()
        this.pausedTitle = nowPlaying?.title
      }
      return
    }
    if (status === 'playing' && this.pausedAt !== undefined) {
      const pausedMs = this.clock.now() - this.pausedAt
      const title = nowPlaying?.title ?? this.pausedTitle
      this.pausedAt = undefined
      this.pausedTitle = undefined
      if (pausedMs >= RESUME_AFTER_PAUSE_MS) {
        this.emitFact('resumedAfterPause', { pausedMs, ...(title ? { title } : {}) })
      }
      return
    }
    if (status !== 'playing') {
      this.pausedAt = undefined
      this.pausedTitle = undefined
    }
  }

  /** 电台指挥台的每一拍采样 + 此刻推着的歌词。 */
  observeSample(sample: OnethingMusicNowPlaying | null, lyrics: MusicMomentLyrics | null): void {
    const title = sample?.title
    // 只在出现一个**不同的**标题时算换歌:一拍读空(播放器短暂答不上)再读回同一首,不该让
    // 同一段间奏再发一次。
    if (title && title !== this.lastSampleTitle) {
      this.lastSampleTitle = title
      this.interludeFiredFor = undefined
    }
    if (!sample || sample.status !== 'playing' || !title) return
    if (this.interludeFiredFor === title) return
    if (!lyrics || lyrics.title !== title || lyrics.lines.length === 0) return
    const interludes = this.interludesOf(lyrics.lines)
    const hit = interludes.find(gap =>
      sample.position >= gap.at && sample.position < gap.at + gap.length - INTERLUDE_TAIL_GUARD_SECONDS)
    if (!hit) return
    this.interludeFiredFor = title
    this.emitFact('interlude', {
      title,
      atSeconds: Math.round(hit.at * 10) / 10,
      lengthSeconds: Math.round(hit.length * 10) / 10,
    })
  }

  private interludesOf(lines: readonly OnethingMusicLyricLine[]): OnethingMusicInterlude[] {
    if (this.interludeCache?.lines !== lines) {
      this.interludeCache = { lines, found: findInterludes([...lines]) }
    }
    return this.interludeCache.found
  }
}
