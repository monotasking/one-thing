/**
 * ACP 子系统对象(C1,`docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
 *
 * 与 `wiring/mcp/subsystem.ts` 同型,理由也同一条:登记(`own`)与启动(`start`)解耦,
 * `dispose()` 负责"在途的那趟先落地再关",于是早退不留孤儿子进程。
 *
 * 两处与 MCP 不同,都是照着代码事实来的:
 *  · `ACPManager.initialize` / `updateSettings` 是**同步**的(只是 syncClients + 起清理
 *    定时器),这里仍然包成 `Promise<void>` 并且 `await` 端口 —— 宿主面前两只子系统的
 *    形状一样,谁也不必记得"ACP 那只不用 await"。
 *  · **权限桥不在这里接**。今天接它的是 Vue 宿主自己的 `initializeACP()`
 *    (`apps/electron/src/main/ipc/acp.ts`),装配层这条路(daemon 的 `mcpAcp: true`)从来
 *    没接过。搬进来等于给 daemon 新开一条今天没有的行为,而"接不接"是产品决定,不是
 *    这一期的机械搬运。留账在方案 §2.2。
 */
import type { ACPSettings } from '@onething/runtime/acp'

/**
 * 子系统看得见的 manager 面 —— 三件事,不是整只 `ACPManager`。
 *
 * 前两件写成 `void | Promise<void>` 而不是照抄 `ACPManager` 今天的同步签名:子系统
 * `await` 它们,于是"在途的 start 必须先落地"这条对 ACP 也是**真的**(今天那只
 * manager 同步返回,`await undefined` 只多一个微任务)。照抄同步签名的话,那条分支
 * 在 ACP 这边永远观察不到,也就写不出反证。
 */
export interface AcpSubsystemManagerPort {
  initialize(settings: ACPSettings): void | Promise<void>
  updateSettings(settings: ACPSettings): void | Promise<void>
  shutdown(): Promise<void>
}

export interface AcpSubsystemDeps {
  manager: AcpSubsystemManagerPort
  /** 读**当下**的 ACP 设置(构造点比 `start()` 早)。 */
  settings: () => ACPSettings
}

export type AcpSubsystemState = 'idle' | 'starting' | 'running' | 'disposed'

export class AcpSubsystem {
  private readonly deps: AcpSubsystemDeps
  private starting: Promise<void> | null = null
  private disposing: Promise<void> | null = null
  /** 见 `McpSubsystem.everStarted`:判据是"我起过没有",不是 manager 的内部状态。 */
  private everStarted = false
  private currentState: AcpSubsystemState = 'idle'

  constructor(deps: AcpSubsystemDeps) {
    this.deps = deps
  }

  get state(): AcpSubsystemState {
    return this.currentState
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
      await this.deps.manager.initialize(this.deps.settings())
      if (this.currentState === 'starting') this.currentState = 'running'
    } catch (error) {
      if (this.currentState === 'starting') this.currentState = 'idle'
      throw error
    }
  }

  /** 设置域改完 ACP 设置后调。 */
  async applySettings(next: ACPSettings): Promise<void> {
    await this.deps.manager.updateSettings(next)
  }

  /** 幂等;先等在途的 start 落地(不管成败),再 shutdown;从未 start 过则不 shutdown。 */
  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposing = (async () => {
      const inFlight = this.starting
      if (inFlight) await inFlight.catch(() => undefined)
      if (this.everStarted) await this.deps.manager.shutdown()
      this.starting = null
      this.currentState = 'disposed'
    })()
    return this.disposing
  }
}
