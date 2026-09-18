/**
 * **唱机面的纯算术**(唱机音乐面 M1,2026-09-17;方案 artifact「唱机音乐面」)。
 *
 * 不碰 DOM、不碰 React,所以单测直接吃。唱臂几何从宠物 P1 起搬去了
 * `record-geometry.ts`(唱片几何、唱针内外圈、这一面的纹带),这里只剩与画面无关的三件:
 *
 *  ② **歌名拆两半** —— 播放器交出来的是一格展示串「歌名 - 歌手」(自述那一格上
 *     写着理由)。这里只为**显示**拆开,永远不拿它当关联键(LLM 手写的串当键是
 *     电台 v5 事故的病根)。
 *  ③ **播放钟** —— `nowPlaying` 只在换歌 / 做完一件事之后才重读,读回来的
 *     `position` 是读的那一刻。唱臂、进度条、歌词高亮要跟着走,就在读数之上按墙钟
 *     往前推;暂停时不推,推到头就停在头上。
 *  ④ **读数的格式** —— 时钟串、节目单封顶、第一句错话。
 */

/* ── ② 歌名拆两半 ──────────────────────────────────────────────────────── */

export interface SplitTitle {
  name: string
  artist: string
}

/** 「歌名 - 歌手」→ 两半。认不出分隔就整串当歌名,歌手留空。 */
export function splitTitle(title: string | undefined): SplitTitle {
  const text = (title ?? '').trim()
  const at = text.lastIndexOf(' - ')
  if (at <= 0) return { name: text, artist: '' }
  return { name: text.slice(0, at).trim(), artist: text.slice(at + 3).trim() }
}

/* ── ③ 播放钟 ──────────────────────────────────────────────────────────── */

export interface PlaybackSample {
  /** 读数里的位置(秒)。 */
  position: number
  duration: number | undefined
  playing: boolean
  /** 读到这份读数的墙钟时刻(ms)。 */
  sampledAt: number
}

/** 此刻(ms)的位置:播放中按墙钟往前推,推到总长为止;暂停就停在读数上。 */
export function positionAt(sample: PlaybackSample, now: number): number {
  const base = Math.max(0, sample.position)
  if (!sample.playing) return base
  const moved = base + Math.max(0, now - sample.sampledAt) / 1000
  return sample.duration !== undefined ? Math.min(sample.duration, moved) : moved
}

/** 歌词里此刻唱到哪一行。还没到第一行 = -1。 */
export function lyricIndexAt(lines: readonly { at: number }[], position: number): number {
  let index = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].at <= position) index = i
    else break
  }
  return index
}

/* ── ④ 读数的格式 ──────────────────────────────────────────────────────── */

/** 节目单最多画几行。余下的用一句文字读数说出来。 */
export const PROGRAMME_LIMIT = 50

/** 秒 → `m:ss`。 */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * `位置 / 总长`。**这不是 UI 文案而是一个数的格式**(跟着语言不变),所以那条
 * 斜杠不进字典;形逐字照抄播放器自己交出来的那一格(`4:01 / 4:58`)。
 */
export function progressOf(position: number, duration: number | undefined): string {
  return duration === undefined ? clockOf(position) : `${clockOf(position)} / ${clockOf(duration)}`
}

/** 一组 mutation 里第一句错话。**就地一行**用它,零 Toast。 */
export function firstError(...snapshots: readonly { error?: string }[]): string | undefined {
  for (const snapshot of snapshots) if (snapshot.error) return snapshot.error
  return undefined
}
