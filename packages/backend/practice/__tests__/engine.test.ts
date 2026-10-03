import { describe, expect, it } from 'vitest'
import { OnethingPracticeEngine, type OnethingPracticeKegelPlan } from '../engine.js'

const PLAN: OnethingPracticeKegelPlan = { holdSec: 10, relaxSec: 5, reps: 2, sets: 2, setRestSec: 60 }
// Timeline: set1 hold[0,10) relax[10,15) hold[15,25) relax[25,30)
//           setRest[30,90)
//           set2 hold[90,100) relax[100,105) hold[105,115) relax[115,120) → total 120s

const T0 = 1_000_000_000

function at(sec: number): number {
  return T0 + sec * 1000
}

describe('OnethingPracticeEngine · kegel', () => {
  it('starts in hold with the full plan snapshot', () => {
    const engine = new OnethingPracticeEngine()
    const { snapshot, edges } = engine.startKegel(PLAN, T0)
    expect(edges).toEqual(['hold-start'])
    expect(snapshot).toMatchObject({
      status: 'running', kind: 'kegel', phase: 'hold',
      phaseSecLeft: 10, rep: 1, reps: 2, set: 1, sets: 2, totalSec: 120,
    })
  })

  it('walks hold → relax → next rep → set rest → next set', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)

    expect(engine.tick(at(10)).edges).toEqual(['relax-start'])
    expect(engine.tick(at(15)).edges).toEqual(['hold-start'])
    expect(engine.tick(at(15)).edges).toEqual([]) // same segment, no re-fire
    expect(engine.tick(at(30)).edges).toEqual(['set-rest-start'])

    const set2 = engine.tick(at(90))
    expect(set2.edges).toEqual(['hold-start'])
    expect(set2.snapshot).toMatchObject({ set: 2, rep: 1, phase: 'hold' })
  })

  it('emits only the newest edge when ticks skip segments', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)
    const result = engine.tick(at(26)) // skipped relax/hold boundaries in between
    expect(result.edges).toEqual(['relax-start'])
    expect(result.snapshot).toMatchObject({ rep: 2, set: 1 })
  })

  it('pause freezes elapsed and resume shifts the anchor', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)
    engine.tick(at(10))

    const paused = engine.pause(at(12))
    expect(paused).toMatchObject({ status: 'paused', phase: 'relax', elapsedSec: 12 })
    expect(engine.tick(at(60)).edges).toEqual([]) // paused: time does not advance
    expect(engine.tick(at(60)).snapshot.elapsedSec).toBe(12)

    engine.resume(at(20)) // 8s paused
    const after = engine.tick(at(22))
    expect(after.snapshot).toMatchObject({ status: 'running', phase: 'relax', elapsedSec: 14, phaseSecLeft: 1 })
  })

  it('stop mid-session settles a partial record: reps count on completed holds', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)
    engine.tick(at(10))

    const record = engine.stop(at(14))
    expect(record).toMatchObject({
      kind: 'kegel', source: 'timer',
      kegel: { repsDone: 1, repsTarget: 2, setsDone: 0, setsTarget: 2 },
    })
    expect(engine.tick(at(15)).snapshot.status).toBe('idle')
  })

  it('finishes with a complete record after the last phase', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)
    const result = engine.tick(at(120))
    expect(result.edges).toEqual(['finished'])
    expect(result.finished).toMatchObject({
      kind: 'kegel',
      kegel: { repsDone: 4, setsDone: 2, setsTarget: 2 },
    })
    expect(result.snapshot.status).toBe('idle')
  })

  it('rejects a second concurrent session', () => {
    const engine = new OnethingPracticeEngine()
    engine.startKegel(PLAN, T0)
    expect(() => engine.startPomodoro({ minutes: 25, category: '学习' }, at(1))).toThrow()
  })
})

describe('OnethingPracticeEngine · pomodoro', () => {
  it('runs a single focus phase and completes', () => {
    const engine = new OnethingPracticeEngine()
    const { snapshot, edges } = engine.startPomodoro({ minutes: 1, category: '学习' }, T0)
    expect(edges).toEqual(['focus-start'])
    expect(snapshot).toMatchObject({ kind: 'pomodoro', name: '学习', phase: 'focus', totalSec: 60 })

    const mid = engine.tick(at(30))
    expect(mid.edges).toEqual([])
    expect(mid.snapshot.phaseSecLeft).toBe(30)

    const done = engine.tick(at(60))
    expect(done.edges).toEqual(['finished'])
    expect(done.finished).toMatchObject({
      kind: 'pomodoro', name: '学习',
      pomodoro: { minutes: 1, elapsedMin: 1, completed: true },
    })
  })

  it('stop mid-way records an incomplete pomodoro with elapsed minutes', () => {
    const engine = new OnethingPracticeEngine()
    engine.startPomodoro({ minutes: 25, category: '看视频', label: '纪录片' }, T0)
    const record = engine.stop(at(11 * 60 + 30))
    expect(record).toMatchObject({
      kind: 'pomodoro', name: '看视频',
      pomodoro: { minutes: 25, elapsedMin: 11, completed: false, label: '纪录片' },
    })
  })
})
