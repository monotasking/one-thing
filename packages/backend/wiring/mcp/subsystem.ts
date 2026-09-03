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
}

export type McpSubsystemState = 'idle' | 'starting' | 'running' | 'disposed'

export class McpSubsystem {
  private readonly deps: McpSubsystemDeps
  private readonly setCapabilitiesChangedHandler: McpCapabilitiesChangedPort
  private starting: Promise<void> | null = null
  private disposing: Promise<void> | null = null
  /**
   * 起过没有 —— 决定 `dispose()` 要不要叫 `shutdown()`。
   *
   * 判据刻意是"**我**起过没有",不是"manager 现在是不是 initialized":standalone server
   * 这期仍然自己直调 `appMCPManager.initialize`(§2.2 留账),而它那只 backend 的
   * `mcpAcp` 是关的 —— 若按 manager 的状态判,backend 的 dispose 会顺手把 server 自己
   * 管着的那台 MCP 关掉,那是今天没有的行为。反过来,只要我起过,就算 manager 早被
   * 别人 initialize 过(`initialize` 遇到已初始化会退化成 `updateSettings`),照样 shutdown。
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
   * 完了或者失败了",不是"它成功了"),再摘 capabilities 口、再 `shutdown()`。
   *
   * 从未 start 过 → 不叫 `shutdown()`:这只 backend 没起过 MCP,替别人关门不是它的事
   * (逐字保留 C1 之前 `own('mcpAcp')` 里那句 `if (!options.mcpAcp) return`)。
   */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposing = (async () => {
      const inFlight = this.starting
      if (inFlight) await inFlight.catch(() => undefined)
      this.setCapabilitiesChangedHandler(null)
      if (this.everStarted) await this.deps.manager.shutdown()
      this.starting = null
      this.currentState = 'disposed'
    })()
    return this.disposing
  }
}
