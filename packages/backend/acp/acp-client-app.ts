// 给 SDK 的客户端回调面(2026-10-04 从 `ACPClient` 拆出,拆分批 3,D227):这一侧答得了的方法表,以及每一条
// agent → onething 的请求怎么落到宿主的桥上 —— 审批、提问、`fs/*`、`terminal/*`。连接 ↔ 会话 ↔ 提示那台
// 状态机仍在 `acp-client.ts`;回调面向它要的东西写成 `AcpClientAppPort`,每一格在调用那一刻回客户端取
// (配置会被 `updateConfig` 换掉,桥是晚绑定的)。方法正文原样,只把读客户端字段的地方改读端口。
import * as acp from '@agentclientprotocol/sdk'
import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type {
  ACPPermissionBridge,
  ACPPermissionDecision,
  ACPPermissionRequestContext,
  AcpAuthBridge,
  AcpClientRequestContext,
  AcpElicitationBridge,
  AcpFsBridge,
  AcpTerminalBridge,
} from './acp-types.js'
import type { ACPAgentConfig, ACPUnattendedPolicy } from '@shared/contracts/acp.js'
import { getLogger } from '../logging/logging.js'

const log = getLogger('acp')

/** claude-agent-acp 推登录状态用的扩展通知。 */
export const AUTH_STATUS_UPDATE_METHOD = '_auth/status_update'

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

/** 宿主注入的几座桥(都是晚绑定的取值器:后注册的桥照样取得到,撤掉的桥立刻不再用)。 */
export interface AcpClientAppBridges {
  getPermissionBridge?: () => ACPPermissionBridge | undefined
  getFsBridge?: () => AcpFsBridge | undefined
  getTerminalBridge?: () => AcpTerminalBridge | undefined
  getAuthBridge?: () => AcpAuthBridge | undefined
  getElicitationBridge?: () => AcpElicitationBridge | undefined
}

/** 回调面向客户端要的东西:每一格都在调用那一刻回客户端取。 */
export interface AcpClientAppPort {
  /** 这台 agent 此刻的配置。 */
  config(): ACPAgentConfig
  bridges(): AcpClientAppBridges
  /** 这条 agent 会话此刻在飞的那一轮 prompt(没有 = undefined)。 */
  promptContext(acpSessionId: string): { localSessionId: string; messageId?: string; cwd: string; abortSignal?: AbortSignal } | undefined
  /** 开着的会话记录。 */
  sessionRecords(): Iterable<{ acpSessionId: string; localSessionId: string; cwd: string }>
  /** `fs/*` / `terminal/*` / 提问请求归哪条本地会话(归不到就抛)。 */
  requestContext(acpSessionId: string, method: string): AcpClientRequestContext
  /** `session/update` 通知:折进会话状态、交给在飞的那一轮。 */
  sessionUpdate(params: SessionNotification): Promise<void>
  /** 扩展通知(方法名以 `_` 起头)。 */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>
}

export class AcpClientApp {
  constructor(private readonly port: AcpClientAppPort) {}

  /**
   * 这一侧答得了的方法表(A3-b 起固定,不再按每台 agent 的开关挂):文件两条无条件挂 ——
   * 没注入文件桥的宿主(只有测试)答 method-not-found;终端五条只在宿主有终端输出通道时挂,
   * 与握手里的 `terminal` 能力同一个判据。没挂的方法 SDK 自己回 `Method not found`。
   * 扩展通知只接认得的那一条,别的 SDK 直接放过。
   */
  createClientApp(plan: AcpClientCapabilityPlan): acp.ClientApp {
    const app = acp.client({ name: 'onething' })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.requestPermission(params))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.port.sessionUpdate(params))
      .onNotification(
        AUTH_STATUS_UPDATE_METHOD,
        (raw: unknown) => (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}),
        ({ params }) => this.port.extNotification(AUTH_STATUS_UPDATE_METHOD, params),
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
      return this.port.bridges().getTerminalBridge?.()?.available() === true
    } catch (error) {
      log.warn('terminal bridge availability check failed', { agentId: this.port.config().id }, error)
      return false
    }
  }

  private authTerminalAvailable(): boolean {
    try {
      return this.port.bridges().getAuthBridge?.()?.terminalAvailable() === true
    } catch (error) {
      log.warn('auth bridge availability check failed', { agentId: this.port.config().id }, error)
      return false
    }
  }

  capabilityPlan(): AcpClientCapabilityPlan {
    return {
      terminal: this.terminalAvailable(),
      authTerminal: this.authTerminalAvailable(),
      elicitation: Boolean(this.port.bridges().getElicitationBridge?.()),
    }
  }

  /**
   * agent 要问人(A3-c):交给提问桥落成交互卡。归属与 `fs/*` 同一个判据(在飞的 prompt,
   * 否则开着的会话);只带 `requestId`、没有会话的那种(协议里「挂在某个请求上」的一档)归不到
   * 任何一条会话,没人看得见那张卡 —— 答 `cancel`,不挂着。
   */
  private async createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const bridge = this.port.bridges().getElicitationBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.elicitation.create)
    const acpSessionId = typeof (params as { sessionId?: unknown }).sessionId === 'string'
      ? (params as { sessionId: string }).sessionId
      : undefined
    if (!acpSessionId) {
      log.info('elicitation without a session cancelled', { agentId: this.port.config().id, mode: params.mode })
      return { action: 'cancel' }
    }
    const context = this.port.requestContext(acpSessionId, 'elicitation/create')
    const abortSignal = this.port.promptContext(acpSessionId)?.abortSignal
    return this.throughBridge('elicitation/create', () => bridge.create(
      { ...context, ...(abortSignal ? { abortSignal } : {}) },
      params,
    ))
  }

  private async completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    this.port.bridges().getElicitationBridge?.()?.complete(this.port.config().id, params.elicitationId)
  }

  private async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const bridge = this.port.bridges().getPermissionBridge?.()
    if (!bridge) {
      // 没有桥 = 没人看得见卡(server / daemon / 测试)。A3-a 起缺省拒(方案 §8 拍点 2):
      // 只有用户对这一台显式打开 `unattended: 'allow'` 才放,而且只答 allow_once。
      return this.resolvePermissionFromMode(this.port.config().unattended === 'allow' ? 'allow' : 'reject', params)
    }

    let decision: ACPPermissionDecision
    try {
      // 回合被中止时,还挂着的审批按协议答 cancelled(A3-a):卡由引擎的 abort 拆掉,
      // 这里不等那张卡的结局,也不把「没人答」说成「拒绝」。
      decision = await raceAbort(
        bridge(this.buildPermissionContext(params)),
        this.port.promptContext(params.sessionId)?.abortSignal,
      )
    } catch (error) {
      log.warn('permission bridge failed, rejecting request', { agentId: this.port.config().id }, error)
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
    const promptContext = this.port.promptContext(params.sessionId)
    const sessionRecord = promptContext
      ? undefined
      : Array.from(this.port.sessionRecords()).find(record => record.acpSessionId === params.sessionId)
    const toolCall = params.toolCall
    return {
      agentId: this.port.config().id,
      agentName: this.port.config().name,
      ...(this.port.config().unattended ? { unattended: this.port.config().unattended } : {}),
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

  private async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const bridge = this.port.bridges().getFsBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.fs.readTextFile)
    const context = this.port.requestContext(params.sessionId, 'fs/read_text_file')
    return this.throughBridge('fs/read_text_file', () => bridge.readTextFile(context, {
      path: params.path,
      line: params.line ?? null,
      limit: params.limit ?? null,
    }))
  }

  private async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const bridge = this.port.bridges().getFsBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(acp.methods.client.fs.writeTextFile)
    const context = this.port.requestContext(params.sessionId, 'fs/write_text_file')
    await this.throughBridge('fs/write_text_file', () => bridge.writeTextFile(context, {
      path: params.path,
      content: params.content,
    }))
    return {}
  }

  private terminalBridge(method: string): AcpTerminalBridge {
    const bridge = this.port.bridges().getTerminalBridge?.()
    if (!bridge) throw acp.RequestError.methodNotFound(method)
    return bridge
  }

  private async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.create)
    const context = this.port.requestContext(params.sessionId, 'terminal/create')
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
    const context = this.port.requestContext(params.sessionId, 'terminal/output')
    const answer = await this.throughBridge('terminal/output', () => bridge.output(context, { terminalId: params.terminalId }))
    return { output: answer.output, truncated: answer.truncated, exitStatus: answer.exitStatus ?? null }
  }

  private async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.waitForExit)
    const context = this.port.requestContext(params.sessionId, 'terminal/wait_for_exit')
    return this.throughBridge('terminal/wait_for_exit', () => bridge.waitForExit(context, { terminalId: params.terminalId }))
  }

  private async killTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.kill)
    const context = this.port.requestContext(params.sessionId, 'terminal/kill')
    await this.throughBridge('terminal/kill', () => bridge.kill(context, { terminalId: params.terminalId }))
    return {}
  }

  private async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    const bridge = this.terminalBridge(acp.methods.client.terminal.release)
    const context = this.port.requestContext(params.sessionId, 'terminal/release')
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
      log.info('client request refused', { agentId: this.port.config().id, method, code, message })
      if (code === 'ENOENT') throw new acp.RequestError(-32002, message)
      throw new acp.RequestError(-32603, message)
    }
  }
}
