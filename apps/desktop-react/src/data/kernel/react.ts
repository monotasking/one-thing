import { useCallback, useSyncExternalStore } from 'react'
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
