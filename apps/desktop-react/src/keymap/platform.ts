import type { KeymapPlatform } from './types'

/**
 * **「这是什么机器」那一问,一只函数一只文件**(K0)。
 *
 * 它从 `transitions.ts` 搬出来,理由是**依赖方向**而不是洁癖:K0 起
 * `keymap/commands.ts`(命令表 + 冲突规则)要读 `focus/scopes.ts` 的 `answers`,
 * 而 `focus/scopes.ts` 读 `content/terminal/key-courtesy.ts` 的认领表,后者又要在
 * 模块加载那一刻量一次平台。三条边接起来,`transitions.ts` 就回到了自己的上游 ——
 * 一个真的模块环(今天靠「函数声明会提升」侥幸能跑,而那不是一条可以指望的性质)。
 *
 * 把这一只拆成叶子模块,环当场断:`commands → focus/scopes → key-courtesy →
 * platform` 走到头,没有一条边指回 `transitions`。
 *
 * `transitions.ts` 仍然把它原样再导出一次,所以既有调用点(`keymap/store.ts` /
 * `content/FileActionsMenu.tsx`)一个字都不用改。
 */

/** 纯函数不许读 navigator,所以「这是什么机器」由调用方量一次递进来。 */
export function platformOf(ua: string): KeymapPlatform {
  return /mac|iphone|ipad/i.test(ua) ? 'mac' : 'other'
}
