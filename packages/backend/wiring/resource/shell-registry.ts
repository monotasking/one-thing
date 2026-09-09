/**
 * K2b-2 —— 壳侧自述的登记簿(`docs/design/atom-2026-09.md` §10.2)。
 *
 * §10.2 那张表把提供者的寿命分成两种,规矩相同:
 *
 *   · **home 在 core 的**寿命 = 装配(`mountBuiltinResources` 一次登记到 dispose);
 *   · **home 在 shell 的**寿命 = **那扇壳的连接** —— 壳连上时经 RPC 交自述,
 *     断线 / 关窗 / 换 core 时注销;在飞的 shell 做法收到
 *     `ResourceHomeUnavailableError`,**不是超时**。
 *
 * 这只文件就是第二行。它管三件事:谁交了哪几个 scheme、同一个 scheme 被两扇壳抢
 * 的时候谁赢、以及一扇壳没了之后怎么收场。
 *
 * ## 注销的次序是有讲究的,三步一步都不能换
 *
 *   ① `dispatch.release(scheme, shellId)` —— 先断路由。之后再来的调用连命令都发不
 *      出去,当场 `ResourceHomeUnavailableError`,而不是发出去等一轮超时。
 *   ② `await dispatch.failShell(shellId)` —— 在飞的以 `ResourceHomeUnavailableError`
 *      收场,**并且等这个结局真的定下来**。它必须在 ③ 之前:③ 的第一句是拉这个
 *      scheme 的取消源,而取消源一响,`Outcome.fromError` 就只看 `scope.aborted`
 *      (`outcome.ts` 头注释),上面那句精心命名的错会被洗成一句 `aborted`。
 *      §10.2 要的是「断线」这个具体答案,不是一句泛泛的「被取消了」。
 *   ③ `await unmount()` —— 摘注册表、工具表、校验器认领。逆序、逐个 await
 *      (并发摘会让「逆序」这句话失效,同 `mountBuiltinResources`)。
 *
 * ## 断线钩子今天没有,所以有一条心跳兜底
 *
 * 壳的寿命该等于它那条 SSE 连接,而 `/api/events` 那一侧确实有 `request.on('close')`。
 * 缺的是**把那条连接与一个 `shellId` 对上**:HTTP 侧今天不填
 * `RpcDispatchContext.callerId`(K2a' 留账的第一个坑),而 mount 走的是
 * `POST /api/rpc`、事件走的是 `GET /api/events`,两条不同的连接。所以本单只做
 * **显式 `unmountShell` + 一条心跳兜底**:壳每 N 秒(建议 30s)幂等地 `mountShell`
 * 一次续命,后端 3N 没等到就当它走了。
 *
 * **心跳是兜底,不是主路。** 主路是壳自己在关窗 / 断开时调 `unmountShell`;心跳只
 * 负责收拾「壳没来得及说再见」的那一种(崩溃、拔网线、进程被杀)。真正的修法是让
 * SSE 连接带上 `shellId`,那要先动 `callerId` 那一格 —— 归拍板,不归本单。
 *
 * ## 幂等续命为什么不重新登记一遍
 *
 * 契约那句「同一 `shellId` 重复 mount 同一 scheme = 先注销再登记」说的是**可观察的
 * 结果**:mountShell 返回之后,注册表里躺着的就是你刚交的那一份。自述一字未变时
 * 摘了再装,结果逐字相同,代价却是每 30 秒一次注册表通知 → 事件桥重订阅 → 工具面
 * 重投影。所以自述**变了**才走「先注销再登记」,没变就只是盖一个时刻。
 */

import { ResourceSchemeTakenError, type ResourceKernel } from '@onething/core/resource'
import type { MountShellResourceResponse, SerializedResourceSpec, ShellCommandResult } from '@shared/ipc/resources.js'
import type { ShellCommandDispatch } from './shell-dispatch.js'
import { ShellResourceProvider, resourceSpecFromShell } from './shell-provider.js'

/** 壳交上来的东西不成形。它是一次编程错误,不是一种结局 —— 所以抛,由派发器折成 `{ok:false}`。 */
export class ShellMountShapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ShellMountShapeError'
  }
}

/** 一条回执报给了一扇没登记过的壳。同上:不是结局,是错。 */
export class UnknownShellError extends Error {
  readonly shellId: string

  constructor(shellId: string) {
    super(`No shell is registered as ${JSON.stringify(shellId)}`)
    this.name = 'UnknownShellError'
    this.shellId = shellId
  }
}

interface ShellMount {
  /** scheme → 摘它的那个闭包(内核 `mount` 给的,异步)。登记顺序即插入顺序。 */
  readonly unmounts: Map<string, () => Promise<void>>
  /** scheme → 上一次收到的那份自述的字面。续命时用它判「自述变没变」。 */
  readonly specs: Map<string, string>
  lastSeen: number
}

export interface ShellMountRegistryOptions {
  /**
   * 心跳周期 N(毫秒)。壳每 N 秒续一次命,**3N** 没续就当它走了。
   * 也是过期扫描的周期 —— 扫得比心跳更勤没有意义。
   */
  readonly heartbeatMs?: number
  readonly now?: () => number
}

export const DEFAULT_SHELL_HEARTBEAT_MS = 30_000

export class ShellMountRegistry {
  /**
   * 这台登记簿驱动的那台派发器。**公开只读** —— 它不是内部细节:登记簿与派发器
   * 是同一件事的两半(谁交了什么 / 命令往哪儿发),而路由表的唯一写者就是这里。
   * 调回执超时那格旋钮的也是它(`timeoutMs`,见 `shell-dispatch.ts`)。
   */
  readonly dispatch: ShellCommandDispatch

  private readonly kernel: ResourceKernel
  private readonly shells = new Map<string, ShellMount>()
  private readonly heartbeatMs: number
  private readonly now: () => number
  private sweeper: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(kernel: ResourceKernel, dispatch: ShellCommandDispatch, options: ShellMountRegistryOptions = {}) {
    this.kernel = kernel
    this.dispatch = dispatch
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_SHELL_HEARTBEAT_MS
    this.now = options.now ?? Date.now
  }

  /** 这扇壳交过东西没有。给 `shellResult` 的归属判定用。 */
  has(shellId: string): boolean {
    return this.shells.has(shellId)
  }

  /** 这扇壳交了哪几个 scheme,登记顺序。只给测试与诊断用。 */
  schemesOf(shellId: string): readonly string[] {
    return [...(this.shells.get(shellId)?.unmounts.keys() ?? [])]
  }

  async mountShell(shellId: string, serialized: SerializedResourceSpec): Promise<MountShellResourceResponse> {
    if (!shellId) throw new ShellMountShapeError('mountShell needs a non-empty shellId')
    const scheme = serialized?.scheme
    if (typeof scheme !== 'string' || scheme.length === 0) {
      throw new ShellMountShapeError('mountShell needs a spec with a scheme')
    }

    // 抢占判定在**做任何事之前**:另一扇壳已经认领了这个命名空间,就一个字都不动。
    // (core 自己那份同名自述由内核的 `ResourceSchemeTakenError` 兜住,见下 —— 那条
    // 路走不到这里,因为 core 的 provider 不进路由表。)
    const owner = this.dispatch.ownerOf(scheme)
    if (owner !== undefined && owner !== shellId) return { ok: false, reason: 'scheme-taken' }

    const entry = this.shells.get(shellId) ?? { unmounts: new Map(), specs: new Map(), lastSeen: 0 }
    entry.lastSeen = this.now()
    this.shells.set(shellId, entry)

    const fingerprint = JSON.stringify(serialized)
    // 续命:自述一字未变,只盖时刻。见文件头「幂等续命为什么不重新登记一遍」。
    if (entry.specs.get(scheme) === fingerprint) {
      this.startSweeping()
      return { ok: true }
    }

    // 自述变了 → 先注销再登记。**这一路不 `failShell`**:壳还在,只是换了一份自述,
    // 在飞的那几条被 scheme 级取消源掐成 `aborted` 才是实话。
    const previous = entry.unmounts.get(scheme)
    if (previous) {
      entry.unmounts.delete(scheme)
      entry.specs.delete(scheme)
      this.dispatch.release(scheme, shellId)
      await previous()
    }

    const spec = resourceSpecFromShell(serialized)
    let unmount: () => Promise<void>
    try {
      unmount = this.kernel.mount(new ShellResourceProvider(shellId, spec, this.dispatch))
    } catch (error) {
      // core 自己就有一份同名自述(`session`),或者别处先装上了 —— 与「另一扇壳先到」
      // 是同一句话,所以是同一个结局。别的登记错(自述不合规矩)照抛。
      if (error instanceof ResourceSchemeTakenError) return { ok: false, reason: 'scheme-taken' }
      throw error
    }
    this.dispatch.claim(scheme, shellId)
    entry.unmounts.set(scheme, unmount)
    entry.specs.set(scheme, fingerprint)
    this.startSweeping()
    return { ok: true }
  }

  /** 撤掉这扇壳交上来的全部 scheme。**幂等** —— 撤一扇已经不在的壳是成功。 */
  async unmountShell(shellId: string): Promise<void> {
    const entry = this.shells.get(shellId)
    if (!entry) return
    this.shells.delete(shellId)

    // ① 断路由 → ② 在飞收场并等结局定下来 → ③ 逆序摘。次序的理由在文件头。
    for (const scheme of entry.unmounts.keys()) this.dispatch.release(scheme, shellId)
    await this.dispatch.failShell(shellId)
    for (const unmount of [...entry.unmounts.values()].reverse()) await unmount()
    entry.unmounts.clear()
    entry.specs.clear()

    if (this.shells.size === 0) this.stopSweeping()
  }

  /**
   * 一条回执。**主体在 RPC 域那一层铸完了**,这里判的是另一件事:这扇壳登记过没有。
   * 没登记过就抛 —— 一条来自陌生 `shellId` 的回执不是「对不上账」,是这条通道被
   * 一个不该说话的人用了。
   *
   * 对得上账才顺手续一次命:一扇正在回执的壳显然活着。
   */
  settleResult(shellId: string, callId: string, result: ShellCommandResult): boolean {
    const entry = this.shells.get(shellId)
    if (!entry) throw new UnknownShellError(shellId)
    entry.lastSeen = this.now()
    return this.dispatch.settle(shellId, callId, result)
  }

  /** 关机:每扇壳走一遍完整的注销,再把派发器清干净。幂等。 */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopSweeping()
    for (const shellId of [...this.shells.keys()]) await this.unmountShell(shellId)
    await this.dispatch.dispose()
  }

  /**
   * 过期扫描。**兜底,不是主路**(见文件头)。
   *
   * 只在有壳的时候才开:一台没有界面的宿主(server / CLI)因此一个定时器都不多。
   * `unref` 是同一句话的另一半 —— 一条等着别人可能永远不来的心跳,不该把进程留在世上。
   */
  private startSweeping(): void {
    if (this.sweeper || this.disposed) return
    this.sweeper = setInterval(() => {
      void this.sweep()
    }, this.heartbeatMs)
    this.sweeper.unref?.()
  }

  private stopSweeping(): void {
    if (!this.sweeper) return
    clearInterval(this.sweeper)
    this.sweeper = undefined
  }

  private async sweep(): Promise<void> {
    const deadline = this.now() - this.heartbeatMs * 3
    for (const [shellId, entry] of [...this.shells]) {
      if (entry.lastSeen > deadline) continue
      await this.unmountShell(shellId)
    }
  }
}
