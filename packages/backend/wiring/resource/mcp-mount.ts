/**
 * K5-a —— MCP 投影驱动的**寿命**
 * (`docs/design/atom-2026-09.md` §10.2:「插件 / 外部提供者的寿命 = 连接期」)。
 *
 * `mcp-provider.ts` 回答「一台 server 长什么样、怎么打电话」;这只文件回答另外三
 * 件事,而它们全是 §10.2 那张表在这一族 scheme 上的填法:
 *
 *   · **连上 → `mount`**:那台 server 出现在注册表里,`resources list` / RPC
 *     `describe` / CLI 立刻够得着它;
 *   · **断开 → 注销**:内核那只注销先掐掉这个 scheme 的在飞、等它们以
 *     `Outcome.aborted` 收场,再摘表(「不许摘了之后 apply 还在写」);
 *   · **工具表变了 → 重挂**:先注销再登记(内核支持,`registry.register` 身份判
 *     等),于是所有出口的投影跟着重建。判据是投影的 `fingerprint` —— 不是原始
 *     工具表:一台 server 把描述里的空格改了一个而投影逐字相同,不该把一个正在被
 *     调用的命名空间摘掉再装回去。
 *
 * ## 事件产地:为什么订的是 `registerMCPTools` 而不是 manager
 *
 * `HeadlessMCPManager` **没有事件**(没有 emitter、没有订阅口,`getServerStates()`
 * 是一次快照)。`McpSubsystem` 也没有:它有 `start` / `applySettings` / `dispose`
 * 三个方法,而 RPC 的 connect / disconnect / refresh **不经过它**(`rpc/domains/mcp.ts`
 * 直接调 `MCPManager` + `registerMCPTools`)。既有的 `configureMCPCapabilitiesChangedHandler`
 * 与它的 toolkit 双胞胎是**单槽**、而且只覆盖「服务器推来 list_changed」这一种变化,
 * 抢任何一格都会让工具目录或宿主的 registerTools 失聪。
 *
 * 唯一同时覆盖五种变化(连上 / 断开 / 换设置 / 整个关掉 / 工具表变了)的汇合点是
 * **`registerMCPTools()`**:上面每一条路的收尾都调它。所以 K5-a 在那只函数的第一
 * 行加了一发多播通知(`runtime/mcp/capabilities-changed.ts` 的
 * `onMCPToolTableChanged`),这里订它。**通知不带内容** —— 它只说「可能变了」,变
 * 成什么样由这里去问一次快照。一条带内容的通知会立刻要求产地知道订阅方在乎什么。
 *
 * ## 为什么是对账,不是「connect 时顺手 mount」
 *
 * 与 `catalog-sync.ts` 逐字同一条:登记的产地有七个(六只 orchestration 函数 +
 * 子系统),让每一个各自记得装、记得摘,就是「按能力枚举」的形状,而漏摘不会报
 * 错 —— 只会让注册表里留着一个打不通电话的命名空间。对账只认一份事实(manager 的
 * 那份快照),产地加多少个都不必回来改这只文件。
 *
 * ## 为什么串成一条队列
 *
 * 注销是**异步**的(要等在飞收场)。两发通知贴着来的时候,第二次对账不能在第一次
 * 的注销还没落地时就去读表 —— 它会看见一个「已经决定要摘、但还没摘」的 scheme,
 * 然后要么重复摘、要么在旧的还没走之前装一个同名的新的(`registry.register` 会
 * 抛 `ResourceSchemeTakenError`)。一条 promise 链把这件事在结构上关掉。
 */

import type { ResourceKernel } from '@onething/core/resource'
import type { MCPServerState } from '@onething/core/mcp'
import { onMCPToolTableChanged } from '@onething/runtime/mcp/capabilities-changed'
import { mcpResourceScheme, projectMcpResource } from '@onething/runtime/mcp/resource-spec'
import { getLogger } from '../logging/index.js'
import { McpResourceProvider, type McpResourceCallPort } from './mcp-provider.js'

const log = getLogger('app.resource.mcp')

/**
 * 这只驱动看得见的 manager 面 —— 两件事,不是整只 `MCPManager`。
 *
 * 窄成这样单测才注入得起一只替身;生产上传进来的仍然是那台进程单例。它也把
 * 「这只驱动会不会自己去连 / 去断一台 server」在类型上答死了:连接的生命周期归
 * `McpSubsystem`,这里只**读快照**和**打电话**。
 */
export interface McpResourceManagerPort extends McpResourceCallPort {
  getServerStates(): MCPServerState[]
}

export interface McpResourceMountOptions {
  readonly kernel: ResourceKernel
  readonly manager: McpResourceManagerPort
  /**
   * 「工具表可能变了」的订阅口。返回退订。
   *
   * 缺席 = 产品层那口(`onMCPToolTableChanged`)。单测传自己的 —— 那是这一单的
   * 反证做得出来的原因:不必起一台真 MCP 就能演「连上 / 断开 / 工具表变了」。
   */
  readonly subscribe?: (listener: () => void) => () => void
}

/** 一台已经挂上去的 server 的账。 */
interface MountedServer {
  readonly scheme: string
  readonly fingerprint: string
  readonly unmount: () => Promise<void>
}

/** 一台**该**挂着的 server:这一轮算出来的地址、指纹与实现。 */
interface DesiredServer {
  readonly scheme: string
  readonly fingerprint: string
  readonly provider: McpResourceProvider
}

class McpResourceMount {
  private readonly options: McpResourceMountOptions
  private readonly mounted = new Map<string, MountedServer>()
  /** 对账串成一条链,理由见文件头。`dispose` 也排在这条链上。 */
  private queue: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(options: McpResourceMountOptions) {
    this.options = options
  }

  /** 排一次对账。**不抛** —— 它跑在通知产地的调用栈上(见文件头)。 */
  schedule(): Promise<void> {
    this.queue = this.queue.then(() => this.reconcile()).catch((error: unknown) => {
      log.error('mcp resource reconcile failed', {}, error)
    })
    return this.queue
  }

  /** 全部摘掉,并且不再接受新的对账。幂等。 */
  dispose(): Promise<void> {
    this.stopped = true
    this.queue = this.queue.then(() => this.unmountAll()).catch((error: unknown) => {
      log.error('mcp resource unmount failed', {}, error)
    })
    return this.queue
  }

  private async reconcile(): Promise<void> {
    if (this.stopped) return

    /*
     * 只认**连上的**。§10.4 那张表把「已启用」与「运行中」分开,而对一台外部
     * server 来说这两格的判据是同一个事实:连着才打得通电话。一台 `error` /
     * `connecting` 的 server 挂上去,等于给出口一个必然失败的命名空间。
     *
     * 按 id 字典序:scheme 的分配要与连接完成的顺序无关(见 `mcpResourceScheme`)。
     */
    const connected = this.options.manager
      .getServerStates()
      .filter(state => state.status === 'connected')
      .sort((a, b) => a.config.id.localeCompare(b.config.id))

    /*
     * 地址分配,**两趟**。
     *
     * 第一趟先把已经挂着的那些占的名字全收进 `taken`,第二趟才给新来的分配 ——
     * 一趟做不出来:按 id 字典序遍历时,一台**新** server 可能排在一台已挂着的
     * 前面,于是它先拿走了那个名字,把在位的那台挤成「撞名 → 跳过」。地址是能被
     * 写进快捷键、deeplink、一句话里的东西,**在位的永远不改名、也不被挤掉**。
     */
    const taken = new Set<string>()
    const keep = new Map<string, string>()
    for (const state of connected) {
      const existing = this.mounted.get(state.config.id)?.scheme
      if (!existing) continue
      keep.set(state.config.id, existing)
      taken.add(existing)
    }

    const desired = new Map<string, DesiredServer>()
    for (const state of connected) {
      const serverId = state.config.id
      const scheme = keep.get(serverId) ?? mcpResourceScheme(serverId, taken)
      if (!scheme) {
        // 归一之后什么都没剩下(id 全是标点)。跳过并说出来 —— 编一个名字出来等于
        // 给了一个谁都指不着的地址。
        log.warn('mcp server has no usable resource scheme', { serverId })
        continue
      }
      taken.add(scheme)
      const projection = projectMcpResource({
        scheme,
        title: state.config.name || serverId,
        tools: state.tools,
      })
      desired.set(serverId, {
        scheme,
        fingerprint: projection.fingerprint,
        provider: new McpResourceProvider(serverId, projection, this.options.manager),
      })
    }

    // 先摘后装,而且**逐个 await**:同一个 scheme 换一份自述时,旧的必须先真的走完
    // (在飞收场 + 表摘干净),否则 `registry.register` 撞名当场抛。
    for (const [serverId, record] of [...this.mounted]) {
      const want = desired.get(serverId)
      if (want && want.scheme === record.scheme && want.fingerprint === record.fingerprint) continue
      this.mounted.delete(serverId)
      await record.unmount()
    }

    if (this.stopped) return

    for (const [serverId, want] of desired) {
      if (this.mounted.has(serverId)) continue
      this.mounted.set(serverId, {
        scheme: want.scheme,
        fingerprint: want.fingerprint,
        unmount: this.options.kernel.mount(want.provider),
      })
    }
  }

  private async unmountAll(): Promise<void> {
    for (const [serverId, record] of [...this.mounted]) {
      this.mounted.delete(serverId)
      await record.unmount()
    }
  }
}

/**
 * 把这台进程上**已连接**的每一台 MCP server 投影成一个命名空间,并跟着连接来去。
 * 返回退订 + 把挂过的全部摘掉(异步 —— §10.2 要求摘之前先让在飞收场)。
 *
 * 开局对账一次:装配时可能已经有连着的 server(CLI daemon 的 `mcpAcp: true` 在
 * 装配里就 `start()`),而一次「我起来晚了」不该让它们等到下一次连接变更才出现。
 */
export function mountMcpResources(options: McpResourceMountOptions): () => Promise<void> {
  const mount = new McpResourceMount(options)
  const subscribe = options.subscribe ?? onMCPToolTableChanged
  const unsubscribe = subscribe(() => {
    void mount.schedule()
  })
  void mount.schedule()
  return async () => {
    unsubscribe()
    await mount.dispose()
  }
}
