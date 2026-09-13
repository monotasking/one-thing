/**
 * **每片叶的「刚关掉的那几格」**(K2,`tab.reopen` / ⌘⇧T 的账本;方案
 * `apps/desktop-react/docs/keymap-responder-2026-09.md` §5 K2)。
 *
 * ── 三条判据,都写在这儿 ─────────────────────────────────────────────────
 *  · **按叶记**。⌘⇧T 的语义是「把**这一排**刚关掉的那一格拿回来」,不是
 *    「全壳最近关掉的那一格」—— 后者会让人在架子上按一下 ⌘⇧T,中央区冒出来
 *    一格东西;
 *  · **不落盘**(它不在 `WORKBENCH_PER_SPACE.pick` 里)。重启之后没有「刚关的」
 *    这回事:那是一句关于**这一段操作**的话,而不是用户摆好的家具。换工作区
 *    同理 —— 账随 store 的瞬态字段一起留在内存里,与 `focusLeafId` 同一条判据;
 *  · **存的是影不是 ref**。浏览器关一格 tab 是**删一行**,那个 tabId 从此不存在,
 *    所以栈上记的是种类自述出来的快照(`ContentKind.snapshot`,缺席 = ref 自己)
 *    加上「它是哪一种」与「它坐在第几格」。核心层不解释影里有什么。
 *
 * 零依赖(只有类型),所以 store 与叶响应者两边都能吃 —— 与 `keymap/platform.ts`
 * 同一条断环纪律。
 */

/** 栈上的一格。`index` 是它被关掉时坐在第几格(重开摆回原位,越界就落末尾)。 */
export interface ClosedTab {
  readonly kind: string
  readonly snapshot: unknown
  readonly index: number
}

/**
 * 栈深。**10 是一个预算,不是能力**:再往前的那几格没人记得,而一条无界的栈
 * 会把关掉的浏览器 tab 的 url 一直攥在手里。
 */
export const CLOSED_STACK_DEPTH = 10

/** 压一格。超过深度就从**栈底**丢(最老的那一格先忘)。 */
export function pushClosedTab(
  stack: readonly ClosedTab[] | undefined,
  entry: ClosedTab,
): ClosedTab[] {
  const next = [...(stack ?? []), entry]
  return next.length > CLOSED_STACK_DEPTH ? next.slice(next.length - CLOSED_STACK_DEPTH) : next
}

/**
 * 取最近关掉的那一格(**取走**,不是看一眼)。空栈 = `null`,调用方据此
 * **不交出 handler**,于是 ⌘⇧T 在一片没关过东西的叶上是个诚实的哑键。
 */
export function popClosedTab(
  stack: readonly ClosedTab[] | undefined,
): { entry: ClosedTab; rest: ClosedTab[] } | null {
  if (!stack || stack.length === 0) return null
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}
