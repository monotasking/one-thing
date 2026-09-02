import type { AsyncSource } from './async-source'
import { messageOf } from './async-source'

/**
 * 取数原语。四条交互稳定律里的三条(保旧数据 / 有反馈 / 身份稳定)在这里是
 * **性质**,不是可以忘记打开的选项 —— 详见 `kernel/index.ts` 那份手册。
 *
 * 这个文件里没有一行 React:它是一个可订阅的小状态机,React 那一头在 `react.ts`。
 */

/**
 * 两个读数**正交**,这是整块原语最要紧的一条形状。
 *
 * · `phase` 说的是「这一格从来有没有过内容」——'initial' 时屏幕上本来就没有东西
 *   可留,骨架 / 空态只许这时候画;一旦有过内容就永远是 'ready',**重拉不退回去**。
 * · `inflight` 说的是「此刻有没有一发在飞」——它给的是头部那个小指示、按钮上那句
 *   「…中」,**不清屏**。
 *
 * 从前一个 `status: 'idle'|'loading'|'ready'|'error'` 把这两件事压成一个数,于是
 * 每个消费者都得自己猜「现在的 loading 是首载还是重拉」。猜错的那一种就是
 * 用户报的「闪」:重拉时画骨架,等于告诉他「你刚才看的东西没了」。
 */
export type QueryPhase = 'initial' | 'ready'

export interface QuerySnapshot<T> {
  /** 上一次成功值。**refetch 期间永不清空** —— keep-previous 是性质不是选项。 */
  readonly data: T | undefined
  readonly phase: QueryPhase
  readonly inflight: boolean
  /** 最近一次失败的原话。**与 data 共存** —— 错误不抹掉旧答案,如实并陈。 */
  readonly error: string | undefined
  /** 上一次**成功落地**的时刻(ms)。0 = 从来没成过。答案没变它也会前进。 */
  readonly updatedAt: number
  /**
   * 数据**真的变了**几次。答案与上次逐字相同时它不动 —— 于是「刷新了但内容没变」
   * 与「刷新出了新内容」在消费侧是两件可以分开处理的事(前者不该让整块面闪一下)。
   */
  readonly dataRev: number
}

export interface FetchContext {
  /** 这一发是哪一格。单例 query 是空串。 */
  readonly key: string
  /**
   * 是不是「用户明确要求重来一次」。`refetch()` 给 true、`ensure()` 给 false ——
   * 后端那一口常有自己的缓存(`listModels(pid, forceRefresh)`),这个位就是
   * 把「刷新」这个意图原样递下去,而不是在 kernel 里替它决定。
   */
  readonly force: boolean
}

export type QueryFetcher<T> = (ctx: FetchContext) => Promise<T>

export interface QueryOptions<T> {
  /**
   * 「答案变了没有」的判据。缺省 `Object.is` —— 对每次都新造一个数组的取数口
   * (绝大多数),等价于「每次都算变了」。要让身份真正稳住就传一个内容比较。
   */
  equals?: (a: T, b: T) => boolean
}

export interface Query<T> extends AsyncSource {
  /** 全名 `<family>:<key>`。日志与调试用,不是给屏幕看的。 */
  readonly key: string
  /** 当下快照。**数据没变就是同一个对象** —— 行组件据它 memo,不会白重渲。 */
  get(): QuerySnapshot<T>
  /** 「确保问过一次」。已经有答案且不脏就什么都不做。 */
  ensure(): Promise<void>
  /** 「再问一次」。`force: true` 递给 fetcher。 */
  refetch(): Promise<void>
  /**
   * 就地打一个补丁(乐观写用)。**返回的函数就是回滚** —— 补丁与它的撤销
   * 出自同一处,不会各写一遍然后漂开。
   */
  patch(next: T | ((prev: T | undefined) => T | undefined)): () => void
  /** 标脏。**有订阅者就后台补拉**(对账,不清屏);没人看就等下一次 ensure。 */
  invalidate(): void
  /** 回到出厂。测试与 source 的 reset() 用。 */
  reset(): void
}

export interface QueryFamily<T, K extends string = string> {
  readonly name: string
  /** 拿这一格的 query。同一个 key 永远是同一个对象 —— 缓存就是这么键控的。 */
  get(key: K): Query<T>
  /** 标脏一格;不给 key = 全家标脏。**不建格**:没建过的键什么都不做。 */
  invalidate(key?: K): void
  /**
   * 丢掉一格 —— 「这个键指的东西**没了**」(会话被删)。
   *
   * 与 `invalidate` 是两件事,判据是**这个键还值不值得再问一次**:
   * 标脏说的是「答案旧了,再问」,丢格说的是「问谁?那条会话已经不在了」。
   * 用标脏顶替会当场换来一发注定失败(或者更糟:被后端当成别的东西)的请求。
   *
   * 丢之前先 `reset()` 那一格:此刻还订着它的组件要立刻看见「回到出厂」,
   * 而不是攥着一份被删对象的旧答案继续画。没建过的键是**恒等变换**
   * (不建格、不喊人)—— 级联删除名单里绝大多数键从来没人问过。
   */
  drop(key: K): void
  /** 全家回到出厂。 */
  reset(): void
  /** 此刻有哪些格建过。测试与调试用,也是整族快照(见 subscribe)的键面。 */
  keys(): readonly string[]
  /**
   * 订**整族**:任何一格 emit 都喊一次,包括此刻还没建出来的格。
   *
   * 它服务的是「屏幕要的是一张 `Record<key, T>`,而**哪些键**由数据自己说了算」
   * 这一种读法(检索面板的章节缓存就是:它按会话 id 去问「这条有章节吗」,
   * 键面等于「已经拉到手的那些」)。逐键订(`useCatalogRecord` 那一手)在
   * 键面由**屏幕**给定时是对的;键面由**数据**给定时它办不到 —— 逐键订必须先
   * `get(key)` 建格,于是「有几条会话就建几格空格」,而且新落地的那一格没人订。
   *
   * 快照那一头**不在这里**:整族的 `dataRev` 要怎么记账是消费者的事
   * (章节那一路按 `keys()` 逐格记 `dataRev`,只有内容真变了才换引用),
   * kernel 不替它拍一个「整族版本号」——那会把 inflight 的来回也算成一次变化。
   */
  subscribe(listener: () => void): () => void
}

interface Entry<T> {
  data: T | undefined
  phase: QueryPhase
  error: string | undefined
  updatedAt: number
  dataRev: number
  dirty: boolean
}

function freshEntry<T>(): Entry<T> {
  return { data: undefined, phase: 'initial', error: undefined, updatedAt: 0, dataRev: 0, dirty: false }
}

/**
 * 一格的实现。闭包而不是 class —— 它交出去的是一个**只有六口的面**,
 * 内部那几个字段谁都够不着,也就不会有人绕过 emit 去改它们。
 */
function createEntryQuery<T>(
  fullKey: string,
  key: string,
  fetcher: QueryFetcher<T>,
  equals: (a: T, b: T) => boolean,
  /**
   * 这一格喊人时**顺带**喊一声整族的订阅者(`QueryFamily.subscribe`)。
   * 走这条而不是让家长自己 `subscribe()` 每一格:家长订自己的孩子会让
   * `listeners.size > 0` 恒真,于是 `invalidate()` 永远走「有人在看 → 后台补拉」,
   * 「没人看就留个脏标记」那一档当场消失。
   */
  notifyFamily: () => void = () => undefined,
): Query<T> {
  let state = freshEntry<T>()
  let running: { promise: Promise<void>; force: boolean } | undefined
  let inflight = false
  const listeners = new Set<() => void>()

  /**
   * 快照缓存 —— **身份稳定**的全部实现就在这四行。
   * 六个读数逐个比,一个都没变就把上一次那个对象原样交出去。
   * 不这么做的话 `useSyncExternalStore` 每次调 getSnapshot 都拿到新对象,
   * React 会判「变了」,于是每一次 emit 都重渲一整张表 —— 而且它会
   * **无限循环**(getSnapshot 每次不同 = 永远不稳定)。
   */
  let cached: QuerySnapshot<T> = {
    data: undefined,
    phase: 'initial',
    inflight: false,
    error: undefined,
    updatedAt: 0,
    dataRev: 0,
  }

  function get(): QuerySnapshot<T> {
    if (
      cached.data === state.data &&
      cached.phase === state.phase &&
      cached.inflight === inflight &&
      cached.error === state.error &&
      cached.updatedAt === state.updatedAt &&
      cached.dataRev === state.dataRev
    ) {
      return cached
    }
    cached = {
      data: state.data,
      phase: state.phase,
      inflight,
      error: state.error,
      updatedAt: state.updatedAt,
      dataRev: state.dataRev,
    }
    return cached
  }

  function emit(): void {
    // 先把快照算好再喊 —— 监听者第一件事就是 get()。
    get()
    for (const listener of listeners) listener()
    notifyFamily()
  }

  /** 落一个成功答案。**data 只在这里和 patch 里变**。 */
  function settle(value: T): void {
    const changed = state.data === undefined || !equals(state.data, value)
    state = {
      data: changed ? value : state.data,
      phase: 'ready',
      error: undefined,
      // 时刻**总是**前进:「上次拉取」说的是问过没有,不是答案变没变。
      updatedAt: Date.now(),
      dataRev: changed ? state.dataRev + 1 : state.dataRev,
      dirty: false,
    }
  }

  function start(force: boolean): Promise<void> {
    if (running) {
      // 并发折叠:同一格同时只有一发。在飞的那发已经够狠(force)或者这次不挑,
      // 就直接复用它。
      if (running.force || !force) return running.promise
      /*
       * 在飞的是一发**非强制**,而这次是用户按了「刷新」。折进去就等于把
       * 「重来一次」这个意图静默吞掉(后端那一口有自己的缓存,非强制那发
       * 很可能原样回一份旧的)。所以排在它后面再来一发真的。
       */
      return running.promise.then(() => start(true))
    }

    const promise = (async () => {
      inflight = true
      emit()
      try {
        const value = await fetcher({ key, force })
        settle(value)
      } catch (error) {
        // **不动 data**:错误与旧答案共存,屏幕上该同时看得见「这是上次的」
        // 和「这次没拿到,原话是这句」。
        state = { ...state, error: messageOf(error), dirty: false }
      } finally {
        running = undefined
        inflight = false
        emit()
      }
    })()

    running = { promise, force }
    return promise
  }

  return {
    key: fullKey,
    get,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isPending: () => inflight,
    ensure: () => {
      // 「问过一次且不脏」= 什么都不做。失败过的算没问过(dataRev 还是 0),
      // 于是换一坑再换回来会重试 —— 这与旧 store 的 `status !== 'ready'` 同义。
      if (state.dataRev > 0 && !state.dirty) return running?.promise ?? Promise.resolve()
      return start(false)
    },
    refetch: () => start(true),
    patch(next) {
      const before = state
      const value =
        typeof next === 'function'
          ? (next as (prev: T | undefined) => T | undefined)(state.data)
          : next
      if (value === undefined) return () => undefined
      state = {
        ...state,
        data: value,
        phase: 'ready',
        dataRev: state.dataRev + 1,
      }
      emit()
      let rolled = false
      return () => {
        // 回滚只回一次:重复调不该把一份更新的答案再推回去。
        if (rolled) return
        rolled = true
        state = before
        emit()
      }
    },
    invalidate() {
      state = { ...state, dirty: true }
      // 有人在看就后台补拉(**不清屏**);没人看就留着脏标记,下次 ensure 会问。
      if (listeners.size > 0) void start(true)
      else emit()
    },
    reset() {
      state = freshEntry<T>()
      running = undefined
      inflight = false
      emit()
    },
  }
}

/**
 * 键控的一族 query。`providers.catalog` 就是这个形状:一坑一格,各拉各的、
 * 各记各的时刻,而「怎么拉」只写一遍。
 */
export function createQueryFamily<T, K extends string = string>(
  name: string,
  fetcher: QueryFetcher<T>,
  opts: QueryOptions<T> = {},
): QueryFamily<T, K> {
  const equals = opts.equals ?? Object.is
  const entries = new Map<string, Query<T>>()
  const familyListeners = new Set<() => void>()

  function notifyFamily(): void {
    for (const listener of familyListeners) listener()
  }

  function get(key: K): Query<T> {
    const existing = entries.get(key)
    if (existing) return existing
    const created = createEntryQuery<T>(`${name}:${key}`, key, fetcher, equals, notifyFamily)
    entries.set(key, created)
    return created
  }

  return {
    name,
    get,
    invalidate(key) {
      if (key !== undefined) {
        entries.get(key)?.invalidate()
        return
      }
      for (const entry of entries.values()) entry.invalidate()
    },
    drop(key) {
      const entry = entries.get(key)
      // 没建过 = 恒等变换。级联删除名单里绝大多数键从来没人问过,
      // 为它们各建一格再各喊一声人,是拿删除去制造缓存。
      if (!entry) return
      entries.delete(key)
      // reset 在 delete **之后**:它会 emit,而那一声该让订阅者看见的是
      // 「回到出厂」;此刻家里已经没有这一格了,`keys()` 也就不会再报它。
      entry.reset()
    },
    reset() {
      for (const entry of entries.values()) entry.reset()
      entries.clear()
    },
    keys: () => Array.from(entries.keys()),
    subscribe(listener) {
      familyListeners.add(listener)
      return () => {
        familyListeners.delete(listener)
      }
    },
  }
}

/** 只有一格的 query。它就是 key 恒为空串的一族 —— 不另写一套实现。 */
export function createQuery<T>(
  name: string,
  fetcher: QueryFetcher<T>,
  opts: QueryOptions<T> = {},
): Query<T> {
  return createQueryFamily<T>(name, fetcher, opts).get('')
}
