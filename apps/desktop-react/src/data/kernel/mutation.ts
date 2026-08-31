import type { AsyncSource } from './async-source'
import { messageOf } from './async-source'

/**
 * 写数原语。它把一次写拆成**四件各有其位的事**,而不是让每个写口自己抄一遍:
 *
 *   optimistic → run → (成了) settle
 *                    → (砸了) 回滚 + onError
 *
 * 「乐观值与对账值分开存」这条(§8 执行机制)在这里是形状:乐观补丁打在
 * query 缓存上(`q.patch` 交出回滚),对账是写完之后 `q.invalidate()` 让它
 * 后台再问一次 —— 两件事经的是两口,谁也不必知道对方存在。
 */

export interface MutationSnapshot {
  /** 有没有任何一发在飞。整块面的粗读数,慎用 —— 律③要的是逐格。 */
  readonly pending: boolean
  /** 此刻在飞的那些格。`key(input)` 没给就永远是空的。 */
  readonly pendingKeys: ReadonlySet<string>
  /** 最近一次失败的原话。下一次 run 开始时清掉。 */
  readonly error: string | undefined
}

/** `optimistic` 交出来的那个撤销。调它 = 把屏幕退回补丁之前。 */
export type Rollback = () => void

export interface MutationOptions<I, R> {
  /** 真正去写的那一发。抛出 = 失败。 */
  run: (input: I) => Promise<R>
  /**
   * 这一发打在**哪一格**上。给了它,反馈才长得到被点的那一个控件上
   * (律③);不给,就只有整体那颗粗读数。
   */
  key?: (input: I) => string
  /**
   * 乐观补丁:立刻上屏。**返回的函数就是回滚** —— 一处产地,不会漂开。
   * 典型写法是 `(input) => q.patch(prev => …)`,`patch` 本来就交出回滚。
   */
  optimistic?: (input: I) => Rollback | void
  /** 失败时除了回滚还要做的事(一条通知,带后端原话)。 */
  onError?: (error: Error, input: I) => void
  /** 成功之后的**对账**:`q.invalidate()` 之类。后台补拉,不清屏。 */
  settle?: (result: R, input: I) => void
}

export interface Mutation<I, R> extends AsyncSource {
  readonly name: string
  get(): MutationSnapshot
  /**
   * 跑一次。**不抛** —— 失败已经在这里处理完了(回滚 + onError),
   * 再抛一遍只会逼每个调用点写一个空 catch。失败返回 undefined。
   */
  run(input: I): Promise<R | undefined>
  reset(): void
}

const EMPTY_KEYS: ReadonlySet<string> = new Set()

export function createMutation<I, R>(name: string, opts: MutationOptions<I, R>): Mutation<I, R> {
  /** 格 → 这一格上在飞几发。同一格连点两下不该被第一发的收尾提前解禁。 */
  const counts = new Map<string, number>()
  let inflight = 0
  let error: string | undefined
  const listeners = new Set<() => void>()

  let cached: MutationSnapshot = { pending: false, pendingKeys: EMPTY_KEYS, error: undefined }
  /** 上一次交出去的那张 key 表是按哪一版算的 —— 表没变就不换引用(身份稳定)。 */
  let keysRev = 0
  let cachedKeysRev = -1

  function get(): MutationSnapshot {
    const pending = inflight > 0
    if (cached.pending === pending && cachedKeysRev === keysRev && cached.error === error) {
      return cached
    }
    cachedKeysRev = keysRev
    cached = {
      pending,
      pendingKeys: counts.size === 0 ? EMPTY_KEYS : new Set(counts.keys()),
      error,
    }
    return cached
  }

  function emit(): void {
    get()
    for (const listener of listeners) listener()
  }

  function mark(key: string | undefined, delta: 1 | -1): void {
    inflight += delta
    if (key === undefined) return
    const next = (counts.get(key) ?? 0) + delta
    if (next > 0) counts.set(key, next)
    else counts.delete(key)
    keysRev += 1
  }

  return {
    name,
    get,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isPending: (key) => (key === undefined ? inflight > 0 : counts.has(key)),
    async run(input) {
      const key = opts.key?.(input)
      // 乐观补丁**先于**忙态:上屏零延迟正是这条原语存在的理由。
      const rollback = opts.optimistic?.(input) ?? undefined
      error = undefined
      mark(key, 1)
      emit()
      try {
        const result = await opts.run(input)
        mark(key, -1)
        emit()
        // 对账排在忙态解除之后:它是后台的事,不该把钮多按住一拍。
        opts.settle?.(result, input)
        return result
      } catch (raw) {
        const failure = raw instanceof Error ? raw : new Error(messageOf(raw))
        // 先回滚再报错:屏幕上不许留一张后端没认下的牌,哪怕只留一帧。
        rollback?.()
        error = failure.message
        mark(key, -1)
        emit()
        opts.onError?.(failure, input)
        return undefined
      }
    },
    reset() {
      counts.clear()
      inflight = 0
      error = undefined
      keysRev += 1
      emit()
    },
  }
}
