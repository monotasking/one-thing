/**
 * K2b-2 —— `ShellDispatch` 的实现:一条 `home: 'shell'` 的做法怎么到得了壳
 * (`docs/design/atom-2026-09.md` §5「资源的家在哪就去哪跑」)。
 *
 * K1 只留了接口和「缺席即结构化降级」这条路径,理由写在 `resource/resource-tool.ts` 的
 * 头注释里:「没有壳时会发生什么」是一条要被测试钉住的行为。这只文件是另一半 ——
 * **有壳时发生什么**。
 *
 * ## 一次往返,两条既有的路
 *
 *   core → 壳:一条全局事件 `resource:shell-command`,骑既有的 `GET /api/events`;
 *   壳 → core:`resources.shellResult` RPC,骑既有的 `POST /api/rpc`。
 *
 * 一条新 SSE 路由都不开、一条新 IPC 通道都不加 —— `transport:gate` 量的正是这个。
 * 命令与回执因此走的是两条不同的连接,于是「对账」必须显式:`callId` 是唯一的
 * 缝合线,而它就是这次调用在管线里的 `Invocation.callId`(做法)——审计账本上那一
 * 行与壳上跑的那一次因此是同一个坐标,不必再维护一张对照表。
 *
 * ## 三件事必须由这里说清楚,因为别处说不了
 *
 * 1. **SSE 是广播,所以命令要带「谁该执行」。** `/api/events` 的每一帧发给每一个
 *    连着的客户端;两扇壳同时执行一次「把面板挪到右边」就是挪了两次。所以载荷里
 *    有 `shellId`,壳自己对,不匹配当没看见。
 *
 *    **发给哪一扇**(第④步批 1,决策 D8 / D276):一个 scheme 可以有好几扇壳同时认领
 *    (桌面窗口 + 浏览器壳)。用户自己点出来的那一次发回**点它的那一扇**(调用带着
 *    `callerId`,HTTP 边界从 `X-Onething-Shell-Id` 请求头铸的,永不从信封里读);
  *    AI 发起的(没有 `callerId`)发给**最近一次有活动的那一扇** —— 「活动」是那扇壳
 *    第一次登记、报一条事实(开格 / 关格)、或者亲手发起一次资源调用(`touch`,登记簿与
 *    资源域记);一样新时后认领的赢。心跳续命**不算**活动:每扇活着的壳每 30 秒都续一次,
 *    拿它判等于抓阄。
 * 2. **回执跨连接,所以必须挂超时。** 壳崩了、窗关了、断网了,回执永远不来。没有
 *    超时的话这次调用会永远悬着,连带内核的 `dispose()` 也等不到它收场(§10.1
 *    要求在飞的必须收场,不许悬着)。
 * 3. **超时与断线的结局是 `ResourceHomeUnavailableError`,不是一个泛泛的超时错。**
 *    §10.2 那张表写死了这个词:「在飞的 shell 做法收到 `ResourceHomeUnavailableError`,
 *    不是超时」。判定方读的是类名,而「这条做法的家不在了」与「这条做法跑得太慢」
 *    是两句不同的话 —— 前者该让调用方去看壳还在不在,后者该让它重试。
 *
 * ## 读也走这条通道
 *
 * 一个 `home: 'shell'` 的命名空间**整个**住在壳里,它的读法同样只有那扇壳答得出
 * 来。所以事件载荷上有一格 `kind: 'op' | 'read'`,而不是给读另开一种事件 —— 为
 * 同一条往返造第二条路,就是这一层要还的那笔债本身的形状。
 *
 * 读这一支不在 `ShellDispatch` 接口上(那个接口是 `ResourceTool` 用的,而
 * `ResourceTool` 的读一律走 `provider.read`)。它是本类多出来的一个方法,由
 * `ShellResourceProvider` 直接调 —— provider 知道自己的 scheme,所以这一支不必去
 * 猜路由。
 */

import { ResourceHomeUnavailableError, type ShellDispatch } from '@onething/backend/resource/resource-api'
import { formatRef, type ResourceRef } from '@shared/resource/ref'
import { textResult, type Result, type RunContext } from '@onething/backend/toolkit'
import type { ResourceShellCommandEvent } from '@shared/events/index.js'
import type { ShellCommandResult } from '@shared/ipc/resources.js'

/**
 * 壳说这条命令没跑成。
 *
 * 与 `ResourceHomeUnavailableError` 分得清清楚楚:那一条说「家不在了」(壳断线 /
 * 超时 / 没人认领这个 scheme),这一条说「家在,但这件事做不成」(那一格已经关了、
 * 那个文件打不开)。两句话合成一句,调用方就再也判不出该不该重试。
 */
export class ShellCommandFailedError extends Error {
  readonly scheme: string
  readonly op: string

  constructor(scheme: string, op: string, message: string) {
    super(message)
    this.name = 'ShellCommandFailedError'
    this.scheme = scheme
    this.op = op
  }
}

/** 一条已经发出去、还在等回执的命令。 */
interface PendingCommand {
  readonly shellId: string
  /** 收场时那句话要说得出「哪个命名空间的哪条做法」——所以坐标记在条目上,不去反查。 */
  readonly scheme: string
  readonly op: string
  readonly settle: (result: ShellCommandResult) => void
  readonly fail: (error: Error) => void
}

export interface ShellCommandDispatchOptions {
  /** 把一条命令放上总线。装配层给的是 `eventBus.emitGlobal`。 */
  readonly emit: (event: ResourceShellCommandEvent) => void
  /** 等回执等多久。缺省 10s。 */
  readonly timeoutMs?: number
  /** 时刻的产地。缺省 `Date.now` —— 时刻由**落账的这一层**盖(同 `resource-event-bridge.ts`)。 */
  readonly now?: () => number
}

/** 缺省的回执超时。10s:壳侧一次开格/聚焦是毫秒级,这里留的是「壳还活着但很忙」的余量。 */
export const DEFAULT_SHELL_COMMAND_TIMEOUT_MS = 10_000

export class ShellCommandDispatch implements ShellDispatch {
  /**
   * 等回执的上限。**公开可写**,而且只有一个真实的写者:装配层构造时定,测试里
   * 调小到几十毫秒去证「超时落成 `ResourceHomeUnavailableError`」。
   *
   * 不做成构造期只读,是因为这台派发器是**内核的构造参数**(`ResourceKernelOptions.
   * shell`),而内核是 `createOnethingBackend` 装出来的 —— 一个装配级用例够不着它的
   * 构造点。做成 `setXxxForTests()` 与做成一格可写字段是同一件事,后者少一层。
   */
  timeoutMs: number

  /**
   * 路由表:scheme → 认领它的那几扇壳(值是认领的先后序号,越大越新)。
   *
   * 它住在派发器里而不是登记表里,因为**路由是它的工作**:`ShellDispatch.run` 手里
   * 只有 op / ref / ctx,没有 shellId,它必须自己挑。登记簿(shellId → 有哪几个
   * scheme、怎么摘)住在 `ShellMountRegistry` 里。两张表是一个事实的两个索引,
   * 但只有一个写者(登记表),所以不会漂。
   */
  private readonly routes = new Map<string, Map<string, number>>()
  private readonly pending = new Map<string, PendingCommand>()
  private readonly options: ShellCommandDispatchOptions
  /** shellId → 它最近一次有活动的序号(越大越新)。见文件头「发给哪一扇」。 */
  private readonly activity = new Map<string, number>()
  private seq = 0
  private claimSeq = 0
  private activitySeq = 0

  constructor(options: ShellCommandDispatchOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_COMMAND_TIMEOUT_MS
  }

  /** 这扇壳认领这个 scheme。由 `ShellMountRegistry` 在登记那一刻调;已经认领过的不改先后。 */
  claim(scheme: string, shellId: string): void {
    let claimants = this.routes.get(scheme)
    if (!claimants) {
      claimants = new Map()
      this.routes.set(scheme, claimants)
    }
    if (!claimants.has(shellId)) {
      this.claimSeq += 1
      claimants.set(shellId, this.claimSeq)
    }
  }

  /** 这扇壳不再认领这个 scheme。别的认领者不受影响;一个都不认领了就忘掉它的活动读数。 */
  release(scheme: string, shellId: string): void {
    const claimants = this.routes.get(scheme)
    if (!claimants) return
    claimants.delete(shellId)
    if (claimants.size === 0) this.routes.delete(scheme)
    if (![...this.routes.values()].some(rest => rest.has(shellId))) this.activity.delete(shellId)
  }

  /** 这扇壳此刻有活动(见文件头「发给哪一扇」)。没认领任何 scheme 的壳记了也白记,不记。 */
  touch(shellId: string): void {
    if (![...this.routes.values()].some(claimants => claimants.has(shellId))) return
    this.activitySeq += 1
    this.activity.set(shellId, this.activitySeq)
  }

  /** 认领这个 scheme 的那几扇壳,认领先后序。只给登记簿、测试与诊断用。 */
  claimantsOf(scheme: string): readonly string[] {
    return [...(this.routes.get(scheme)?.keys() ?? [])]
  }

  /**
   * 这一次发给哪一扇(决策 D276)。发起者认领了这个 scheme → 就是它;否则挑最近一次有活动的
   * 那一扇,活动读数一样(或都读不到)时后认领的赢。没人认领 → `undefined`。
   */
  pick(scheme: string, callerId?: string): string | undefined {
    const claimants = this.routes.get(scheme)
    if (!claimants || claimants.size === 0) return undefined
    if (callerId !== undefined && claimants.has(callerId)) return callerId
    let best: string | undefined
    let bestActivity = -Infinity
    let bestClaim = -Infinity
    for (const [shellId, claimedAt] of claimants) {
      const activity = this.activity.get(shellId) ?? -Infinity
      if (activity > bestActivity || (activity === bestActivity && claimedAt > bestClaim)) {
        best = shellId
        bestActivity = activity
        bestClaim = claimedAt
      }
    }
    return best
  }

  /** 还在等回执的条数。只给测试与诊断用。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * `ShellDispatch` 的那一支:做一件事。
   *
   * scheme 从 `ref` 上取,`ref` 缺席(这一次说的是整个命名空间)时退回
   * `invocation.toolId` —— 那一格就是 scheme:`ResourceTool.spec.id = spec.scheme`,
   * 而内核铸 `Invocation` 时写的也是 `parsed.scheme`。两条路都指着同一个字符串。
   *
   * `callId` **直接用 `invocation.callId`**:审计账本上那一行与壳上跑的那一次因此
   * 是同一个坐标。
   */
  async run(op: string, ref: ResourceRef | null, params: unknown, ctx: RunContext, planned?: unknown): Promise<Result> {
    const scheme = ref?.scheme ?? ctx.invocation.toolId
    const answer = await this.send({
      kind: 'op',
      scheme,
      op,
      ref,
      params,
      ...(planned !== undefined ? { planned } : {}),
      callId: ctx.invocation.callId,
      ...(ctx.invocation.callerId !== undefined ? { callerId: ctx.invocation.callerId } : {}),
      signal: ctx.abort.signal,
    })
    return textResult(answer)
  }

  /**
   * 读的那一支。`ShellResourceProvider` 直接调它 —— provider 知道自己的 scheme,
   * 所以这一支不必猜路由。
   *
   * `callId` 这里是**铸的**:读没有 `Invocation`(`ResourceReadContext` 刻意比
   * `PlanContext` 窄 —— 读没有 plan 阶段),所以借不到那个坐标。前缀与 uuid 撞不上,
   * 也一眼看得出它不是一次「做」的 callId。
   */
  async read(
    scheme: string,
    name: string,
    ref: ResourceRef | null,
    query: unknown,
    signal: AbortSignal,
    callerId?: string,
  ): Promise<string> {
    return this.send({
      kind: 'read',
      scheme,
      op: name,
      ref,
      params: query,
      callId: this.mintReadCallId(scheme),
      ...(callerId !== undefined ? { callerId } : {}),
      signal,
    })
  }

  /**
   * 一条回执到了。返回「有没有对上账」—— 对不上不是错误:一条在超时之后才回来的
   * 回执是正常的(命令已经以 `ResourceHomeUnavailableError` 收场了),这里没有第二
   * 件事可做。
   *
   * `shellId` 要对得上:一扇壳不许替另一扇壳收场。这不是防御性编程,是这条通道的
   * 唯一一道归属判定 —— 命令是广播出去的。
   */
  settle(shellId: string, callId: string, result: ShellCommandResult): boolean {
    const entry = this.pending.get(callId)
    if (!entry || entry.shellId !== shellId) return false
    entry.settle(result)
    return true
  }

  /**
   * 这扇壳没了(显式注销 / 心跳过期)。它在飞的全部以 `ResourceHomeUnavailableError`
   * 收场 —— §10.2:「在飞的 shell 做法收到 `ResourceHomeUnavailableError`,不是超时」。
   *
   * ## 为什么最后要让出一个宏任务
   *
   * 因为紧接着 `ShellMountRegistry` 会去调内核的注销,而内核的注销**第一句就是拉
   * 这个 scheme 的取消源**。而 `Outcome.fromError(error, scope)` 给了 scope 时判据
   * 只有一个:`scope.aborted`(`outcome.ts` 头注释写死的 —— 按错误对象判会把工具的
   * 失败洗成用户的取消)。所以取消源只要在管线读到结局之前响,上面这几条精心命名
   * 的错就会被统统洗成 `aborted`。
   *
   * 从「拒绝」到「管线把它折成 `Outcome`」之间**全是微任务**(`send` 的 await →
   * `ResourceTool.apply` → `ToolRunner` 的 catch)。让出一个宏任务 = 微任务队列排空
   * = 那几条结局都已经定下来了。这不是掐时间,是事件循环的定义。
   */
  async failShell(shellId: string): Promise<void> {
    const doomed = [...this.pending.entries()].filter(([, entry]) => entry.shellId === shellId)
    if (doomed.length === 0) return
    for (const [, entry] of doomed) {
      entry.fail(new ResourceHomeUnavailableError(entry.scheme, entry.op, 'shell'))
    }
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0)
    })
  }

  /** 关机:在飞的全部收场,路由表清空。幂等。 */
  async dispose(): Promise<void> {
    for (const shellId of new Set([...this.pending.values()].map(entry => entry.shellId))) {
      await this.failShell(shellId)
    }
    this.routes.clear()
    this.activity.clear()
  }

  private send(command: {
    kind: 'op' | 'read'
    scheme: string
    op: string
    ref: ResourceRef | null
    params: unknown
    planned?: unknown
    callId: string
    callerId?: string
    signal: AbortSignal
  }): Promise<string> {
    const shellId = this.pick(command.scheme, command.callerId)
    // 没人认领这个 scheme = 家不在了。与「这台宿主根本没有壳」是同一句话,所以是
    // 同一个错 —— 调用方要判的是「还能不能做」,不是「为什么不能」。
    if (!shellId) throw new ResourceHomeUnavailableError(command.scheme, command.op, 'shell')

    return new Promise<string>((resolve, reject) => {
      // 收场要撤的东西登记在一张表里,而不是几格 `let`:定时器与 abort 监听是**同一件
      // 事的两半**(「不再等这条回执了」),分开记就有分开忘的机会。同 `own()` 那条
      // 「谁起的谁给出收尾」。
      const cleanup: Array<() => void> = []
      const finish = (): void => {
        for (const undo of cleanup.splice(0)) undo()
        this.pending.delete(command.callId)
      }
      const entry: PendingCommand = {
        shellId,
        scheme: command.scheme,
        op: command.op,
        settle: result => {
          finish()
          if (result.kind === 'ok') resolve(result.text)
          else reject(new ShellCommandFailedError(command.scheme, command.op, result.message))
        },
        fail: error => {
          finish()
          reject(error)
        },
      }
      this.pending.set(command.callId, entry)

      if (command.signal.aborted) {
        entry.fail(new Error(`Resource ${command.scheme}: ${command.op} was cancelled before it reached the shell`))
        return
      }
      const onAbort = (): void => {
        // 归因不在这里判:取消源响了的时候 `Outcome.fromError` 只看 scope,
        // 抛什么都会被折成 `aborted`。这里只负责**立刻收场**,不悬着。
        entry.fail(new Error(`Resource ${command.scheme}: ${command.op} was cancelled`))
      }
      command.signal.addEventListener('abort', onAbort, { once: true })
      cleanup.push(() => command.signal.removeEventListener('abort', onAbort))

      const timer = setTimeout(() => {
        entry.fail(new ResourceHomeUnavailableError(command.scheme, command.op, 'shell'))
      }, this.timeoutMs)
      // 一条等回执的定时器不该把进程留在世上(CLI 跑完一条命令就该退)。
      timer.unref?.()
      cleanup.push(() => clearTimeout(timer))

      this.options.emit({
        type: 'resource:shell-command',
        shellId,
        callId: command.callId,
        kind: command.kind,
        ref: command.ref ? formatRef(command.ref) : null,
        scheme: command.scheme,
        op: command.op,
        params: asRecord(command.params),
        ...(command.planned !== undefined ? { planned: command.planned } : {}),
        at: (this.options.now ?? Date.now)(),
      })
    })
  }

  private mintReadCallId(scheme: string): string {
    this.seq += 1
    return `shell-read-${scheme}-${this.seq}`
  }
}

/** 载荷过线时是一个 JSON 对象。不是对象就当空 —— 事件载荷的形状不该由调用方决定。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
