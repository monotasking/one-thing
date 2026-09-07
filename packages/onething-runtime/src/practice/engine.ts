import type {
  OnethingPracticeKegelDetail,
  OnethingPracticeLedgerRecord,
  OnethingPracticePomodoroDetail,
  OnethingPracticeRecordInput,
} from './types.js'

import type {
  OnethingPracticeSessionKind,
  OnethingPracticePhase,
  OnethingPracticePhaseEdge,
  OnethingPracticeEngineSnapshot,
} from '@shared/contracts/practice.js'
export type {
  OnethingPracticeSessionKind,
  OnethingPracticePhase,
  OnethingPracticePhaseEdge,
  OnethingPracticeEngineSnapshot,
} from '@shared/contracts/practice.js'

export interface OnethingPracticeKegelPlan {
  holdSec: number
  relaxSec: number
  /** Reps per set. */
  reps: number
  sets: number
  setRestSec: number
}

export interface OnethingPracticePomodoroPlan {
  minutes: number
  /** Category — becomes the ledger record's name. */
  category: string
  label?: string
}

export interface OnethingPracticeEngineTickResult {
  snapshot: OnethingPracticeEngineSnapshot
  edges: OnethingPracticePhaseEdge[]
  /** Present exactly once, on the tick that finishes the session. */
  finished?: OnethingPracticeRecordInput
}

interface Segment {
  phase: OnethingPracticePhase
  edge: OnethingPracticePhaseEdge
  startSec: number
  endSec: number
  /** 1-based, kegel only. */
  set?: number
  rep?: number
}

interface ActiveSession {
  kind: OnethingPracticeSessionKind
  name: string
  label?: string
  kegelPlan?: OnethingPracticeKegelPlan
  pomodoroPlan?: OnethingPracticePomodoroPlan
  segments: Segment[]
  totalSec: number
  startedAtMs: number
  /** Start anchor, shifted forward by accumulated pause time. */
  anchorMs: number
  pausedAtMs: number | null
  lastSegmentIndex: number
}

function buildKegelSegments(plan: OnethingPracticeKegelPlan): Segment[] {
  const segments: Segment[] = []
  let cursor = 0
  for (let set = 1; set <= plan.sets; set++) {
    for (let rep = 1; rep <= plan.reps; rep++) {
      segments.push({ phase: 'hold', edge: 'hold-start', startSec: cursor, endSec: cursor + plan.holdSec, set, rep })
      cursor += plan.holdSec
      segments.push({ phase: 'relax', edge: 'relax-start', startSec: cursor, endSec: cursor + plan.relaxSec, set, rep })
      cursor += plan.relaxSec
    }
    if (set < plan.sets && plan.setRestSec > 0) {
      segments.push({ phase: 'setRest', edge: 'set-rest-start', startSec: cursor, endSec: cursor + plan.setRestSec, set })
      cursor += plan.setRestSec
    }
  }
  return segments
}

/**
 * Pure phase-cycle state machine for kegel/pomodoro sessions. No timers of its
 * own: the host feeds it `tick(now)` (about 1 Hz) and forwards the returned
 * edges/snapshot. Elapsed time derives from an absolute anchor, so tick jitter
 * never accumulates; pauses shift the anchor forward on resume.
 */
export class OnethingPracticeEngine {
  private session: ActiveSession | null = null

  startKegel(plan: OnethingPracticeKegelPlan, now: number): OnethingPracticeEngineTickResult {
    if (this.session) throw new Error('practice session already active')
    const segments = buildKegelSegments(plan)
    this.session = {
      kind: 'kegel',
      name: '凯格尔',
      kegelPlan: plan,
      segments,
      totalSec: segments[segments.length - 1]?.endSec ?? 0,
      startedAtMs: now,
      anchorMs: now,
      pausedAtMs: null,
      lastSegmentIndex: 0,
    }
    return { snapshot: this.getSnapshot(now), edges: ['hold-start'] }
  }

  startPomodoro(plan: OnethingPracticePomodoroPlan, now: number): OnethingPracticeEngineTickResult {
    if (this.session) throw new Error('practice session already active')
    const totalSec = plan.minutes * 60
    this.session = {
      kind: 'pomodoro',
      name: plan.category,
      label: plan.label,
      pomodoroPlan: plan,
      segments: [{ phase: 'focus', edge: 'focus-start', startSec: 0, endSec: totalSec }],
      totalSec,
      startedAtMs: now,
      anchorMs: now,
      pausedAtMs: null,
      lastSegmentIndex: 0,
    }
    return { snapshot: this.getSnapshot(now), edges: ['focus-start'] }
  }

  pause(now: number): OnethingPracticeEngineSnapshot {
    const session = this.session
    if (session && session.pausedAtMs === null) session.pausedAtMs = now
    return this.getSnapshot(now)
  }

  resume(now: number): OnethingPracticeEngineSnapshot {
    const session = this.session
    if (session && session.pausedAtMs !== null) {
      session.anchorMs += now - session.pausedAtMs
      session.pausedAtMs = null
    }
    return this.getSnapshot(now)
  }

  /** Ends the session early. Returns the (partial) ledger input, or null when idle. */
  stop(now: number): OnethingPracticeRecordInput | null {
    const session = this.session
    if (!session) return null
    const result = this.buildRecordInput(session, this.elapsedSec(session, now), now)
    this.session = null
    return result
  }

  tick(now: number): OnethingPracticeEngineTickResult {
    const session = this.session
    if (!session) return { snapshot: { status: 'idle' }, edges: [] }
    if (session.pausedAtMs !== null) return { snapshot: this.getSnapshot(now), edges: [] }

    const elapsed = this.elapsedSec(session, now)
    if (elapsed >= session.totalSec) {
      const finished = this.buildRecordInput(session, session.totalSec, now)
      this.session = null
      return { snapshot: { status: 'idle' }, edges: ['finished'], finished }
    }

    const index = this.segmentIndexAt(session, elapsed)
    const edges: OnethingPracticePhaseEdge[] = []
    if (index > session.lastSegmentIndex) {
      // Emit only the newest boundary — with 1 Hz ticks a multi-segment skip
      // means the host stalled, and replaying stale cues would just spam audio.
      edges.push(session.segments[index].edge)
      session.lastSegmentIndex = index
    }
    return { snapshot: this.getSnapshot(now), edges }
  }

  getSnapshot(now: number): OnethingPracticeEngineSnapshot {
    const session = this.session
    if (!session) return { status: 'idle' }
    const elapsed = Math.min(this.elapsedSec(session, now), session.totalSec)
    const index = this.segmentIndexAt(session, elapsed)
    const segment = session.segments[index]
    const snapshot: OnethingPracticeEngineSnapshot = {
      status: session.pausedAtMs !== null ? 'paused' : 'running',
      kind: session.kind,
      name: session.name,
      phase: segment.phase,
      phaseSecLeft: Math.max(0, Math.ceil(segment.endSec - elapsed)),
      elapsedSec: Math.floor(elapsed),
      totalSec: session.totalSec,
      startedAt: session.startedAtMs,
    }
    if (session.kind === 'kegel' && session.kegelPlan) {
      snapshot.rep = segment.rep ?? session.kegelPlan.reps
      snapshot.reps = session.kegelPlan.reps
      snapshot.set = segment.set ?? 1
      snapshot.sets = session.kegelPlan.sets
    }
    return snapshot
  }

  private elapsedSec(session: ActiveSession, now: number): number {
    const effectiveNow = session.pausedAtMs ?? now
    return Math.max(0, (effectiveNow - session.anchorMs) / 1000)
  }

  private segmentIndexAt(session: ActiveSession, elapsed: number): number {
    const segments = session.segments
    for (let i = 0; i < segments.length; i++) {
      if (elapsed < segments[i].endSec) return i
    }
    return segments.length - 1
  }

  private buildRecordInput(session: ActiveSession, elapsed: number, now: number): OnethingPracticeRecordInput {
    if (session.kind === 'kegel' && session.kegelPlan) {
      const plan = session.kegelPlan
      // A rep counts once its hold phase fully passed; a set once all its reps' holds passed.
      let repsDone = 0
      const setsWithAllReps = new Set<number>()
      const repsPerSet = new Map<number, number>()
      for (const segment of session.segments) {
        if (segment.phase !== 'hold' || segment.endSec > elapsed) continue
        repsDone += 1
        const done = (repsPerSet.get(segment.set!) ?? 0) + 1
        repsPerSet.set(segment.set!, done)
        if (done >= plan.reps) setsWithAllReps.add(segment.set!)
      }
      const kegel: OnethingPracticeKegelDetail = {
        holdSec: plan.holdSec,
        relaxSec: plan.relaxSec,
        repsDone,
        repsTarget: plan.reps,
        setsDone: setsWithAllReps.size,
        setsTarget: plan.sets,
      }
      return { ts: now, kind: 'kegel', source: 'timer', name: session.name, kegel }
    }
    const plan = session.pomodoroPlan!
    const completed = elapsed >= session.totalSec
    const pomodoro: OnethingPracticePomodoroDetail = {
      minutes: plan.minutes,
      elapsedMin: Math.floor(elapsed / 60),
      completed,
    }
    if (plan.label) pomodoro.label = plan.label
    return { ts: now, kind: 'pomodoro', source: 'timer', name: session.name, pomodoro }
  }
}

export type { OnethingPracticeLedgerRecord }
