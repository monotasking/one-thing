import type { BlockDef } from '../registry'

/**
 * 重渲染器的懒加载(§3.1 的 `def.loader`)。
 *
 * shiki / mermaid / katex 都是几百 KB 起步的东西,不该在开屏时拉。声明了 `loader`
 * 的块由壳负责:第一次要画的时候拉一次,拉的过程里显骨架(Suspense),拉到了就画,
 * **拉不到就降级** —— 这里把失败原样抛出去,由块级错误边界接住变成源码。
 * 于是「加载失败」和「渲染抛错」是同一条降级路径,不是两套。
 *
 * 缓存按 kind:同一种块拉一次,后面每一块都是同步命中(读到 done 直接返回)。
 */

type Entry =
  | { status: 'pending'; promise: Promise<unknown> }
  | { status: 'done' }
  | { status: 'error'; error: unknown }

const ENTRIES = new Map<string, Entry>()

/**
 * Suspense 的读法:没好就抛 promise(React 接住去画 fallback),
 * 出错就抛错(错误边界接住去降级),好了就返回。
 */
export function readBlockLoader(def: BlockDef): void {
  if (!def.loader) return
  const cached = ENTRIES.get(def.kind)
  if (cached) {
    if (cached.status === 'done') return
    if (cached.status === 'error') throw cached.error
    throw cached.promise
  }
  const promise = Promise.resolve()
    .then(() => def.loader?.())
    .then(
      () => ENTRIES.set(def.kind, { status: 'done' }),
      (error: unknown) => ENTRIES.set(def.kind, { status: 'error', error }),
    )
  ENTRIES.set(def.kind, { status: 'pending', promise })
  throw promise
}

/** 只给测试用:缓存是模块级的,用例之间要能各拉各的。 */
export function clearBlockLoaderCache(): void {
  ENTRIES.clear()
}
