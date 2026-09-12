import type { ContentRef } from '../../workbench/kinds'

/**
 * **一格终端在拼贴台里的名字**(T1)。三行单独一个文件,理由与
 * `content/kinds/dir-ref.ts` 逐字相同:它是**两层之间那条缝**。启动瓦、
 * 焦点召唤、右键菜单三处都要造这个 ref,而它们都不该 import 那一种内容的
 * **实现**(`../kinds/terminal.tsx` 的 import 闭包里有 xterm 与整台注册表)。
 *
 * `key` = 终端 id(core 那边 `randomUUID()` 发的那一个),不是 cwd:同一个
 * 目录可以开好几格终端,而 `refId` 是「这块内容在全应用的唯一名字」。
 * 种类名 `terminal` 与 core 的 scheme 语法相容(`^[a-z][a-z0-9-]*$`)。
 */
export const TERMINAL_KIND = 'terminal'

/** 一格终端的内容引用。 */
export const terminalRef = (id: string): ContentRef => ({ kind: TERMINAL_KIND, key: id })

/** 反过来:这一格 tab 装的是不是一格终端?是就给出 id,不是就是 null。 */
export function terminalIdOf(ref: ContentRef): string | null {
  return ref.kind === TERMINAL_KIND ? ref.key : null
}
