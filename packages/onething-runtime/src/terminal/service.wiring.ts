/**
 * Real PTY terminal service (user-driven shells; unrelated to the ACP
 * protocol "terminal" in acp/client.ts, which is a pipes-based registry).
 *
 * Owns the whole output pipeline so every transport shares it:
 *   PTY onData → 16ms coalescing flush → seq stamp → bounded ring buffer
 *   → broadcaster port (Electron IPC today; a server WS host would plug the
 *   same port).
 *
 * Flow control is generation-scoped acks (see docs/design/terminal-system.md
 * 7.3): acks only come from a live renderer, so every attach starts a new
 * generation with a zeroed ledger, stale-generation acks are dropped, and a
 * detached terminal never pauses — the ring absorbs output instead. All byte
 * accounting uses JS string length (UTF-16 code units) on both sides.
 *
 * Lazy singleton (music service pattern): never constructed inside
 * createOnethingBackend, so the CLI daemon and readonly servers never load
 * node-pty. Import of this module configures nothing.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  TerminalAttachResponse,
  TerminalCreateRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInfo,
  TerminalOutputChunk,
} from '@shared/ipc.js'
import { createNodePtyBackend, type PtyBackend, type PtyHandle } from './pty-backend.js'
import { buildSpawnProfile } from './spawn-profile.wiring.js'

export interface TerminalBroadcaster {
  sendData(event: TerminalDataEvent): void
  sendExit(event: TerminalExitEvent): void
}

/**
 * 这台宿主的终端输出通道 —— `OnethingHostPorts` 里 `terminal` 那一格的形状
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.1)。
 *
 * 只有一件事:把 PTY 的输出推到消费者那边。没有它,请求面(开 shell / 写入)
 * 就是「只能写不能读」,所以 `terminal` 域拿 `hasTerminalHost()` 当闸,替掉
 * 从前的 `transport === 'http'`。
 */
export interface TerminalHostPorts {
  broadcaster: TerminalBroadcaster
}

export interface TerminalServiceOptions {
  flushIntervalMs?: number
  ringMaxUnits?: number
  highWaterUnits?: number
  lowWaterUnits?: number
  ackStallMs?: number
  killGraceMs?: number
}

const DEFAULTS: Required<TerminalServiceOptions> = {
  flushIntervalMs: 16,
  ringMaxUnits: 1024 * 1024,
  highWaterUnits: 128 * 1024,
  lowWaterUnits: 64 * 1024,
  ackStallMs: 5000,
  killGraceMs: 1000,
}

interface TerminalRecord {
  info: TerminalInfo
  pty: PtyHandle
  seq: number
  ring: TerminalOutputChunk[]
  ringUnits: number
  ringTruncated: boolean
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | null
  generation: number
  attached: boolean
  unackedUnits: number
  paused: boolean
  stallTimer: ReturnType<typeof setTimeout> | null
  exited: boolean
  killTimer: ReturnType<typeof setTimeout> | null
}

export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>()
  private readonly options: Required<TerminalServiceOptions>

  constructor(
    private readonly backend: PtyBackend,
    private readonly getBroadcaster: () => TerminalBroadcaster | null,
    options?: TerminalServiceOptions,
  ) {
    this.options = { ...DEFAULTS, ...options }
  }

  create(request: TerminalCreateRequest): TerminalInfo {
    const profile = buildSpawnProfile(request)
    const pty = this.backend.spawn(profile)
    const info: TerminalInfo = {
      id: randomUUID(),
      title: path.basename(profile.shell),
      cwd: profile.cwd,
      shell: profile.shell,
      cols: profile.cols,
      rows: profile.rows,
      createdAt: Date.now(),
    }
    const record: TerminalRecord = {
      info,
      pty,
      seq: 0,
      ring: [],
      ringUnits: 0,
      ringTruncated: false,
      pending: '',
      flushTimer: null,
      generation: 0,
      attached: false,
      unackedUnits: 0,
      paused: false,
      stallTimer: null,
      exited: false,
      killTimer: null,
    }
    this.terminals.set(info.id, record)
    pty.onData(data => this.handleData(record, data))
    pty.onExit(event => this.handleExit(record, event.exitCode))
    return { ...info }
  }

  list(): TerminalInfo[] {
    return [...this.terminals.values()].map(record => ({ ...record.info }))
  }

  write(terminalId: string, data: string): void {
    const record = this.terminals.get(terminalId)
    if (!record || record.exited) return
    record.pty.write(data)
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const record = this.terminals.get(terminalId)
    if (!record || record.exited) return
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
    record.info.cols = Math.floor(cols)
    record.info.rows = Math.floor(rows)
    record.pty.resize(record.info.cols, record.info.rows)
  }

  /**
   * Reattach protocol: flush pending output so the snapshot is complete, then
   * start a fresh flow-control generation with a zeroed ledger. Replayed
   * chunks must NOT be acked by the caller.
   */
  attach(terminalId: string): TerminalAttachResponse {
    const record = this.terminals.get(terminalId)
    if (!record) return { success: false, error: `Terminal not found: ${terminalId}` }
    this.flushNow(record)
    record.generation += 1
    record.unackedUnits = 0
    record.attached = true
    this.clearStallTimer(record)
    this.resumeIfPaused(record)
    return {
      success: true,
      info: { ...record.info },
      chunks: record.ring.map(chunk => ({ ...chunk })),
      lastSeq: record.seq,
      truncated: record.ringTruncated,
      generation: record.generation,
    }
  }

  ack(terminalId: string, units: number, generation: number): void {
    const record = this.terminals.get(terminalId)
    if (!record || generation !== record.generation) return
    if (!Number.isFinite(units) || units <= 0) return
    record.unackedUnits = Math.max(0, record.unackedUnits - units)
    if (record.paused && record.unackedUnits <= this.options.lowWaterUnits) {
      this.clearStallTimer(record)
      this.resumeIfPaused(record)
    }
  }

  markDetached(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (record) this.detach(record)
  }

  /**
   * Detach edge: called by the host when the consumer is provably gone
   * (webContents reload/destroy, window closed). Without it, acks stop while
   * `attached` stays true and every chatty terminal freezes at the high-water
   * mark — the exact failure the generation protocol exists to prevent.
   */
  markAllDetached(): void {
    for (const record of this.terminals.values()) this.detach(record)
  }

  kill(terminalId: string): void {
    const record = this.terminals.get(terminalId)
    if (!record) return
    this.disposeRecord(record)
    this.terminals.delete(terminalId)
  }

  /** No-op safe for hosts where no terminal was ever created. */
  killAll(): void {
    for (const record of this.terminals.values()) this.disposeRecord(record)
    this.terminals.clear()
  }

  private handleData(record: TerminalRecord, data: string): void {
    if (record.exited) return
    record.pending += data
    if (record.flushTimer === null) {
      record.flushTimer = setTimeout(() => this.flushNow(record), this.options.flushIntervalMs)
      record.flushTimer.unref?.()
    }
  }

  private flushNow(record: TerminalRecord): void {
    if (record.flushTimer !== null) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    if (record.pending.length === 0) return
    const data = record.pending
    record.pending = ''
    record.seq += 1
    this.pushRing(record, { seq: record.seq, data })
    if (!record.attached) return
    this.getBroadcaster()?.sendData({ terminalId: record.info.id, seq: record.seq, data })
    record.unackedUnits += data.length
    if (!record.paused && record.unackedUnits >= this.options.highWaterUnits) {
      record.paused = true
      record.pty.pause()
      // Stall fallback: if no ack arrives for a while the consumer is gone in
      // a way the host missed — treat as detached instead of freezing forever.
      this.clearStallTimer(record)
      record.stallTimer = setTimeout(() => this.detach(record), this.options.ackStallMs)
      record.stallTimer.unref?.()
    }
  }

  private pushRing(record: TerminalRecord, chunk: TerminalOutputChunk): void {
    const max = this.options.ringMaxUnits
    if (chunk.data.length > max) {
      // A single oversized burst: keep only its tail.
      chunk = { seq: chunk.seq, data: chunk.data.slice(chunk.data.length - max) }
      record.ring.length = 0
      record.ringUnits = 0
      record.ringTruncated = true
    }
    record.ring.push(chunk)
    record.ringUnits += chunk.data.length
    while (record.ring.length > 1 && record.ringUnits > max) {
      const evicted = record.ring.shift()
      if (!evicted) break
      record.ringUnits -= evicted.data.length
      record.ringTruncated = true
    }
  }

  private handleExit(record: TerminalRecord, exitCode: number | null): void {
    if (record.exited) return
    // Flush BEFORE the exit event so exit can never overtake tail output
    // (same flush-before-event rule as the stream coalescer).
    this.flushNow(record)
    record.exited = true
    record.info.exited = { code: exitCode }
    this.clearStallTimer(record)
    if (record.killTimer !== null) {
      clearTimeout(record.killTimer)
      record.killTimer = null
    }
    this.getBroadcaster()?.sendExit({ terminalId: record.info.id, exitCode })
  }

  private detach(record: TerminalRecord): void {
    record.attached = false
    record.unackedUnits = 0
    this.clearStallTimer(record)
    this.resumeIfPaused(record)
  }

  private resumeIfPaused(record: TerminalRecord): void {
    if (!record.paused) return
    record.paused = false
    if (!record.exited) record.pty.resume()
  }

  private clearStallTimer(record: TerminalRecord): void {
    if (record.stallTimer !== null) {
      clearTimeout(record.stallTimer)
      record.stallTimer = null
    }
  }

  private disposeRecord(record: TerminalRecord): void {
    if (record.flushTimer !== null) {
      clearTimeout(record.flushTimer)
      record.flushTimer = null
    }
    this.clearStallTimer(record)
    if (record.killTimer !== null) {
      clearTimeout(record.killTimer)
      record.killTimer = null
    }
    if (record.exited) return
    record.exited = true
    // Graceful first (whole process group — SIGHUP-ignoring grandchildren
    // included via the follow-up SIGKILL), forceful after a short grace.
    record.pty.kill('SIGHUP')
    record.killTimer = setTimeout(() => {
      record.pty.kill('SIGKILL')
    }, this.options.killGraceMs)
    record.killTimer.unref?.()
  }
}

let broadcaster: TerminalBroadcaster | null = null
let serviceInstance: TerminalService | null = null

/** Host injection port (practice-broadcaster pattern); consulted per call. */
export function configureTerminalBroadcaster(next: TerminalBroadcaster | null): void {
  broadcaster = next
}

/**
 * 这台宿主有没有终端输出通道。未注入 = 没有 —— 于是 `terminal` 域一条都不给,
 * 与从前 `transport === 'http'` 那七条结构化拒绝逐字同一批答案。
 */
export function hasTerminalHost(): boolean {
  return broadcaster !== null
}

export function getTerminalService(): TerminalService {
  serviceInstance ??= new TerminalService(createNodePtyBackend(), () => broadcaster)
  return serviceInstance
}

/**
 * Shutdown reaping — wired into the desktop beforeQuit cleanup table (the
 * host's real quit path; backend.shutdown() is NOT run by the Electron host)
 * and mirrored in backend.ts/HeadlessBackend for symmetry. No-op when no
 * terminal was ever created, so the daemon and readonly servers never touch
 * the native module.
 */
export function killAllTerminals(): void {
  serviceInstance?.killAll()
}

/** Detach edge for host wiring (window reload/close). No-op safe. */
export function markAllTerminalsDetached(): void {
  serviceInstance?.markAllDetached()
}
