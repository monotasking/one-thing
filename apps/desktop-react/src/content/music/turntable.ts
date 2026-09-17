/**
 * **唱机面的纯算术**(唱机音乐面 M1,2026-09-17;方案 artifact「唱机音乐面」)。
 *
 * 三件事,都不碰 DOM、不碰 React,所以单测直接吃:
 *
 *  ① **唱臂几何** —— 进度 ↔ 角度。唱臂只有一个含义:「跳到这里」。外圈是开头、
 *     内圈是结尾,角度是进度的纯函数;拖动时反过来由角度求进度。坐标系是唱盘那一格
 *     自己的百分比(左上 0、右下 100),轴心钉在 (95, 6),与样式表里 `.arm` 的
 *     `left` / `top` 是同一对数 —— 两处一起改。
 *  ② **歌名拆两半** —— 播放器交出来的是一格展示串「歌名 - 歌手」(自述那一格上
 *     写着理由)。这里只为**显示**拆开,永远不拿它当关联键(LLM 手写的串当键是
 *     电台 v5 事故的病根)。
 *  ③ **播放钟** —— `nowPlaying` 只在换歌 / 做完一件事之后才重读,读回来的
 *     `position` 是读的那一刻。唱臂、进度条、歌词高亮要跟着走,就在读数之上按墙钟
 *     往前推;暂停时不推,推到头就停在头上。
 */

/* ── ① 唱臂几何 ─────────────────────────────────────────────────────────── */

/** 轴心在唱盘格子里的位置(百分比)。与 `.arm` 的 left / top 同一对数。 */
export const ARM_PIVOT = { x: 95, y: 6 } as const
/** 唱针落在最外圈(开头)时唱臂的角度。 */
export const ARM_OUTER_DEG = 94.4
/** 唱针落在最内圈(结尾)时唱臂的角度。 */
export const ARM_INNER_DEG = 117.3
/** 没有歌时唱臂靠在支架上的角度。 */
export const ARM_REST_DEG = 80

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/** 进度(0–1)→ 唱臂角度。 */
export function armAngleFor(progress: number): number {
  return ARM_OUTER_DEG + (ARM_INNER_DEG - ARM_OUTER_DEG) * clamp01(progress)
}

/** 唱臂角度 → 进度(0–1)。拖出唱片范围一律夹回两头。 */
export function progressForAngle(deg: number): number {
  return clamp01((deg - ARM_OUTER_DEG) / (ARM_INNER_DEG - ARM_OUTER_DEG))
}

/**
 * 指针落在唱盘哪一格 → 唱臂该指向的角度。`box` 是唱盘那一格的矩形。
 * 空矩形(还没布局)答轴心正下方,等价于「不动」。
 */
export function angleAtPointer(box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): number {
  if (box.width <= 0 || box.height <= 0) return 90
  const x = ((clientX - box.left) / box.width) * 100
  const y = ((clientY - box.top) / box.height) * 100
  return (Math.atan2(y - ARM_PIVOT.y, x - ARM_PIVOT.x) * 180) / Math.PI
}

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
