import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { AsyncSource } from './async-source'
import { IDLE_ASYNC_SOURCE } from './async-source'
import type { Mutation, MutationSnapshot } from './mutation'
import type { Query, QuerySnapshot } from './query'

/**
 * kernel 的 React 那一头。三个 hook,全部走 `useSyncExternalStore` ——
 * 不是 `useState` + `useEffect` 抄快照。
 *
 * 为什么必须是 useSyncExternalStore:同一份 query 会被好几个组件同时订
 * (目录表、头上的时刻、刷新钮)。用 useEffect 抄快照的话,这几处会在**不同的
 * 提交里**看见不同版本的数据(撕裂),而且首帧一定慢一拍。useSyncExternalStore
 * 是 React 为这件事造的口,它还顺带要求 getSnapshot **稳定** ——
 * 而那正是 kernel 的「快照身份稳定」在守的东西(不稳定 = 无限重渲)。
 */

export function useQuery<T>(query: Query<T>): QuerySnapshot<T> {
  const subscribe = useCallback((listener: () => void) => query.subscribe(listener), [query])
  const snapshot = useCallback(() => query.get(), [query])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * 律②′ **换键在飞的那一段,上一把键的答案留在屏上**。
 *
 * 律②(`query.ts` 里那条性质)守的是**同一格**:重拉期间 `data` 永不清空。
 * 它对「换了一格」无能为力 —— 换键 = 换了一个 `Query` 对象,新格是崭新的,
 * `data` 当然是 `undefined`。检索面的病根正是这一格:词一改就换键,列表当场
 * 清空、容器高度归零、`scrollTop` 被浏览器钳到 0,松手回来就是「跳回顶部」。
 *
 * 所以律②′ 补的是**跨键**那一半,而且只补一件事:`data`。
 *
 * ── 交出去的读数怎么读 ──────────────────────────────────────────────────
 * · `phase` / `inflight` / `error` / `updatedAt` / `dataRev` —— **新格的,如实**。
 *   不造第二种语义:骨架的判据从 `phase === 'initial'` 改成
 *   `phase === 'initial' && !stale`(「从来没有过内容」**且**「屏上现在也没有
 *   垫着的旧内容」),而不是让 `phase` 说谎。
 * · `data` —— 新格自己有答案就是新格的;新格还没有答案而上一把键有,就是
 *   上一把键最后那份。
 * · `stale` —— 屏上这份 `data` 是不是**别的键**的。真时 `shownKey` 与
 *   `query.key` 不同。
 * · `shownKey` —— **屏上那份数据的键**。滚动记忆、行 key、块标识一律按它取
 *   (按 `query.key` 取就会在换键那一帧把旧内容记到新键名下)。
 *
 * ── 什么时候放手 ────────────────────────────────────────────────────────
 * **新格自己有了 `data` 就放手**,一帧都不多留。失败那一档**不放手**:
 * `error` 照实透出,旧行继续留在屏上 —— 这与律②在同一格里的做法逐字一致
 * (「错误与旧答案共存,如实并陈」),换成清屏就等于告诉用户「你刚才看的
 * 东西也没了」。同一把键内它**逐字等于 `useQuery`**:`stale` 恒假,
 * `data` 就是快照的 `data`(那一格被 `reset()` 清成 `undefined` 也照实清)。
 *
 * ── 为什么是「渲染期派生 state」而不是 `useRef` ──────────────────────────
 * 记住「上一把键那份答案」是一件**随渲染走**的事。写在 `useRef` 里要靠某次
 * 渲染的副作用去更新它,而并发渲染下被丢弃的那次渲染同样会执行渲染体 ——
 * ref 会被一次没有提交的渲染污染。渲染期 `setState`(React 官方的
 * 「props 变了就地调整 state」那一手)是安全的:它不提交、当场重跑本组件,
 * 而且被丢弃的渲染连同它的 state 一起丢。
 */
export interface HeldSnapshot<T> extends QuerySnapshot<T> {
  /** 屏上这份 `data` 是不是上一把键的。 */
  readonly stale: boolean
  /** 屏上那份数据属于哪一把键。`stale` 假时等于 `query.key`。 */
  readonly shownKey: string
}

interface Shown<T> {
  readonly key: string
  readonly data: T
}

export function useQueryHeld<T>(query: Query<T>): HeldSnapshot<T> {
  const snapshot = useQuery(query)
  const key = query.key
  const [shown, setShown] = useState<Shown<T> | null>(null)

  // 这一格自己有答案 = 它就是屏上那份,记下来给下一把键当垫子。
  const own = snapshot.data !== undefined
  if (own && (shown === null || shown.key !== key || !Object.is(shown.data, snapshot.data))) {
    setShown({ key, data: snapshot.data as T })
  }

  /*
   * 垫着的条件有三条,缺一不可:这一格自己**没有**答案、垫子存在、而且垫子
   * 是**别的键**的。第三条是「同键逐字等于 useQuery」的全部实现:同一把键被
   * `reset()` 清空时,垫子的键与当下的键相同,于是不垫 —— 如实清空。
   */
  const holding = !own && shown !== null && shown.key !== key
  const data = holding ? shown.data : snapshot.data
  const shownKey = holding ? shown.key : key

  // 读数身份稳定(律④):字段逐个没变就交回同一个对象,消费方据它 memo。
  return useMemo(
    () => ({ ...snapshot, data, stale: holding, shownKey }),
    [snapshot, data, holding, shownKey],
  )
}

export function useMutation<I, R>(mutation: Mutation<I, R>): MutationSnapshot {
  const subscribe = useCallback((listener: () => void) => mutation.subscribe(listener), [mutation])
  const snapshot = useCallback(() => mutation.get(), [mutation])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/**
 * 「这一格此刻在飞吗」。`AsyncButton` 绑的就是它 —— 按钮不该关心自己绑的是
 * 一发取数还是一次写入(见 `async-source.ts` 的文件头)。
 *
 * source 缺席时给一个恒静的空实现,而不是在调用点写第二条分支:hook 不能
 * 有条件地调。
 */
export function useAsyncPending(source: AsyncSource | undefined, key?: string): boolean {
  const bound = source ?? IDLE_ASYNC_SOURCE
  const subscribe = useCallback((listener: () => void) => bound.subscribe(listener), [bound])
  const snapshot = useCallback(() => bound.isPending(key), [bound, key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
