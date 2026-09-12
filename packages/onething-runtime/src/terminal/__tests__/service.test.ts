import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc.js'
import type { PtyBackend, PtyExitEvent, PtyHandle, PtySpawnRequest } from '../pty-backend.js'
import { TerminalService, type TerminalBroadcaster } from '../service.wiring.js'

class FakePty implements PtyHandle {
  pid = 4242
  written: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  signals: string[] = []
  pauseCount = 0
  resumeCount = 0
  private dataCallback: ((data: string) => void) | null = null
  private exitCallback: ((event: PtyExitEvent) => void) | null = null

  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }
  pause(): void {
    this.pauseCount += 1
  }
  resume(): void {
    this.resumeCount += 1
  }
  kill(signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal)
  }
  onData(callback: (data: string) => void): void {
    this.dataCallback = callback
  }
  onExit(callback: (event: PtyExitEvent) => void): void {
    this.exitCallback = callback
  }

  emitData(data: string): void {
    this.dataCallback?.(data)
  }
  emitExit(exitCode: number): void {
    this.exitCallback?.({ exitCode })
  }
}

class FakeBackend implements PtyBackend {
  spawned: Array<{ request: PtySpawnRequest; pty: FakePty }> = []
  spawn(request: PtySpawnRequest): PtyHandle {
    const pty = new FakePty()
    this.spawned.push({ request, pty })
    return pty
  }
}

class RecordingBroadcaster implements TerminalBroadcaster {
  data: TerminalDataEvent[] = []
  exits: TerminalExitEvent[] = []
  sendData(event: TerminalDataEvent): void {
    this.data.push(event)
  }
  sendExit(event: TerminalExitEvent): void {
    this.exits.push(event)
  }
}

const FLUSH = 16

function createHarness(options?: ConstructorParameters<typeof TerminalService>[2]) {
  const backend = new FakeBackend()
  const broadcaster = new RecordingBroadcaster()
  const service = new TerminalService(backend, () => broadcaster, options)
  return { backend, broadcaster, service }
}

describe('TerminalService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns with defaults and lists the terminal', () => {
    const { backend, service } = createHarness()
    const info = service.create({})
    expect(backend.spawned).toHaveLength(1)
    expect(backend.spawned[0].request.cols).toBe(80)
    expect(backend.spawned[0].request.rows).toBe(24)
    expect(backend.spawned[0].request.args).toEqual(['-l'])
    expect(backend.spawned[0].request.env.TERM).toBe('xterm-256color')
    expect(service.list().map(t => t.id)).toEqual([info.id])
  })

  it('coalesces bursts into one seq-stamped chunk per flush tick', () => {
    const { backend, broadcaster, service } = createHarness()
    const info = service.create({})
    service.attach(info.id)
    const pty = backend.spawned[0].pty
    pty.emitData('a')
    pty.emitData('b')
    pty.emitData('c')
    expect(broadcaster.data).toHaveLength(0)
    vi.advanceTimersByTime(FLUSH)
    expect(broadcaster.data).toEqual([{ terminalId: info.id, seq: 1, data: 'abc' }])
    pty.emitData('d')
    vi.advanceTimersByTime(FLUSH)
    expect(broadcaster.data[1]).toEqual({ terminalId: info.id, seq: 2, data: 'd' })
  })

  it('does not broadcast while detached; attach replays the ring snapshot', () => {
    const { backend, broadcaster, service } = createHarness()
    const info = service.create({})
    const pty = backend.spawned[0].pty
    pty.emitData('early output')
    vi.advanceTimersByTime(FLUSH)
    expect(broadcaster.data).toHaveLength(0)

    const response = service.attach(info.id)
    expect(response.success).toBe(true)
    expect(response.chunks).toEqual([{ seq: 1, data: 'early output' }])
    expect(response.lastSeq).toBe(1)
    expect(response.truncated).toBe(false)
    expect(response.generation).toBe(1)
    expect(response.info?.cols).toBe(80)
  })

  it('attach flushes pending output first so the snapshot is complete', () => {
    const { backend, service } = createHarness()
    const info = service.create({})
    const pty = backend.spawned[0].pty
    pty.emitData('pending')
    const response = service.attach(info.id)
    expect(response.chunks).toEqual([{ seq: 1, data: 'pending' }])
    expect(response.lastSeq).toBe(1)
  })

  it('evicts old chunks beyond the ring cap and marks truncated', () => {
    const { backend, service } = createHarness({ ringMaxUnits: 10 })
    const info = service.create({})
    const pty = backend.spawned[0].pty
    pty.emitData('aaaaaa')
    vi.advanceTimersByTime(FLUSH)
    pty.emitData('bbbbbb')
    vi.advanceTimersByTime(FLUSH)
    const response = service.attach(info.id)
    expect(response.chunks).toEqual([{ seq: 2, data: 'bbbbbb' }])
    expect(response.truncated).toBe(true)
  })

  it('keeps only the tail of a single oversized burst', () => {
    const { backend, service } = createHarness({ ringMaxUnits: 4 })
    const info = service.create({})
    const pty = backend.spawned[0].pty
    pty.emitData('0123456789')
    vi.advanceTimersByTime(FLUSH)
    const response = service.attach(info.id)
    expect(response.chunks).toEqual([{ seq: 1, data: '6789' }])
    expect(response.truncated).toBe(true)
  })

  it('pauses at the high-water mark and resumes when acks drain below low water', () => {
    const { backend, service } = createHarness({ highWaterUnits: 10, lowWaterUnits: 4 })
    const info = service.create({})
    const generation = service.attach(info.id).generation!
    const pty = backend.spawned[0].pty
    pty.emitData('0123456789ab')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(1)

    service.ack(info.id, 4, generation)
    expect(pty.resumeCount).toBe(0)
    service.ack(info.id, 6, generation)
    expect(pty.resumeCount).toBe(1)
  })

  it('drops stale-generation acks', () => {
    const { backend, service } = createHarness({ highWaterUnits: 10, lowWaterUnits: 9 })
    const info = service.create({})
    const first = service.attach(info.id).generation!
    const pty = backend.spawned[0].pty
    pty.emitData('0123456789ab')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(1)

    service.attach(info.id) // new generation zeroes the ledger and resumes
    expect(pty.resumeCount).toBe(1)
    pty.emitData('0123456789ab')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(2)
    service.ack(info.id, 100, first) // stale — must be ignored
    expect(pty.resumeCount).toBe(1)
  })

  it('never pauses while detached — the ring absorbs output instead', () => {
    const { backend, service } = createHarness({ highWaterUnits: 4 })
    service.create({})
    const pty = backend.spawned[0].pty
    pty.emitData('a very long burst well past the high-water mark')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(0)
  })

  it('markAllDetached resumes a paused pty and stops broadcasting', () => {
    const { backend, broadcaster, service } = createHarness({ highWaterUnits: 4 })
    const info = service.create({})
    service.attach(info.id)
    const pty = backend.spawned[0].pty
    pty.emitData('123456')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(1)

    service.markAllDetached()
    expect(pty.resumeCount).toBe(1)
    const before = broadcaster.data.length
    pty.emitData('more')
    vi.advanceTimersByTime(FLUSH)
    expect(broadcaster.data.length).toBe(before)
  })

  it('auto-detaches when acks stall past the deadline', () => {
    const { backend, service } = createHarness({ highWaterUnits: 4, ackStallMs: 5000 })
    const info = service.create({})
    service.attach(info.id)
    const pty = backend.spawned[0].pty
    pty.emitData('123456')
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(1)
    vi.advanceTimersByTime(5000)
    expect(pty.resumeCount).toBe(1)
  })

  it('flushes tail output before broadcasting exit', () => {
    const { backend, broadcaster, service } = createHarness()
    const info = service.create({})
    service.attach(info.id)
    const pty = backend.spawned[0].pty
    pty.emitData('final words')
    pty.emitExit(0)
    expect(broadcaster.data).toHaveLength(1)
    expect(broadcaster.data[0].data).toBe('final words')
    expect(broadcaster.exits).toEqual([{ terminalId: info.id, exitCode: 0 }])
    expect(service.list()[0].exited).toEqual({ code: 0 })
  })

  /**
   * **经 RPC 杀掉的那一格也要发死讯**(T1-fix,2026-09-12)。
   *
   * 病历:`handleExit` 从前的最后一句是 `if (!record.disposing) sendExit(...)`,
   * 而 `kill()` 一进门就把 `disposing` 翻真 —— 于是从别的窗口 / 别的客户端杀掉
   * 一格终端,这台消费者永远收不到死讯,屏幕上那一格停在「活着」。
   * 判据现在是 `exitSent` 那格闩:**每格最多一次,而且怎么死都发**。
   *
   * 反证:把 `if (!record.exitSent)` 改回 `if (!record.disposing)` → 这一条当场红。
   */
  it('kill still broadcasts exit once (the consumer is not the one who killed it)', () => {
    const { backend, broadcaster, service } = createHarness({ killGraceMs: 1000 })
    const info = service.create({})
    service.attach(info.id)
    void service.kill(info.id)
    expect(broadcaster.exits).toHaveLength(0) // 还没真死
    backend.spawned[0].pty.emitExit(0)
    expect(broadcaster.exits).toEqual([{ terminalId: info.id, exitCode: 0 }])
  })

  it('exit is broadcast at most once per terminal (the latch, not the disposing flag)', () => {
    const { backend, broadcaster, service } = createHarness()
    const info = service.create({})
    service.attach(info.id)
    const pty = backend.spawned[0].pty
    pty.emitExit(0)
    // 再喊一遍死讯(node-pty 真机上不会,但闩守的就是「最多一次」这句话)。
    pty.emitExit(0)
    void service.kill(info.id)
    expect(broadcaster.exits).toEqual([{ terminalId: info.id, exitCode: 0 }])
  })

  it('kill signals the process group gracefully then forcefully', () => {
    const { backend, service } = createHarness({ killGraceMs: 1000 })
    const info = service.create({})
    const pty = backend.spawned[0].pty
    service.kill(info.id)
    expect(pty.signals).toEqual(['SIGHUP'])
    vi.advanceTimersByTime(1000)
    expect(pty.signals).toEqual(['SIGHUP', 'SIGKILL'])
    expect(service.list()).toHaveLength(0)
  })

  it('killAll disposes every terminal and write/resize become no-ops', () => {
    const { backend, service } = createHarness()
    const a = service.create({})
    service.create({})
    service.killAll()
    expect(service.list()).toHaveLength(0)
    expect(backend.spawned[0].pty.signals).toContain('SIGHUP')
    expect(backend.spawned[1].pty.signals).toContain('SIGHUP')
    service.write(a.id, 'x')
    expect(backend.spawned[0].pty.written).toHaveLength(0)
  })

  it('killAll waits for a previously removed terminal and cancels its late force-kill after real exit', async () => {
    const { backend, broadcaster, service } = createHarness()
    const first = service.create({})
    service.create({})
    const pty = backend.spawned[0].pty
    const stoppingOne = service.kill(first.id)
    expect(service.kill(first.id)).toBe(stoppingOne)
    let finished = false
    const stoppingAll = service.killAll().then(() => { finished = true })
    backend.spawned[1].pty.emitExit(0)
    await Promise.resolve()
    expect(finished).toBe(false)
    pty.emitData('late output')
    pty.emitExit(0)
    await stoppingOne
    await stoppingAll
    vi.advanceTimersByTime(2000)
    expect(pty.signals).toEqual(['SIGHUP'])
    /*
     * **尾巴不刷屏,死讯照发**(T1-fix 把这两件事拆开了)。
     *
     * `disposing` 守的是前半句:正在拆的那一格不再 flush 尾巴('late output'
     * 一个字都不上屏)—— 那是它一直以来要干的事,一个字没改。
     * 后半句从前也被它顺手挡了,而那是一条 bug:经 RPC 杀掉一格终端,消费者
     * 永远收不到死讯。现在由 `exitSent` 那格闩说了算:每格最多一次、怎么死都发。
     * 两格终端两条死讯,次序按它们各自真死的先后。
     */
    expect(broadcaster.data).toEqual([])
    expect(broadcaster.exits).toHaveLength(2)
    expect(broadcaster.exits.map((e) => e.exitCode)).toEqual([0, 0])
  })

  it('retains the force-kill and drain while the exited shell still has a live process group', async () => {
    const { backend, service } = createHarness({ killGraceMs: 100 })
    const info = service.create({})
    const pty = backend.spawned[0].pty
    let alive = true
    Object.assign(pty, { isProcessGroupAlive: () => alive })
    let finished = false
    const stopping = service.kill(info.id).then(() => { finished = true })
    pty.emitExit(0)
    await Promise.resolve()
    expect(finished).toBe(false)
    vi.advanceTimersByTime(100)
    expect(pty.signals).toEqual(['SIGHUP', 'SIGKILL'])
    expect(finished).toBe(false)
    alive = false
    vi.advanceTimersByTime(25)
    await stopping
    expect(finished).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('write and resize reach the pty and update info', () => {
    const { backend, service } = createHarness()
    const info = service.create({})
    service.write(info.id, 'ls\r')
    service.resize(info.id, 120, 40)
    const pty = backend.spawned[0].pty
    expect(pty.written).toEqual(['ls\r'])
    expect(pty.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(service.list()[0].cols).toBe(120)
    service.resize(info.id, 0, -3) // rejected
    expect(pty.resizes).toHaveLength(1)
  })

  it('CJK accounting stays consistent in UTF-16 code units', () => {
    const { backend, service } = createHarness({ highWaterUnits: 6, lowWaterUnits: 2 })
    const info = service.create({})
    const generation = service.attach(info.id).generation!
    const pty = backend.spawned[0].pty
    const cjk = '中文输出测试' // 6 code units
    pty.emitData(cjk)
    vi.advanceTimersByTime(FLUSH)
    expect(pty.pauseCount).toBe(1)
    service.ack(info.id, cjk.length, generation)
    expect(pty.resumeCount).toBe(1)
  })
})
