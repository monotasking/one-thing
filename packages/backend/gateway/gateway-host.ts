/**
 * 网关跟着后端运行(第④步批 4,`docs/design/two-process-2026-10.md` §2.5):后端进程自己实现 `GatewayHostPorts`。
 *
 * 从前这台生命周期机器住在 Electron 主进程里(Vue 宿主的 `gateway/lifecycle-controller.ts`,随 Vue 宿主退役删掉),
 * 之后三张宿主表的 `gateway` 一格全是 `null`,网关只剩独立进程 `gateway-standalone-main.ts` 一种跑法。
 * 这只文件把那台机器原样搬回后端:起停微信网关、二维码登录的状态、多账号的增删改名,形状就是端口要的
 * 生命周期原语(`GatewayStatus` / `{status, account}`),信封由 `gateway-lifecycle-port.ts` 的门面统一包。
 *
 * 与旧实现只差三处,都是有意的:
 *  ① **只按设置起**(用户 10-07 拍定「网关按设置自动连」):开关是 `settings.channels.wechat.enabled`;
 *     旧实现还认 `ONETHING_GATEWAY` / `GATEWAY_CHANNELS` / `TELEGRAM_BOT_TOKEN` 这几个环境变量,搬进后端之后
 *     这条路不留 —— 登录 shell 的环境会被补进后端进程,一个碰巧设在 `.zshrc` 里的 Telegram 令牌不该让桌面一启动
 *     就连上 Telegram。要按环境变量起网关,用独立网关进程。
 *  ② 对话 runtime 是**这台后端进程内**的引擎(`OnethingBackend.runtime.conversationRuntime`),每次起网关时现取,
 *     不再需要 `ONETHING_GATEWAY_RUNTIME_MODULE`。
 *  ③ 日志走后端的 `getLogger`(网关的记录落进这台后端的 `app.jsonl`,命名空间 `gateway.*`)。
 *
 * 交出两样:`createBackendGatewayHost(options)`(一台生命周期机器,`GatewayHostPorts` 的八件事 + 设置套用 + 收尾),
 * 与 `GATEWAY_SHUTDOWN_TIMEOUT_MS`(收尾的上限)。依赖:网关自己的启动面与微信渠道、logging 入口。
 */
import type {
  AppSettings,
} from '@shared/ipc/settings.js'
import type {
  GatewayStartRequest,
  GatewayStatus,
  GatewayWechatAccountStatus,
  GatewayWechatAddAccountRequest,
  GatewayWechatLoginStatus,
  GatewayWechatLogoutRequest,
  GatewayWechatRemoveAccountRequest,
  GatewayWechatRenameAccountRequest,
  GatewayWechatStopAccountRequest,
} from '@shared/ipc/gateway.js'
import { getLogger } from '@onething/backend/logging'
import type { CoreConversationRuntime } from './gateway-conversation-runtime.js'
import type { GatewayHostAccountResult, GatewayHostPorts } from './gateway-lifecycle-port.js'
import { startGateway, type GatewayRuntime, type StartGatewayOptions } from './gateway-standalone.js'
import { WechatChannel, clearAuthState, type WechatAuthEvent } from './channels/wechat/wechat.js'
import type { Channel, GatewayCommandProvider, GatewayLoggerFactory } from './hub/gateway-hub.js'

const DEFAULT_WECHAT_ACCOUNT_ID = 'default'

/**
 * 收尾的上限。与 MCP / ACP 子系统同一个数、同一个理由(`mcp/mcp-subsystem.ts` 的 `DEFAULT_MCP_DISPOSE_TIMEOUT_MS`):
 * 后端收到 SIGTERM 之后只有 5 秒,会话账本的落盘排在后面;一条挂在长轮询上的渠道不值得拿用户的消息去换。
 */
export const GATEWAY_SHUTDOWN_TIMEOUT_MS = 3000

interface WechatAccountConfig {
  id: string
  label?: string
  enabled: boolean
}

/** 起一台网关要的那几件。测试替身经这里进来;生产里由 `backend-launcher.ts` 接线。 */
export interface BackendGatewayHostOptions {
  /** 起网关那一刻现取的对话 runtime(后端进程内的引擎)。 */
  getConversationRuntime(): CoreConversationRuntime
  /** 现读的设置(只读 `channels` 一段)。 */
  getSettings(): Pick<AppSettings, 'channels'> | undefined
  /** 网关里的插件命令(`/命令`)。缺席 = 没有插件命令。 */
  commandProvider?: GatewayCommandProvider
  /** 白名单 / 限流 / 远程审批那几格仍读环境变量(与独立网关同一份读法)。缺省 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** 缺省是后端的 `getLogger`。 */
  getLogger?: GatewayLoggerFactory
  /** 测试替身:起网关、造微信渠道、清登录态。缺省是真的那三样。 */
  startGatewayImpl?: (options: StartGatewayOptions) => Promise<GatewayRuntime>
  createWechatChannel?: (options: { accountId: string; onAuthEvent: (event: WechatAuthEvent) => void }) => Channel
  clearWechatAuthState?: (accountId?: string) => Promise<void>
  shutdownTimeoutMs?: number
}

/** 端口那八件事 + 两件只有宿主自己调的:按设置起(后端起来时)与收尾(后端退出时)。 */
export interface BackendGatewayHost extends Required<Omit<GatewayHostPorts, 'getStatus' | 'applySettings'>> {
  getStatus(): GatewayStatus
  /** 设置存盘之后的套用(端口的 `applySettings` 一格)。 */
  applySettings(settings?: Pick<AppSettings, 'channels'>): Promise<void>
  /** 设置里有开着的微信账号就起,没有就什么都不做。永不抛:起不来记进状态的 `lastError`。 */
  startFromSettings(): Promise<GatewayStatus>
  /** 停掉网关,最多等 `shutdownTimeoutMs`;返回是否超时。幂等。 */
  shutdown(): Promise<boolean>
}

export function createBackendGatewayHost(options: BackendGatewayHostOptions): BackendGatewayHost {
  const log = getLogger('gateway.host')
  const env = options.env ?? process.env
  const runGateway = options.startGatewayImpl ?? startGateway
  const makeWechatChannel = options.createWechatChannel
    ?? (channelOptions => new WechatChannel(channelOptions))
  const clearWechat = options.clearWechatAuthState ?? clearAuthState
  const gatewayLoggerFactory: GatewayLoggerFactory = options.getLogger ?? (namespace => getLogger(namespace))

  /*
   * 这台机器的状态。它是**一台网关实例**的字段,不是模块级的:每次 `createBackendGatewayHost` 是一台新机器,
   * 进程里由 `backend-launcher.ts` 造一台、交给宿主表那一格,`dispose()` 之后随端口一起还原。
   */
  const state = {
    gatewayRuntime: null as GatewayRuntime | null,
    starting: false,
    stopping: false,
    lastError: undefined as string | undefined,
    activeWechatAccountIds: new Set<string>(),
    shutdownWork: null as Promise<boolean> | null,
  }
  const wechatStates = new Map<string, GatewayWechatAccountStatus>()
  const localWechatAccounts = new Map<string, WechatAccountConfig>()
  const removedWechatAccounts = new Set<string>()

  const listWechatAccountConfigs = (settings = options.getSettings()): WechatAccountConfig[] => {
    const byId = new Map<string, WechatAccountConfig>()
    const wechat = settings?.channels?.wechat
    if (wechat?.enabled) {
      const configured = wechat.accounts?.length
        ? wechat.accounts
        : [{ id: DEFAULT_WECHAT_ACCOUNT_ID, enabled: true }]
      for (const account of configured) {
        const id = normalizeWechatAccountId(account.id)
        if (!id || removedWechatAccounts.has(id)) continue
        byId.set(id, { id, label: account.label, enabled: account.enabled !== false })
      }
    }
    for (const account of localWechatAccounts.values()) {
      if (removedWechatAccounts.has(account.id)) continue
      byId.set(account.id, account)
    }
    return [...byId.values()]
  }

  const enabledWechatAccounts = (settings = options.getSettings()): WechatAccountConfig[] =>
    listWechatAccountConfigs(settings).filter(account => account.enabled)

  const ensureWechatState = (config: WechatAccountConfig): GatewayWechatAccountStatus => {
    const existing = wechatStates.get(config.id)
    if (existing) {
      existing.enabled = config.enabled
      existing.label = config.label
      existing.running = Boolean(state.gatewayRuntime && state.activeWechatAccountIds.has(config.id))
      return existing
    }
    const created = createInitialWechatStatus(config)
    wechatStates.set(config.id, created)
    return created
  }

  const syncWechatStates = (): GatewayWechatAccountStatus[] => {
    const configs = listWechatAccountConfigs()
    const ids = new Set(configs.map(account => account.id))
    for (const account of configs) ensureWechatState(account)
    for (const id of [...wechatStates.keys()]) {
      if (!ids.has(id) && !state.activeWechatAccountIds.has(id)) wechatStates.delete(id)
    }
    return configs.map(account => ({ ...ensureWechatState(account) }))
  }

  const updateWechatState = (accountId: string, patch: Partial<GatewayWechatAccountStatus>): void => {
    const config = listWechatAccountConfigs().find(account => account.id === accountId)
      ?? localWechatAccounts.get(accountId)
      ?? { id: accountId, enabled: true }
    const existing = ensureWechatState(config)
    wechatStates.set(accountId, {
      ...existing,
      ...patch,
      id: accountId,
      label: patch.label ?? existing.label ?? config.label,
      enabled: patch.enabled ?? config.enabled,
      running: patch.running ?? Boolean(state.gatewayRuntime && state.activeWechatAccountIds.has(accountId)),
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
        updateWechatState(accountId, { loginStatus: 'waiting-for-scan', qrUrl: event.qrUrl, loggedIn: false, lastError: undefined })
        break
      case 'status':
        updateWechatState(accountId, { loginStatus: mapWechatQrStatus(event.status), baseUrl: event.baseUrl })
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
      enabled: options.getSettings()?.channels?.wechat?.enabled === true,
    })
    return {
      running: Boolean(state.gatewayRuntime) && !state.starting,
      starting: state.starting,
      stopping: state.stopping,
      // 只按设置(文件头 ①):有开着的账号就是「开着」。
      enabled: accounts.some(account => account.enabled),
      lastError: state.lastError,
      wechat: { ...legacy },
      wechatAccounts: accounts,
    }
  }

  const sameAccountSet = (accounts: WechatAccountConfig[]): boolean =>
    accounts.length === state.activeWechatAccountIds.size
    && accounts.every(account => state.activeWechatAccountIds.has(account.id))

  const markAllStopped = (): void => {
    state.activeWechatAccountIds = new Set()
    for (const entry of wechatStates.values()) {
      entry.running = false
      entry.loginStatus = entry.loggedIn ? 'logged-in' : 'idle'
    }
  }

  const stopRuntime = async (): Promise<void> => {
    const runtime = state.gatewayRuntime
    state.gatewayRuntime = null
    state.starting = false
    if (!runtime) {
      markAllStopped()
      return
    }
    state.stopping = true
    try {
      await runtime.gateway.stop()
      log.info('gateway stopped')
    } finally {
      state.stopping = false
      markAllStopped()
    }
  }

  const startRuntime = async (accounts: WechatAccountConfig[]): Promise<GatewayStatus> => {
    if (!accounts.length) {
      // 没有开着的账号 = 不该有网关(只按设置,文件头 ①)。
      if (state.gatewayRuntime) await stopRuntime()
      return currentStatus()
    }
    if (state.gatewayRuntime && sameAccountSet(accounts)) return currentStatus()
    if (state.gatewayRuntime) await stopRuntime()

    state.starting = true
    state.stopping = false
    state.lastError = undefined
    state.activeWechatAccountIds = new Set(accounts.map(account => account.id))
    for (const account of accounts) {
      updateWechatState(account.id, {
        enabled: true,
        running: false,
        loginStatus: wechatStates.get(account.id)?.loggedIn ? 'logged-in' : 'idle',
        lastError: undefined,
      })
    }

    try {
      const channels = accounts.map(account => makeWechatChannel({
        accountId: account.id,
        onAuthEvent: event => handleWechatAuthEvent(account.id, event),
      }))
      const runtime = await runGateway({
        runtime: options.getConversationRuntime(),
        env,
        channels,
        background: true,
        ...(options.commandProvider ? { commandProvider: options.commandProvider } : {}),
        getLogger: gatewayLoggerFactory,
      })
      state.gatewayRuntime = runtime
      runtime.startPromise
        ?.then(() => {
          if (state.gatewayRuntime !== runtime) return
          state.starting = false
          for (const accountId of state.activeWechatAccountIds) {
            updateWechatState(accountId, { running: Boolean(state.gatewayRuntime) })
          }
          log.info('gateway started', { accounts: [...state.activeWechatAccountIds] })
        })
        .catch(error => {
          if (state.gatewayRuntime !== runtime) return
          const message = formatError(error)
          state.starting = false
          state.gatewayRuntime = null
          state.lastError = message
          for (const accountId of state.activeWechatAccountIds) {
            updateWechatState(accountId, {
              loginStatus: message === 'WechatChannel stopped' ? 'idle' : 'error',
              running: false,
              lastError: message,
            })
          }
          state.activeWechatAccountIds = new Set()
          if (message !== 'WechatChannel stopped') log.warn('gateway start failed', { reason: message })
        })
      return currentStatus()
    } catch (error) {
      state.starting = false
      state.lastError = formatError(error)
      for (const accountId of state.activeWechatAccountIds) {
        updateWechatState(accountId, { loginStatus: 'error', running: false, lastError: state.lastError })
      }
      state.activeWechatAccountIds = new Set()
      log.warn('gateway start failed', { reason: state.lastError })
      return currentStatus()
    }
  }

  const host: BackendGatewayHost = {
    getStatus: () => currentStatus(),

    async start(request: GatewayStartRequest = {}): Promise<GatewayStatus> {
      if (state.shutdownWork) return currentStatus()
      if (state.starting) return currentStatus()
      if (request.channel && request.channel !== 'wechat') return currentStatus()
      if (request.channel === 'wechat') {
        const accountId = normalizeWechatAccountId(request.accountId)
        const existing = listWechatAccountConfigs().find(account => account.id === accountId)
        localWechatAccounts.set(accountId, { id: accountId, label: existing?.label, enabled: true })
        removedWechatAccounts.delete(accountId)
      }
      return startRuntime(enabledWechatAccounts())
    },

    async stop(): Promise<GatewayStatus> {
      await stopRuntime()
      return currentStatus()
    },

    async wechatLogout(request: GatewayWechatLogoutRequest = {}): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      await stopRuntime()
      await clearWechat(accountId)
      const existing = wechatStates.get(accountId)
      wechatStates.set(accountId, createInitialWechatStatus({
        id: accountId,
        label: existing?.label,
        enabled: existing?.enabled ?? true,
      }))
      return startRuntime(enabledWechatAccounts())
    },

    async wechatAddAccount(request: GatewayWechatAddAccountRequest = {}): Promise<GatewayHostAccountResult> {
      const accountId = nextWechatAccountId(localWechatAccounts, wechatStates)
      localWechatAccounts.set(accountId, {
        id: accountId,
        label: request.label?.trim() || `WeChat ${localWechatAccounts.size + 1}`,
        enabled: true,
      })
      removedWechatAccounts.delete(accountId)
      await startRuntime(enabledWechatAccounts())
      return { status: currentStatus(), account: { ...ensureWechatState(localWechatAccounts.get(accountId)!) } }
    },

    async wechatStopAccount(request: GatewayWechatStopAccountRequest): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      const existing = listWechatAccountConfigs().find(account => account.id === accountId)
        ?? localWechatAccounts.get(accountId)
      localWechatAccounts.set(accountId, { id: accountId, label: existing?.label, enabled: false })
      updateWechatState(accountId, {
        enabled: false,
        running: false,
        loginStatus: wechatStates.get(accountId)?.loggedIn ? 'logged-in' : 'idle',
      })
      await stopRuntime()
      return startRuntime(enabledWechatAccounts())
    },

    async wechatRemoveAccount(request: GatewayWechatRemoveAccountRequest): Promise<GatewayStatus> {
      const accountId = normalizeWechatAccountId(request.accountId)
      await stopRuntime()
      await clearWechat(accountId)
      localWechatAccounts.delete(accountId)
      removedWechatAccounts.add(accountId)
      wechatStates.delete(accountId)
      return startRuntime(enabledWechatAccounts())
    },

    async wechatRenameAccount(request: GatewayWechatRenameAccountRequest): Promise<GatewayHostAccountResult> {
      const accountId = normalizeWechatAccountId(request.accountId)
      const existing = listWechatAccountConfigs().find(account => account.id === accountId)
      const next = { id: accountId, label: request.label?.trim() || existing?.label, enabled: existing?.enabled ?? true }
      localWechatAccounts.set(accountId, next)
      updateWechatState(accountId, { label: next.label })
      return { status: currentStatus(), account: { ...ensureWechatState(next) } }
    },

    /** 设置存盘之后(`settings` 域调):有开着的账号就起(账号集变了就重起),一个都没有就停。 */
    async applySettings(settings?: Pick<AppSettings, 'channels'>): Promise<void> {
      if (state.shutdownWork) return
      // 设置里关掉了微信 = 网关整个停:界面上临时加的账号也一起收掉,不留一条设置说「关」而渠道还连着的路。
      if (settings?.channels?.wechat?.enabled !== true) localWechatAccounts.clear()
      await startRuntime(enabledWechatAccounts(settings))
    },

    async startFromSettings(): Promise<GatewayStatus> {
      if (state.shutdownWork) return currentStatus()
      const accounts = enabledWechatAccounts()
      if (!accounts.length) return currentStatus()
      log.info('gateway enabled in settings, starting', { accounts: accounts.map(account => account.id) })
      return startRuntime(accounts)
    },

    shutdown(): Promise<boolean> {
      if (state.shutdownWork) return state.shutdownWork
      const work = stopRuntime()
      work.catch(() => undefined)
      const timeoutMs = options.shutdownTimeoutMs ?? GATEWAY_SHUTDOWN_TIMEOUT_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      state.shutdownWork = Promise.race([work.then(() => false, () => false), deadline]).then(timedOut => {
        if (timer) clearTimeout(timer)
        if (timedOut) log.warn('gateway shutdown timed out, moving on', { timeoutMs })
        return timedOut
      })
      return state.shutdownWork
    },
  }
  return host
}

function createInitialWechatStatus(config: Pick<WechatAccountConfig, 'id' | 'label' | 'enabled'>): GatewayWechatAccountStatus {
  return { id: config.id, label: config.label, enabled: config.enabled, running: false, loginStatus: 'idle', loggedIn: false }
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
