import type { MusicNowPlayingView } from './music-source'

/**
 * **播放 / 暂停:屏幕按人的意图走,后端追上来**(2026-09-25,正本 `docs/music-panel-2026-09.md` §11)。
 *
 * 用户:「你要做的事,保证前后端一致,保证用户的使用体验、点击及时响应。」
 *
 * 从前 ⏯ 是一次普通的乐观补丁:按下去读数先变,`do` 回来再对账。它有两个洞,都是真机上会看见的:
 *  ① **旧读数把屏幕打回去**:暂停还在路上时,任何一次重读(后端 5 秒一拍的轮询、别的事实带来的
 *     标脏)都拿回「还在放」,屏幕 播放 → 暂停 → 播放 跳一下(09-25 用夹具复现);
 *  ② **连点没有序**:每一下都是一只独立的 mutation,暂停 / 播放 / 暂停 三发同时在路上,谁先到
 *     由两个子进程的起跑决定。
 *
 * 这只文件是判据本身(纯函数,单测钉每一格):**人按下去那一刻起,屏幕上的「在放 / 停着」只听人的,
 * 直到后端说「照做了」之后的第一份读数** —— 那一份是权威:它与意图一致,意图功成身退;不一致,
 * 屏幕照读数改回来,并且说一句「播放器没有照做」(不许静默改回去)。
 * 状态机与发送序在 `music-source.ts`(`setMusicPlaying`),这里只有「这份读数该怎么画」。
 */

export interface PlaybackIntent {
  /** 人要的:在放(true)还是停着(false)。 */
  playing: boolean
  /**
   * 后端对**最后一发**说了「照做了」之后,读数的票号起点。票号大于它的读数是在确认之后才发出去的,
   * 所以是权威;缺席 = 还在发(还没有任何读数是权威的)。
   */
  ackTicket?: number
}

export interface PlaybackReconcile {
  /** 画在屏上的那一份。 */
  view: MusicNowPlayingView
  /** 意图还留不留着。 */
  intent: PlaybackIntent | null
  /** 权威读数与意图不一致(后端说照做了,播放器却不是那样)—— 要说一句,不能静默改回去。 */
  disagreed: boolean
}

/**
 * 此刻(`at`,墙钟 ms)的位置:在放就从 `sampledAt` 往前推(推到总长为止),停着就停在读数上。
 * 与 `content/music/turntable.ts` 的 `positionAt` 同一条算式(那边是给屏幕的播放钟用的)。
 */
export function positionOf(view: MusicNowPlayingView, at: number): number {
  const base = Math.max(0, view.position)
  if (!view.playing || view.sampledAt === undefined) return base
  const moved = base + Math.max(0, at - view.sampledAt) / 1000
  return view.duration !== undefined ? Math.min(view.duration, moved) : moved
}

/**
 * 把「在放 / 停着」换成 `playing` 那一档。`status` 与 `playing` 两格一起换:两处读的人都有。
 * **位置冻在换档这一刻**(`at`):暂停时停在此刻推到的那一秒,不退回那份旧读数的位置;继续时从这一秒起推。
 */
export function withPlaying(view: MusicNowPlayingView, playing: boolean, at: number = Date.now()): MusicNowPlayingView {
  if (view.playing === playing) return view
  return { ...view, playing, status: playing ? 'playing' : 'paused', position: positionOf(view, at), sampledAt: at }
}

/**
 * 一份读数到了,该怎么画。
 *
 * @param fetched 后端交回来的读数
 * @param ticket  这一发读是第几号(发出去那一刻取的号,单调递增)
 * @param intent  此刻的意图(没有 = 屏幕只听读数)
 */
export function reconcilePlayback(
  fetched: MusicNowPlayingView,
  ticket: number,
  intent: PlaybackIntent | null,
): PlaybackReconcile {
  if (!intent) return { view: fetched, intent: null, disagreed: false }
  // 播放器那边已经没有歌了(守护进程退了 / 歌放完了):没有东西可停可放,意图作废,听读数。
  if (!fetched.title) return { view: fetched, intent: null, disagreed: false }
  const authoritative = intent.ackTicket !== undefined && ticket > intent.ackTicket
  if (authoritative) {
    return { view: fetched, intent: null, disagreed: fetched.playing !== intent.playing }
  }
  return { view: withPlaying(fetched, intent.playing), intent, disagreed: false }
}
