import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, isAbsolute, resolve } from 'path'
import { Readable, Writable } from 'stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  ClientConnection,
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
  SessionConfigOption,
  SessionNotification,
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
  ACPConnectionStatus,
  ACPPermissionBridge,
  ACPPermissionDecision,
  ACPPermissionMode,
  ACPPermissionRequestContext,
  ACPPromptStreamEvent,
  ACPPromptStreamOptions,
  ACPSessionOption,
  ACPSessionOptionChoice,
} from './types.js'
import type { ACPSessionLink, ACPSessionLinkStore } from './session-links.js'

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
/**
 * 连接先断、进程还没报 exit 时,给 exit 留的一小段时间:agent 崩掉时 stdout 的 EOF 常比
 * `exit` 事件早到,等一下就能把退出码写进那句报错;真是「连接断了、进程还活着」才由连接这头收尾。
 */
const CONNECTION_CLOSED_EXIT_GRACE_MS = 250

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  const rpc = rpcErrorShape(error)
  return rpc ? rpc.message : String(error)
}

/** claude-agent-acp 推登录状态用的扩展通知。 */
const AUTH_STATUS_UPDATE_METHOD = '_auth/status_update'

/** ACP 规范给 `authRequired` 的 JSON-RPC 错误码。 */
const ACP_AUTH_REQUIRED_CODE = -32000

/**
 * 对端回来的 JSON-RPC 错误:0.x 的 SDK 原样 reject 成**普通对象**(`{code, message, data}`),
 * 1.x 包成 `RequestError`(是 `Error`,但 agent 的原话在 `data` 里)—— 两种都认。
 */
function rpcErrorShape(error: unknown): { code?: number; message: string; data?: unknown } | undefined {
  if (!error || typeof error !== 'object') return undefined
  if (error instanceof Error && !(error instanceof acp.RequestError)) return undefined
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof message !== 'string') return undefined
  return { ...(typeof code === 'number' ? { code } : {}), message, ...(data === undefined ? {} : { data }) }
}

function describeRpcData(data: unknown): string {
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data
  const text = (data as { message?: unknown; details?: unknown }).message ?? (data as { details?: unknown }).details
  if (typeof text === 'string') return text
  try {
    return JSON.stringify(data).slice(0, 500)
  } catch {
    return ''
  }
}

/**
 * 一轮 prompt 失败时交给会话的那句话(2026-09-24:真机上这里显示的是 `[object Object]` ——
 * SDK 把对端的 JSON-RPC 错误原样 reject 成普通对象,`String()` 一下什么都没了)。
 * `authRequired` 单独说人话:它不是 onething 的错,是那台 agent 自己的登录过期了,
 * 要去**它自己的** CLI 里登录;`authLabel` 是 agent 经 `_auth/status_update` 推来的原话。
 */
export function toAcpPromptError(error: unknown, agentName: string, authLabel?: string): Error {
  const rpc = rpcErrorShape(error)
  if (!rpc) return error instanceof Error ? error : new Error(String(error))
  const detail = describeRpcData(rpc.data)
  if (rpc.code === ACP_AUTH_REQUIRED_CODE) {
    const why = authLabel || detail || rpc.message
    return new Error(
      `ACP agent "${agentName}" is not logged in (${why}). Log in with the agent's own CLI and retry.`,
      { cause: error },
    )
  }
  const message = detail && !rpc.message.includes(detail) ? `${rpc.message}: ${detail}` : rpc.message
  return new Error(message, { cause: error })
}

/**
 * 连不上时交给会话的那句话。ENOENT 单独说人话:它几乎总是「适配器没装」或
 * 「GUI 起的 app 没拿到登录 shell 的 PATH」,而 Node 原话 `spawn x ENOENT` 两件都没说。
 * 进程起了但握手前就退了,把 stderr 尾巴带上 —— 适配器自己的报错多半就在那里。
 */
export function describeConnectFailure(command: string, error: unknown, stderrTail = ''): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') {
    return new Error(
      `ACP agent command "${command}" was not found on PATH. `
      + 'Install the ACP adapter or set the agent command to an absolute path.',
      { cause: error },
    )
  }
  const tail = stderrTail.trim()
  const base = errorMessage(error)
  if (!tail || base.includes(tail.slice(-200))) return error instanceof Error ? error : new Error(base)
  return new Error(`${base} stderr: ${tail.slice(-1000)}`, { cause: error })
}

/** 子进程环境 = 宿主给的底(缺席就是进程环境)⊕ 这台 agent 配置里自己的 `env`。 */
function mergeEnv(
  env?: Record<string, string>,
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const filteredBase = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return env ? { ...filteredBase, ...env } : filteredBase
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
  /** agent 在这条会话里自述的可调选项(新开 / 恢复 / 改选项时的答复)。 */
  options: ACPSessionOption[]
}

/**
 * 会话目录的**唯一**判据:会话绑了目录就用它,没绑(`undefined` 或空串 —— 真店
 * `meta.json` 里存的就是 `''`)才退回进程目录。从前 provider 用 `??` 判,空串会原样
 * 递进 `session/new`,pi 直接回 `cwd must be an absolute path`。
 */
export function resolveACPSessionCwd(cwd: string | undefined): string {
  const trimmed = cwd?.trim()
  // ACP 要求绝对路径(pi 当场拒相对路径);provider 的最后一档兜底是 `'.'`。
  return trimmed ? resolve(trimmed) : process.cwd()
}

/** ACP `configOptions` → onething 的选项投影:只收 `select`,分组拍平。 */
export function projectACPConfigOptions(
  configOptions: readonly SessionConfigOption[] | null | undefined,
): ACPSessionOption[] {
  const out: ACPSessionOption[] = []
  for (const option of configOptions ?? []) {
    if (option.type !== 'select') continue
    const choices: ACPSessionOptionChoice[] = []
    for (const entry of option.options) {
      if ('group' in entry) {
        for (const choice of entry.options) choices.push(projectChoice(choice, entry.name))
      } else {
        choices.push(projectChoice(entry))
      }
    }
    out.push({
      id: option.id,
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      ...(option.category ? { category: option.category } : {}),
      currentValue: option.currentValue,
      choices,
    })
  }
  return out
}

function projectChoice(
  choice: { value: string; name: string; description?: string | null },
  group?: string,
): ACPSessionOptionChoice {
  return {
    value: choice.value,
    name: choice.name,
    ...(choice.description ? { description: choice.description } : {}),
    ...(group ? { group } : {}),
  }
}

function withCurrentValue(options: ACPSessionOption[], optionId: string, value: string): ACPSessionOption[] {
  return options.map(option => (option.id === optionId ? { ...option, currentValue: value } : option))
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
  private connection: ClientConnection | null = null
  private connectionGeneration = {}
  private initResponse: InitializeResponse | null = null
  private statusValue: ACPConnectionStatus = 'disconnected'
  private errorValue: string | undefined
  /** agent 自己报的「没登录」原话(`_auth/status_update`);登录了就是 undefined。 */
  private authLabel: string | undefined
  private connectedAtValue: number | undefined
  private lastUsedAtValue: number | undefined
  private sessions = new Map<string, ACPSessionRecord>()
  private sessionOpenings = new Map<string, Promise<ACPSessionRecord>>()
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
    private runtimeOptions: {
      /**
       * Late-bound accessor so clients created before the host registers the
       * bridge still pick it up, and bridge removal takes effect immediately.
       */
      getPermissionBridge?: () => ACPPermissionBridge | undefined
      /** 会话对应关系的落盘处;缺席 = 只记在内存里(旧行为)。 */
      getSessionLinks?: () => ACPSessionLinkStore | undefined
      /** 子进程环境的底(宿主注入代理等);缺席 = `process.env`。 */
      getSpawnEnv?: () => Record<string, string | undefined> | undefined
    } = {},
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
    const generation = this.connectionGeneration = {}
    // 这一代连接收过尾没有;握手失败走 catch 自己收,也要把它置上,免得迟到的关闭把 error 改回 disconnected。
    let ended = false

    try {
      const child = spawn(this.config.command, this.config.args ?? [], {
        cwd: this.config.cwd || undefined,
        env: mergeEnv(this.config.env, this.runtimeOptions.getSpawnEnv?.() ?? process.env),
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

      // 连接的收尾只有一条:进程退出与连接关闭(stdout 到头、对端关流)都走这里,
      // 谁先到谁收,第二次进来什么都不做 —— 否则后到的那个会把先到的原因盖掉。
      const endConnection = (reason: string) => {
        if (ended || this.connectionGeneration !== generation) return
        ended = true
        if (this.unexpectedExit) {
          this.statusValue = 'error'
          this.errorValue = reason
        } else {
          this.statusValue = 'disconnected'
        }
        this.connection = null
        this.connectedAtValue = undefined
        this.failAllQueues(new Error(this.errorValue || 'ACP agent disconnected'))
        this.releaseAllTerminals()
      }
      const stderrSuffix = () => (this.stderrTail ? ` stderr: ${this.stderrTail.slice(-1000)}` : '')

      child.once('exit', (code, signal) => {
        if (this.connectionGeneration !== generation) return
        if (this.child === child) this.child = null
        endConnection(
          `ACP agent exited${code !== null ? ` with code ${code}` : ''}${signal ? ` by signal ${signal}` : ''}.${stderrSuffix()}`,
        )
      })

      const input = Writable.toWeb(child.stdin)
      const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      const stream = acp.ndJsonStream(input, output)
      const connection = this.connection = this.createClientApp().connect(stream)

      // 连接断了而进程没退(对端关了 stdout、或流出错):不等 exit,先给 exit 一小段时间说清退出码,
      // 过了还没来就由这头收尾,并把那个已经说不上话的进程收掉。
      // `closed` 按 d.ts 只 resolve;但它是一条 promise,流出错真 reject 的话没人接就是 unhandledRejection,
      // 会被崩溃钩子记成 fatal —— 两个分支都收进同一个收尾。
      const onConnectionClosed = () => {
        if (ended || this.connectionGeneration !== generation) return
        setTimeout(() => {
          if (ended || this.connectionGeneration !== generation) return
          endConnection(`ACP agent "${this.config.name}" closed its connection.${stderrSuffix()}`)
          if (this.child === child) {
            this.child = null
            if (child.exitCode === null && child.signalCode === null) child.kill()
          }
        }, CONNECTION_CLOSED_EXIT_GRACE_MS)
      }
      connection.closed.then(onConnectionClosed, onConnectionClosed)

      try {
        this.initResponse = await withTimeout(
          Promise.race([
            connection.agent.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
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
      ended = true
      const failure = describeConnectFailure(this.config.command, error, this.stderrTail)
      log.error('agent connect failed', {
        agentId: this.id,
        command: this.config.command,
        args: this.config.args ?? [],
        ...(this.stderrTail ? { stderr: this.stderrTail.slice(-1000) } : {}),
      }, error)
      await this.disconnect()
      this.statusValue = 'error'
      this.errorValue = failure.message
      throw failure
    }
  }

  async disconnect(): Promise<void> {
    this.unexpectedExit = false
    this.failAllQueues(new Error('ACP agent disconnected'))
    this.releaseAllTerminals()
    this.sessions.clear()
    this.initResponse = null
    const connection = this.connection
    this.connection = null
    connection?.close()

    const child = this.child
    this.child = null
    if (child && !child.killed) {
      child.kill()
      await new Promise<void>((resolveDone) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
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
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.acpSessionId })
  }

  async *streamPrompt(options: ACPPromptStreamOptions): AsyncGenerator<ACPPromptStreamEvent, void, unknown> {
    await this.connect()
    if (!this.connection) throw new Error('ACP connection is not available')

    const session = await this.ensureSession(options.localSessionId, options.cwd)
    if (this.updateQueues.has(session.acpSessionId)) throw new Error('An ACP prompt is already active for this session')
    const queue = new BoundedAsyncQueue<ACPPromptStreamEvent>(
      Math.max(1, this.config.maxBufferedUpdates ?? DEFAULT_MAX_BUFFERED_UPDATES)
    )
    this.updateQueues.set(session.acpSessionId, queue)
    const connection = this.connection
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
        connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(error => {
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
      connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: session.acpSessionId,
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
        connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: session.acpSessionId }).catch(cancelError => {
          log.warn('cancel after prompt failure failed', { agentId: this.id }, cancelError)
        })
        queue.error(toAcpPromptError(error, this.config.name, this.authLabel))
      })
      .finally(() => {
        if (this.updateQueues.get(session.acpSessionId) === queue) {
          this.updateQueues.delete(session.acpSessionId)
          this.promptContexts.delete(session.acpSessionId)
          this.activePromptCountValue = Math.max(0, this.activePromptCountValue - 1)
        }
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

  /**
   * onething 会话 → agent 会话。三档,依次试:
   *  ① 内存里就有、目录没变 → 直接用;
   *  ② 盘上记着(同一台 agent、同一个目录)→ `resume`(不回放历史)或 `load`
   *     (回放的 `session/update` 此刻没有队列接,`sessionUpdate` 按设计丢掉 ——
   *     onething 自己有历史,不需要第二份);恢复失败就退到 ③;
   *  ③ `session/new`。
   * 开出来之后按「这台 agent 上次的选择 ⊕ 这条会话里的选择」调一遍选项,再落盘。
   * 同一条会话并发来两次(选项面板 + 发送)只开一次:在飞的那一发被复用。
   */
  private async ensureSession(localSessionId: string, rawCwd: string | undefined): Promise<ACPSessionRecord> {
    const cwd = resolveACPSessionCwd(rawCwd)
    const existing = this.sessions.get(localSessionId)
    if (existing && existing.cwd === cwd) {
      existing.prompts += 1
      existing.lastUsedAt = Date.now()
      return existing
    }
    const inflight = this.sessionOpenings.get(localSessionId)
    if (inflight) return inflight
    const opening = this.openSession(localSessionId, cwd, existing).finally(() => {
      if (this.sessionOpenings.get(localSessionId) === opening) this.sessionOpenings.delete(localSessionId)
    })
    this.sessionOpenings.set(localSessionId, opening)
    return opening
  }

  private async openSession(
    localSessionId: string,
    cwd: string,
    existing: ACPSessionRecord | undefined,
  ): Promise<ACPSessionRecord> {
    if (!this.connection) throw new Error('ACP connection is not available')
    if (existing) {
      await this.connection.agent
        .notify(acp.methods.agent.session.cancel, { sessionId: existing.acpSessionId })
        .catch(() => undefined)
      this.sessions.delete(localSessionId)
    }

    const links = this.runtimeOptions.getSessionLinks?.()
    const link = links?.getLink(this.id, localSessionId)
    let opened = link && link.cwd === cwd ? await this.restoreSession(link.acpSessionId, cwd) : undefined
    if (!opened) {
      const response = await this.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: (this.config.mcpServers ?? []) as unknown as acp.McpServer[],
      })
      opened = { acpSessionId: response.sessionId, options: projectACPConfigOptions(response.configOptions) }
    }

    const session: ACPSessionRecord = {
      localSessionId,
      acpSessionId: opened.acpSessionId,
      cwd,
      prompts: 1,
      lastUsedAt: Date.now(),
      options: opened.options,
    }
    this.sessions.set(localSessionId, session)
    this.trimSessionRecords(localSessionId)

    const chosen = link?.options ?? {}
    await this.applyDesiredOptions(session, { ...(links?.getProfile(this.id)?.preferred ?? {}), ...chosen })
    this.persistLink(session, chosen)
    return session
  }

  /** 按 agent 声明的能力回到原会话;任何一步失败都返回 undefined,由调用方新开。 */
  private async restoreSession(
    acpSessionId: string,
    cwd: string,
  ): Promise<{ acpSessionId: string; options: ACPSessionOption[] } | undefined> {
    const connection = this.connection
    if (!connection) return undefined
    const capabilities = this.initResponse?.agentCapabilities
    const mcpServers = (this.config.mcpServers ?? []) as unknown as acp.McpServer[]
    try {
      if (capabilities?.sessionCapabilities?.resume) {
        const response = await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: acpSessionId,
          cwd,
          mcpServers,
        })
        log.info('session resumed', { agentId: this.id, acpSessionId })
        return { acpSessionId, options: projectACPConfigOptions(response.configOptions) }
      }
      if (capabilities?.loadSession) {
        const response = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: acpSessionId,
          cwd,
          mcpServers,
        })
        log.info('session loaded', { agentId: this.id, acpSessionId })
        return { acpSessionId, options: projectACPConfigOptions(response.configOptions) }
      }
    } catch (error) {
      log.warn('session restore failed; opening a new one', { agentId: this.id, acpSessionId }, error)
    }
    return undefined
  }

  /** 把想要的值调到 agent 身上:只调「这条会话里有这一格、值在可选里、且与当前不同」的。 */
  private async applyDesiredOptions(session: ACPSessionRecord, desired: Record<string, string>): Promise<void> {
    for (const [optionId, value] of Object.entries(desired)) {
      const option = session.options.find(candidate => candidate.id === optionId)
      if (!option || option.currentValue === value) continue
      if (!option.choices.some(choice => choice.value === value)) continue
      try {
        await this.writeOption(session, optionId, value)
      } catch (error) {
        log.warn('restoring session option failed', { agentId: this.id, optionId, value }, error)
      }
    }
  }

  private async writeOption(session: ACPSessionRecord, optionId: string, value: string): Promise<void> {
    if (!this.connection) throw new Error('ACP connection is not available')
    const response = await this.connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: session.acpSessionId,
      configId: optionId,
      value,
    })
    const projected = projectACPConfigOptions(response?.configOptions)
    session.options = projected.length > 0 ? projected : withCurrentValue(session.options, optionId, value)
  }

  private persistLink(session: ACPSessionRecord, chosen: Record<string, string>): void {
    const links = this.runtimeOptions.getSessionLinks?.()
    if (!links) return
    const now = Date.now()
    const link: ACPSessionLink = {
      agentId: this.id,
      localSessionId: session.localSessionId,
      acpSessionId: session.acpSessionId,
      cwd: session.cwd,
      options: chosen,
      updatedAt: now,
    }
    links.putLink(link)
    if (session.options.length > 0) {
      const profile = links.getProfile(this.id)
      links.putProfile({
        agentId: this.id,
        preferred: profile?.preferred ?? {},
        catalog: session.options,
        updatedAt: now,
      })
    }
  }

  /** 这条会话此刻的选项 —— 会连上 agent、开(或恢复)那条会话。 */
  async getSessionOptions(localSessionId: string, cwd: string | undefined): Promise<ACPSessionOption[]> {
    await this.connect()
    const session = await this.ensureSession(localSessionId, cwd)
    return session.options
  }

  /**
   * 用户在选择器里改了一格:交给 agent,再记两处 —— 这条会话的选择(恢复时重放)
   * 与这台 agent 的 `preferred`(下一条新会话照这个开)。
   */
  async setSessionOption(
    localSessionId: string,
    cwd: string | undefined,
    optionId: string,
    value: string,
  ): Promise<ACPSessionOption[]> {
    await this.connect()
    const session = await this.ensureSession(localSessionId, cwd)
    await this.writeOption(session, optionId, value)
    const links = this.runtimeOptions.getSessionLinks?.()
    const chosen = { ...(links?.getLink(this.id, localSessionId)?.options ?? {}), [optionId]: value }
    this.persistLink(session, chosen)
    if (links) {
      const profile = links.getProfile(this.id)
      links.putProfile({
        agentId: this.id,
        preferred: { ...(profile?.preferred ?? {}), [optionId]: value },
        catalog: session.options,
        updatedAt: Date.now(),
      })
    }
    return session.options
  }

  /**
   * 这一侧答得了的方法表。文件与终端仍按这台 agent 的 allow* 开关挂(能力何时固定是后面一单的事);
   * 没挂的方法 SDK 自己回 `Method not found`。扩展通知只接认得的那一条,别的 SDK 直接放过。
   */
  private createClientApp(): acp.ClientApp {
    const app = acp.client({ name: 'onething' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.requestPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.sessionUpdate(params))
      .onNotification(
        AUTH_STATUS_UPDATE_METHOD,
        (raw: unknown) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
        ({ params }) => this.extNotification(AUTH_STATUS_UPDATE_METHOD, params),
      )
    if (this.config.allowFileSystemAccess) {
      app
        .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => this.readTextFile(params))
        .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => this.writeTextFile(params))
    }
    if (this.config.allowTerminalAccess) {
      app
        .onRequest(acp.methods.client.terminal.create, ({ params }) => this.createTerminal(params))
        .onRequest(acp.methods.client.terminal.output, ({ params }) => this.terminalOutput(params))
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => this.waitForTerminalExit(params))
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => this.killTerminal(params))
        .onRequest(acp.methods.client.terminal.release, ({ params }) => this.releaseTerminal(params))
    }
    return app
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

  /**
   * ACP 的扩展通知(方法名以 `_` 起头)。claude-agent-acp 连上就推一条 `_auth/status_update`,
   * 它是「没登录」那句人话的来源;1.x 的 SDK 对没登记的通知静默放过,所以这里只登记认得的。
   */
  private async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === AUTH_STATUS_UPDATE_METHOD) {
      const status = params.authStatus as { kind?: unknown; label?: unknown } | undefined
      const kind = typeof status?.kind === 'string' ? status.kind : undefined
      const label = typeof status?.label === 'string' ? status.label : undefined
      this.authLabel = kind === 'none' ? (label ?? 'not logged in') : undefined
      log.info('agent auth status', { agentId: this.id, kind, label })
      return
    }
    log.debug('agent extension notification ignored', { agentId: this.id, method })
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
    this.promptContexts.clear()
    this.activePromptCountValue = 0
  }

  private releaseAllTerminals(): void {
    for (const terminal of this.terminals.values()) {
      if (!terminal.child.killed && !terminal.exitStatus) terminal.child.kill()
    }
    this.terminals.clear()
  }
}
