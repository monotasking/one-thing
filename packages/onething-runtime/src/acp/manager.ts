import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPPermissionBridge,
  AcpAuthBridge,
  AcpElicitationBridge,
  AcpFsBridge,
  AcpTerminalBridge,
  ACPPromptStreamEvent,
  ACPPromptStreamOptions,
  ACPOpenSessionOptions,
  ACPSessionOption,
  ACPSessionOptionsSnapshot,
  ACPSettings,
  AcpSessionState,
} from './types.js'
import type { InitializeResponse } from '@agentclientprotocol/sdk'
import { ACPClient } from './client.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from './session-links.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('acp')

class ACPManagerClass {
  private clients = new Map<string, ACPClient>()
  private settings: ACPSettings = { enabled: true, agents: [] }
  private cleanupTimer: NodeJS.Timeout | null = null
  private permissionBridge: ACPPermissionBridge | undefined
  private fsBridge: AcpFsBridge | undefined
  private terminalBridge: AcpTerminalBridge | undefined
  private authBridge: AcpAuthBridge | undefined
  private elicitationBridge: AcpElicitationBridge | undefined
  /** 会话对应关系落盘处(缺省 `<store>/acp/session-links.json`);测试换成内存那只。 */
  private sessionLinks: ACPSessionLinkStore = new FileACPSessionLinkStore()
  private spawnEnv: (() => Record<string, string | undefined>) | undefined
  private sessionStateListeners = new Set<(state: AcpSessionState) => void>()
  private agentStateListeners = new Set<(state: ACPAgentState) => void>()
  /** 每只客户端上挂的那两条转发;客户端被摘时连同它们一起摘。 */
  private clientUnsubscribers = new Map<string, () => void>()
  /**
   * 旧 agent id → 现 id(A1-a:`codex-cli` → `codex` 这类改名,数据来自种子的 `aliases`,
   * 由装配层的名册递进来)。老会话、老的模型选择里记着旧 id,照样认到那一台。
   */
  private agentAliases = new Map<string, string>()

  setAgentAliases(aliases: Record<string, string>): void {
    this.agentAliases = new Map(Object.entries(aliases))
  }

  /**
   * 旧 id 认回现 id(公开的那一面,A4-b):装配层按 agent 签桥凭据、按 agent 作废,两头要是同一个 id
   * —— 作废时拿到的是连接状态里的现 id,签的时候就不能用会话里记着的旧 id。
   */
  canonicalAgentId(agentId: string): string {
    return this.resolveAgentId(agentId)
  }

  /** 旧 id 认回现 id;现在的名册里真有这个 id 时以它为准(用户可能新建了同名条目)。 */
  private resolveAgentId(agentId: string): string {
    if (this.settings.agents.some(agent => agent.id === agentId) || this.clients.has(agentId)) return agentId
    return this.agentAliases.get(agentId) ?? agentId
  }

  /**
   * 任一台 agent 上任一条会话的状态变了(§3.3)。装配层订这里再 `emitGlobal`;产品层不认识总线。
   * 返回退订函数。
   */
  onSessionStateChanged(listener: (state: AcpSessionState) => void): () => void {
    this.sessionStateListeners.add(listener)
    return () => this.sessionStateListeners.delete(listener)
  }

  /** 任一台 agent 的连接状态(状态 / pid / 错误)变了。 */
  onAgentStateChanged(listener: (state: ACPAgentState) => void): () => void {
    this.agentStateListeners.add(listener)
    return () => this.agentStateListeners.delete(listener)
  }

  /**
   * 这条本地会话在 agent 那边的状态。指定了 agent 就只问那一台;没指定就找正开着它的那台,
   * 都没开着就退回任一台留着的上一份(断开之后壳仍要看得到「断了」)。
   */
  getSessionState(localSessionId: string, agentId?: string): AcpSessionState | undefined {
    if (agentId) return this.clients.get(this.resolveAgentId(agentId))?.getSessionState(localSessionId)
    let fallback: AcpSessionState | undefined
    for (const client of this.clients.values()) {
      const state = client.getSessionState(localSessionId)
      if (!state) continue
      if (client.hasLiveSession(localSessionId)) return state
      fallback ??= state
    }
    return fallback
  }

  private fanOut<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of listeners) {
      try {
        listener(value)
      } catch (error) {
        log.warn('acp state listener failed', {}, error)
      }
    }
  }

  /**
   * Host registers its interactive permission surface here (Electron →
   * Permission.ask). Applies to existing and future clients; unset it to
   * fall back to config-driven auto resolution.
   */
  setPermissionBridge(bridge: ACPPermissionBridge | undefined): void {
    this.permissionBridge = bridge
  }

  /**
   * 子进程环境的来源(2026-09-24,用户:「而且没有走代理」)。宿主递进来的是**它**的
   * 那一份(桌面 = 进程环境 + 应用代理 → `HTTPS_PROXY` / `NO_PROXY`,与 Claude Code
   * SDK 那条外部 agent 通路同一个函数);缺席 = 只继承进程环境(旧行为)。每次 spawn 时
   * 现读,所以改了代理之后**新起的**适配器就走新代理。
   */
  setSpawnEnvProvider(provider: (() => Record<string, string | undefined>) | undefined): void {
    this.spawnEnv = provider
  }

  /**
   * agent 要文件 / 要终端时的落点(A3-b)。与权限桥同一种晚绑定:已有的客户端下一次请求就用上;
   * 缺席 = 那几个方法答 method-not-found(文件能力照样声明;终端能力只在终端桥在、且宿主有
   * 终端输出通道时声明,见 `ACPClient.createClientApp`)。
   */
  setFsBridge(bridge: AcpFsBridge | undefined): void {
    this.fsBridge = bridge
  }

  getFsBridge(): AcpFsBridge | undefined {
    return this.fsBridge
  }

  setTerminalBridge(bridge: AcpTerminalBridge | undefined): void {
    this.terminalBridge = bridge
  }

  getTerminalBridge(): AcpTerminalBridge | undefined {
    return this.terminalBridge
  }

  /**
   * 登录与提问的落点(A3-c)。同一种晚绑定;但它们改的是**握手里的声明**,所以只对下一次连上
   * 的那一台生效(已连着的 agent 在握手时没看见它们)。
   */
  setAuthBridge(bridge: AcpAuthBridge | undefined): void {
    this.authBridge = bridge
  }

  getAuthBridge(): AcpAuthBridge | undefined {
    return this.authBridge
  }

  setElicitationBridge(bridge: AcpElicitationBridge | undefined): void {
    this.elicitationBridge = bridge
  }

  getElicitationBridge(): AcpElicitationBridge | undefined {
    return this.elicitationBridge
  }

  /** agent 型登录:连上那一台、调它的 `authenticate`。 */
  async authenticateAgent(agentId: string, methodId: string): Promise<ACPAgentState> {
    const client = this.usableClient(agentId)
    await client.authenticate(methodId)
    return client.state
  }

  /** 终端型登录程序退出码 0:清掉那一台的「要登录」(连接由调用方断开)。 */
  markAgentAuthenticated(agentId: string): void {
    this.clients.get(this.resolveAgentId(agentId))?.markAuthenticated()
  }

  setSessionLinkStore(store: ACPSessionLinkStore): void {
    this.sessionLinks = store
  }

  /**
   * 链接表只能有**一个实例**:文件那只读一次进内存,两个实例各写各的就会互相覆盖。
   * 外部 agent 的装配层(Claude 路的链接)从这里拿同一只,而不是自己再 new 一只。
   */
  getSessionLinkStore(): ACPSessionLinkStore {
    return this.sessionLinks
  }

  /** 这台 agent 最近一次握手的答复;没连过为 undefined。只读,不起进程。 */
  getAgentHandshake(agentId: string): InitializeResponse | undefined {
    return this.clients.get(this.resolveAgentId(agentId))?.lastHandshake ?? undefined
  }

  /** 连上 agent 并开(或恢复)这条会话,答 agent 侧的会话 id。 */
  async openSession(
    agentId: string,
    localSessionId: string,
    cwd: string | undefined,
    open: ACPOpenSessionOptions = {},
  ): Promise<{ acpSessionId: string; cwd: string }> {
    return this.usableClient(agentId).openLocalSession(localSessionId, cwd, open)
  }

  /**
   * 连上并握手,不开会话(A2-a)。连接器在读 `capabilitiesFor` 之前调它 —— 否则第一条消息
   * 读到的是握手前的保守能力,带图的首轮会被说成「送不出」。与开会话同一道开关判断:
   * 被停用的 agent 不会因为这一步被拉起来。
   */
  async prepareAgent(agentId: string): Promise<void> {
    await this.usableClient(agentId).connect()
  }

  /**
   * 选择器右栏要画的那几格。有会话 id → 连上 agent、开(或恢复)那条会话,答它的真
   * 选项;草稿态(还没有会话)→ 不起进程,答这台 agent 上次见到的目录,当前值用
   * 上次选过的(`live: false`,屏上据此说「发第一条消息后生效」)。
   */
  async getSessionOptions(
    agentId: string,
    localSessionId: string | undefined,
    cwd: string | undefined,
  ): Promise<ACPSessionOptionsSnapshot> {
    agentId = this.resolveAgentId(agentId)
    const client = this.getOrCreateClient(agentId)
    if (!localSessionId) return { options: this.draftOptions(agentId), live: false }
    return { options: await client.getSessionOptions(localSessionId, cwd), live: true }
  }

  async setSessionOption(
    agentId: string,
    localSessionId: string | undefined,
    cwd: string | undefined,
    optionId: string,
    value: string,
  ): Promise<ACPSessionOptionsSnapshot> {
    agentId = this.resolveAgentId(agentId)
    const client = this.getOrCreateClient(agentId)
    if (localSessionId) {
      return { options: await client.setSessionOption(localSessionId, cwd, optionId, value), live: true }
    }
    const profile = this.sessionLinks.getProfile(agentId)
    this.sessionLinks.putProfile({
      agentId,
      preferred: { ...(profile?.preferred ?? {}), [optionId]: value },
      ...(profile?.catalog ? { catalog: profile.catalog } : {}),
      updatedAt: Date.now(),
    })
    return { options: this.draftOptions(agentId), live: false }
  }

  private draftOptions(agentId: string): ACPSessionOption[] {
    const profile = this.sessionLinks.getProfile(agentId)
    const preferred = profile?.preferred ?? {}
    return (profile?.catalog ?? []).map(option => {
      const wanted = preferred[option.id]
      return wanted && option.choices.some(choice => choice.value === wanted)
        ? { ...option, currentValue: wanted }
        : option
    })
  }

  getPermissionBridge(): ACPPermissionBridge | undefined {
    return this.permissionBridge
  }

  initialize(settings: ACPSettings): void {
    this.settings = settings
    this.syncClients(settings.agents)
    this.ensureCleanupTimer()
  }

  updateSettings(settings: ACPSettings): void {
    this.settings = settings
    this.syncClients(settings.agents)
    this.ensureCleanupTimer()
  }

  getSettings(): ACPSettings {
    return {
      ...this.settings,
      agents: this.settings.agents.map(agent => ({ ...agent, args: [...(agent.args ?? [])], env: agent.env ? { ...agent.env } : undefined })),
    }
  }

  getAgentStates(): ACPAgentState[] {
    const states: ACPAgentState[] = []
    const seen = new Set<string>()

    for (const config of this.settings.agents) {
      seen.add(config.id)
      const client = this.clients.get(config.id)
      states.push(client?.state ?? {
        config,
        status: 'disconnected',
        sessionCount: 0,
        activePromptCount: 0,
      })
    }

    for (const [id, client] of this.clients.entries()) {
      if (!seen.has(id)) states.push(client.state)
    }

    return states
  }

  getAgentState(agentId: string): ACPAgentState | undefined {
    agentId = this.resolveAgentId(agentId)
    const client = this.clients.get(agentId)
    if (client) return client.state

    const config = this.settings.agents.find(agent => agent.id === agentId)
    if (!config) return undefined
    return {
      config,
      status: 'disconnected',
      sessionCount: 0,
      activePromptCount: 0,
    }
  }

  async connectAgent(agentId: string): Promise<ACPAgentState> {
    const client = this.getOrCreateClient(agentId)
    await client.connect()
    return client.state
  }

  async disconnectAgent(agentId: string): Promise<void> {
    const client = this.clients.get(this.resolveAgentId(agentId))
    if (client) await client.disconnect()
  }

  async refreshAgent(agentId: string): Promise<ACPAgentState> {
    const client = this.getOrCreateClient(agentId)
    await client.refresh()
    return client.state
  }

  async cancelSession(localSessionId: string, agentId?: string): Promise<void> {
    const targets = agentId ? [this.clients.get(this.resolveAgentId(agentId))] : Array.from(this.clients.values())
    await Promise.allSettled(targets.filter(Boolean).map(client => client!.cancelLocalSession(localSessionId)))
  }

  async *streamPrompt(agentId: string, options: ACPPromptStreamOptions): AsyncGenerator<ACPPromptStreamEvent, void, unknown> {
    yield* this.usableClient(agentId).streamPrompt(options)
  }

  /** 总开关与单台开关都开着才给出客户端;开会话与发 prompt 走同一道判断。 */
  private usableClient(agentId: string): ACPClient {
    if (this.settings.enabled === false) {
      throw new Error('ACP is disabled in settings')
    }
    const client = this.getOrCreateClient(agentId)
    if (client.state.config.enabled === false) {
      throw new Error(`ACP agent "${agentId}" is disabled`)
    }
    return client
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    await Promise.allSettled(Array.from(this.clients.values()).map(client => client.disconnect()))
    for (const unsubscribe of this.clientUnsubscribers.values()) unsubscribe()
    this.clientUnsubscribers.clear()
    this.clients.clear()
  }

  private syncClients(configs: ACPAgentConfig[]): void {
    const ids = new Set(configs.map(config => config.id))
    for (const [id, client] of this.clients.entries()) {
      if (!ids.has(id)) {
        // 断开那一下的状态照常转发出去,之后再摘转发。
        const unsubscribe = this.clientUnsubscribers.get(id)
        this.clientUnsubscribers.delete(id)
        client.disconnect()
          .catch(error => log.warn('removed agent disconnect failed', { agentId: id }, error))
          .finally(() => unsubscribe?.())
        this.clients.delete(id)
      }
    }

    for (const config of configs) {
      const existing = this.clients.get(config.id)
      if (existing) {
        const oldConfig = existing.state.config
        existing.updateConfig(config)
        if (JSON.stringify(oldConfig) !== JSON.stringify(config) && existing.status === 'connected') {
          existing.disconnect().catch(error => log.warn('changed agent reconnect failed', { agentId: config.id }, error))
        }
      }
    }
  }

  private getOrCreateClient(agentId: string): ACPClient {
    agentId = this.resolveAgentId(agentId)
    const existing = this.clients.get(agentId)
    if (existing) return existing

    const config = this.settings.agents.find(agent => agent.id === agentId)
    if (!config) throw new Error(`ACP agent "${agentId}" not found`)

    const client = new ACPClient(config, {
      getPermissionBridge: () => this.permissionBridge,
      getSessionLinks: () => this.sessionLinks,
      getSpawnEnv: () => this.spawnEnv?.(),
      getFsBridge: () => this.fsBridge,
      getTerminalBridge: () => this.terminalBridge,
      getAuthBridge: () => this.authBridge,
      getElicitationBridge: () => this.elicitationBridge,
    })
    const offSession = client.onSessionStateChanged(state => this.fanOut(this.sessionStateListeners, state))
    const offAgent = client.onAgentStateChanged(state => this.fanOut(this.agentStateListeners, state))
    this.clientUnsubscribers.set(agentId, () => {
      offSession()
      offAgent()
    })
    this.clients.set(agentId, client)
    return client
  }

  private ensureCleanupTimer(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const client of this.clients.values()) {
        if (client.status !== 'connected') continue
        if (client.activePromptCount > 0) continue
        const lastUsedAt = client.lastUsedAt
        if (!lastUsedAt) continue
        if (now - lastUsedAt > client.idleTimeoutMs) {
          client.disconnect().catch(error => log.warn('idle disconnect failed', { agentId: client.id }, error))
        }
      }
    }, 60 * 1000)
    this.cleanupTimer.unref?.()
  }
}

export const ACPManager = new ACPManagerClass()
