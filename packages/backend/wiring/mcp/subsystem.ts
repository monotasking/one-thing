/**
 * MCP 子系统对象(C1,`docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 从前 MCP 的生命周期是**散在宿主里的三段手写词**:daemon 在装配里 `initialize` +
 * `registerMCPTools`,React 壳开窗后自己再抄一遍(外加一份重复的
 * `configureMCPCapabilitiesChangedHandler`),server runtime 按 `processPorts` 抄第三遍;
 * 收尾则各自 `own(MCPManager.shutdown)`。壳那份的登记排在一个 `.then()` 里 —— 起来两秒内
 * 退出,stdio 子进程已经拉起而 shutdown 还没登记,于是成了孤儿(审查第 2 条)。
 *
 * 这只对象把那件事收成一个有状态的东西:**谁 own 它由构造点决定,何时 start 由宿主决定,
 * 而"关的时候在途的那趟怎么办"由它自己回答** —— `dispose()` 先等在途的 `start()` 落地
 * (不管成败),再 `shutdown()`。于是"登记"与"起没起完"彻底解耦:装配一构造就 `own()`,
 * 孤儿在结构上不存在。
 *
 * 依赖全部从构造参数进来(manager / 设置读法 / 工具目录重建 / capabilities 通知口),
 * 所以它在单测里不需要真起一台 MCP —— 那正是这一期反证做得出来的原因。
 */
import { configureMCPCapabilitiesChangedHandler } from '@onething/runtime/mcp/capabilities-changed'
import type { MCPSettings } from '@onething/core/mcp'
import { getLogger } from '../logging/index.js'

const log = getLogger('app.mcp.subsystem')

/**
 * 子系统看得见的 manager 面 —— 三件事,不是整只 `MCPManager`。
 *
 * 窄到这个程度是有意的:单测注入一只三件套的替身就够,而生产上传进来的仍然是
 * 那只进程单例。
 */
export interface McpSubsystemManagerPort {
  initialize(settings: MCPSettings): Promise<void>
  updateSettings(settings: MCPSettings): Promise<void>
  shutdown(): Promise<void>
}

/** capabilities-changed 那口单槽端口的形状(`null` = 摘掉)。 */
export type McpCapabilitiesChangedPort = (handler: ((serverId: string) => void) | null) => void

export interface McpSubsystemDeps {
  manager: McpSubsystemManagerPort
  /** 读**当下**的 MCP 设置。懒读:构造点比 `start()` 早,中间设置可能已经被改过。 */
  settings: () => MCPSettings
  /** 重建模型面的工具目录(`registerMCPTools`)。 */
  registerTools: () => Promise<void>
  /** 缺省是产品层那口单槽端口;单测注入自己的。 */
  onCapabilitiesChanged?: McpCapabilitiesChangedPort
  /** `dispose()` 的上限,毫秒。缺省 {@link DEFAULT_MCP_DISPOSE_TIMEOUT_MS};单测传小值。 */
  disposeTimeoutMs?: number
}

/**
 * `dispose()` 里"等在途 start + `manager.shutdown()`"这两段**合起来**的上限。
 *
 * 3000ms 这个数不是拍的,是**卡在 `apps/server/src/main.ts` 那条 5s 死线底下**:
 * `SHUTDOWN_FLUSH_TIMEOUT_MS` 到点之后 server 会打一行
 * `shutdown did not finish in time; pending session writes may be lost` 然后硬退,
 * 会话账本的 flush 就没跑完。MCP 的收尾排在 dispose 链的中段(`engineAbortAll` 之后、
 * `pluginManager` 之前),后面还挂着账本 flush —— 所以 MCP 这一格必须**自己**先认输,
 * 把剩下的 2s 留给它后面的人。
 *
 * **超时之后可能留下一只孤儿 stdio 子进程,这是有意的取舍:会话数据比 MCP 子进程重要。**
 * C1 引进"等在途 start"是为了消掉早退孤儿(那是 manager 几十毫秒内就能收摊的常态);
 * 一台在握手上挂死的服务器属于另一类事故,拿用户的消息去换它不值。
 */
export const DEFAULT_MCP_DISPOSE_TIMEOUT_MS = 3000

export type McpSubsystemState = 'idle' | 'starting' | 'running' | 'disposed'

export class McpSubsystem {
  private readonly deps: McpSubsystemDeps
  private readonly setCapabilitiesChangedHandler: McpCapabilitiesChangedPort
  private starting: Promise<void> | null = null
  private disposing: Promise<void> | null = null
  /**
   * 起过没有 —— 决定 `dispose()` 要不要叫 `shutdown()`。
   *
   * 判据刻意是"**我**起过没有",不是"manager 现在是不是 initialized"。C1 当时的理由是
   * standalone server 还自己直调 `appMCPManager.initialize`;收尾批(2026-09-03)把那处
   * 也接进了子系统,理由却仍然成立,只是换了一条:`mcpAcp:false` 且宿主从不 `start()`
   * 的那些 backend(React 壳今天的 ACP、任何只装配不起 MCP 的进程)不该替别人关门 ——
   * 按 manager 的状态判就会。反过来,只要我起过,就算 manager 早被别人 initialize 过
   * (`initialize` 遇到已初始化会退化成 `updateSettings`),照样 shutdown。
   */
  private everStarted = false
  private currentState: McpSubsystemState = 'idle'

  constructor(deps: McpSubsystemDeps) {
    this.deps = deps
    this.setCapabilitiesChangedHandler = deps.onCapabilitiesChanged ?? configureMCPCapabilitiesChangedHandler
    // 服务器推来 list_changed 时把模型面的工具目录重建一遍。接**一次**,在构造点 ——
    // 从前壳与 server runtime 各自接一份,而这是个单槽端口,谁后接谁生效。
    this.setCapabilitiesChangedHandler(() => {
      void this.deps.registerTools().catch(error => {
        log.error('mcp tools re-registration failed', {}, error)
      })
    })
  }

  get state(): McpSubsystemState {
    return this.currentState
  }

  /**
   * 幂等:在途或已起好都返回**同一只** promise。已经在 dispose 的实例上调是 no-op ——
   * 关门之后再开一台 MCP 正是这一期要消掉的那种孤儿。
   *
   * 失败不粘住:记下的 promise 清掉、状态退回 `idle`,宿主想重试就重试。
   */
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
      await this.deps.manager.initialize(this.deps.settings())
      await this.deps.registerTools()
      if (this.currentState === 'starting') this.currentState = 'running'
    } catch (error) {
      if (this.currentState === 'starting') this.currentState = 'idle'
      throw error
    }
  }

  /** 设置域改完 MCP 设置后调:改连接 + 重建工具目录,是一件事的两半。 */
  async applySettings(next: MCPSettings): Promise<void> {
    await this.deps.manager.updateSettings(next)
    await this.deps.registerTools()
  }

  /**
   * 幂等。在途的 `start()` 先等它落地(**不管成败** —— 要的是"那一趟已经把子进程拉
   * 完了或者失败了",不是"它成功了"),再 `shutdown()`。
   *
   * 从未 start 过 → 不叫 `shutdown()`:这只 backend 没起过 MCP,替别人关门不是它的事
   * (逐字保留 C1 之前 `own('mcpAcp')` 里那句 `if (!options.mcpAcp) return`)。
   *
   * **等待有界**({@link DEFAULT_MCP_DISPOSE_TIMEOUT_MS}):那两段合起来超时就记一行
   * warn 并**照常返回**,让 dispose 链后面的账本 flush 一定跑得到。摘 capabilities 口
   * 提到了计时区之外 —— 它是同步的、挂不住,而"超时了就把这只已死的 backend 留在
   * 通知端口上"是另一个泄漏。
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposing = (async () => {
      this.setCapabilitiesChangedHandler(null)
      const startedAt = Date.now()
      const timedOut = await this.raceDisposeTimeout(this.shutdownInFlightThenManager())
      if (timedOut) {
        log.warn('mcp shutdown timed out; continuing dispose', {
          elapsedMs: Date.now() - startedAt,
          servers: this.countConfiguredServers(),
        })
      }
      this.starting = null
      this.currentState = 'disposed'
    })()
    return this.disposing
  }

  /** 计时区里的活:先等在途的 start,再关 manager。 */
  private async shutdownInFlightThenManager(): Promise<void> {
    const inFlight = this.starting
    if (inFlight) await inFlight.catch(() => undefined)
    if (this.everStarted) await this.deps.manager.shutdown()
  }

  /**
   * `work` 先落地 → `false`;上限先到 → `true`(`work` 继续在后台跑,不再等它)。
   *
   * `work` 抛错仍然照旧向上抛(与加上限之前逐字相同,由 `OnethingBackend.dispose()`
   * 的逐格 try/catch 接住);同时单独挂一只 catch,免得超时之后那只没人听的 promise
   * 变成 unhandledRejection。定时器 unref + clearTimeout,自己留不住进程。
   */
  private raceDisposeTimeout(work: Promise<void>): Promise<boolean> {
    const timeoutMs = this.deps.disposeTimeoutMs ?? DEFAULT_MCP_DISPOSE_TIMEOUT_MS
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
  private countConfiguredServers(): number | undefined {
    try {
      return this.deps.settings().servers.length
    } catch {
      return undefined
    }
  }
}
