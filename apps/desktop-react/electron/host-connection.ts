/**
 * **「这台壳连到哪台 core」是一个开窗之前就存在的承诺**(2026-09-15 启动次序那一批)。
 *
 * ── 病(它为什么值一只文件)──────────────────────────────────────────────
 * 从前 `main.ts` 里那一格是 `let connectionReady: Promise<…> | undefined`,而
 * `host:connection` 的 handler 写成 `connectionReady ? connectionReady : 一句错话`。
 * 那个三元只在**装配已经跑完**时才是对的:旧次序是「先 `await assembleOwnCore()`
 * (真店 ≈1.7s)→ 再开窗」,窗子出现时那一格必定已经被赋值,于是三元的 else 分支
 * 是一条永远不走的路。
 *
 * 启动次序一改(先开窗,装配与页面加载并行跑),那条路就成了主路:渲染层挂载前
 * 第一件事就是 `host.getConnection()`(`src/platform/connection.ts`),它会赶在
 * 赋值之前问到 —— 拿到 `{ ok: false, error: 'core 尚未连接' }`,而 `whenConnected()`
 * 是**一次性**的(`pending ??= connect()`),它不重试。表现是壳起来了、页面也画了,
 * 但这台壳这辈子都不连 core:一条假话把一次竞速变成了永久故障。
 *
 * ── 治(为什么是一个 promise,而不是「一个值 + 一次重试」)────────────────
 * 「谁来服务这个 store」这件事在进程活着的整段时间里**只答一次**,而回答的时刻
 * 比提问的时刻晚 —— 这正是 promise 这个形状说的话。所以:
 *
 *  · **构造即持有一个待定的 promise**。进程一起来(模块求值那一刻)承诺就在了,
 *    比第一扇窗早,更比渲染层的第一次提问早。于是 handler 永远有东西可还,
 *    「还没答」与「答不上」是两件不同的事,前者不必冒充后者。
 *  · **handler 永远返回同一个 promise**。不是「有就给、没有就编一句」——
 *    问得早的人和问得晚的人拿到的是同一个答案,而不是各自一个快照。渲染层那边
 *    `getConnection()` 本来就返回 Promise,契约一个字不用改。
 *  · **`resolve` 幂等**。答案只有一个:先到的那一个算数(自装那条路上挂 HTTP 面
 *    的结果,借用活 core 那条路上的发现文件记录,装配失败那条路上的错话)。
 *    第二次调用**静默忽略并交回 false** —— 不抛(抛在 `.then()` 里没人接得住),
 *    也不记日志(这只文件不 import 日志门面,它要能在 vitest 里裸跑)。调用方
 *    需要知道自己是不是第一个,就读那个返回值。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────
 * 零 electron import,零日志,零单例:gate 由 `main.ts` 持有一份(那是进程级的
 * 事实,判词写在那边的那一格上),这只文件只提供形状。
 */

/** `host:connection` 的回执:成功给基址与 token,失败给一句人话(启发式⑨)。 */
export type HostConnectionResult =
  | { ok: true; baseUrl: string; token?: string }
  | { ok: false; error: string }

/**
 * 一次性的连接承诺。构造即待定,`resolve` 一次落定,之后只读。
 */
export class HostConnectionGate {
  /**
   * 渲染层等的就是它。**永不 reject** —— 连不上是一种落地(`ok: false`),
   * 不是一次异常:handler 那边没有第二条路把异常翻译成人话。
   */
  readonly promise: Promise<HostConnectionResult>

  #settle: (result: HostConnectionResult) => void
  #settled = false

  constructor() {
    // Promise 的执行器是**同步**跑的,所以这个占位在构造结束前必定被换掉;
    // 给它一个空函数只是为了不写非空断言。
    let settle: (result: HostConnectionResult) => void = () => {}
    this.promise = new Promise<HostConnectionResult>(resolve => {
      settle = resolve
    })
    this.#settle = settle
  }

  /** 答案到了没有。给调用方(与测试)读,不影响任何行为。 */
  get settled(): boolean {
    return this.#settled
  }

  /**
   * 落定。第一次算数,交回 `true`;之后每一次都是空动作,交回 `false`。
   */
  resolve(result: HostConnectionResult): boolean {
    if (this.#settled) return false
    this.#settled = true
    this.#settle(result)
    return true
  }
}
