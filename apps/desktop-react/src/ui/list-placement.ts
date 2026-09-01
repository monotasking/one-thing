import { useRef } from 'react'

/**
 * **交互中的列表不许在用户手底下重排**(09-01 立法,起因:模型服务面勾选一个
 * 模型,它当场从第 16 行飞到第 3 行 —— 真机量到 -689px、DOM 节点被换掉;
 * 用户原话「很难受」)。
 *
 * ── 病型 ────────────────────────────────────────────────────────────────
 * 交互稳定性四律(`docs/design/react-shell-2026-08.md` §8)C 型的变体:
 * C 型是「整份写回换行身份」,这一支是**排序键里混进了用户正在改的那一格**。
 * 「已选置顶」「已启用优先」「最近使用在前」都是这个形状 —— 排序键一旦包含
 * 用户当下正在拨的那个开关,每一次拨动都是一次重排,而重排发生在鼠标已经
 * 停在那一行上的时刻。表现出来就是:点一下,东西跑了;想再点一下取消,
 * 得先满屏找它。
 *
 * ── 修法:排序键固化一次 ────────────────────────────────────────────────
 * 「怎么排」与「现在是什么状态」拆成两件事:
 *   · **位置**读固化快照 —— 进这块面 / 显式刷新 时拍一次,交互期间不再变;
 *   · **状态**读活值 —— 勾选框画的永远是此刻的真相。
 * 于是勾选只改行的样子,不改行的位置;重排只发生在下次进入或下次刷新。
 *
 * 快照**不认识**的项(固化之后才出现的,例如刚手填的一个 id)按活值算 ——
 * 它没有旧位置可守,硬塞进快照会让它出现在一个谁也说不清的地方。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 * ```ts
 * const placement = useFrozenFlags(rows, (r) => r.id, (r) => r.selected, `${pid}:${fetchedAt}`)
 * // 排序/分区读 placement,勾选框读 row.selected
 * const picked = rows.filter((r) => frozenFlagOf(placement, r.id, r.selected))
 * ```
 * `token` 就是「什么时候才允许重排」这条判据本身:换一坑、拉到新目录、显式
 * 刷新各是一次换 token。**别把用户改的那一格放进 token** —— 那等于没冻。
 */

const EMPTY: ReadonlyMap<string, boolean> = new Map()

/** 拍一张快照。纯函数,好断言。 */
export function freezeFlags<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  flagOf: (item: T) => boolean,
): ReadonlyMap<string, boolean> {
  const frozen = new Map<string, boolean>()
  for (const item of items) frozen.set(keyOf(item), flagOf(item))
  return frozen
}

/**
 * 快照怎么读:**认识就用快照,不认识就用活值**。
 * 单独一个函数而不是让每个消费者写 `?? live` —— 那个 `??` 正是最容易漏的一格。
 */
export function frozenFlagOf(
  frozen: ReadonlyMap<string, boolean> | undefined,
  key: string,
  live: boolean,
): boolean {
  if (!frozen) return live
  const held = frozen.get(key)
  return held === undefined ? live : held
}

/**
 * `token` 变了就重拍一张,否则原样交出上一张(**引用稳定** —— 下游拿它当
 * useMemo 的依赖,每帧换一个新 Map 就等于每帧重算一次分区)。
 *
 * 拍照发生在**渲染期**而不是 useEffect 里:effect 要等一帧,那一帧里快照还是
 * 空的,于是首屏之后的第一次勾选照样会跳。这里只写自己的 ref、不碰外面任何
 * 东西,重复渲染得到同一个结果 —— 与 React 文档里「props 变了就地调整 state」
 * 是同一种写法。
 */
export function useFrozenFlags<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  flagOf: (item: T) => boolean,
  token: unknown,
): ReadonlyMap<string, boolean> {
  const held = useRef<{ token: unknown; frozen: ReadonlyMap<string, boolean> }>({
    token: Symbol('unset'),
    frozen: EMPTY,
  })
  if (held.current.token !== token) {
    held.current = { token, frozen: freezeFlags(items, keyOf, flagOf) }
  }
  return held.current.frozen
}
