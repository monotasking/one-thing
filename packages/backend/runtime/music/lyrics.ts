/**
 * LRC parsing for the composer's placeholder lyrics.
 *
 * `ncm-cli song lyric --songId <加密ID>` answers (field-verified 2026-07-16):
 *
 *     { "data": { "lyric": "[00:03.320]光落在你脸上\n…", "noLyric": false,
 *                 "transLyric": null, "txtLyric": "…" } }
 *
 * `lyric` is standard LRC — `[mm:ss.mmm]text`, possibly several timestamps
 * sharing one text line. Credit lines (作词/作曲) ride the same format at the
 * head; they are kept — the bar simply shows whatever the clock points at.
 */

export interface OnethingMusicLyricLine {
  /** Seconds from song start. */
  at: number
  text: string
}

const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

export function parseLrcLyric(lrc: string): OnethingMusicLyricLine[] {
  const lines: OnethingMusicLyricLine[] = []
  for (const raw of lrc.split('\n')) {
    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    let textStart = 0
    while ((match = TIME_TAG.exec(raw)) !== null) {
      if (match.index !== textStart) break // tags must be a leading run
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0
      stamps.push(minutes * 60 + seconds + fraction)
      textStart = TIME_TAG.lastIndex
    }
    const text = raw.slice(textStart).trim()
    if (stamps.length === 0 || !text) continue
    for (const at of stamps) lines.push({ at, text })
  }
  return lines.sort((a, b) => a.at - b.at)
}

/** The line the clock points at: last line at or before `position`. */
export function lyricLineAt(
  lines: OnethingMusicLyricLine[],
  position: number,
): string | undefined {
  let current: string | undefined
  for (const line of lines) {
    if (line.at > position) break
    current = line.text
  }
  return current
}

/** LRC head-matter: credits ride the same timed format as sung lines. */
const CREDIT_LINE = /(作词|作曲|编曲|混音|制作|监制|录音|母带|吉他|贝斯|键盘|鼓|和声|OP|SP)\s*[:：·/]/

/**
 * When the singing starts — the end of the instrumental intro. This is what
 * lets the DJ talk over the intro like a real host and shut up before the
 * vocal comes in. Credit lines (作词/作曲…, usually stamped in the first
 * seconds) are skipped; undefined means "no usable lyric timeline" and the
 * caller should not gamble.
 */
export function firstVocalStartAt(lines: OnethingMusicLyricLine[]): number | undefined {
  for (const line of lines) {
    if (CREDIT_LINE.test(line.text)) continue
    return line.at
  }
  return undefined
}

/**
 * Rough Mandarin TTS duration: ~4.2 characters/second, floored at 3s so even
 * a one-liner is not assumed instant. Used only to decide "does this patter
 * fit the intro" — a wrong guess degrades to talking a moment over the vocal
 * or finishing early, never to broken playback.
 */
export function estimateSpeechSeconds(text: string): number {
  return Math.max(3, text.length / 4.2)
}

/** A mid-song instrumental break must last at least this long to count (seconds). */
export const INTERLUDE_MIN_SECONDS = 12

/**
 * How long a sung line is assumed to last: ~3 characters per second, clamped
 * to 2–8s. LRC stamps only where a line STARTS — nothing says where it ends
 * (`parseLrcLyric` drops the empty stamped lines some files use as end marks,
 * and most files do not have them anyway) — so without this, the gap between
 * two line starts would count the singing of the first line as silence.
 */
function sungLineSeconds(text: string): number {
  return Math.min(8, Math.max(2, text.length / 3))
}

export interface OnethingMusicInterlude {
  /** Seconds from song start where the voice stops (estimated end of the last sung line). */
  at: number
  /** Seconds until the next sung line. */
  length: number
}

/**
 * The instrumental breaks in the MIDDLE of a song: after the first sung line
 * and before the last one, at least `INTERLUDE_MIN_SECONDS` long. The intro
 * (before the first vocal) and the outro (after the last line) never count —
 * nothing follows an outro, and the intro is the patter's slot. Credit lines
 * (作词/作曲…) are not vocals. An empty array means "no mid-song break, or no
 * usable timeline" — the caller must not guess one.
 */
export function findInterludes(lines: OnethingMusicLyricLine[]): OnethingMusicInterlude[] {
  const vocals = lines.filter(line => !CREDIT_LINE.test(line.text))
  const out: OnethingMusicInterlude[] = []
  for (let i = 0; i + 1 < vocals.length; i += 1) {
    const current = vocals[i]!
    const next = vocals[i + 1]!
    const at = current.at + sungLineSeconds(current.text)
    const length = next.at - at
    if (length >= INTERLUDE_MIN_SECONDS) out.push({ at, length })
  }
  return out
}
