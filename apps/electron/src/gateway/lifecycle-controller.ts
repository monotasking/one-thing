import type { CoreConversationRuntime } from '@onething/core/gateway-runtime'
import { isGatewayEnabledFromEnv } from '@onething/gateway/config'
import type { Channel, GatewayCommandProvider, GatewayLoggerFactory } from '@onething/gateway'
import type { WechatAuthEvent, WechatChannel } from '@onething/gateway'
import type {
  AppSettings,
  GatewayStartRequest,
  GatewayStatus,
  GatewayWechatAccountStatus,
  GatewayWechatAddAccountRequest,
  GatewayWechatLoginStatus,
  GatewayWechatLogoutRequest,
  GatewayWechatRemoveAccountRequest,
  GatewayWechatRenameAccountRequest,
  GatewayWechatStopAccountRequest,
} from '@shared/ipc'
import {
  type GatewayRuntime,
} from '@onething/gateway'

const DEFAULT_WECHAT_ACCOUNT_ID = 'default'

interface WechatAccountConfig {
  id: string
  label?: string
  enabled: boolean
}

export interface ElectronGatewayLifecycleOptions {
  getConversationRuntime(): CoreConversationRuntime
  getSettings?: () => Pick<AppSettings, 'channels'>
  env?: NodeJS.ProcessEnv
  logger?: Pick<Console, 'log'>
  /**
   * 宿主的日志工厂(logging L2)。传进去之后网关的记录落进主进程的
   * `app.jsonl`,命名空间 `gateway.*`;不传网关就自己往终端打。
   */
  gatewayLogger?: GatewayLoggerFactory
  commandProvider?: GatewayCommandProvider
  importGateway?: () => Promise<{
    startGateway(options: {
      runtime: CoreConversationRuntime
      env?: NodeJS.ProcessEnv
      channels?: Channel[]
      background?: boolean
      commandProvider?: GatewayCommandProvider
      getLogger?: GatewayLoggerFactory
    }): Promise<GatewayRuntime>
    WechatChannel: typeof WechatChannel
    clearWechatAuthState?: (accountId?: string) => Promise<void>
  }>
}

export interface ElectronGatewayLifecycle {
  isGatewayEnabled(env?: NodeJS.ProcessEnv): boolean
  initializeGateway(): Promise<void>
  shutdownGateway(): Promise<void>
  applySettings(settings?: Pick<AppSettings, 'channels'>): Promise<GatewayStatus>
  getStatus(): GatewayStatus
  startGateway(request?: GatewayStartRequest): Promise<GatewayStatus>
  stopGateway(): Promise<GatewayStatus>
  logoutWechat(request?: GatewayWechatLogoutRequest): Promise<GatewayStatus>
  addWechatAccount(request?: GatewayWechatAddAccountRequest): Promise<{
    status: GatewayStatus
    account: GatewayWechatAccountStatus
  }>
  stopWechatAccount(request: GatewayWechatStopAccountRequest): Promise<GatewayStatus>
  removeWechatAccount(request: GatewayWechatRemoveAccountRequest): Promise<GatewayStatus>
  renameWechatAccount(request: GatewayWechatRenameAccountRequest): Promise<{
    status: GatewayStatus
    account: GatewayWechatAccountStatus
  }>
}

export function createElectronGatewayLifecycle(
  options: ElectronGatewayLifecycleOptions,
): ElectronGatewayLifecycle {
  let gatewayRuntime: GatewayRuntime | null = null
  let starting = false
  let stopping = false
  let lastError: string | undefined
  let managedWechat = false
  const wechatStates = new Map<string, GatewayWechatAccountStatus>()
  const localWechatAccounts = new Map<string, WechatAccountConfig>()
  const removedWechatAccounts = new Set<string>()
  let activeWechatAccountIds = new Set<string>()
  const env = options.env ?? process.env
  const logger = options.logger ?? console

  const isWechatEnabled = (settings = options.getSettings?.()): boolean =>
    settings?.channels?.wechat?.enabled === true

  const listWechatAccountConfigs = (settings = options.getSettings?.()): WechatAccountConfig[] => {
    const byId = new Map<string, WechatAccountConfig>()
    const wechat = settings?.channels?.wechat
    if (wechat?.enabled) {
      const configured = wechat.accounts?.length
        ? wechat.accounts
        : [{ id: DEFAULT_WECHAT_ACCOUNT_ID, enabled: true }]
      for (const account of configured) {
        const id = normalizeWechatAccountId(account.id)
        if (!id || removedWechatAccounts.has(id)) continue
        byId.set(id, {
          id,
          label: account.label,
          enabled: account.enabled !== false,
        })
      }
    }

    for (const account of localWechatAccounts.values()) {
      if (removedWechatAccounts.has(account.id)) continue
      byId.set(account.id, account)
    }

    return [...byId.values()]
  }

  const enabledWechatAccounts = (settings = options.getSettings?.()): WechatAccountConfig[] =>
    listWechatAccountConfigs(settings).filter(account => account.enabled)

  const ensureWechatState = (config: WechatAccountConfig): GatewayWechatAccountStatus => {
    const existing = wechatStates.get(config.id)
    if (existing) {
      existing.enabled = config.enabled
      existing.label = config.label
      existing.running = Boolean(gatewayRuntime && activeWechatAccountIds.has(config.id))
      return existing
    }

    const state = createInitialWechatStatus(config)
    wechatStates.set(config.id, state)
    return state
  }

  const syncWechatStates = (settings = options.getSettings?.()): GatewayWechatAccountStatus[] => {
    const configs = listWechatAccountConfigs(settings)
    const ids = new Set(configs.map(account => account.id))
    for (const account of configs) ensureWechatState(account)
    for (const id of [...wechatStates.keys()]) {
      if (!ids.has(id) && !activeWechatAccountIds.has(id)) wechatStates.delete(id)
    }
    return configs.map(account => ({ ...ensureWechatState(account) }))
  }

  const updateWechatState = (accountId: string, patch: Partial<GatewayWechatAccountStatus>): void => {
    const configs = listWechatAccountConfigs()
    const config = configs.find(account => account.id === accountId)
      ?? localWechatAccounts.get(accountId)
      ?? { id: accountId, enabled: true }
    const existing = ensureWechatState(config)
    wechatStates.set(accountId, {
      ...existing,
      ...patch,
      id: accountId,
      label: patch.label ?? existing.label ?? config.label,
      enabled: patch.enabled ?? config.enabled,
      running: patch.running ?? Boolean(gatewayRuntime && activeWechatAccountIds.has(accountId)),
      lastUpdatedAt: Date.now(),
    })
  }

  const handleWechatAuthEvent = (accountId: string, event: WechatAuthEvent): void => {
    switch (event.type) {
      case 'saved-auth':
      case 'confirmed':
        updateWechatState(accountId, {
          loginStatus: 'logged-in',
          qrUrl: undefined,
          loggedIn: true,
          accountId: event.auth.ilinkUserId,
          botId: event.auth.ilinkBotId,
          baseUrl: event.auth.baseUrl,
          lastError: undefined,
        })
        break
      case 'qr':
        updateWechatState(accountId, {
          loginStatus: 'waiting-for-scan',
          qrUrl: event.qrUrl,
          loggedIn: false,
          lastError: undefined,
        })
        break
      case 'status':
        updateWechatState(accountId, {
          loginStatus: mapWechatQrStatus(event.status),
          baseUrl: event.baseUrl,
        })
        break
      case 'redirect':
        updateWechatState(accountId, { baseUrl: event.baseUrl })
        break
      case 'expired':
        updateWechatState(accountId, { loginStatus: 'expired', qrUrl: undefined, loggedIn: false })
        break
    }
  }

  const currentStatus = (): GatewayStatus => {
    const accounts = syncWechatStates()
    const legacy = accounts[0] ?? createInitialWechatStatus({
      id: DEFAULT_WECHAT_ACCOUNT_ID,
      enabled: isWechatEnabled(),
    })
    return {
      running: Boolean(gatewayRuntime) && !starting,
      starting,
      stopping,
      enabled: isGatewayEnabledFromEnv(env) || accounts.some(account => account.enabled),
      lastError,
      wechat: { ...legacy },
      wechatAccounts: accounts,
    }
  }

  const sameAccountSet = (accounts: WechatAccountConfig[]): boolean => {
    if (accounts.length !== activeWechatAccountIds.size) return false
    return accounts.every(account => activeWechatAccountIds.has(account.id))
  }

  const stopRuntime = async (): Promise<void> => {
    if (!gatewayRuntime) {
      starting = false
      managedWechat = false
      activeWechatAccountIds = new Set()
      for (const state of wechatStates.values()) {
        state.running = false
        state.loginStatus = state.loggedIn ? 'logged-in' : 'idle'
      }
      return
    }

    const runtime = gatewayRuntime
    gatewayRuntime = null
    starting = false
    stopping = true
    try {
      await runtime.gateway.stop()
      logger.log('[Gateway] Stopped')
    } finally {
      stopping = false
      managedWechat = false
      activeWechatAccountIds = new Set()
      for (const state of wechatStates.values()) {
        state.running = false
        state.loginStatus = state.loggedIn ? 'logged-in' : 'idle'
      }
    }
  }

  const startRuntime = async (accounts: WechatAccountConfig[], allowEnvFallback: boolean): Promise<GatewayStatus> => {
    if (!accounts.length && !allowEnvFallback) return currentStatus()
    if (gatewayRuntime && sameAccountSet(accounts)) return currentStatus()
    if (gatewayRuntime) await stopRuntime()

    starting = true
    stopping = false
    lastError = undefined
    managedWechat = accounts.length > 0
    activeWechatAccountIds = new Set(accounts.map(account => account.id))
    for (const account of accounts) {
      localWechatAccounts.set(account.id, account)
      updateWechatState(account.id, {
        enabled: true,
        running: false,
        loginStatus: wechatStates.get(account.id)?.loggedIn ? 'logged-in' : 'idle',
        lastError: undefined,
      })
    }

    try {
      const gatewayModule = await (options.importGateway ?? defaultImportGateway)()
      const channels = accounts.length
        ? accounts.map(account => new gatewayModule.WechatChannel({
            accountId: account.id,
            onAuthEvent: event => handleWechatAuthEvent(account.id, event),
          }))
        : undefined
      const startOptions = {
        runtime: options.getConversationRuntime(),
        env,
        channels,
        background: true,
        ...(options.commandProvider ? { commandProvider: options.commandProvider } : {}),
        ...(options.gatewayLogger ? { getLogger: options.gatewayLogger } : {}),
      }
      const runtime = await gatewayModule.startGateway(startOptions)
      gatewayRuntime = runtime
      runtime.startPromise
        ?.then(() => {
          if (gatewayRuntime !== runtime) return
          starting = false
          for (const accountId of activeWechatAccountIds) {
            updateWechatState(accountId, { running: Boolean(gatewayRuntime) })
          }
          logger.log('[Gateway] Started from Electron host')
        })
        .catch(error => {
          if (gatewayRuntime !== runtime) return
          const message = formatError(error)
          starting = false
          gatewayRuntime = null
          lastError = message
          for (const accountId of activeWechatAccountIds) {
            updateWechatState(accountId, {
              loginStatus: message === 'WechatChannel stopped' ? 'idle' : 'error',
              running: false,
              lastError: message,
            })
          }
          activeWechatAccountIds = new Set()
          if (message !== 'WechatChannel stopped') {
            logger.log(`[Gateway] Start failed: ${message}`)
          }
        })
      return currentStatus()
    } catch (error) {
      starting = false
      lastError = formatError(error)
      for (const accountId of activeWechatAccountIds) {
        updateWechatState(accountId, {
          loginStatus: 'error',
          running: false,
          lastError,
        })
      }
      activeWechatAccountIds = new Set()
      return currentStatus()
    }
  }

  return {
    isGatewayEnabled(checkEnv: NodeJS.ProcessEnv = env): boolean {
      return isGatewayEnabledFromEnv(checkEnv) || enabledWechatAccounts().length > 0
    },

    async initializeGateway(): Promise<void> {
      if (!isGatewayEnabledFromEnv(env) && !enabledWechatAccounts().length) return
      await this.startGateway(enabledWechatAccounts().length ? { channel: 'wechat' } : undefined)
    },

    async applySettings(settings?: Pick<AppSettings, 'channels'>): Promise<GatewayStatus> {
      const accounts = enabledWechatAccounts(settings)
      if (accounts.length) return startRuntime(accounts, false)
      if (!isGatewayEnabledFromEnv(env)) {
        await stopRuntime()
      }
      return currentStatus()
    },

    getStatus(): GatewayStatus {
      return currentStatus()
    },

    async startGateway(request: GatewayStartRequest = {}): Promise<GatewayStatus> {
      if (starting) return currentStatus()
      if (request.channel && request.channel !== 'wechat') return currentStatus()

      if (request.channel === 'wechat') {
        const accountId = normalizeWechatAccountId(request.accountId)
        const existing = listWechatAccountConfigs().find(account => account.id === accountId)
        localWechatAccounts.set(accountId, {
          id: accountId,
          label: existing?.label,
          enabled: true,
        })
        removedWechatAccounts.delete(accountId)
      }

      const accounts = enabledWechatAccounts()
      const shouldStartWechat = request.channel === 'wechat' || accounts.length > 0
      if (!shouldStartWechat && !isGatewayEnabledFromEnv(env)) return currentStatus()
      return startRuntime(accounts, !shouldStartWechat && isGatewayEnabledFromEnv(env))
    },

    async stopGateway(): Promise<GatewayStatus> {
      await stopRuntime()
      return currentStatus()
    },

    async logoutWechat(request: GatewayWechatLogoutRequest = {}): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      await stopRuntime()
      const gatewayModule = await (options.importGateway ?? defaultImportGateway)()
      await gatewayModule.clearWechatAuthState?.(accountId)
      const existing = wechatStates.get(accountId)
      wechatStates.set(accountId, createInitialWechatStatus({
        id: accountId,
        label: existing?.label,
        enabled: existing?.enabled ?? true,
      }))
      return startRuntime(enabledWechatAccounts(), false)
    },

    async addWechatAccount(request: GatewayWechatAddAccountRequest = {}): Promise<{
      status: GatewayStatus
      account: GatewayWechatAccountStatus
    }> {
      const accountId = nextWechatAccountId(localWechatAccounts, wechatStates)
      localWechatAccounts.set(accountId, {
        id: accountId,
        label: request.label?.trim() || `WeChat ${localWechatAccounts.size + 1}`,
        enabled: true,
      })
      removedWechatAccounts.delete(accountId)
      await startRuntime(enabledWechatAccounts(), false)
      return {
        status: currentStatus(),
        account: { ...ensureWechatState(localWechatAccounts.get(accountId)!) },
      }
    },

    async stopWechatAccount(request: GatewayWechatStopAccountRequest): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      const existing = listWechatAccountConfigs().find(account => account.id === accountId)
        ?? localWechatAccounts.get(accountId)
        ?? { id: accountId, enabled: true }
      const label = 'label' in existing ? existing.label : undefined
      localWechatAccounts.set(accountId, {
        id: accountId,
        label,
        enabled: false,
      })
      updateWechatState(accountId, {
        enabled: false,
        running: false,
        loginStatus: wechatStates.get(accountId)?.loggedIn ? 'logged-in' : 'idle',
      })
      await stopRuntime()
      return startRuntime(enabledWechatAccounts(), false)
    },

    async removeWechatAccount(request: GatewayWechatRemoveAccountRequest): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      await stopRuntime()
      const gatewayModule = await (options.importGateway ?? defaultImportGateway)()
      await gatewayModule.clearWechatAuthState?.(accountId)
      localWechatAccounts.delete(accountId)
      removedWechatAccounts.add(accountId)
      wechatStates.delete(accountId)
      return startRuntime(enabledWechatAccounts(), false)
    },

    async renameWechatAccount(request: GatewayWechatRenameAccountRequest): Promise<{
      status: GatewayStatus
      account: GatewayWechatAccountStatus
    }> {
      const accountId = normalizeWechatAccountId(request.accountId)
      const existing = listWechatAccountConfigs().find(account => account.id === accountId)
      const next = {
        id: accountId,
        label: request.label?.trim() || existing?.label,
        enabled: existing?.enabled ?? true,
      }
      localWechatAccounts.set(accountId, next)
      updateWechatState(accountId, { label: next.label })
      return {
        status: currentStatus(),
        account: { ...ensureWechatState(next) },
      }
    },

    async shutdownGateway(): Promise<void> {
      await this.stopGateway()
    },
  }
}

function createInitialWechatStatus(config: Pick<WechatAccountConfig, 'id' | 'label' | 'enabled'>): GatewayWechatAccountStatus {
  return {
    id: config.id,
    label: config.label,
    enabled: config.enabled,
    running: false,
    loginStatus: 'idle',
    loggedIn: false,
  }
}

function normalizeWechatAccountId(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_WECHAT_ACCOUNT_ID
  return trimmed.replace(/[^a-zA-Z0-9_.@-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_WECHAT_ACCOUNT_ID
}

function nextWechatAccountId(
  localAccounts: Map<string, WechatAccountConfig>,
  states: Map<string, GatewayWechatAccountStatus>,
): string {
  for (let index = 1; index < 1000; index += 1) {
    const id = `account-${index}`
    if (!localAccounts.has(id) && !states.has(id)) return id
  }
  return `account-${Date.now().toString(36)}`
}

function mapWechatQrStatus(status: string): GatewayWechatLoginStatus {
  if (status === 'scaned' || status === 'scaned_but_redirect') return 'scanned'
  if (status === 'confirmed' || status === 'binded_redirect') return 'confirmed'
  if (status === 'expired' || status === 'verify_code_blocked') return 'expired'
  if (status === 'need_verifycode') return 'error'
  return 'waiting-for-scan'
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function defaultImportGateway(): Promise<{
  startGateway(options: {
    runtime: CoreConversationRuntime
    env?: NodeJS.ProcessEnv
    channels?: Channel[]
    background?: boolean
    commandProvider?: GatewayCommandProvider
  }): Promise<GatewayRuntime>
  WechatChannel: typeof WechatChannel
  clearWechatAuthState?: (accountId?: string) => Promise<void>
}> {
  return import('@onething/gateway')
}
