import type { CommandId } from './types'

/**
 * **「第 n 格标签」那一族的 id**(K2,方案 `docs/keymap-responder-2026-09.md` §5 K2)。
 *
 * ── 它为什么自己占一只文件 ────────────────────────────────────────────────
 * 与 `keymap/platform.ts` 逐字同一条理由:**断模块环**。命令表
 * (`keymap/commands.ts`)要读 `focus/scopes.ts` 的 `answers`(冲突规则问「谁可能
 * 答」),而 `focus/scopes.ts` 这一批要声明「叶答得出 ⌘1–⌘9」—— 两边互相 import
 * 就是一个环。id 的拼法与格数本来就不依赖任何一头,所以它们住在这只**零依赖**
 * (只有类型)的叶子模块里,两边各取所需。
 *
 * `commands.ts` 把这里的导出原样再导一次(同 `transitions.ts` 再导 `commands.ts`
 * 的判例),于是「一个 id 的拼法只有一个产地」这句话仍旧成立。
 */

/** 派发器与响应者按它分流 —— 全仓唯一一处这个字面量。 */
export const TAB_SELECT_COMMAND_PREFIX = 'tab.select:'

/**
 * ⌘1–⌘9 —— **九格,第 9 格是「最后一格」**(浏览器 / 终端 / 编辑器三十年的惯例:
 * ⌘9 永远跳到最后一个标签,不管一共有几格)。这个数是**键位预算**而不是能力上限:
 * 第 10 格照样点得到、⌘⇧] 也走得到,只是没有直达键。
 */
export const TAB_SELECT_SLOTS = 9

export function tabSelectCommandId(slot: number): CommandId {
  return `${TAB_SELECT_COMMAND_PREFIX}${slot}`
}

/**
 * 这个 id 是第几格(1 起)。**认不出就是 null** —— 响应者据此放行,不去猜。
 *
 * 收 `string` 而不是 `CommandId`,判据与 `shelfSideOfCommand` 逐字相同:它是
 * **反解**,而反解的入参按定义是「还不知道是不是一条命令」的串。
 */
export function tabSelectSlotOf(id: string): number | null {
  if (!id.startsWith(TAB_SELECT_COMMAND_PREFIX)) return null
  const slot = Number(id.slice(TAB_SELECT_COMMAND_PREFIX.length))
  return Number.isInteger(slot) && slot >= 1 && slot <= TAB_SELECT_SLOTS ? slot : null
}
