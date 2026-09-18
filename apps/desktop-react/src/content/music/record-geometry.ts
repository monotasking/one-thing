/**
 * **唱片面的几何与「这一面」**(音乐面 v8 · 唱针读歌词,2026-09-18;样例「黑豆电台」v7)。
 *
 * 纯函数,没有 DOM。两件事:
 *
 * ① **几何全部按唱片半径 R 算**,面板宽窄只改 R。转轴 O、枢轴 P 在 O 的右上
 *    (1.05R, −0.95R)、臂长 1.3R;唱针走的那一段半径从 0.93R(外圈)到 0.52R(内圈,
 *    标签外)。歌词那一栏从 O 右边 1.34R 起,正在唱的那一句对着唱针的高度(O 下 0.27R)。
 *
 * ② **唱片就是这一面的节目单**:一面最多 `SIDE_CAP` 首 —— 本面放过的、正在放的、
 *    节目单里排进这一面的,各占一圈纹带,宽窄按时长。唱臂的位置是「这一面放到哪了」。
 *    第几面由本场开台以来放过几首算(`brief.recent` 的长度),不存任何状态。
 */
import type { MusicProgrammeEntryDTO, MusicRadioSpinDTO } from '@shared/ipc/music'

export const SIDE_CAP = 5
/** 说不出时长的歌按这个长度占一圈 —— 只影响纹带宽窄,不影响任何读数。 */
export const UNKNOWN_TRACK_S = 210
/** 唱针走的那一段:外圈 / 内圈,以 R 为单位。 */
export const R_IN = 0.93
export const R_OUT = 0.52

/* ── ① 几何 ─────────────────────────────────────────────────────────────── */

export interface DeckGeometry {
  /** 画面宽高。 */
  width: number
  height: number
  /** 唱片半径、直径。 */
  R: number
  D: number
  /** 唱片外框左上角。 */
  rx: number
  ry: number
  /** 转轴。 */
  ox: number
  oy: number
  /** 枢轴。 */
  px: number
  py: number
  /** 臂长(枢轴 → 唱针)。 */
  L: number
  /** 歌词那一栏左缘、右缘(离画面右边多远)。 */
  lyricsLeft: number
  lyricsRight: number
  /** 正在唱的那一句的竖直中心。 */
  anchorY: number
  /** 黑豆脚底正中、脚底离画面底边多远、形象缩放。 */
  petX: number
  petBottom: number
  petScale: number
}

const PAD = 16
/**
 * 唱片最大直径。画面是弹性的(09-18 用户:「他能是一个弹性布局吗?」)—— 面板多高唱片就多大,
 * 但一张占满一整块高屏的唱片不再是唱机,是一张海报;到这个数就停,多出来的高度上下平分。
 */
const MAX_D = 520
/** 宽的时候歌词栏的宽,唱片 + 歌词当一整块居中。 */
const WIDE_LYRICS_W = 460

export function deckGeometry(width: number, height: number, wide: boolean): DeckGeometry {
  const D = Math.max(0, Math.round(Math.min(height - 2 * PAD, width * (wide ? 0.36 : 0.47), MAX_D)))
  const R = D / 2
  const ry = Math.round((height - D) / 2)
  const rx = wide ? Math.max(PAD, Math.round((width - (2.34 * R + WIDE_LYRICS_W)) / 2)) : PAD + Math.round(R * 0.05)
  const ox = rx + R
  const oy = ry + R
  const lyricsLeft = Math.round(ox + 1.34 * R)
  const petScale = wide ? 0.97 : 0.7
  return {
    width,
    height,
    R,
    D,
    rx,
    ry,
    ox,
    oy,
    px: ox + 1.05 * R,
    py: oy - 0.95 * R,
    L: 1.3 * R,
    lyricsLeft,
    lyricsRight: wide ? Math.max(0, width - lyricsLeft - WIDE_LYRICS_W) : 0,
    anchorY: Math.round(oy + 0.27 * R),
    petX: Math.max(4, rx - 36 * petScale) + 60 * petScale,
    // 他坐在唱片左下角,不是画面底边:画面变高之后唱片居中,脚底跟着唱片的下沿走。
    petBottom: Math.max(0, height - (ry + D) - PAD),
    petScale,
  }
}

/** 唱臂转过 `deg`(0 = 竖直向下,顺时针为正)时唱针的位置。 */
export function needleAt(g: DeckGeometry, deg: number): { x: number; y: number } {
  const a = (deg * Math.PI) / 180
  return { x: g.px - g.L * Math.sin(a), y: g.py + g.L * Math.cos(a) }
}

/** 唱针离转轴多远(以 R 为单位)。 */
export function needleRadius(g: DeckGeometry, deg: number): number {
  const n = needleAt(g, deg)
  return g.R > 0 ? Math.hypot(n.x - g.ox, n.y - g.oy) / g.R : 0
}

/** 唱针落在半径 r(以 R 为单位)时唱臂转多少度。0°–40° 内半径单调减。 */
export function angleForRadius(g: DeckGeometry, r: number): number {
  let lo = 0
  let hi = 40
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (needleRadius(g, mid) > r) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** 这一面放到 `p`(0–1)时唱臂的角度。 */
export function angleForSide(g: DeckGeometry, p: number): number {
  return angleForRadius(g, R_IN - (R_IN - R_OUT) * clamp01(p))
}

/** 唱臂在 `deg` 时,这一面放到哪(0–1)。 */
export function sideAtAngle(g: DeckGeometry, deg: number): number {
  return clamp01((R_IN - needleRadius(g, deg)) / (R_IN - R_OUT))
}

/** 指针落在画面坐标 (x, y) 时唱臂该转到的角度。 */
export function angleAtPoint(g: DeckGeometry, x: number, y: number): number {
  return (Math.atan2(-(x - g.px), y - g.py) * 180) / Math.PI
}

/** 这一面的半径(以 R 为单位)→ 唱片 svg 的坐标(viewBox 200,R = 100)。 */
export function svgRadiusAt(p: number): number {
  return (R_IN - (R_IN - R_OUT) * clamp01(p)) * 100
}

/* ── ② 这一面 ───────────────────────────────────────────────────────────── */

export interface SideBand {
  /** 显示的歌名(播放器 / 节目单的原串)。 */
  title: string
  /** 这一圈占多少秒。 */
  seconds: number
  /** 这一面上从第几秒开始。 */
  start: number
  /** 放过的 / 正在放的 / 排着的。 */
  kind: 'played' | 'current' | 'ahead'
  /** 排着的那几首:节目单里的 id(拖唱臂到这一圈 = 放它)。 */
  encryptedId?: string
  /** 黑豆会在这首之前开口。 */
  talk: boolean
}

export interface RecordSide {
  /** 'A' / 'B',一面一面轮着翻。 */
  letter: 'A' | 'B'
  bands: SideBand[]
  /** 正在放的那一圈的下标。 */
  current: number
  /** 这一面总共多少秒。 */
  total: number
  /** 节目单里排不进这一面、要翻面之后才放的有几首。 */
  overflow: number
}

/**
 * 从读数算出这一面。
 *
 * `recent` 是本场放过的歌、新的在前;**有歌在放时它的头一个就是这首**(后端在歌起播那一刻
 * 记账)。本场第 n 首(1 起)落在第 ⌊(n−1)/5⌋ 面的第 (n−1)%5 圈 —— 所以同一面上
 * 放过的就是 `recent[1..pos]`。
 *
 * 读数不齐时(头一个不是这首:没开电台、或刚开台还没记上账)就当这首是这一面的第一首。
 */
export function recordSideOf(input: {
  nowTitle: string | undefined
  nowDuration: number | undefined
  recent: readonly MusicRadioSpinDTO[] | undefined
  entries: readonly MusicProgrammeEntryDTO[] | undefined
}): RecordSide | null {
  const { nowTitle, nowDuration } = input
  if (!nowTitle) return null
  const recent = input.recent ?? []
  const counted = recent[0]?.title === nowTitle ? recent.length : 0
  const pos = counted > 0 ? (counted - 1) % SIDE_CAP : 0
  const sideIndex = counted > 0 ? Math.floor((counted - 1) / SIDE_CAP) : 0
  const played = recent.slice(1, 1 + pos).reverse()
  const room = SIDE_CAP - pos - 1
  const entries = input.entries ?? []
  const ahead = entries.slice(0, room)

  const bands: SideBand[] = []
  let start = 0
  const push = (band: Omit<SideBand, 'start'>) => {
    bands.push({ ...band, start })
    start += band.seconds
  }
  for (const spin of played) push({ title: spin.title, seconds: spin.durationS ?? UNKNOWN_TRACK_S, kind: 'played', talk: false })
  push({
    title: nowTitle,
    seconds: nowDuration !== undefined && nowDuration > 0 ? nowDuration : UNKNOWN_TRACK_S,
    kind: 'current',
    talk: false,
  })
  for (const entry of ahead) {
    push({
      title: entry.title,
      seconds: entry.durationS ?? UNKNOWN_TRACK_S,
      kind: 'ahead',
      encryptedId: entry.encryptedId,
      talk: Boolean(entry.say),
    })
  }
  return {
    letter: sideIndex % 2 === 0 ? 'A' : 'B',
    bands,
    current: played.length,
    total: start,
    overflow: Math.max(0, entries.length - ahead.length),
  }
}

/** 这一面放到哪(0–1):前几圈的时长 + 这首放到的秒数。 */
export function sideProgress(side: RecordSide, position: number | undefined): number {
  const band = side.bands[side.current]
  if (!band || side.total <= 0) return 0
  const into = Math.min(band.seconds, Math.max(0, position ?? 0))
  return (band.start + into) / side.total
}

/** 唱针在这一面的 `p` 处:落在哪一圈、那一首的第几秒。不往回找放过的那几圈。 */
export function bandAt(side: RecordSide, p: number): { index: number; seconds: number } {
  const at = clamp01(p) * side.total
  let index = side.current
  for (let i = side.current; i < side.bands.length; i++) if (side.bands[i].start <= at) index = i
  const band = side.bands[index]
  return { index, seconds: Math.min(band.seconds - 1, Math.max(0, at - band.start)) }
}

/* ── 标签的颜色 ─────────────────────────────────────────────────────────── */

export interface LabelColors {
  /** 标签边与字(深)。 */
  ink: string
  /** 标签纸(浅)。 */
  paper: string
}

/**
 * 歌名 → 标签两色。**没有封面图**(判词在 `MusicPanel.tsx` 文件头),所以标签是从歌名
 * 算出来的:FNV-1a 取两个色相,一深一浅。同一首歌永远同一张标签,在唱片上、在播放列表的
 * 碟形色块上是同一个颜色。颜色是生成的数据,不是界面色,所以不进 token(与 `--fb-*`
 * 品牌色数据同一条例外)。
 */
export function labelColorsFor(title: string): LabelColors {
  let h = 0x811c9dc5
  for (const ch of title) {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const hueInk = h % 360
  const huePaper = (hueInk + 25 + ((h >>> 9) % 110)) % 360
  return { ink: `hsl(${hueInk} 26% 30%)`, paper: `hsl(${huePaper} 44% 84%)` }
}
