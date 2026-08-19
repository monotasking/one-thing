import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { Readable, Writable } from 'stream'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Client,
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPClientRuntimeOptions,
  ACPConnectionStatus,
  ACPPermissionDecision,
  ACPPermissionMode,
  ACPPermissionRequestContext,
  ACPPromptStreamEvent,
  ACPPromptStreamOptions,
} from './types.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('acp')

const DEFAULT_CONNECT_TIMEOUT_MS = 30000
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_BUFFERED_UPDATES = 1000
const DEFAULT_MAX_SESSION_RECORDS = 100
const DEFAULT_MAX_TERMINALS = 32
const DEFAULT_MAX_TERMINAL_OUTPUT_BYTES = 1024 * 1024
const MAX_FILE_READ_BYTES = 1024 * 1024

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function mergeEnv(env?: Record<string, string>): Record<string, string> {
  const filteredProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return env ? { ...filteredProcessEnv, ...env } : filteredProcessEnv
}

function trimToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { text, truncated: false }

  let retained = text
  while (Buffer.byteLength(retained) > maxBytes && retained.length > 0) {
    retained = retained.slice(Math.max(1, retained.length - Math.ceil(retained.length * 0.9)))
  }
  return { text: retained, truncated: true }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

class BoundedAsyncQueue<T> {
  private items: T[] = []
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: Error) => void
  }> = []
  private ended = false
  private failure: Error | null = null
  private dropped = 0

  constructor(private readonly maxItems: number) {}

  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return
    }

    if (this.items.length >= this.maxItems) {
      this.items.shift()
      this.dropped += 1
    }
    this.items.push(item)
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.failure) throw this.failure
    if (this.dropped > 0) {
      const dropped = this.dropped
      this.dropped = 0
      return {
        value: { type: 'warning', message: `ACP stream buffer overflow: dropped ${dropped} old update(s).` } as T,
        done: false,
      }
    }
    const item = this.items.shift()
    if (item) return { value: item, done: false }
    if (this.ended) return { value: undefined, done: true }

    return new Promise<IteratorResult<T>>((resolveNext, rejectNext) => {
      this.waiters.push({ resolve: resolveNext, reject: rejectNext })
    })
  }

  end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  error(error: Error): void {
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error)
    }
  }
}

interface ACPSessionRecord {
  localSessionId: string
  acpSessionId: string
  cwd: string
  prompts: number
  lastUsedAt: number
}

interface TerminalRecord {
  child: ChildProcessByStdio<null, Readable, Readable>
  output: string
  truncated: boolean
  outputLimit: number
  createdAt: number
  lastUsedAt: number
  exitStatus?: { exitCode?: number | null; signal?: string | null }
  exitPromise: Promise<{ exitCode?: number | null; signal?: string | null }>
}

export class ACPClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: ClientSideConnection | null = null
  private initResponse: InitializeResponse | null = null
  private statusValue: ACPConnectionStatus = 'disconnected'
  private errorValue: string | undefined
  private connectedAtValue: number | undefined
  private lastUsedAtValue: number | undefined
  private sessions = new Map<string, ACPSessionRecord>()
  private updateQueues = new Map<string, BoundedAsyncQueue<ACPPromptStreamEvent>>()
  /** acpSessionId → context of the currently streaming prompt (for permission attribution). */
  private promptContexts = new Map<string, { localSessionId: string; messageId?: string; cwd: string }>()
  private terminals = new Map<string, TerminalRecord>()
  private activePromptCountValue = 0
  private stderrTail = ''
  private unexpectedExit = false
  private connectPromise: Promise<void> | null = null

  constructor(
    private config: ACPAgentConfig,
    private runtimeOptions: ACPClientRuntimeOptions = {},
  ) {}

  get id(): string {
    return this.config.id
  }

  get status(): ACPConnectionStatus {
    return this.statusValue
  }

  get activePromptCount(): number {
    return this.activePromptCountValue
  }

  get lastUsedAt(): number | undefined {
    return this.lastUsedAtValue
  }

  get idleTimeoutMs(): number {
    return this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  }

  get state(): ACPAgentState {
    return {
      config: this.config,
      status: this.statusValue,
      error: this.errorValue,
      connectedAt: this.connectedAtValue,
      lastUsedAt: this.lastUsedAtValue,
      pid: this.child?.pid,
      protocolVersion: this.initResponse?.protocolVersion,
      agentInfo: this.initResponse?.agentInfo ?? undefined,
      sessionCount: this.sessions.size,
      activePromptCount: this.activePromptCountValue,
    }
  }

  updateConfig(config: ACPAgentConfig): void {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.statusValue === 'connected' && this.connection) return
    if (this.connectPromise) return this.connectPromise

    this.connectPromise = this.openConnection().finally(() => {
      this.connectPromise = null
    })
    return this.connectPromise
  }

  private async openConnection(): Promise<void> {
    if (!this.config.command?.trim()) throw new Error('ACP agent command is required')

    await this.disconnect()
    this.statusValue = 'connecting'
    this.errorValue = undefined
    this.stderrTail = ''
    this.unexpectedExit = true

    try {
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd || undefined,
        env: mergeEnv(this.config.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      let childSpawnErrorHandler: ((error: Error) => void) | undefined
      const childSpawnError = new Promise<never>((_, reject) => {
        childSpawnErrorHandler = (error: Error) => reject(error)
        child.once('error', childSpawnErrorHandler)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const next = this.stderrTail + chunk.toString('utf8')
        this.stderrTail = trimToBytes(next, 16 * 1024).text
      })

      child.once('exit', (code, signal) => {
        const suffix = this.stderrTail ? ` stderr: ${this.stderrTail.slice(-1000)}` : ''
        if (this.unexpectedExit) {
          this.statusValue = 'error'
          this.errorValue = `ACP agent exited${code !== null ? ` with code ${code}` : ''}${signal ? ` by signal ${signal}` : ''}.${suffix}`
        } else {
          this.statusValue = 'disconnected'
        }
        this.connection = null
        this.child = null
        this.connectedAtValue = undefined
        this.failAllQueues(new Error(this.errorValue || 'ACP agent disconnected'))
        this.releaseAllTerminals()
      })

      const input = Writable.toWeb(child.stdin)
      const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      const stream = ndJsonStream(input, output)
      this.connection = new ClientSideConnection(() => this.createClientHandlers(), stream)

      try {
        this.initResponse = await withTimeout(
          Promise.race([
            this.connection.initialize({
              protocolVersion: PROTOCOL_VERSION,
              clientInfo: {
                name: 'onething',
                version: process.env.npm_package_version || '1.0.0',
              },
              clientCapabilities: {
                ...(this.config.allowFileSystemAccess ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
                ...(this.config.allowTerminalAccess ? { terminal: true } : {}),
              },
            }),
            childSpawnError,
          ]),
          this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          `ACP agent "${this.config.name}" did not initialize in time`,
        )
      } finally {
        if (childSpawnErrorHandler) child.off('error', childSpawnErrorHandler)
      }

      child.once('error', (error) => {
        if (this.child !== child) return
        this.statusValue = 'error'
        this.errorValue = `ACP agent process error: ${error.message}`
        this.failAllQueues(error)
      })

      this.statusValue = 'connected'
      this.connectedAtValue = Date.now()
      this.lastUsedAtValue = Date.now()
      log.info('agent connected', {
        agentId: this.id,
        pid: child.pid,
        protocolVersion: this.initResponse.protocolVersion,
        agent: this.initResponse.agentInfo?.name,
      })
    } catch (error) {
      const message = errorMessage(error)
      await this.disconnect()
      this.statusValue = 'error'
      this.errorValue = message
      throw error
    }
  }

  async disconnect(): Promise<void> {
    this.unexpectedExit = false
    this.failAllQueues(new Error('ACP agent disconnected'))
    this.releaseAllTerminals()
    this.sessions.clear()
    this.initResponse = null
    this.connection = null

    const child = this.child
    this.child = null
    if (child && !child.killed) {
      child.kill()
      await new Promise<void>((resolveDone) => {
        const timer = setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL')
          resolveDone()
        }, 1500)
        child.once('exit', () => {
          clearTimeout(timer)
          resolveDone()
        })
      })
    }

    this.statusValue = 'disconnected'
    this.connectedAtValue = undefined
  }

  async refresh(): Promise<void> {
    await this.disconnect()
    await this.connect()
  }

  async cancelLocalSession(localSessionId: string): Promise<void> {
    const session = this.sessions.get(localSessionId)
    if (!session || !this.connection) return
    await this.connection.cancel({ sessionId: session.acpSessionId })
  }

  async *streamPrompt(options: ACPPromptStreamOptions): AsyncGenerator<ACPPromptStreamEvent, void, unknown> {
    await this.connect()
    if (!this.connection) throw new Error('ACP connection is not available')

    const session = await this.ensureSession(options.localSessionId, options.cwd)
    const queue = new BoundedAsyncQueue<ACPPromptStreamEvent>(
      Math.max(1, this.config.maxBufferedUpdates ?? DEFAULT_MAX_BUFFERED_UPDATES)
    )
    this.updateQueues.set(session.acpSessionId, queue)
    this.promptContexts.set(session.acpSessionId, {
      localSessionId: options.localSessionId,
      messageId: options.messageId,
      cwd: options.cwd,
    })
    this.activePromptCountValue += 1
    this.lastUsedAtValue = Date.now()

    let abortListener: (() => void) | undefined
    if (options.abortSignal) {
      abortListener = () => {
        this.connection?.cancel({ sessionId: session.acpSessionId }).catch(error => {
          log.warn('cancel failed', { agentId: this.id }, error)
        })
      }
      if (options.abortSignal.aborted) {
        abortListener()
      } else {
        options.abortSignal.addEventListener('abort', abortListener, { once: true })
      }
    }

    const promptPromise = withTimeout(
      this.connection.prompt({
        sessionId: session.acpSessionId,
        messageId: randomUUID(),
        prompt: [{ type: 'text', text: options.prompt }],
      }),
      this.config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      `ACP prompt timed out for agent "${this.config.name}"`,
    )

    promptPromise
      .then((response) => {
        queue.push({
          type: 'finish',
          stopReason: response.stopReason,
          usage: response.usage
            ? {
                inputTokens: response.usage.inputTokens,
                outputTokens: response.usage.outputTokens,
                totalTokens: response.usage.totalTokens,
              }
            : undefined,
        })
        queue.end()
      })
      .catch((error) => {
        this.connection?.cancel({ sessionId: session.acpSessionId }).catch(cancelError => {
          log.warn('cancel after prompt failure failed', { agentId: this.id }, cancelError)
        })
        queue.error(error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        this.updateQueues.delete(session.acpSessionId)
        this.promptContexts.delete(session.acpSessionId)
        this.activePromptCountValue = Math.max(0, this.activePromptCountValue - 1)
        this.lastUsedAtValue = Date.now()
        if (options.abortSignal && abortListener) {
          options.abortSignal.removeEventListener('abort', abortListener)
        }
      })

    while (true) {
      const next = await queue.next()
      if (next.done) break
      yield next.value
    }
  }

  private async ensureSession(localSessionId: string, cwd: string): Promise<ACPSessionRecord> {
    const existing = this.sessions.get(localSessionId)
    if (existing && existing.cwd === cwd) {
      existing.prompts += 1
      existing.lastUsedAt = Date.now()
      return existing
    }

    if (!this.connection) throw new Error('ACP connection is not available')
    if (existing) {
      await this.connection.cancel({ sessionId: existing.acpSessionId }).catch(() => undefined)
      this.sessions.delete(localSessionId)
    }

    const response = await this.connection.newSession({
      cwd,
      mcpServers: (this.config.mcpServers ?? []) as any,
    })
    const session = {
      localSessionId,
      acpSessionId: response.sessionId,
      cwd,
      prompts: 1,
      lastUsedAt: Date.now(),
    }
    this.sessions.set(localSessionId, session)
    this.trimSessionRecords(localSessionId)
    return session
  }

  private createClientHandlers(): Client {
    return {
      requestPermission: (params) => this.requestPermission(params),
      sessionUpdate: (params) => this.sessionUpdate(params),
      readTextFile: this.config.allowFileSystemAccess ? (params) => this.readTextFile(params) : undefined,
      writeTextFile: this.config.allowFileSystemAccess ? (params) => this.writeTextFile(params) : undefined,
      createTerminal: this.config.allowTerminalAccess ? (params) => this.createTerminal(params) : undefined,
      terminalOutput: this.config.allowTerminalAccess ? (params) => this.terminalOutput(params) : undefined,
      waitForTerminalExit: this.config.allowTerminalAccess ? (params) => this.waitForTerminalExit(params) : undefined,
      killTerminal: this.config.allowTerminalAccess ? (params) => this.killTerminal(params) : undefined,
      releaseTerminal: this.config.allowTerminalAccess ? (params) => this.releaseTerminal(params) : undefined,
    }
  }

  private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const bridge = this.runtimeOptions.getPermissionBridge?.()
    if (!bridge) {
      // No interactive surface registered (headless server, tests): keep the
      // legacy policy-driven resolution.
      return this.resolvePermissionFromMode(this.config.permissionMode ?? 'allow', params)
    }

    let decision: ACPPermissionDecision
    try {
      decision = await bridge(this.buildPermissionContext(params))
    } catch (error) {
      log.warn('permission bridge failed, rejecting request', { agentId: this.id }, error)
      return this.resolvePermissionFromMode('reject', params)
    }

    switch (decision.behavior) {
      case 'allow':
        return this.resolvePermissionFromMode('allow', params)
      case 'reject':
        return this.resolvePermissionFromMode('reject', params)
      case 'select': {
        const match = params.options.find(option => option.optionId === decision.optionId)
        if (match) return { outcome: { outcome: 'selected', optionId: match.optionId } }
        return this.resolvePermissionFromMode('reject', params)
      }
      case 'cancel':
      default:
        return { outcome: { outcome: 'cancelled' } }
    }
  }

  private resolvePermissionFromMode(
    mode: ACPPermissionMode,
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (mode === 'reject') {
      const reject = params.options.find(option => option.kind.includes('reject')) ?? params.options[0]
      if (!reject) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }

    const allow = params.options.find(option => option.kind.includes('allow')) ?? params.options[0]
    if (!allow) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId: allow.optionId } }
  }

  private buildPermissionContext(params: RequestPermissionRequest): ACPPermissionRequestContext {
    const promptContext = this.promptContexts.get(params.sessionId)
    const sessionRecord = promptContext
      ? undefined
      : Array.from(this.sessions.values()).find(record => record.acpSessionId === params.sessionId)
    const toolCall = params.toolCall
    return {
      agentId: this.config.id,
      agentName: this.config.name,
      localSessionId: promptContext?.localSessionId ?? sessionRecord?.localSessionId,
      messageId: promptContext?.messageId,
      cwd: promptContext?.cwd ?? sessionRecord?.cwd,
      toolCall: toolCall
        ? {
            toolCallId: toolCall.toolCallId,
            title: toolCall.title ?? undefined,
            kind: toolCall.kind ?? undefined,
            rawInput: toolCall.rawInput,
          }
        : undefined,
      options: params.options.map(option => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    }
  }

  private async sessionUpdate(params: SessionNotification): Promise<void> {
    const queue = this.updateQueues.get(params.sessionId)
    if (!queue) return
    queue.push({ type: 'update', notification: params })
  }

  private async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const filePath = this.resolveClientPath(params.path)
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_READ_BYTES) {
      throw new Error(`Refusing to read file larger than ${MAX_FILE_READ_BYTES} bytes`)
    }

    const content = await fs.readFile(filePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const start = Math.max(0, (params.line ?? 1) - 1)
    const end = params.limit ? start + params.limit : lines.length
    return { content: lines.slice(start, end).join('\n') }
  }

  private async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const filePath = this.resolveClientPath(params.path)
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, params.content, 'utf8')
    return {}
  }

  private async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const terminalId = randomUUID()
    const outputLimit = Math.min(
      params.outputByteLimit ?? this.config.maxTerminalOutputBytes ?? DEFAULT_MAX_TERMINAL_OUTPUT_BYTES,
      DEFAULT_MAX_TERMINAL_OUTPUT_BYTES,
    )
    const env = Object.fromEntries((params.env ?? []).map(item => [item.name, item.value]))
    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd || this.config.cwd || undefined,
      env: mergeEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const record: TerminalRecord = {
      child,
      output: '',
      truncated: false,
      outputLimit,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      exitPromise: new Promise(resolveExit => {
        child.once('exit', (exitCode, signal) => {
          record.exitStatus = { exitCode, signal }
          resolveExit(record.exitStatus)
        })
      }),
    }

    const appendOutput = (chunk: Buffer) => {
      const trimmed = trimToBytes(record.output + chunk.toString('utf8'), outputLimit)
      record.output = trimmed.text
      record.truncated = record.truncated || trimmed.truncated
    }
    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    this.terminals.set(terminalId, record)
    this.trimTerminalRecords(terminalId)
    return { terminalId }
  }

  private async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const terminal = this.getTerminal(params.terminalId)
    terminal.lastUsedAt = Date.now()
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus ?? null,
    }
  }

  private async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getTerminal(params.terminalId)
    terminal.lastUsedAt = Date.now()
    return terminal.exitPromise
  }

  private async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId)
    terminal.lastUsedAt = Date.now()
    if (!terminal.child.killed) terminal.child.kill()
    return {}
  }

  private async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const terminal = this.getTerminal(params.terminalId)
    if (!terminal.child.killed && !terminal.exitStatus) terminal.child.kill()
    this.terminals.delete(params.terminalId)
    return {}
  }

  private getTerminal(terminalId: string): TerminalRecord {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) throw new Error(`ACP terminal "${terminalId}" not found`)
    return terminal
  }

  private resolveClientPath(filePath: string): string {
    if (!isAbsolute(filePath)) throw new Error('ACP file paths must be absolute')
    return resolve(filePath)
  }

  private trimSessionRecords(currentLocalSessionId: string): void {
    const maxRecords = Math.max(1, this.config.maxSessionRecords ?? DEFAULT_MAX_SESSION_RECORDS)
    while (this.sessions.size > maxRecords) {
      const removable = Array.from(this.sessions.values())
        .filter(session => session.localSessionId !== currentLocalSessionId)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
      if (!removable) break
      this.sessions.delete(removable.localSessionId)
    }
  }

  private trimTerminalRecords(currentTerminalId: string): void {
    const maxRecords = Math.max(1, this.config.maxTerminals ?? DEFAULT_MAX_TERMINALS)
    while (this.terminals.size > maxRecords) {
      const removable = Array.from(this.terminals.entries())
        .filter(([terminalId]) => terminalId !== currentTerminalId)
        .sort(([, a], [, b]) => {
          if (a.exitStatus && !b.exitStatus) return -1
          if (!a.exitStatus && b.exitStatus) return 1
          return a.lastUsedAt - b.lastUsedAt
        })[0]
      if (!removable) break
      const [terminalId, terminal] = removable
      if (!terminal.child.killed && !terminal.exitStatus) terminal.child.kill()
      this.terminals.delete(terminalId)
    }
  }

  private failAllQueues(error: Error): void {
    for (const queue of this.updateQueues.values()) {
      queue.error(error)
    }
    this.updateQueues.clear()
    this.activePromptCountValue = 0
  }

  private releaseAllTerminals(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.child.killed && !terminal.exitStatus) terminal.child.kill()
    }
    this.terminals.clear()
  }
}
