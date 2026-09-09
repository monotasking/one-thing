import { useCallback } from 'react'
import { runShellCommand } from './run-command'
import type { CommandId } from './types'

/**
 * **一条全局命令怎么落地** —— 从前是派发器,后来是派发器的一半,现在是一层薄壳。
 *
 * ── 三段史 ────────────────────────────────────────────────────────────────
 * ① 它从前叫 `useKeymapDispatch`:一条 window keydown 监听 + 一张动作表。
 * ② 09-02 R1 把**监听**收进了全壳唯一的那一个(`focus/dispatch.ts` 的
 *    `useFocusDispatch`),留下的是**动作表**,提成 `useKeymapCommandRunner()`
 *    由那边消费。
 * ③ K2b-1 把**动作表本体**降成模块级纯函数 `run-command.ts` 的
 *    `runShellCommand(id)` —— 它从此不订阅任何 store,于是「跑一条壳命令」
 *    不再要求调用方在 React 树里(判词整段写在那只文件的头上:
 *    将来 SSE 送来的 `home: 'shell'` 那一路调得到它,hook 调不到)。
 *
 * 留在这里的只剩**给 React 消费者的那层壳**:`useFocusDispatch({ runCommand })`
 * 收的是一个函数,而 `runShellCommand` 的引用本来就是稳的 —— `useCallback` 的
 * 依赖表因此是空的,这只 hook 一次都不会重建。
 *
 * 表本身一个字没改:命令 id 的形状与反解仍然只有 `keymap/transitions` 一个产地,
 * 认不出的 id 一律回 `false`,不去猜。
 *
 * 结构导航键(Esc / 方向键 / Enter / Space)不进这张表,理由见 types.ts 顶部。
 */
export function useKeymapCommandRunner(): (id: CommandId) => void {
  return useCallback((id: CommandId) => {
    runShellCommand(id)
  }, [])
}
