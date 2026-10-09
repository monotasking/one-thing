/**
 * 看着父进程(`lifecycle-parent-watch.ts`,10-09 孤儿后端修复)。
 *
 * 钉三件事:①两条判据(`ppid` 变了、原父进程查无此人)任一成立就报;②只报一次,报完计时器停;
 * ③起点 `ppid` 已经是 1 时第一拍就报。真进程那一半由 `gate:backend-process` 的监督门证(`kill -9` 驱动)。
 */
import { describe, expect, it } from 'vitest'
import { watchParentProcess } from '../lifecycle-parent-watch.js'

function harness(initialPpid: number) {
  const state = { ppid: initialPpid, alive: new Set([initialPpid]), ticks: [] as Array<() => void>, cleared: 0, unrefs: 0, intervalMs: 0 }
  const gone: number[] = []
  const watch = watchParentProcess({
    onGone: pid => { gone.push(pid) },
    readPpid: () => state.ppid,
    isAlive: pid => state.alive.has(pid),
    setInterval: (tick, ms) => { state.ticks.push(tick); state.intervalMs = ms; return { unref: () => { state.unrefs += 1 } } },
    clearInterval: () => { state.cleared += 1 },
  })
  const tick = () => { for (const fn of state.ticks) fn() }
  return { state, gone, watch, tick }
}

describe('watchParentProcess', () => {
  it('checks every second on an unref-ed timer and stays quiet while the parent lives', () => {
    const h = harness(500)
    expect(h.watch.parentPid).toBe(500)
    expect(h.state.intervalMs).toBe(1000)
    expect(h.state.unrefs).toBe(1)
    h.tick()
    h.tick()
    expect(h.gone).toEqual([])
  })

  it('reports once when the ppid changes (re-parented to launchd)', () => {
    const h = harness(500)
    h.state.ppid = 1
    h.tick()
    h.tick()
    expect(h.gone).toEqual([500])
    expect(h.state.cleared).toBe(1)
  })

  it('reports when the original parent no longer exists even if the ppid reads the same', () => {
    const h = harness(500)
    h.state.alive.delete(500)
    h.tick()
    expect(h.gone).toEqual([500])
  })

  it('reports on the first tick when the launcher was already gone at start', () => {
    const h = harness(1)
    h.tick()
    expect(h.gone).toEqual([1])
  })

  it('never reports after stop()', () => {
    const h = harness(500)
    h.watch.stop()
    h.watch.stop()
    h.state.ppid = 1
    h.tick()
    expect(h.gone).toEqual([])
    expect(h.state.cleared).toBe(1)
  })
})
