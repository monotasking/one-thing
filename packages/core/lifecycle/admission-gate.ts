/**
 * 「入场闸 + 在途集」—— 关机骨架里被手抄了六遍的那一段(工单 5 §1)。
 *
 * 每一台会在关机时被排空的子系统(音乐、凭证策略档、评估任务、工具执行、插件
 * 模型调用、todo 监视器……)都写了同一段:一个 `accepting` 布尔、一个
 * `AbortController`、一个在途 promise 集,外加 `assertActive / track / quiesce /
 * drain` 四个方法。抄六遍的代价不是行数,是**六份都可能写歪一处**:少一次
 * `delete`(集合永不空,`drain()` 死等)、`quiesce()` 不幂等(第二次 abort 覆盖
 * 掉第一次的理由)、`drain()` 用 `Promise.all` 于是一件失败就把整条关机链带塌。
 *
 * 这里放两只:
 *  - `AdmissionGate` —— 一个取消源管住全部在途工作(音乐、凭证策略档)。
 *  - `KeyedAdmissionGate` —— 每件在途工作**自带**取消源、按键寻址(评估任务、
 *    工具执行)。它不是前者的特例:那些子系统要按 key 单独取消一件,
 *    单取消源做不到。
 *
 * 零依赖,零 node import:这两只是纯状态机,住在 `packages/core`。
 */

/** 关机中被拒时抛什么;一律由持有者给,闸自己不认识任何一台子系统的文案。 */
export type AdmissionRejection = () => unknown

/**
 * 单取消源的入场闸。
 *
 * `quiesce()` 幂等 —— 第二次调用既不重复 abort(取消理由保持第一次那一个),也不
 * 重复通知。`drain()` 用 `allSettled` 循环:循环是因为一件在途工作可以在自己收尾
 * 时再起一件(音乐的 `sleep` 链),`allSettled` 是因为关机不该被一件失败的清理
 * 打断。
 */
export class AdmissionGate {
  private readonly controller = new AbortController()
  private readonly pending = new Set<PromiseLike<unknown>>()
  private accepting = true

  constructor(private readonly rejection: AdmissionRejection = () => new Error('Shutting down')) {}

  /** 在途工作观察它来提前退出;`quiesce()` 之后恒为 aborted。 */
  get signal(): AbortSignal { return this.controller.signal }

  get closed(): boolean { return !this.accepting }

  /** 只给测试与断言用:关机链上没人按条数决策。 */
  get pendingCount(): number { return this.pending.size }

  assertAccepting(): void {
    if (!this.accepting) throw this.rejection()
  }

  /** 登记一件在途工作并原样交回,于是调用点写得下 `return gate.track(work)`。 */
  track<T extends PromiseLike<unknown>>(work: T): T {
    this.pending.add(work)
    const settled = (): void => { this.pending.delete(work) }
    void Promise.resolve(work).then(settled, settled)
    return work
  }

  quiesce(reason?: unknown): void {
    if (!this.accepting) return
    this.accepting = false
    this.controller.abort(reason)
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}

/** 一件按键寻址的在途工作:自带取消源,自带"落定"信号。 */
export interface KeyedWork {
  abort(reason?: unknown): void
  /** 这件工作彻底落定(含它自己的清理)之后 settle;不许 reject。 */
  readonly settled: PromiseLike<unknown>
}

/**
 * 按键寻址的入场闸:一个键至多一件在途工作,每件自己能被单独取消。
 *
 * 取消理由是**每件一份**(`reason(entry)`),不是一份共享的对象 —— 工具执行那边
 * 交的是 `createToolAbortError(...)`,而错误对象带栈,共享一份等于把第一件的栈
 * 按到了所有件身上。
 */
export class KeyedAdmissionGate<T extends KeyedWork> {
  private readonly entries = new Map<string, T>()
  private accepting = true

  constructor(private readonly rejection: AdmissionRejection = () => new Error('Shutting down')) {}

  get closed(): boolean { return !this.accepting }
  get size(): number { return this.entries.size }

  assertAccepting(): void {
    if (!this.accepting) throw this.rejection()
  }

  has(key: string): boolean { return this.entries.has(key) }
  get(key: string): T | undefined { return this.entries.get(key) }
  values(): IterableIterator<T> { return this.entries.values() }

  add(key: string, entry: T): void { this.entries.set(key, entry) }

  /** 只删还是自己那一件 —— 同键的下一件已经进来时,晚到的收尾不许把它删掉。 */
  remove(key: string, entry: T): void {
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }

  quiesce(reason: (entry: T) => unknown = () => undefined): void {
    this.accepting = false
    for (const entry of this.entries.values()) entry.abort(reason(entry))
  }

  async drain(): Promise<void> {
    while (this.entries.size) await Promise.allSettled([...this.entries.values()].map(entry => entry.settled))
  }
}
