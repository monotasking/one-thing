import { currentSpaceId, subscribeCurrentSpace } from './current'

/**
 * 「**家具按工作区各持一份**」的唯一原语(T-W1,09-01 用户裁定:「切换 Workspace
 * 时架子、文件树整套都是新的一套,之前的留在那个空间」)。
 *
 * 四个 store 要的是同一件事(stage 的架子与浮窗、分屏比、打开方式、总览的折叠),
 * 所以按「基础件先行」它们**共用这一件**,不许各写各的 —— 四份手写的换装逻辑
 * 迟早会在「谁先存谁后取」上分叉,而那种 bug 的现场是「切回去布局没了」。
 *
 * ── 形:一本账 + 一份活状态 ──────────────────────────────────────────────
 * 与 `data/sessions-source.ts` 的全库账/屏幕投影是同一个形,理由也一样:
 *
 *   `byWorkspace`  = **账**(每个空间一格,落盘的就是它);
 *   store 顶层那几个字段 = **活状态**(当前空间那一格的展开,组件与动作照旧读写它)。
 *
 * 这么分是为了让**换装不经过任何一次异步**:切换 = 把活状态收进账、再把新空间
 * 那一格摊开,同步完成。于是「新世界一帧就位、零骨架」是结构保证的,而不是
 * 靠调快一点(四律第 2 条在这里的样子:根本没有重拉)。
 *
 * 另一条路(persist 键带空间 id、切换时 `setOptions({name})` + `rehydrate()`)
 * 被否掉的正是这一点:`rehydrate()` 回的是 Promise,换装就有了一个中间态 ——
 * 那一帧屏幕上是**出厂布局**,看起来就是闪一下。
 *
 * ── 什么算家具,由 `pick` 一处说了算 ────────────────────────────────────
 * 每个 store 自己交一个 `pick`(摘出家具那一份)与 `factory`(出厂布局)。
 * 存盘、换装、首进某空间三处都问这两个函数,所以「哪几格跟着空间走」在每个
 * store 里只有一个产地 —— 存的时候多摘一格、换的时候少摊一格,是这类 bug 的
 * 全部来源。
 *
 * **判据一句话:它是不是「用户在这个空间里摆好的东西」。** 是就进 `pick`
 * (架子/浮窗/分屏比/折叠态);不是就留在外面 —— Dock 贴哪条边、界面语言、
 * 键位、阅读轴都是**这台机器的偏好**,换个空间不该跟着变。
 */

/** 一本家具账:workspaceId → 那个空间的家具。 */
export type SpaceLedger<F> = Record<string, F>

/** 带账的 store 状态。四个 store 各自的 state 都 extends 它。 */
export interface PerSpaceState<F> {
  /**
   * 家具账。**落盘的是它,不是活状态** —— 活状态只是当前空间那一格的展开,
   * 两处都落盘就会有两份真相,而它们一定会在某次「先切换后刷新」时对不上。
   */
  byWorkspace: SpaceLedger<F>
}

export interface PerSpaceSpec<S, F> {
  /** 从活状态里摘出家具那一份。**「什么算家具」的单产地。** */
  pick(state: S): F
  /** 出厂布局 —— 首次进入某个空间时摊开的就是它。 */
  factory(): F
  /**
   * **换装那一拍:进场这份家具接住离场的活状态**(S1,正本
   * `apps/desktop-react/docs/dock-scope-2026-09.md` §2.3)。缺席 = 原样摊开(今天
   * 四个 store 里三个如此)。
   *
   * 起因是「有些东西不属于哪个工作区,是这台壳的」:那几格该**随人走** ——
   * 换空间那一拍从离场的活状态里捡出来,原样放进进场这一份(进场那份要先把
   * 自己账上残留的同类剥掉,那是**上一次离场时留下的旧影**)。
   *
   * ── 这只文件仍然不认识树、不认识瓦 ──────────────────────────────────────
   * 它只知道「有这么一口」与「什么时候调」;**剥什么、携带什么**由各 store 在
   * 自己那份规格里说(判据一律经内容自述,不是核心层点名)。与 `pick` 的分工是
   * 一句话:`pick` 答「什么算家具」,`carry` 答「哪几格不归这个空间」。
   *
   * ── 时机:只在**真有离场方**时跑 ─────────────────────────────────────────
   * 它挂在 `swapSpace` 上,而 `swapSpace` 只由 `bindPerSpace` 的订阅调 —— 开机
   * 那一路走的是 `spreadSpace`(persist 的 merge / 首进某空间),碰不到这一口。
   * 这是**结构保证**,不是一句 if:开机那一刻当前空间的账在 `partialize` 时就是
   * 活树,随人走的那几格存在里面,那正是要恢复的东西;剥只在有人来接班时做,
   * 才不会两份。
   *
   * `outgoingLive` 是**离场那一侧的活状态**(不是它刚被收进账的那一份)——
   * 两者内容相同,但活状态是调用方手上现成的那一个,少一次从账里取。
   */
  carry?(incoming: F, outgoingLive: S): F
}

/**
 * 把当前空间那一格记进账。**`partialize` 用它**,所以「不切换只刷新」也存得对。
 *
 * 不在这里判「和账上那一格一不一样」:`partialize` 每次写盘都跑,而 JSON 序列化
 * 本来就要把整棵树走一遍,省这一次浅比较换不到什么,却要多维护一条判据。
 */
export function stashSpace<S, F>(
  state: S,
  ledger: SpaceLedger<F>,
  spec: PerSpaceSpec<S, F>,
  spaceId: string = currentSpaceId(),
): SpaceLedger<F> {
  return { ...ledger, [spaceId]: spec.pick(state) }
}

/**
 * 摊开某个空间那一格。**账上没有 = 第一次进这个空间 = 出厂布局**,
 * 不去看别的空间的(那正是「整套都是新的一套」这句话的字面意思)。
 */
export function spreadSpace<S, F>(
  ledger: SpaceLedger<F>,
  spec: PerSpaceSpec<S, F>,
  spaceId: string = currentSpaceId(),
): F {
  return ledger[spaceId] ?? spec.factory()
}

/**
 * 换装:**先把旧空间的收进账,再把新空间的摊开**。次序即语义 —— 反过来的话
 * 收进账的会是刚摊开的那一份,旧空间的布局当场蒸发(这是这个原语最容易写错的
 * 一格,`per-space.test.ts` 有一条断言专钉它)。
 *
 * 返回的是**一次 `set` 的全部内容**:账 + 摊开的那些字段。一次 set 而不是两次,
 * 因为两次之间会有一帧「新账配旧家具」——订阅者看得见那一帧。
 */
export function swapSpace<S, F extends object>(
  state: S & PerSpaceState<F>,
  spec: PerSpaceSpec<S, F>,
  next: string,
  previous: string,
): PerSpaceState<F> & F {
  const byWorkspace = stashSpace(state, state.byWorkspace, spec, previous)
  const incoming = spreadSpace(byWorkspace, spec, next)
  /*
   * **携带排在「收进账 → 摊开新的」之间**(S1)。次序即语义,三条:
   *  · 排在 `stashSpace` **之后** —— 离场那个空间的账里要留着那几格随人走的
   *    (它此刻还是那个空间落盘的真相;下一次进它时由它自己的 `carry` 剥掉);
   *  · 排在 `spreadSpace` **之后** —— 携带的落点是**进场那份家具**,先得有它;
   *  · 收账用的是 `state`(离场的活状态),携带读的也是它,同一份,不会分叉。
   */
  return { byWorkspace, ...(spec.carry ? spec.carry(incoming, state) : incoming) }
}

/** 能被 `bindPerSpace` 接上的最小 store 形状(zustand 的 vanilla 面)。 */
interface BindableStore<T> {
  getState(): T
  setState(partial: Partial<T>): void
}

/**
 * 把一个 store 接上「换空间」。返回 `unbind`(**幂等**)。
 *
 * 每个消费模块都要把它交给自己的 HMR dispose(09-01 立法:模块级副作用必须配
 * dispose)—— 不退役的话热更之后会有两条订阅同时换装,而第二条拿的是上一个
 * 模块实例的 store,换装会写进一台没人在看的 store 里。
 */
export function bindPerSpace<S extends PerSpaceState<F>, F extends object>(
  store: BindableStore<S>,
  spec: PerSpaceSpec<S, F>,
): () => void {
  const stop = subscribeCurrentSpace((next, previous) => {
    store.setState(swapSpace(store.getState(), spec, next, previous) as Partial<S>)
  })
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    stop()
  }
}

/**
 * 迁移用:**把一份「只有一个空间时代」的扁平档案折进账的 default 那一格**。
 *
 * 四个 store 的 v→v+1 迁移逐字都是这一句,所以它住在这里而不是各写一遍。
 * 零丢失:既有布局原样成为默认空间的布局,别的空间还不存在(自然是出厂)。
 *
 * 已经有 `byWorkspace` 的档案原样放行 —— 迁移必须幂等(存量实例的写盘会带着
 * 新版本号落旧值,migrate 那时不再跑,这条在 stage 的 merge 注释里有判例)。
 */
export function foldFlatIntoDefaultSpace<F>(
  persisted: Record<string, unknown>,
  keys: readonly (keyof F & string)[],
  defaultSpaceId: string,
): Record<string, unknown> {
  if (persisted.byWorkspace && typeof persisted.byWorkspace === 'object') return persisted
  const furniture: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(persisted)) {
    if ((keys as readonly string[]).includes(key)) furniture[key] = value
    else rest[key] = value
  }
  // 一格都没摘到(全新的机器 / 档案本来就空)= 不造一格空家具出来:
  // 账上没有 default 这一格,首进时走出厂,与「从来没摆过」是同一件事。
  if (Object.keys(furniture).length === 0) return rest
  return { ...rest, byWorkspace: { [defaultSpaceId]: furniture } }
}
