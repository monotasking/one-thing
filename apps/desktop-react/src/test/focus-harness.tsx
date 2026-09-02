import { useFocusDispatch } from '../focus/dispatch'
import type { CommandId } from '../keymap/types'

/**
 * **单测里的那一个派发器**(09-02 R1)。
 *
 * 响应链上线之后,「Esc 关掉这层浮层」「Tab 圈在模态里」不再是各组件自己挂的
 * 监听 —— 它们是**声明**(`<FocusScope onEscape>` / `kind='modal'`),真正听键盘的
 * 只有 `focus/dispatch.ts` 那一个,而它挂在外壳上(`AppShell`)。
 *
 * 所以单独渲染一件浮层去按 Esc,现在等于「在一台没有外壳的机器上按键」——
 * 谁都不会响。把这一格摆进 render 树里,就补齐了那台外壳唯一还缺的东西。
 * 它一个 DOM 节点都不渲染。
 *
 * 放在 `src/test/` 而不是某个 `__tests__/`:它是**给测试用的产地**,与
 * `src/test/setup.ts` 同一格身份;而 vitest 只收 `*.test.{ts,tsx}`,所以它
 * 自己不会被当成一份测试跑。
 */
export function FocusDispatchHarness({
  runCommand,
}: {
  /** 全局命令的落点。多数用例不关心它,不传就是个空函数。 */
  runCommand?: (id: CommandId) => void
}) {
  useFocusDispatch({ runCommand: runCommand ?? (() => {}) })
  return null
}
