/**
 * Segment persistence: `<sessionsDir>/<id>/segments.jsonl`.
 *
 * Sits next to `messages.jsonl` rather than in a global ledger because this
 * data is always read *per session* — a month-sharded ledger (the shape usage
 * billing uses) would mean scanning a whole month to answer "what happened in
 * this session". It also means segments are deleted and migrated along with
 * the session for free, with no separate cleanup path to forget.
 *
 * Append-only with last-write-wins on id: segments are revised on almost every
 * turn (see ./apply.ts), and rewriting the file each time would be pure write
 * amplification. Reading folds the log down to the latest state per id.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { SessionSegment } from './types.js'

const SEGMENTS_FILE = 'segments.jsonl'

/**
 * Rewrite once the log grows past this many lines. Bounds both file size and
 * read cost for a long-lived session that keeps revising the same few segments.
 */
export const SEGMENT_LOG_COMPACT_THRESHOLD = 200

export interface SessionSegmentStoreOptions {
  /** Returns the directory holding per-session folders. */
  getSessionsDir(): string
  logger?: Pick<Console, 'error'>
}

interface SegmentLogLine {
  t: 'seg'
  s: SessionSegment
}

export function createSessionSegmentStore(options: SessionSegmentStoreOptions) {
  const segmentsPath = (sessionId: string): string =>
    path.join(options.getSessionsDir(), sessionId, SEGMENTS_FILE)

  /**
   * Folds the append log into current state. A corrupt line is skipped rather
   * than failing the read: a half-written line must not cost the user their
   * whole table of contents.
   */
  function foldLog(raw: string): { segments: SessionSegment[]; lineCount: number } {
    const byId = new Map<string, SessionSegment>()
    let lineCount = 0

    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lineCount += 1
      try {
        const parsed = JSON.parse(trimmed) as SegmentLogLine
        if (parsed?.t !== 'seg' || !parsed.s?.id) continue
        byId.set(parsed.s.id, parsed.s)
      } catch {
        continue
      }
    }

    const segments = Array.from(byId.values()).sort((a, b) => a.startedAt - b.startedAt)
    return { segments, lineCount }
  }

  async function read(sessionId: string): Promise<SessionSegment[]> {
    try {
      const raw = await fsp.readFile(segmentsPath(sessionId), 'utf-8')
      return foldLog(raw).segments
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.logger?.error?.('[toc] failed to read segments:', error)
      }
      return []
    }
  }

  /** Replaces the file with one line per current segment. */
  async function rewrite(sessionId: string, segments: readonly SessionSegment[]): Promise<void> {
    const file = segmentsPath(sessionId)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const body = segments.map(segment => JSON.stringify({ t: 'seg', s: segment })).join('\n')
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, body ? `${body}\n` : '', 'utf-8')
    await fsp.rename(tmp, file)
  }

  /**
   * Appends the segments a turn touched. Compacts when the log has grown past
   * the threshold — the fold makes stale lines harmless, just wasteful.
   */
  async function append(
    sessionId: string,
    changed: readonly SessionSegment[],
  ): Promise<void> {
    if (changed.length === 0) return
    const file = segmentsPath(sessionId)
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const lines = changed.map(segment => JSON.stringify({ t: 'seg', s: segment }))
      await fsp.appendFile(file, `${lines.join('\n')}\n`, 'utf-8')

      const raw = await fsp.readFile(file, 'utf-8')
      const folded = foldLog(raw)
      if (folded.lineCount > SEGMENT_LOG_COMPACT_THRESHOLD) {
        await rewrite(sessionId, folded.segments)
      }
    } catch (error) {
      // Losing a TOC entry must never break the turn that produced it.
      options.logger?.error?.('[toc] failed to append segments:', error)
    }
  }

  async function clear(sessionId: string): Promise<void> {
    try {
      await fsp.unlink(segmentsPath(sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.logger?.error?.('[toc] failed to clear segments:', error)
      }
    }
  }

  return { read, append, rewrite, clear, segmentsPath }
}

export type SessionSegmentStore = ReturnType<typeof createSessionSegmentStore>
