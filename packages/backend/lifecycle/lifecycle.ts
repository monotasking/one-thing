/**
 * 关机骨架的零依赖原语(工单 5 §1)。
 *
 * 阶段表、`own()` 登记与死线仍然住在装配层(`packages/backend/lifecycle.ts`)——
 * 那是**这个进程**的关机链。这里只放被反复手抄的那两类状态机(入场闸)与它们
 * 共用的那一个形状(`Quiescible`),于是 core / runtime / backend 三层说的是同一个词。
 *
 * 第④步批 3 起多一类:「请这个进程退出」的那一格(`lifecycle-process-shutdown.ts`)。独立后端进程的入口
 * 登记自己的收尾函数,`backend.shutdown` 这条 RPC(第二入口 `lifecycle-client-api.ts`)只问这一格。
 *
 * 10-09 起再多一类:看着父进程(`lifecycle-parent-watch.ts`),父进程没了就告诉调用者一次。发现之后怎么办
 * 不归这里管(桌面档的后端读设置决定退还是留,在包根的 `backend-launcher.ts`)。
 */
export {
  AdmissionGate,
  KeyedAdmissionGate,
  type AdmissionRejection,
  type KeyedWork,
} from './lifecycle-admission-gate.js'

// ── 进程收尾的那一格 ──────────────────────────────────────────────────────
export {
  canRequestProcessShutdown,
  configureProcessShutdownRequest,
  requestProcessShutdown,
  resetProcessShutdownRequest,
  type ProcessShutdownRequester,
} from './lifecycle-process-shutdown.js'

// ── 看着父进程(10-09 孤儿后端修复:桌面档的后端靠它发现拉起它的 Electron 没了) ──────
export {
  PARENT_WATCH_INTERVAL_MS,
  watchParentProcess,
  type ParentWatch,
  type ParentWatchOptions,
} from './lifecycle-parent-watch.js'

/**
 * 一台「先停止接活,再等在途落定」的子系统。
 *
 * 两段是**分开**的,因为关机链把它们排在两个阶段:先让全部子系统一起关闸
 * (`quiesce`),再一起排空(`drain`)。合成一个方法就变成串行 —— 第 N 台还在收活
 * 的时候第 1 台已经在等它自己那件干完了。
 */
export interface Quiescible {
  quiesce(): void | Promise<void>
  drain(): void | Promise<void>
}

/**
 * 一台子系统 + 它按需造出来的一群档(scope)。
 *
 * 「插件模型调用」与「凭证策略」两处逐字相同:一个 `closed` 布尔、一个
 * `Set<档>`、关闸时挨个关、排空时挨个等、档自己排空完把自己摘下来。
 */
export class QuiescibleScopes<T extends Quiescible> implements Quiescible {
  private readonly scopes = new Set<T>()
  private accepting = true

  get closed(): boolean { return !this.accepting }
  get size(): number { return this.scopes.size }

  /** 造档之前先问闸;拒绝的文案由持有者决定,所以这里只回答"能不能"。 */
  add(scope: T): T {
    this.scopes.add(scope)
    return scope
  }

  release(scope: T): void { this.scopes.delete(scope) }

  quiesce(): void {
    this.accepting = false
    for (const scope of this.scopes) scope.quiesce()
  }

  async drain(): Promise<void> {
    await Promise.all([...this.scopes].map(scope => scope.drain()))
  }
}
