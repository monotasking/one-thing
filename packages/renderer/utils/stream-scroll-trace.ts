/**
 * Frame-level trace for diagnosing streaming scroll jitter.
 *
 * Enable:  `window.__onethingLog.level('info,renderer.stream-scroll=trace')`
 * Disable: `window.__onethingLog.level('info')`
 *
 * 没有第二个开关:采不采样由**日志等级**决定(`renderer.stream-scroll=trace`),
 * 与全仓一致(docs/design/logging-system-2026-08.md §8.1)。环形缓冲与
 * `window.__streamScrollTrace` 的取样口原样保留 —— 它们是现场工具,不是日志通路。
 *
 * When enabled, records per-frame snapshots of scroll geometry, virtualizer
 * state, DOM heights, scroll writes, anchor deltas, and the trigger source.
 */
import { getLogger } from '@/services/log'

const log = getLogger('renderer.stream-scroll')

export interface TraceFrame {
  frameId: number
  ts: number
  trigger: string
  action: string | null
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceToBottom: number
  beforeScrollTop: number | null
  afterScrollTop: number | null
  scrollDelta: number | null
  targetScrollTop: number | null
  anchorKind: string | null
  anchorDelta: number | null
  isSuppressed: boolean | null
  virtualizerOffset: number | null
  virtualizerTotalSize: number | null
  lastMessageHeight: number | null
  lastCodeBlockHeight: number | null
  streamTextLen: number | null
  codeBlockLines: number | null
  isFollowing: boolean
  extra?: string
}

const RING_SIZE = 160

let globalFrameId = 0
let rafFrameId = 0
let lastRafTs = 0

const ring: TraceFrame[] = []
let ringIdx = 0

/** 采样门 = 等级门。逐帧快照很贵,所以调用点先问一句。 */
export function isTraceEnabled(): boolean {
  return log.isLevelEnabled('trace')
}

function tickFrame(): void {
  if (rafFrameId) return
  rafFrameId = requestAnimationFrame((ts) => {
    rafFrameId = 0
    if (ts !== lastRafTs) {
      globalFrameId++
      lastRafTs = ts
    }
  })
}

function pushFrame(frame: TraceFrame): void {
  if (ring.length < RING_SIZE) {
    ring.push(frame)
  } else {
    ring[ringIdx % RING_SIZE] = frame
  }
  ringIdx++
}

function getOrderedFrames(): TraceFrame[] {
  if (ring.length < RING_SIZE) return [...ring]
  const start = ringIdx % RING_SIZE
  return [...ring.slice(start), ...ring.slice(0, start)]
}

export function traceEvent(
  trigger: string,
  getScrollEl: () => HTMLElement | null,
  opts: {
    isFollowing: boolean
    action?: string
    beforeScrollTop?: number | null
    afterScrollTop?: number | null
    targetScrollTop?: number | null
    anchorKind?: string | null
    anchorDelta?: number | null
    isSuppressed?: boolean | null
    virtualizerOffset?: number | null
    virtualizerTotalSize?: number | null
    lastMessageHeight?: number | null
    lastCodeBlockHeight?: number | null
    streamTextLen?: number | null
    codeBlockLines?: number | null
    extra?: string
  },
): void {
  if (!isTraceEnabled()) return
  tickFrame()

  const el = getScrollEl()
  const scrollTop = el?.scrollTop ?? 0
  const scrollHeight = el?.scrollHeight ?? 0
  const clientHeight = el?.clientHeight ?? 0
  const distanceToBottom = scrollHeight - scrollTop - clientHeight
  const beforeScrollTop = opts.beforeScrollTop ?? null
  const afterScrollTop = opts.afterScrollTop ?? null
  const scrollDelta =
    beforeScrollTop !== null && afterScrollTop !== null
      ? afterScrollTop - beforeScrollTop
      : null

  const frame: TraceFrame = {
    frameId: globalFrameId,
    ts: performance.now(),
    trigger,
    action: opts.action ?? null,
    scrollTop: Math.round(scrollTop),
    scrollHeight: Math.round(scrollHeight),
    clientHeight: Math.round(clientHeight),
    distanceToBottom: Math.round(distanceToBottom),
    beforeScrollTop: beforeScrollTop === null ? null : Math.round(beforeScrollTop),
    afterScrollTop: afterScrollTop === null ? null : Math.round(afterScrollTop),
    scrollDelta: scrollDelta === null ? null : Math.round(scrollDelta),
    targetScrollTop: opts.targetScrollTop == null ? null : Math.round(opts.targetScrollTop),
    anchorKind: opts.anchorKind ?? null,
    anchorDelta: opts.anchorDelta == null ? null : Math.round(opts.anchorDelta),
    isSuppressed: opts.isSuppressed ?? null,
    virtualizerOffset: opts.virtualizerOffset == null ? null : Math.round(opts.virtualizerOffset),
    virtualizerTotalSize: opts.virtualizerTotalSize ?? null,
    lastMessageHeight: opts.lastMessageHeight ?? null,
    lastCodeBlockHeight: opts.lastCodeBlockHeight ?? null,
    streamTextLen: opts.streamTextLen ?? null,
    codeBlockLines: opts.codeBlockLines ?? null,
    isFollowing: opts.isFollowing,
    extra: opts.extra,
  }

  pushFrame(frame)

  // Keep tracing passive. Printing during streaming changes timing enough to
  // create its own scroll jank, so callers explicitly use printTrace/summary.
}

export function traceLog(trigger: string, msg: string): void {
  if (!isTraceEnabled()) return
  tickFrame()
  log.trace('stream scroll event', { frameId: globalFrameId, trigger, detail: msg })
}

export function dumpTrace(): TraceFrame[] {
  return getOrderedFrames()
}

export interface TraceSummary {
  frames: number
  scrollWrites: number
  totalAbsScrollDelta: number
  maxAbsScrollDelta: number
  largeWrites: number
  largestWrites: TraceFrame[]
  nudgeWrites: number
  virtualizerWrites: number
  followStateChanges: number
  maxAnchorDelta: number
  maxCodeBlockHeightStep: number
}

export function analyzeTrace(frames: TraceFrame[] = getOrderedFrames()): TraceSummary {
  const writes = frames.filter(frame => frame.scrollDelta !== null && frame.scrollDelta !== 0)
  const nudgeWrites = writes.filter(frame => frame.action?.includes('nudge-anchor')).length
  const virtualizerWrites = writes.filter(frame => frame.action?.includes('virtualizer')).length
  const followStateChanges = frames.filter(frame => frame.action?.startsWith('state:following')).length
  const largestWrites = [...writes]
    .sort((a, b) => Math.abs(b.scrollDelta ?? 0) - Math.abs(a.scrollDelta ?? 0))
    .slice(0, 12)

  let maxCodeBlockHeightStep = 0
  let previousCodeBlockHeight: number | null = null
  for (const frame of frames) {
    if (frame.lastCodeBlockHeight === null) continue
    if (previousCodeBlockHeight !== null) {
      maxCodeBlockHeightStep = Math.max(
        maxCodeBlockHeightStep,
        Math.abs(frame.lastCodeBlockHeight - previousCodeBlockHeight),
      )
    }
    previousCodeBlockHeight = frame.lastCodeBlockHeight
  }

  return {
    frames: frames.length,
    scrollWrites: writes.length,
    totalAbsScrollDelta: Math.round(writes.reduce((sum, frame) => sum + Math.abs(frame.scrollDelta ?? 0), 0)),
    maxAbsScrollDelta: Math.round(Math.max(0, ...writes.map(frame => Math.abs(frame.scrollDelta ?? 0)))),
    largeWrites: writes.filter(frame => Math.abs(frame.scrollDelta ?? 0) >= 24).length,
    largestWrites,
    nudgeWrites,
    virtualizerWrites,
    followStateChanges,
    maxAnchorDelta: Math.round(Math.max(0, ...frames.map(frame => Math.abs(frame.anchorDelta ?? 0)))),
    maxCodeBlockHeightStep: Math.round(maxCodeBlockHeightStep),
  }
}

export function clearTrace(): void {
  ring.length = 0
  ringIdx = 0
}

/** 现场取样:返回值就是给 devtools 看的那张表;同时留一条结构化记录。 */
export function printTrace(): TraceFrame[] {
  const frames = getOrderedFrames()
  log.debug('stream scroll frames dumped', { frames })
  return frames
}

export function printSummary(): TraceSummary {
  const summary = analyzeTrace()
  log.debug('stream scroll summary', { ...summary })
  return summary
}

if (typeof window !== 'undefined') {
  ;(window as any).__streamScrollTrace = {
    dumpTrace,
    analyzeTrace,
    printTrace,
    printSummary,
    clearTrace,
  }
}
