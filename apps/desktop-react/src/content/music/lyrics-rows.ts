/**
 * **歌词那一屏的纯算术**(音乐面 v7,正本 `apps/desktop-react/docs/music-panel-2026-09.md`)。
 *
 * 不碰 DOM、不碰 React,所以单测直接吃。三件事:
 *
 *  ① **把读数折成行** —— 播放器交出来的是 `{ at, text }` 的一串。屏幕上要的不是这串:
 *     没词的那几行是**间奏**(样例里画成三点),而间奏只在它真的够长时才值得占一行 ——
 *     两秒的空当画三个点,人会以为歌词卡住了。
 *  ② **一句唱到几成** —— 逐字填色要的那个百分比。往回收 0.6 秒:一句的最后半秒通常是
 *     尾音,填满得比字唱完早一点,读起来才是「跟着唱」而不是「追着字」。
 *  ③ **此刻是第几句** —— 与 `turntable.ts` 的 `lyricIndexAt` 同一件事,只是这里的下标
 *     是**折过的行**的下标(间奏被删掉之后那一串),不是原读数的下标。
 */

export interface LyricRow {
  /** 这一句在这首歌里的坐标(秒)。点它就是 seek 到这儿。 */
  at: number
  /** 下一句的坐标(末句 = 总长)。②那个百分比的分母。 */
  end: number
  text: string
  /** 间奏:一段没有词的空当,画成三点,不接点击。 */
  interlude: boolean
}

/**
 * 「这一行没有词」。`♪` 这类音符记号是**排版**不是词 —— 后端(与实验台)常拿它占位,
 * 照字面画出来就是一行孤零零的音符,而它想说的正是「这儿没词」。
 */
const WORDLESS = /^[\s♪♫♩♬~～]*$/u

/** 空当短于这个秒数就整行不画 —— 三个点说的是「等一会儿」,不是「换了口气」。 */
export const INTERLUDE_MIN_SEC = 6

/** 末句没有下一句可依,给它这么长的尾巴(总长答不出时)。 */
const TAIL_SEC = 5

export function lyricRowsOf(
  lines: readonly { at: number; text: string }[],
  duration: number | undefined,
): LyricRow[] {
  const rows: LyricRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].at
    const next = lines[i + 1]?.at
    const tail = duration !== undefined && duration > at ? duration : at + TAIL_SEC
    const end = next !== undefined && next > at ? next : tail
    const text = lines[i].text ?? ''
    if (!WORDLESS.test(text)) {
      rows.push({ at, end, text, interlude: false })
    } else if (end - at >= INTERLUDE_MIN_SEC) {
      rows.push({ at, end, text: '', interlude: true })
    }
  }
  return rows
}

/** 这一串里有没有真的词。一句都没有 = 这首没有歌词(纯音乐也落这一格)。 */
export function hasWords(rows: readonly LyricRow[]): boolean {
  return rows.some((row) => !row.interlude)
}

/** 此刻唱到第几行。还没到第一行 = -1。 */
export function currentRowAt(rows: readonly LyricRow[], position: number | undefined): number {
  if (position === undefined) return -1
  let index = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].at <= position) index = i
    else break
  }
  return index
}

/** 尾音的宽限:一句的最后这么久不再算进填色。 */
const TAIL_GRACE_SEC = 0.6

/** 这一行唱到几成(0…1)。 */
export function fillOf(row: LyricRow, position: number | undefined): number {
  if (position === undefined) return 0
  const span = Math.max(0.1, row.end - row.at - TAIL_GRACE_SEC)
  return Math.max(0, Math.min(1, (position - row.at) / span))
}

/**
 * 手动滚动之后,视野正中最近的那一句 —— 「从这一句开始放」那条定位条指的就是它。
 * 拿的是行的中线与视野中线的距离;间奏不参选(它不是一句,seek 到它等于跳进空当)。
 */
export function nearestRowTo(
  rows: readonly LyricRow[],
  boxes: readonly { top: number; height: number }[],
  center: number,
): number {
  let best = -1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].interlude) continue
    const box = boxes[i]
    if (!box) continue
    const distance = Math.abs(box.top + box.height / 2 - center)
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}
