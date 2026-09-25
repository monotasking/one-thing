import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPPermissionBridge,
  ACPPromptStreamEvent,
  ACPPromptStreamOptions,
  ACPSessionOption,
  ACPSessionOptionsSnapshot,
  ACPSettings,
} from './types.js'
import { ACPClient } from './client.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from './session-links.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('acp')

class ACPManagerClass {
  private clients = new Map<string, ACPClient>()
  private settings: ACPSettings = { enabled: true, agents: [] }
  private cleanupTimer: NodeJS.Timeout | null = null
  private permissionBridge: ACPPermissionBridge | undefined
  /** 会话对应关系落盘处(缺省 `<store>/acp/session-links.json`);测试换成内存那只。 */
  private sessionLinks: ACPSessionLinkStore = new FileACPSessionLinkStore()
  private spawnEnv: (() => Record<string, string | undefined>) | undefined

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

  setSessionLinkStore(store: ACPSessionLinkStore): void {
    this.sessionLinks = store
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
    const client = this.clients.get(agentId)
    if (client) await client.disconnect()
  }

  async refreshAgent(agentId: string): Promise<ACPAgentState> {
    const client = this.getOrCreateClient(agentId)
    await client.refresh()
    return client.state
  }

  async cancelSession(localSessionId: string, agentId?: string): Promise<void> {
    const targets = agentId ? [this.clients.get(agentId)] : Array.from(this.clients.values())
    await Promise.allSettled(targets.filter(Boolean).map(client => client!.cancelLocalSession(localSessionId)))
  }

  async *streamPrompt(agentId: string, options: ACPPromptStreamOptions): AsyncGenerator<ACPPromptStreamEvent, void, unknown> {
    if (this.settings.enabled === false) {
      throw new Error('ACP is disabled in settings')
    }
    const client = this.getOrCreateClient(agentId)
    if (client.state.config.enabled === false) {
      throw new Error(`ACP agent "${agentId}" is disabled`)
    }
    yield* client.streamPrompt(options)
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    await Promise.allSettled(Array.from(this.clients.values()).map(client => client.disconnect()))
    this.clients.clear()
  }

  private syncClients(configs: ACPAgentConfig[]): void {
    const ids = new Set(configs.map(config => config.id))
    for (const [id, client] of this.clients.entries()) {
      if (!ids.has(id)) {
        client.disconnect().catch(error => log.warn('removed agent disconnect failed', { agentId: id }, error))
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
    const existing = this.clients.get(agentId)
    if (existing) return existing

    const config = this.settings.agents.find(agent => agent.id === agentId)
    if (!config) throw new Error(`ACP agent "${agentId}" not found`)

    const client = new ACPClient(config, {
      getPermissionBridge: () => this.permissionBridge,
      getSessionLinks: () => this.sessionLinks,
      getSpawnEnv: () => this.spawnEnv?.(),
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
