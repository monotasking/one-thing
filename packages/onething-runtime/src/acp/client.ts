import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { resolve } from 'path'
import { Readable, Writable } from 'stream'
import * as acp from '@agentclientprotocol/sdk'
import type {
  AuthMethod,
  ClientConnection,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  InitializeResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  NewSessionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
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
  ACPOpenSessionOptions,
  ACPPermissionBridge,
  ACPPermissionDecision,
  ACPUnattendedPolicy,
  ACPPermissionRequestContext,
  ACPPromptStreamEvent,
  ACPPromptStreamOptions,
  ACPSessionOption,
  ACPSessionOptionChoice,
  AcpAuthBridge,
  AcpAuthMethod,
  AcpClientRequestContext,
  AcpElicitationBridge,
  AcpFsBridge,
  AcpSessionState,
  AcpTerminalBridge,
} from './types.js'
import type { ACPSessionLink, ACPSessionLinkStore } from './session-links.js'
import {
  applySessionUpdate,
  createAcpSessionState,
  seedAcpSessionState,
  withAcpSessionProcess,
} from './session-state.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('acp')

const DEFAULT_CONNECT_TIMEOUT_MS = 30000
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_MAX_BUFFERED_UPDATES = 1000
const DEFAULT_MAX_SESSION_RECORDS = 100
/**
 * 连接先断、进程还没报 exit 时,给 exit 留的一小段时间:agent 崩掉时 stdout 的 EOF 常比
 * `exit` 事件早到,等一下就能把退出码写进那句报错;真是「连接断了、进程还活着」才由连接这头收尾。
 */
const CONNECTION_CLOSED_EXIT_GRACE_MS = 250
/**
 * `session/new` 在飞时,agent 可能在我们记下它的会话 id 之前就推来通知(答复与紧随其后的
 * `available_commands_update` 同一批到,处理顺序不由我们定)。这种通知先按会话 id 暂存,
 * 记下 id 时补折;只在有会话正在开时暂存,上限防一台发疯的 agent 撑爆内存。
 */
const MAX_PARKED_UPDATES_PER_SESSION = 64
const MAX_PARKED_SESSIONS = 8

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

/** 对端答的是不是 `-32000 auth_required`(那台 agent 自己没登录)。 */
export function isAcpAuthRequired(error: unknown): boolean {
  if (error instanceof Error && error.cause !== undefined && rpcErrorShape(error) === undefined) {
    return isAcpAuthRequired(error.cause)
  }
  return rpcErrorShape(error)?.code === ACP_AUTH_REQUIRED_CODE
}

/**
 * 握手里 agent 自报的登录方法 → 契约形状。`type` 缺席按协议即 `agent`;认不出的 `type`
 * (将来的新型)不上屏 —— 我们不知道怎么跑它,画一枚按不动的钮比不画更糟。
 */
export function authMethodsOf(handshake: Pick<InitializeResponse, 'authMethods'> | null | undefined): AcpAuthMethod[] {
  const out: AcpAuthMethod[] = []
  for (const method of (handshake?.authMethods ?? []) as Array<AuthMethod & { type?: string }>) {
    if (!method || typeof method.id !== 'string' || typeof method.name !== 'string') continue
    const type = method.type === undefined || method.type === 'agent' ? 'agent' : method.type === 'terminal' ? 'terminal' : undefined
    if (!type) continue
    out.push({
      id: method.id,
      name: method.name,
      ...(method.description ? { description: method.description } : {}),
      type,
    })
  }
  return out
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
  /**
   * persona 还欠不欠这条 agent 会话(A2-a)。`session/new` 出来、`_meta` 里也没带过 → `'owed'`,
   * 第一条 prompt 把它折成头块后翻 `'delivered'`;恢复出来的会话 agent 自己有历史 → 生来就是
   * `'delivered'`。记在会话上而不是回合上:选项面板可能先把会话开出来,第一条消息才到。
   */
  persona: 'owed' | 'delivered'
}

/**
 * persona 头块(A2-a)。标签是给 agent 读的分隔符 —— 它知道这段是「你是谁」,不是用户这一轮的话。
 * 导出给测试逐字比对。
 */
export function acpPersonaBlock(persona: string): string {
  return `<persona>\n${persona.trim()}\n</persona>`
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

export class ACPClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: ClientConnection | null = null
  private connectionGeneration = {}
  private initResponse: InitializeResponse | null = null
  /** 最近一次握手的答复;断开时**不清**——连接器在下一次连上之前也要答得出这台 agent 能做什么。 */
  private lastInitResponse: InitializeResponse | null = null
  private statusValue: ACPConnectionStatus = 'disconnected'
  private errorValue: string | undefined
  /** agent 自己报的「没登录」原话(`_auth/status_update`);登录了就是 undefined。 */
  private authLabel: string | undefined
  /**
   * 此刻要不要登录(A3-c):agent 以 `-32000` 拒掉开会话 / 一轮、或 `_auth/status_update` 推「没登录」
   * 时置上;一轮成功、`authenticate` 成功、终端登录程序退出码 0 时清掉。断开不清 —— 凭据在 agent
   * 自己那里,断开重连不会让它变成登录了。
   */
  private authRequiredValue = false
  private connectedAtValue: number | undefined
  private lastUsedAtValue: number | undefined
  private sessions = new Map<string, ACPSessionRecord>()
  private sessionOpenings = new Map<string, Promise<ACPSessionRecord>>()
  private updateQueues = new Map<string, BoundedAsyncQueue<ACPPromptStreamEvent>>()
  /** acpSessionId → context of the currently streaming prompt (for permission attribution). */
  private promptContexts = new Map<string, { localSessionId: string; messageId?: string; cwd: string; abortSignal?: AbortSignal }>()
  private activePromptCountValue = 0
  /** 本地会话 id → 它在 agent 那边的会话状态(§3.3)。断开时不清:壳还要看得到「断了」。 */
  private sessionStates = new Map<string, AcpSessionState>()
  /** agent 会话 id → 本地会话 id;通知只带前者。 */
  private stateIndex = new Map<string, string>()
  private parkedUpdates = new Map<string, SessionUpdate[]>()
  private sessionStateListeners = new Set<(state: AcpSessionState) => void>()
  private agentStateListeners = new Set<(state: ACPAgentState) => void>()
  /** 上一次折进会话状态的进程三格;只有它变了才折。 */
  private lastProcessKey = ''
  /** 上一次广播出去的 agent 状态指纹(进程三格 + 登录);只有它变了才发 `agent-state`。 */
  private lastAgentKey = ''
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
      /**
       * agent 要文件时的落点(A3-b):读写走 onething 的沙箱与许可。缺席 = `fs/*` 答
       * method-not-found —— 从前那份不问沙箱、不问许可的裸实现已删,不再有「没桥就裸读」这一档。
       */
      getFsBridge?: () => AcpFsBridge | undefined
      /** agent 要终端时的落点(A3-b):命令跑在 `TerminalService` 里。缺席 = 不声明终端能力。 */
      getTerminalBridge?: () => AcpTerminalBridge | undefined
      /** 登录(A3-c)。注入了且宿主有终端才声明 `auth.terminal`;缺席 = 不声明。 */
      getAuthBridge?: () => AcpAuthBridge | undefined
      /** 提问(A3-c)。注入了才声明 `elicitation` 并挂 `elicitation/*`;缺席 = 不声明、不挂。 */
      getElicitationBridge?: () => AcpElicitationBridge | undefined
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
      capabilities: this.initResponse?.agentCapabilities
        ? this.initResponse.agentCapabilities as unknown as NonNullable<ACPAgentState['capabilities']>
        : undefined,
      sessionCount: this.sessions.size,
      activePromptCount: this.activePromptCountValue,
      ...(this.authState ? { auth: this.authState } : {}),
    }
  }

  /** 登录那一格:握手自报了方法,或者被拒过 / 被推过「没登录」,才有。 */
  private get authState(): ACPAgentState['auth'] {
    const methods = authMethodsOf(this.lastInitResponse)
    if (methods.length === 0 && !this.authRequiredValue && !this.authLabel) return undefined
    return {
      methods,
      required: this.authRequiredValue,
      ...(this.authLabel ? { label: this.authLabel } : {}),
    }
  }

  get authRequired(): boolean {
    return this.authRequiredValue
  }

  /** 改「要不要登录」只走这一处:变了就发一条 agent 状态。 */
  private setAuthRequired(required: boolean, why: string): void {
    if (this.authRequiredValue === required) return
    this.authRequiredValue = required
    if (!required) this.authLabel = undefined
    log.info('agent auth requirement changed', { agentId: this.id, required, why })
    this.syncProcess()
  }

  /**
   * 终端型登录程序退出码 0(装配层看着那一格终端):我们这边清掉「要登录」。
   * 连接由调用方断开 —— agent 进程要重读凭据,下一轮自然重连。
   */
  markAuthenticated(): void {
    this.setAuthRequired(false, 'terminal login exited 0')
  }

  /** agent 型登录:连上(握手不需要凭据),调 `authenticate({ methodId })`;成功即清「要登录」。 */
  async authenticate(methodId: string): Promise<void> {
    await this.connect()
    if (!this.connection) throw new Error('ACP connection is not available')
    try {
      await this.connection.agent.request(acp.methods.agent.authenticate, { methodId })
    } catch (error) {
      throw toAcpPromptError(error, this.config.name, this.authLabel)
    }
    this.setAuthRequired(false, `authenticate(${methodId})`)
  }

  /** 开会话 / 一轮失败:是 `auth_required` 就记下「要登录」,并换成那句人话。 */
  private noteAuthFailure(error: unknown, where: string): unknown {
    if (!isAcpAuthRequired(error)) return error
    this.setAuthRequired(true, where)
    return toAcpPromptError(error, this.config.name, this.authLabel)
  }

  /** 这台 agent 最近一次 `initialize` 的答复(未连过 = null)。连接器据它填能力表。 */
  get lastHandshake(): InitializeResponse | null {
    return this.lastInitResponse
  }

  updateConfig(config: ACPAgentConfig): void {
    this.config = config
  }

  /** 这条本地会话在 agent 那边此刻的状态;没开过为 undefined。 */
  getSessionState(localSessionId: string): AcpSessionState | undefined {
    return this.sessionStates.get(localSessionId)
  }

  /** 这条本地会话此刻是否真开在这台 agent 上(不只是留着上一次的状态)。 */
  hasLiveSession(localSessionId: string): boolean {
    return this.sessions.has(localSessionId)
  }

  onSessionStateChanged(listener: (state: AcpSessionState) => void): () => void {
    this.sessionStateListeners.add(listener)
    return () => this.sessionStateListeners.delete(listener)
  }

  onAgentStateChanged(listener: (state: ACPAgentState) => void): () => void {
    this.agentStateListeners.add(listener)
    return () => this.agentStateListeners.delete(listener)
  }

  private get processState(): AcpSessionState['process'] {
    return {
      status: this.statusValue,
      ...(this.errorValue ? { error: this.errorValue } : {}),
      ...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
    }
  }

  /**
   * 状态 / 错误 / pid 任一变了:发一条 agent 状态,再把新进程格折进每条会话状态。
   * 所有改这三格的地方改完都调这一处,别处不自己发。
   */
  private syncProcess(): void {
    const process = this.processState
    const key = `${process.status}|${process.pid ?? ''}|${process.error ?? ''}`
    const auth = this.authState
    const agentKey = `${key}|${auth ? `${auth.required}|${auth.label ?? ''}|${auth.methods.map(method => method.id).join(',')}` : ''}`
    if (agentKey !== this.lastAgentKey) {
      this.lastAgentKey = agentKey
      const agentState = this.state
      for (const listener of this.agentStateListeners) {
        try {
          listener(agentState)
        } catch (error) {
          log.warn('agent state listener failed', { agentId: this.id }, error)
        }
      }
    }
    if (key === this.lastProcessKey) return
    this.lastProcessKey = key
    for (const [localSessionId, state] of this.sessionStates) {
      this.commitSessionState(localSessionId, state, withAcpSessionProcess(state, process))
    }
  }

  /** 新旧是同一只对象就什么都不做 —— reducer 没变就原样返回,广播靠这一点跳过空帧。 */
  private commitSessionState(localSessionId: string, previous: AcpSessionState | undefined, next: AcpSessionState): void {
    if (previous === next) return
    this.sessionStates.set(localSessionId, next)
    for (const listener of this.sessionStateListeners) {
      try {
        listener(next)
      } catch (error) {
        log.warn('session state listener failed', { agentId: this.id, localSessionId }, error)
      }
    }
  }

  /**
   * 记下「这条 agent 会话属于这条本地会话」。agent 会话 id 换了(新开 / 恢复失败改开)就给一张
   * 新起点表:上一个 agent 会话留下的命令、计划不再作数。再把开会话期间暂存的通知补折进去。
   */
  private bindSessionState(localSessionId: string, acpSessionId: string): void {
    const previous = this.sessionStates.get(localSessionId)
    if (previous?.acpSessionId !== acpSessionId) {
      if (previous?.acpSessionId) this.stateIndex.delete(previous.acpSessionId)
      this.commitSessionState(localSessionId, previous, createAcpSessionState({
        localSessionId,
        agentId: this.id,
        acpSessionId,
        process: this.processState,
      }))
      this.trimSessionStates(localSessionId)
    }
    this.stateIndex.set(acpSessionId, localSessionId)
    const parked = this.parkedUpdates.get(acpSessionId)
    if (parked) {
      this.parkedUpdates.delete(acpSessionId)
      for (const update of parked) this.foldSessionUpdate(acpSessionId, update)
    }
  }

  /** 会话答复里带的初值(模式、选项)折进去。 */
  private seedSessionState(
    localSessionId: string,
    response: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null } | null | undefined,
  ): void {
    const state = this.sessionStates.get(localSessionId)
    if (!state || !response) return
    this.commitSessionState(localSessionId, state, seedAcpSessionState(state, response))
  }

  /** 任何时候收到的会话通知都先折进状态;prompt 在不在飞与此无关。 */
  private foldSessionUpdate(acpSessionId: string, update: SessionUpdate): void {
    const localSessionId = this.stateIndex.get(acpSessionId)
    const state = localSessionId ? this.sessionStates.get(localSessionId) : undefined
    if (!localSessionId || !state) {
      if (this.sessionOpenings.size > 0 && this.parkUpdate(acpSessionId, update)) return
      log.debug('session update for unknown session dropped', { agentId: this.id, acpSessionId, kind: update.sessionUpdate })
      return
    }
    this.commitSessionState(localSessionId, state, applySessionUpdate(state, update))
  }

  private parkUpdate(acpSessionId: string, update: SessionUpdate): boolean {
    let parked = this.parkedUpdates.get(acpSessionId)
    if (!parked) {
      if (this.parkedUpdates.size >= MAX_PARKED_SESSIONS) return false
      parked = []
      this.parkedUpdates.set(acpSessionId, parked)
    }
    if (parked.length >= MAX_PARKED_UPDATES_PER_SESSION) return false
    parked.push(update)
    return true
  }

  /** 状态表跟着会话记录的上限走:留着的都是还开着的,加上最近断掉的几条。 */
  private trimSessionStates(currentLocalSessionId: string): void {
    const maxRecords = Math.max(1, this.config.maxSessionRecords ?? DEFAULT_MAX_SESSION_RECORDS)
    for (const [localSessionId, state] of this.sessionStates) {
      if (this.sessionStates.size <= maxRecords) break
      if (localSessionId === currentLocalSessionId || this.sessions.has(localSessionId)) continue
      this.sessionStates.delete(localSessionId)
      if (state.acpSessionId && this.stateIndex.get(state.acpSessionId) === localSessionId) {
        this.stateIndex.delete(state.acpSessionId)
      }
    }
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
    this.syncProcess()
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
      this.syncProcess()
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
        this.syncProcess()
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
      // 能力在握手那一刻定:终端 / 终端登录要宿主有终端输出通道,提问要注入了提问桥
      // (方案 §11.3 A3-b / A3-c);声明了什么就挂什么。
      const plan = this.capabilityPlan()
      const connection = this.connection = this.createClientApp(plan).connect(stream)

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
            this.syncProcess()
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
              clientCapabilities: clientCapabilitiesFor(plan),
            }),
            childSpawnError,
          ]),
          this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
          `ACP agent "${this.config.name}" did not initialize in time`,
        )
      } finally {
        if (childSpawnErrorHandler) child.off('error', childSpawnErrorHandler)
      }
      this.lastInitResponse = this.initResponse

      child.once('error', (error) => {
        if (this.child !== child) return
        this.statusValue = 'error'
        this.errorValue = `ACP agent process error: ${error.message}`
        this.failAllQueues(error)
        this.syncProcess()
      })

      this.statusValue = 'connected'
      this.connectedAtValue = Date.now()
      this.lastUsedAtValue = Date.now()
      this.syncProcess()
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
      this.syncProcess()
      throw failure
    }
  }

  async disconnect(): Promise<void> {
    this.unexpectedExit = false
    this.failAllQueues(new Error('ACP agent disconnected'))
    this.sessions.clear()
    // 状态表留着(壳要看到「断了」),但 agent 会话 id 随连接作废:索引与暂存一起清。
    this.stateIndex.clear()
    this.parkedUpdates.clear()
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
    this.syncProcess()
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

  /** 连上并开(或恢复)这条会话,只答对应关系 —— 连接器据此落「本地会话 ↔ agent 会话」那条链接。 */
  async openLocalSession(
    localSessionId: string,
    cwd: string | undefined,
    open: ACPOpenSessionOptions = {},
  ): Promise<{ acpSessionId: string; cwd: string }> {
    await this.connect()
    const session = await this.ensureSession(localSessionId, cwd, open)
    return { acpSessionId: session.acpSessionId, cwd: session.cwd }
  }

  async *streamPrompt(options: ACPPromptStreamOptions): AsyncGenerator<ACPPromptStreamEvent, void, unknown> {
    await this.connect()
    if (!this.connection) throw new Error('ACP connection is not available')

    const session = await this.ensureSession(options.localSessionId, options.cwd, { persona: options.persona })
    if (this.updateQueues.has(session.acpSessionId)) throw new Error('An ACP prompt is already active for this session')
    // persona 只欠一次:这条 agent 会话的第一条 prompt 还它,之后(以及恢复出来的会话)不再送。
    const personaText = session.persona === 'owed' ? options.persona?.trim() : undefined
    session.persona = 'delivered'
    const queue = new BoundedAsyncQueue<ACPPromptStreamEvent>(
      Math.max(1, this.config.maxBufferedUpdates ?? DEFAULT_MAX_BUFFERED_UPDATES)
    )
    this.updateQueues.set(session.acpSessionId, queue)
    const connection = this.connection
    this.promptContexts.set(session.acpSessionId, {
      localSessionId: options.localSessionId,
      messageId: options.messageId,
      cwd: options.cwd,
      abortSignal: options.abortSignal,
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
        prompt: [
          ...(personaText ? [{ type: 'text' as const, text: acpPersonaBlock(personaText) }] : []),
          ...(options.prompt || !options.extraContent?.length ? [{ type: 'text' as const, text: options.prompt }] : []),
          ...(options.extraContent ?? []),
        ],
      }),
      this.config.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      `ACP prompt timed out for agent "${this.config.name}"`,
    )

    promptPromise
      .then((response) => {
        // 一轮走通 = agent 手里的凭据是好的。
        this.setAuthRequired(false, 'prompt succeeded')
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
        if (isAcpAuthRequired(error)) this.setAuthRequired(true, 'session/prompt')
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
   *     (回放的正文此刻没有队列接,不进任何一轮 —— onething 自己有历史,不需要第二份;
   *     命令表 / 模式这类会话状态照常折进状态表);恢复失败就退到 ③;
   *  ③ `session/new`。
   * 开出来之后按「这台 agent 上次的选择 ⊕ 这条会话里的选择」调一遍选项,再落盘。
   * 同一条会话并发来两次(选项面板 + 发送)只开一次:在飞的那一发被复用。
   */
  private async ensureSession(
    localSessionId: string,
    rawCwd: string | undefined,
    open: ACPOpenSessionOptions = {},
  ): Promise<ACPSessionRecord> {
    const cwd = resolveACPSessionCwd(rawCwd)
    const existing = this.sessions.get(localSessionId)
    if (existing && existing.cwd === cwd) {
      existing.prompts += 1
      existing.lastUsedAt = Date.now()
      return existing
    }
    const inflight = this.sessionOpenings.get(localSessionId)
    if (inflight) return inflight
    const opening = this.openSession(localSessionId, cwd, existing, open).finally(() => {
      if (this.sessionOpenings.get(localSessionId) === opening) this.sessionOpenings.delete(localSessionId)
    })
    this.sessionOpenings.set(localSessionId, opening)
    return opening
  }

  private async openSession(
    localSessionId: string,
    cwd: string,
    existing: ACPSessionRecord | undefined,
    open: ACPOpenSessionOptions = {},
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
    let opened = link && link.cwd === cwd ? await this.restoreSession(localSessionId, link.acpSessionId, cwd) : undefined
    // 恢复出来的会话 agent 自己有历史(persona 当初已经送过),不再欠。
    let persona: ACPSessionRecord['persona'] = 'delivered'
    if (!opened) {
      /**
       * `claude-agent-acp` 的怪癖(manifest `quirks.systemPromptMeta`,实测 0.81
       * `dist/acp-agent.js:6240-6252`):`session/new` 的 `_meta.systemPrompt` 给**字符串**会整个
       * 替换 Claude Code 自己的操作指令,给 `{ append }` 才是追加 —— 只用对象形。走了这一格,
       * 第一条 prompt 就不再带头块(同一段话不送两遍)。
       */
      const personaText = open.persona?.trim()
      const viaMeta = Boolean(personaText) && this.config.quirks?.systemPromptMeta === 'claude-agent-acp'
      persona = viaMeta ? 'delivered' : 'owed'
      let response: NewSessionResponse
      try {
        response = await this.connection.agent.request(acp.methods.agent.session.new, {
          cwd,
          mcpServers: (this.config.mcpServers ?? []) as unknown as acp.McpServer[],
          ...(viaMeta ? { _meta: { systemPrompt: { append: personaText } } } : {}),
        })
      } catch (error) {
        throw this.noteAuthFailure(error, 'session/new')
      }
      opened = { acpSessionId: response.sessionId, options: projectACPConfigOptions(response.configOptions) }
      this.bindSessionState(localSessionId, response.sessionId)
      this.seedSessionState(localSessionId, response)
    }

    const session: ACPSessionRecord = {
      localSessionId,
      acpSessionId: opened.acpSessionId,
      cwd,
      prompts: 1,
      lastUsedAt: Date.now(),
      options: opened.options,
      persona,
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
    localSessionId: string,
    acpSessionId: string,
    cwd: string,
  ): Promise<{ acpSessionId: string; options: ACPSessionOption[] } | undefined> {
    const connection = this.connection
    if (!connection) return undefined
    const capabilities = this.initResponse?.agentCapabilities
    const mcpServers = (this.config.mcpServers ?? []) as unknown as acp.McpServer[]
    // 恢复前就记下对应关系:`load` 期间 agent 推来的命令表 / 模式要折得进来(回放的正文照旧不进回合)。
    if (capabilities?.sessionCapabilities?.resume || capabilities?.loadSession) {
      this.bindSessionState(localSessionId, acpSessionId)
    }
    try {
      if (capabilities?.sessionCapabilities?.resume) {
        const response = await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: acpSessionId,
          cwd,
          mcpServers,
        })
        log.info('session resumed', { agentId: this.id, acpSessionId })
        this.seedSessionState(localSessionId, response)
        return { acpSessionId, options: projectACPConfigOptions(response.configOptions) }
      }
      if (capabilities?.loadSession) {
        const response = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: acpSessionId,
          cwd,
          mcpServers,
        })
        log.info('session loaded', { agentId: this.id, acpSessionId })
        this.seedSessionState(localSessionId, response)
        return { acpSessionId, options: projectACPConfigOptions(response.configOptions) }
      }
    } catch (error) {
      // 没登录也照旧退到新开:那一发会以同一个 `auth_required` 失败,由它把人话交给调用方。
      if (isAcpAuthRequired(error)) this.setAuthRequired(true, 'session restore')
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
    if (response?.configOptions) this.seedSessionState(session.localSessionId, { configOptions: response.configOptions })
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
   * 这一侧答得了的方法表(A3-b 起固定,不再按每台 agent 的开关挂):文件两条无条件挂 ——
   * 没注入文件桥的宿主(只有测试)答 method-not-found;终端五条只在宿主有终端输出通道时挂,
   * 与握手里的 `terminal` 能力同一个判据。没挂的方法 SDK 自己回 `Method not found`。
   * 扩展通知只接认得的那一条,别的 SDK 直接放过。
   */
  private createClientApp(plan: AcpClientCapabilityPlan): acp.ClientApp {
    const app = acp.client({ name: 'onething' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.requestPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.sessionUpdate(params))
      .onNotification(
        AUTH_STATUS_UPDATE_METHOD,
        (raw: unknown) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
        ({ params }) => this.extNotification(AUTH_STATUS_UPDATE_METHOD, params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => this.readTextFile(params))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => this.writeTextFile(params))
    if (plan.elicitation) {
      app
        .onRequest(acp.methods.client.elicitation.create, ({ params }) => this.createElicitation(params))
        .onNotification(acp.methods.client.elicitation.complete, ({ params }) => this.completeElicitation(params))
    }
    if (plan.terminal) {
      app
        .onRequest(acp.methods.client.terminal.create, ({ params }) => this.createTerminal(params))
        .onRequest(acp.methods.client.terminal.output, ({ params }) => this.terminalOutput(params))
        .onRequest(acp.methods.client.terminal.waitForExit, ({ params }) => this.waitForTerminalExit(params))
        .onRequest(acp.methods.client.terminal.kill, ({ params }) => this.killTerminal(params))
        .onRequest(acp.methods.client.terminal.release, ({ params }) => this.releaseTerminal(params))
    }
    return app
  }

  private terminalAvailable(): boolean {
    try {
      return this.runtimeOptions.getTerminalBridge?.()?.available() === true
    } catch (error) {
      log.warn('terminal bridge availability check failed', { agentId: this.id }, error)
      return false
    }
  }

  private authTerminalAvailable(): boolean {
    try {
      return this.runtimeOptions.getAuthBridge?.()?.terminalAvailable() === true
    } catch (error) {
      log.warn('auth bridge availability check failed', { agentId: this.id }, error)
      return false
    }
  }

  private capabilityPlan(): AcpClientCapabilityPlan {
    return {
      terminal: this.terminalAvailable(),
      authTerminal: this.authTerminalAvailable(),
      elicitation: Boolean(this.runtimeOptions.getElicitationBridge?.()),
    }
  }

  /**
   * agent 要问人(A3-c):交给提问桥落成交互卡。归属与 `fs/*` 同一个判据(在飞的 prompt,
   * 否则开着的会话);只带 `requestId`、没有会话的那种(协议里「挂在某个请求上」的一档)归不到
   * 任何一条会话,没人看得见那张卡 —— 答 `cancel`,不挂着。
   */
  private async createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const bridge = this.runtimeOptions.getElicitationBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.elicitation.create)
    const acpSessionId = typeof (params as { sessionId?: unknown }).sessionId === 'string'
      ? (params as { sessionId: string }).sessionId
      : undefined
    if (!acpSessionId) {
      log.info('elicitation without a session cancelled', { agentId: this.id, mode: params.mode })
      return { action: 'cancel' }
    }
    const context = this.requestContext(acpSessionId, 'elicitation/create')
    const abortSignal = this.promptContexts.get(acpSessionId)?.abortSignal
    return this.throughBridge('elicitation/create', () => bridge.create(
      { ...context, ...(abortSignal ? { abortSignal } : {}) },
      params,
    ))
  }

  private async completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    this.runtimeOptions.getElicitationBridge?.()?.complete(this.id, params.elicitationId)
  }

  private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const bridge = this.runtimeOptions.getPermissionBridge?.()
    if (!bridge) {
      // 没有桥 = 没人看得见卡(server / daemon / 测试)。A3-a 起缺省拒(方案 §8 拍点 2):
      // 只有用户对这一台显式打开 `unattended: 'allow'` 才放,而且只答 allow_once。
      return this.resolvePermissionFromMode(this.config.unattended === 'allow' ? 'allow' : 'reject', params)
    }

    let decision: ACPPermissionDecision
    try {
      // 回合被中止时,还挂着的审批按协议答 cancelled(A3-a):卡由引擎的 abort 拆掉,
      // 这里不等那张卡的结局,也不把「没人答」说成「拒绝」。
      decision = await raceAbort(
        bridge(this.buildPermissionContext(params)),
        this.promptContexts.get(params.sessionId)?.abortSignal,
      )
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
    mode: ACPUnattendedPolicy,
    params: RequestPermissionRequest,
  ): RequestPermissionResponse {
    // 自动答永远只挑「一次」那格:自动选 allow_always / reject_always 等于替用户在 agent 那边
    // 落了一条长期规则,而用户根本没看见卡。没有「一次」那格就答 cancelled
    // —— 绝不退到 options[0](那可能是反方向,也可能是 always)。
    if (mode === 'reject') {
      const reject = params.options.find(option => option.kind === 'reject_once')
      if (!reject) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    }

    const allow = params.options.find(option => option.kind === 'allow_once')
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
      ...(this.config.unattended ? { unattended: this.config.unattended } : {}),
      localSessionId: promptContext?.localSessionId ?? sessionRecord?.localSessionId,
      messageId: promptContext?.messageId,
      cwd: promptContext?.cwd ?? sessionRecord?.cwd,
      toolCall: toolCall
        ? {
            toolCallId: toolCall.toolCallId,
            title: toolCall.title ?? undefined,
            kind: toolCall.kind ?? undefined,
            rawInput: toolCall.rawInput,
            ...(toolCall.locations?.length
              ? { locations: toolCall.locations.map(location => ({ path: location.path, ...(location.line != null ? { line: location.line } : {}) })) }
              : {}),
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
      // agent 自己说了算:推「没登录」就要登录,推别的(已登录的身份)就不要。
      if (kind) this.setAuthRequired(kind === 'none', '_auth/status_update')
      else this.syncProcess()
      return
    }
    log.debug('agent extension notification ignored', { agentId: this.id, method })
  }

  /**
   * 先折状态,再看有没有在飞的 prompt 队列 —— 顺序不能反:不在 prompt 期间推来的通知
   * (`session/new` 之后的命令表、空闲时的用量)从前在「没有队列」那一步就被扔掉了。
   */
  private async sessionUpdate(params: SessionNotification): Promise<void> {
    this.foldSessionUpdate(params.sessionId, params.update)
    const queue = this.updateQueues.get(params.sessionId)
    if (!queue) return
    queue.push({ type: 'update', notification: params })
  }

  /**
   * `fs/*` / `terminal/*` 请求的归属:在飞 prompt 的那条本地会话,没有就找开着的会话记录。
   * 两处都找不到 = 这条请求归不到任何一条会话,没人看得见那张卡 —— 当场拒,不交给桥。
   */
  private requestContext(acpSessionId: string, method: string): AcpClientRequestContext {
    const promptContext = this.promptContexts.get(acpSessionId)
    const sessionRecord = promptContext
      ? undefined
      : Array.from(this.sessions.values()).find(record => record.acpSessionId === acpSessionId)
    const localSessionId = promptContext?.localSessionId ?? sessionRecord?.localSessionId
    const cwd = promptContext?.cwd ?? sessionRecord?.cwd
    if (!localSessionId || !cwd) {
      throw new acp.RequestError(-32603, `onething refused ${method}: session ${acpSessionId} is not attached to any onething session.`)
    }
    return {
      agentId: this.config.id,
      agentName: this.config.name,
      localSessionId,
      ...(promptContext?.messageId ? { messageId: promptContext.messageId } : {}),
      cwd: resolveACPSessionCwd(cwd),
      ...(this.config.unattended ? { unattended: this.config.unattended } : {}),
    }
  }

  private async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const bridge = this.runtimeOptions.getFsBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.fs.readTextFile)
    const context = this.requestContext(params.sessionId, 'fs/read_text_file')
    return this.throughBridge('fs/read_text_file', () => bridge.readTextFile(context, {
      path: params.path,
      line: params.line ?? null,
      limit: params.limit ?? null,
    }))
  }

  private async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const bridge = this.runtimeOptions.getFsBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.fs.writeTextFile)
    const context = this.requestContext(params.sessionId, 'fs/write_text_file')
    await this.throughBridge('fs/write_text_file', () => bridge.writeTextFile(context, {
      path: params.path,
      content: params.content,
    }))
    return {}
  }

  private terminalBridge(method: string): AcpTerminalBridge {
    const bridge = this.runtimeOptions.getTerminalBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(method)
    return bridge
  }

  private async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.create)
    const context = this.requestContext(params.sessionId, 'terminal/create')
    const env = Object.fromEntries((params.env ?? []).map(item => [item.name, item.value]))
    return this.throughBridge('terminal/create', () => bridge.create(context, {
      command: params.command,
      ...(params.args ? { args: params.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      cwd: params.cwd ?? null,
      outputByteLimit: params.outputByteLimit ?? null,
    }))
  }

  private async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.output)
    const context = this.requestContext(params.sessionId, 'terminal/output')
    const answer = await this.throughBridge('terminal/output', () => bridge.output(context, { terminalId: params.terminalId }))
    return { output: answer.output, truncated: answer.truncated, exitStatus: answer.exitStatus ?? null }
  }

  private async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.waitForExit)
    const context = this.requestContext(params.sessionId, 'terminal/wait_for_exit')
    return this.throughBridge('terminal/wait_for_exit', () => bridge.waitForExit(context, { terminalId: params.terminalId }))
  }

  private async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.kill)
    const context = this.requestContext(params.sessionId, 'terminal/kill')
    await this.throughBridge('terminal/kill', () => bridge.kill(context, { terminalId: params.terminalId }))
    return {}
  }

  private async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.release)
    const context = this.requestContext(params.sessionId, 'terminal/release')
    await this.throughBridge('terminal/release', () => bridge.release(context, { terminalId: params.terminalId }))
    return {}
  }

  /**
   * 桥抛的错 → JSON-RPC 错误。文件不存在答 `-32002 resource_not_found`(协议给的那一格);
   * 其余(拒绝、越限、找不到终端)答 `-32603`,message 就是桥写给 agent 的那句人话。
   * 不用 `-32000`:那是 ACP 的 `auth_required`,agent 会把一次拒绝读成「要重新登录」。
   */
  private async throughBridge<T>(method: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      if (error instanceof acp.RequestError) throw error
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      const message = error instanceof Error ? error.message : String(error)
      log.info('client request refused', { agentId: this.id, method, code, message })
      if (code === 'ENOENT') throw new acp.RequestError(-32002, message)
      throw new acp.RequestError(-32603, message)
    }
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
    this.trimSessionStates(currentLocalSessionId)
  }

  private failAllQueues(error: Error): void {
    for (const queue of this.updateQueues.values()) {
      queue.error(error)
    }
    this.updateQueues.clear()
    this.promptContexts.clear()
    this.activePromptCountValue = 0
  }
}

/** 桥的答案与回合的中止信号赛跑;先中止 = `cancel`。 */
function raceAbort(
  pending: Promise<ACPPermissionDecision>,
  signal: AbortSignal | undefined,
): Promise<ACPPermissionDecision> {
  if (!signal) return pending
  if (signal.aborted) return Promise.resolve({ behavior: 'cancel' })
  return new Promise<ACPPermissionDecision>((resolve, reject) => {
    const onAbort = () => resolve({ behavior: 'cancel' })
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/** 握手那一刻「这台宿主有什么」:三格各自一个判据,声明与挂方法读的是同一份。 */
export interface AcpClientCapabilityPlan {
  /** 终端桥在且宿主有终端输出通道。 */
  terminal: boolean
  /** 登录桥在且宿主有终端可跑登录程序。 */
  authTerminal: boolean
  /** 提问桥在。 */
  elicitation: boolean
}

/**
 * 我们对 agent 声明的客户端能力(A3-b 起固定:能力是 onething 有什么,不是每台 agent 一个开关)。
 * 文件两条恒声明;终端只在宿主有终端输出通道时声明;`auth.terminal` 只在登录桥在且有终端时声明;
 * `elicitation` 只在提问桥在时声明(A3-c)—— 声明了却答 method-not-found 比不声明更糟。
 * claude-agent-acp 只在看到 `elicitation.form` 时才把 AskUserQuestion 发成表单,否则退化成一次审批。
 */
export function clientCapabilitiesFor(plan: AcpClientCapabilityPlan): acp.ClientCapabilities {
  return {
    fs: { readTextFile: true, writeTextFile: true },
    ...(plan.terminal ? { terminal: true } : {}),
    ...(plan.authTerminal ? { auth: { terminal: true } } : {}),
    ...(plan.elicitation ? { elicitation: { form: {}, url: {} } } : {}),
    session: { configOptions: {}, notices: {}, compaction: {} },
    plan: {},
  }
}
