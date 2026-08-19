import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type {
  DaemonEvent,
  DaemonFrame,
  DaemonMethod,
  DaemonRequest,
  DaemonResponse,
} from '@shared/cli/protocol.js'
import { assertSupportedPlatform, ensureRuntimeDirs, getCliRuntimePaths } from './paths.js'
import { NdjsonReader, encodeFrame } from './ndjson.js'

const READY_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 100

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onEvent?: (event: DaemonEvent['event']) => void | Promise<void>
}

export interface DaemonClientOptions {
  storePath?: string
}

export class DaemonClient {
  private socket: net.Socket | null = null
  private pending = new Map<string, PendingRequest>()

  constructor(private readonly options: DaemonClientOptions = {}) {}

  async connect(): Promise<void> {
    assertSupportedPlatform()
    const paths = getCliRuntimePaths(this.options.storePath)
    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(paths.socketPath)
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
    const reader = new NdjsonReader<DaemonFrame>(
      frame => this.handleFrame(frame),
      error => this.rejectAll(error),
    )
    this.socket.on('data', chunk => reader.push(chunk))
    this.socket.on('end', () => reader.end())
    this.socket.on('close', () => this.rejectAll(namedError('ERR_DAEMON_DISCONNECTED', 'Daemon disconnected')))
    this.socket.on('error', error => this.rejectAll(error))
  }

  close(): void {
    this.socket?.end()
    this.socket = null
  }

  async request<TData = unknown>(
    method: DaemonMethod,
    params?: unknown,
    onEvent?: (event: DaemonEvent['event']) => void | Promise<void>,
  ): Promise<TData> {
    if (!this.socket || this.socket.destroyed) await this.connect()
    const id = randomRequestId()
    const request: DaemonRequest = { id, method, params }
    const promise = new Promise<TData>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as TData),
        reject,
        onEvent,
      })
    })
    this.socket!.write(encodeFrame(request))
    return promise
  }

  private handleFrame(frame: DaemonFrame): void {
    const pending = this.pending.get(frame.id)
    if (!pending) return
    if (frame.type === 'event') {
      void pending.onEvent?.(frame.event)
      return
    }

    this.pending.delete(frame.id)
    const response = frame as DaemonResponse
    if (response.type === 'error') {
      const error = namedError(response.error.code, response.error.message)
      ;(error as Error & { details?: unknown }).details = response.error.details
      pending.reject(error)
      return
    }
    pending.resolve(response.data)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export async function ensureDaemon(options: DaemonClientOptions = {}): Promise<DaemonClient> {
  assertSupportedPlatform()
  const existing = await tryConnect(options)
  if (existing) return existing

  const paths = getCliRuntimePaths(options.storePath)
  ensureRuntimeDirs(paths)
  removeStaleSocket(paths.socketPath)
  spawnDaemon(options.storePath, paths.bootLogPath)

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    const client = await tryConnect(options)
    if (client) return client
  }

  throw new Error(`Daemon failed to start within ${READY_TIMEOUT_MS / 1000}s. Check logs: onething daemon logs`)
}

export async function tryConnect(options: DaemonClientOptions = {}): Promise<DaemonClient | null> {
  const client = new DaemonClient(options)
  try {
    await client.connect()
    await client.request('daemon.health')
    return client
  } catch {
    client.close()
    return null
  }
}

/**
 * `bootLogPath` 只接**配置日志之前**的 stderr(L2)。
 *
 * 从前这里把 stdout 和 stderr 都重定向到 `daemon.log`,守护进程的每一行都靠 fd
 * 落盘;现在守护进程一起来就 `configureLogging({fileBaseName:'daemon'})`,自己写
 * 结构化的 `daemon.jsonl`(轮转 / 保留期由 janitor 管)。stdout 因此改成 `ignore`
 * —— 再重定向就是同一条记录落两遍;stderr 留着,因为**配置起来之前**炸掉的 Node
 * 栈只会出现在那里,而那正是最需要看见的一种失败。
 */
export function spawnDaemon(storePath: string | undefined, logPath: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const err = fs.openSync(logPath, 'a')
  const cliEntry = process.argv[1]
  if (!cliEntry) throw new Error('Cannot determine CLI entrypoint for daemon spawn')
  const args = [cliEntry, '--daemon-child']
  if (storePath) args.push('--store', storePath)
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', err],
    env: {
      ...process.env,
      ONETHING_HEADLESS: '1',
      ...(storePath ? { ONETHING_STORE_PATH: storePath } : {}),
    },
  })
  child.unref()
}

function removeStaleSocket(socketPath: string): void {
  if (!fs.existsSync(socketPath)) return
  try {
    const socket = net.connect(socketPath)
    socket.once('connect', () => socket.end())
    socket.once('error', () => {
      try {
        fs.unlinkSync(socketPath)
      } catch {
        // Best effort.
      }
    })
  } catch {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // Best effort.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function randomRequestId(): string {
  return `req-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

function namedError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}
