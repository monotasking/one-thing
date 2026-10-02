/**
 * ACP 子系统对象(C1,`docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 与 `runtime/mcp/wiring/subsystem.ts` 同型,理由也同一条:登记(`own`)与启动(`start`)解耦,
 * `dispose()` 负责"在途的那趟先落地再关",于是早退不留孤儿子进程。
 *
 * 两处与 MCP 不同,都是照着代码事实来的:
 *  · `ACPManager.initialize` / `updateSettings` 是**同步**的(只是 syncClients + 起清理
 *    定时器),这里仍然包成 `Promise<void>` 并且 `await` 端口 —— 宿主面前两只子系统的
 *    形状一样,谁也不必记得"ACP 那只不用 await"。
 *  · **桥不在这里接**。审批 / 文件 / 终端三只桥由宿主各自 `own(registerACPPermissionBridge(…))`
 *    (A3-b 起三个宿主都挂:React 壳等人答,server 与 daemon 没人答就拒)—— 「没人答怎么办」
 *    是宿主的事实,子系统不替它猜。
 */
import type {
  ACPAgentConfig,
  ACPAgentState,
  ACPSettings,
  AcpSessionState,
} from '@shared/contracts/acp'
import { getLogger } from '../logging/index.js'
import { installAcpStateBroadcaster, type AcpStateSource } from './events.js'
import type { AcpAgentRosterEntry, AcpRegistryRefreshOptions } from './registry.js'
import { HostMcpBridge } from './host-mcp-bridge.js'

const log = getLogger('app.acp.subsystem')

/**
 * 子系统看得见的 manager 面 —— 三件事,不是整只 `ACPManager`。
 *
 * 前两件写成 `void | Promise<void>` 而不是照抄 `ACPManager` 今天的同步签名:子系统
 * `await` 它们,于是"在途的 start 必须先落地"这条对 ACP 也是**真的**(今天那只
 * manager 同步返回,`await undefined` 只多一个微任务)。照抄同步签名的话,那条分支
 * 在 ACP 这边永远观察不到,也就写不出反证。
 */
export interface AcpSubsystemManagerPort extends Partial<AcpStateSource> {
  initialize(settings: ACPSettings): void | Promise<void>
  updateSettings(settings: ACPSettings): void | Promise<void>
  shutdown(): Promise<void>
  /** 旧 id → 现 id(名册的 `aliases`);老会话里记着旧 id 的照样找得到那一台。 */
  setAgentAliases?(aliases: Record<string, string>): void
  /** 管家眼里这一台此刻的连接状态;不认识 = undefined。 */
  getAgentState?(agentId: string): ACPAgentState | undefined
}

/** 子系统看得见的名册面(`AcpAgentRegistry` 的子集;测试可以递一只假的)。 */
export interface AcpSubsystemRegistryPort {
  loadLocal(): void
  roster(settings?: ACPSettings): AcpAgentRosterEntry[]
  aliases(): Record<string, string>
  refresh(options?: AcpRegistryRefreshOptions): Promise<void>
  detect(agentId?: string): Promise<void>
  onChanged(listener: () => void): () => void
}

/**
 * 会话状态的一只**投影**(A2-b):订 `onSessionStateChanged`,把状态表的某一格写到别的域
 * (计划 → 待办、标题 → 会话名)。子系统不认识任何一只投影的名字 —— 宿主递一张表,子系统
 * 构造时逐只订上、`dispose()` 时逐只退订并 `dispose()`。`observe` 抛了只记一行,不连累别的投影。
 */
export interface AcpSessionStateProjection {
  readonly label: string
  observe(state: AcpSessionState): void
  dispose?(): void
}

function isStateSource(manager: AcpSubsystemManagerPort): manager is AcpSubsystemManagerPort & AcpStateSource {
  return typeof manager.onSessionStateChanged === 'function' && typeof manager.onAgentStateChanged === 'function'
}

export interface AcpSubsystemDeps {
  manager: AcpSubsystemManagerPort
  /** 读**当下**的 ACP 设置(构造点比 `start()` 早)。 */
  settings: () => ACPSettings
  /** `dispose()` 的上限,毫秒。缺省 {@link DEFAULT_ACP_DISPOSE_TIMEOUT_MS};单测传小值。 */
  disposeTimeoutMs?: number
  /**
   * 名册(A1-a)。有它时管家吃的是**名册的生效配置**(种子 ⊕ 注册表 ⊕ 用户覆盖,只留启用且
   * 起得来的),不再是 `settings.acp.agents` 原样;缺席 = 旧行为(只用于不关心名册的单测)。
   */
  registry?: AcpSubsystemRegistryPort
  /** 宿主工具面的桥(A4-a)。缺席 = 用真依赖造一只;单测可以递一只假的。 */
  hostMcpBridge?: HostMcpBridge
  /**
   * 「这几条会话删了」的来源(A4-b):订上它,删会话就作废那条会话名下的桥凭据。答退订函数。
   * 装配层接总线(`resource:event` 的 `session:<id>` / `deleted`,连同级联删掉的子会话);
   * 缺席 = 不订(只在单测里)。
   */
  onSessionsDeleted?: (listener: (sessionIds: string[]) => void) => () => void
  /** 会话状态的投影表(A2-b:计划 → 待办、标题 → 会话名)。缺席 = 不投影(单测)。 */
  projections?: readonly AcpSessionStateProjection[]
}

/**
 * 与 `McpSubsystem` 同型同数的收尾上限 —— 理由逐字相同,见
 * `runtime/mcp/wiring/subsystem.ts` 的 `DEFAULT_MCP_DISPOSE_TIMEOUT_MS`:
 * 卡在 `apps/server/src/main.ts` 那条 5s 死线底下,给排在 dispose 链后面的
 * 会话账本 flush 留出余量。**超时可能留下孤儿子进程,这是有意的取舍:
 * 会话数据比 ACP 子进程重要。**
 *
 * ACP 与 MCP 各自计时(不共用一份预算):两格挨着登记,最坏情况下合计 6s 会顶穿
 * 5s 死线 —— 但那要求两台外部执行体同时挂死,而分一份预算的代价是先关的那格
 * 把后关的那格饿死。宁可两格各自诚实。
 */
export const DEFAULT_ACP_DISPOSE_TIMEOUT_MS = 3000

export type AcpSubsystemState = 'idle' | 'starting' | 'running' | 'disposed'

export class AcpSubsystem {
  private readonly deps: AcpSubsystemDeps
  private starting: Promise<void> | null = null
  private disposing: Promise<void> | null = null
  /** 见 `McpSubsystem.everStarted`:判据是"我起过没有",不是 manager 的内部状态。 */
  private everStarted = false
  private currentState: AcpSubsystemState = 'idle'
  /**
   * 状态广播器的退订(A0-2)。构造时就订:它不起任何东西,只挂两条监听,发送时才取总线;
   * 登记在构造点,于是收尾不依赖 `start()` 跑没跑完。退订由 `dispose()` 做。
   */
  private stopStateBroadcast: (() => void) | undefined

  /** 名册变化的退订;构造时订,`dispose()` 退。 */
  private stopRegistryWatch: (() => void) | undefined
  /** 桥凭据的两条作废监听(会话删了 / agent 进程没了,A4-b);构造时订,`dispose()` 退。 */
  private stopCredentialWatch: Array<() => void> = []
  /** 投影的退订(A2-b);构造时订,`dispose()` 退。 */
  private stopProjections: Array<() => void> = []
  /** 每台 agent 上一次见到的连接状态:只有「connected → 别的」才算进程没了。 */
  private readonly lastAgentStatus = new Map<string, string>()
  /** 后台那趟联网刷新的中止器;`dispose()` 拉闸。 */
  private readonly backgroundAbort = new AbortController()
  /**
   * 宿主工具面的桥与凭据表(A4-a,`host-mcp-bridge.ts`)。**实例字段**,不是模块级槽:
   * 凭据的寿命不长于签发它的这台 backend —— `dispose()` 全部作废,第二台 backend 不会
   * 认第一台签的钥匙。`host-mcp` 域与 `/api/mcp` 都从这里查。
   */
  readonly hostMcpBridge: HostMcpBridge

  constructor(deps: AcpSubsystemDeps) {
    this.deps = deps
    this.hostMcpBridge = deps.hostMcpBridge ?? new HostMcpBridge()
    if (isStateSource(deps.manager)) {
      this.stopStateBroadcast = installAcpStateBroadcaster(this.decoratedSource(deps.manager))
      this.stopCredentialWatch.push(deps.manager.onAgentStateChanged(state => this.noteAgentState(state)))
      const source = deps.manager
      for (const projection of deps.projections ?? []) {
        const off = source.onSessionStateChanged(state => {
          try {
            projection.observe(state)
          } catch (error) {
            log.warn('acp session state projection failed', { projection: projection.label, localSessionId: state.localSessionId }, error)
          }
        })
        this.stopProjections.push(() => {
          off()
          projection.dispose?.()
        })
      }
    }
    const stopDeleted = deps.onSessionsDeleted?.(sessionIds => {
      for (const sessionId of sessionIds) {
        const revoked = this.hostMcpBridge.revokeSession(sessionId)
        if (revoked > 0) log.info('bridge credentials revoked: session deleted', { sessionId, revoked })
      }
    })
    if (stopDeleted) this.stopCredentialWatch.push(stopDeleted)
    // 名册变了(探测 / 注册表刷新 / 种子重读)就按当下设置重喂管家。dispose 之后的迟到通知不理。
    this.stopRegistryWatch = deps.registry?.onChanged(() => {
      if (this.disposing) return
      this.applySettings(this.deps.settings()).catch(error => log.warn('acp roster re-apply failed', {}, error))
    })
  }

  get state(): AcpSubsystemState {
    return this.currentState
  }

  /** 名册(没有名册的旧形态答空表)。 */
  roster(settings?: ACPSettings): AcpAgentRosterEntry[] {
    return this.deps.registry?.roster(settings ?? this.deps.settings()) ?? []
  }

  /**
   * 管家该拿到的那份设置:总开关照抄,`agents` = 名册里**启用且有命令**的生效配置。
   * 没有名册 = 原样(旧行为)。
   */
  managerSettings(next: ACPSettings): ACPSettings {
    const registry = this.deps.registry
    if (!registry) return next
    return {
      enabled: next.enabled !== false,
      agents: registry.roster(next)
        .map(entry => entry.effective)
        .filter(config => config.enabled && Boolean(config.command)),
    }
  }

  /**
   * 模型目录要的 agent 表(`models.getWithCapabilities` 的 acp 那一格):种子与用户条目全列
   * (没装的也列,壳据探测置灰),注册表来的只列启用的 —— 注册表有四十来家,全列进模型
   * 选择器是噪音。没有名册 = 设置原样。
   */
  modelAgents(): ACPAgentConfig[] {
    const registry = this.deps.registry
    if (!registry) return this.deps.settings().agents ?? []
    return registry.roster(this.deps.settings())
      .filter(entry => entry.source !== 'registry' || entry.effective.enabled)
      .filter(entry => Boolean(entry.effective.command))
      .map(entry => entry.effective)
  }

  /** `acp.getAgents` 的行:名册每一行 × 管家的连接状态,补上 manifest / 来处 / 探测。 */
  agentStates(): ACPAgentState[] {
    return this.roster().map(entry => this.rowOf(entry))
  }

  agentState(agentId: string): ACPAgentState | undefined {
    const entry = this.roster().find(row => row.manifest.id === agentId)
    return entry ? this.rowOf(entry) : this.deps.manager.getAgentState?.(agentId)
  }

  /** 探测一台或全部,答刷新后的整张名册行。 */
  async detect(agentId?: string): Promise<ACPAgentState[]> {
    await this.deps.registry?.detect(agentId)
    return this.agentStates()
  }

  /** 立刻重拉注册表(不看 TTL)并探测,答刷新后的整张名册行。 */
  async refreshRegistry(): Promise<ACPAgentState[]> {
    await this.deps.registry?.refresh({ network: true, force: true, signal: this.backgroundAbort.signal })
    return this.agentStates()
  }

  private rowOf(entry: AcpAgentRosterEntry): ACPAgentState {
    const live = this.deps.manager.getAgentState?.(entry.manifest.id)
    const base: ACPAgentState = live ?? {
      config: entry.effective,
      status: 'disconnected',
      sessionCount: 0,
      activePromptCount: 0,
    }
    return {
      ...base,
      manifest: entry.manifest,
      source: entry.source,
      ...(entry.detect ? { detect: entry.detect } : {}),
    }
  }

  /**
   * agent 进程没了(连接从 `connected` 掉到别的状态:崩了、断了、闲置回收、刷新重连)→ 它名下的
   * 桥凭据全部作废(A4-b)。它起的桥子进程随它一起死了,钥匙留着只会让一把没人用的钥匙活着;
   * 下一轮开会话时重签一枚,经 `session/load` / `resume` 递给新进程。
   *
   * 判据是「从 connected 掉下来」而不是「现在不是 connected」:连接器签完凭据才开会话,那一路上
   * 会经过 disconnected → connecting → connected,按「现在」判会把刚签的那枚当场作废。
   */
  private noteAgentState(state: ACPAgentState): void {
    const agentId = state.config.id
    const previous = this.lastAgentStatus.get(agentId)
    this.lastAgentStatus.set(agentId, state.status)
    if (previous !== 'connected' || state.status === 'connected') return
    const revoked = this.hostMcpBridge.revokeAgent(agentId)
    if (revoked > 0) log.info('bridge credentials revoked: agent connection ended', { agentId, status: state.status, revoked })
  }

  /** 管家推出来的 agent 状态没有名册那一半;出网之前补上,壳收到的每一行形状一样。 */
  private decoratedSource(source: AcpStateSource): AcpStateSource {
    return {
      onSessionStateChanged: (listener: (state: AcpSessionState) => void) => source.onSessionStateChanged(listener),
      onAgentStateChanged: (listener: (state: ACPAgentState) => void) =>
        source.onAgentStateChanged(state => listener(this.decorate(state))),
    }
  }

  private decorate(state: ACPAgentState): ACPAgentState {
    if (!this.deps.registry) return state
    try {
      const entry = this.roster().find(row => row.manifest.id === state.config.id)
      if (!entry) return state
      return { ...state, manifest: entry.manifest, source: entry.source, ...(entry.detect ? { detect: entry.detect } : {}) }
    } catch (error) {
      log.warn('acp agent state decorate failed', { agentId: state.config.id }, error)
      return state
    }
  }

  /** 幂等;在途/已起好返回同一只 promise;已在 dispose 则 no-op。失败不粘住。 */
  start(): Promise<void> {
    if (this.disposing) return Promise.resolve()
    if (this.starting) return this.starting
    this.everStarted = true
    this.currentState = 'starting'
    const run = this.runStart()
    this.starting = run
    run.catch(() => {
      if (this.starting === run) this.starting = null
    })
    return run
  }

  private async runStart(): Promise<void> {
    try {
      const registry = this.deps.registry
      // 种子与缓存**同步**先读(连同「装没装」的同步判断),名册在任何联网之前就能用。
      registry?.loadLocal()
      if (registry) this.deps.manager.setAgentAliases?.(registry.aliases())
      await this.deps.manager.initialize(this.managerSettings(this.deps.settings()))
      if (this.currentState === 'starting') this.currentState = 'running'
      // 联网拉注册表 + 取版本号在后台跑;名册有变由 `onChanged` 重喂管家。不 await:
      // CLI daemon 的装配会等 `start()`,不能让一次离线超时拖住它。
      registry?.refresh({ network: true, signal: this.backgroundAbort.signal })
        .catch(error => log.warn('acp roster refresh failed', {}, error))
    } catch (error) {
      if (this.currentState === 'starting') this.currentState = 'idle'
      throw error
    }
  }

  /**
   * 设置域改完 ACP 设置后调;名册变化也走这里。重算名册 → 把生效配置喂给管家。
   */
  async applySettings(next: ACPSettings): Promise<void> {
    if (this.deps.registry) this.deps.manager.setAgentAliases?.(this.deps.registry.aliases())
    await this.deps.manager.updateSettings(this.managerSettings(next))
  }

  /**
   * 幂等;先等在途的 start 落地(不管成败),再 shutdown;从未 start 过则不 shutdown。
   *
   * **等待有界**({@link DEFAULT_ACP_DISPOSE_TIMEOUT_MS}):那两段合起来超时就记一行
   * warn 并照常返回,让 dispose 链后面的账本 flush 一定跑得到。
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposing = (async () => {
      this.backgroundAbort.abort()
      // 钥匙先作废:关机途中还在跑的桥子进程再来调,一律 401 / 拒,而不是打进一台半拆的核。
      this.hostMcpBridge.revokeAll()
      for (const stop of this.stopCredentialWatch.splice(0)) stop()
      // 投影先退:收尾途中 agent 断开那一下只改进程格,不该再往待办 / 会话名上写。
      for (const stop of this.stopProjections.splice(0)) stop()
      this.stopRegistryWatch?.()
      this.stopRegistryWatch = undefined
      const startedAt = Date.now()
      const timedOut = await this.raceDisposeTimeout(this.shutdownInFlightThenManager())
      if (timedOut) {
        log.warn('acp shutdown timed out; continuing dispose', {
          elapsedMs: Date.now() - startedAt,
          agents: this.countConfiguredAgents(),
        })
      }
      this.starting = null
      this.currentState = 'disposed'
      // 放在 shutdown 之后:agent 断开那一下的状态还要发得出去。
      this.stopStateBroadcast?.()
      this.stopStateBroadcast = undefined
    })()
    return this.disposing
  }

  /** 计时区里的活:先等在途的 start,再关 manager。 */
  private async shutdownInFlightThenManager(): Promise<void> {
    const inFlight = this.starting
    if (inFlight) await inFlight.catch(() => undefined)
    if (this.everStarted) await this.deps.manager.shutdown()
  }

  /** 见 `McpSubsystem.raceDisposeTimeout`,逐字同型。 */
  private raceDisposeTimeout(work: Promise<void>): Promise<boolean> {
    const timeoutMs = this.deps.disposeTimeoutMs ?? DEFAULT_ACP_DISPOSE_TIMEOUT_MS
    work.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    return Promise.race([work.then(() => false), deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /** warn 里的读数。设置读法是宿主的闭包,读不到就不写这一格。 */
  private countConfiguredAgents(): number | undefined {
    try {
      return this.deps.settings().agents.length
    } catch {
      return undefined
    }
  }
}
