import type { BlockModel } from '../../../model/blocks'

/**
 * **一个代码块跑不跑得了,以及跑的是哪一段**(2026-09-14,`run` 动词的块这一半)。
 *
 * 纯函数、零 UI import —— 判据在这里只写一遍,`index.ts` 那句声明与用例读的是
 * 同一只。
 */

/**
 * 能跑的那几种围栏语言。
 *
 * `console` 在里面不是笔误:那是 markdown 里「贴一段终端会话」的惯用语言名,
 * 里头的行通常带着 `$ ` 提示符 —— 剥掉提示符之后它就是一段能跑的脚本
 * (剥的那一句在 `runnableScriptOf`)。
 *
 * 比较前一律压小写(`Bash` / `SH` 在真实的 markdown 里都见得到)。
 */
export const RUNNABLE_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console'])

/**
 * 把围栏正文整理成**可以直接喂下去的那一份**。
 *
 * 今天只做一件事:逐行剥掉行首的 `$ ` 提示符(`^\s*\$ `)。**只认行首**——
 * 行当中的 `$` 是变量(`echo $HOME`)、`$(…)` 是命令替换,动它们就是改脚本本身。
 * 提示符之外一个字节都不改:缩进、续行、注释、空行原样留着。
 *
 * **不补末尾换行** —— 那是「按一下回车」的语义,归执行器那一层
 * (`content/terminal/run-script.ts`),在这儿补就会与它那一句判据各写一遍。
 */
export function runnableScriptOf(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/^\s*\$ /, ''))
    .join('\n')
}

/**
 * 这一块该不该露出「运行」。两条**同时**成立:
 *
 *  ① 语言在表里;
 *  ② **围栏闭合了**(`closed === true`)。未闭合 = 还在流式,脚本没写完 ——
 *    此刻露出来,人点下去跑的是半句命令。这一格与「有取件口才露出」是同一条法
 *    (`shell/actions.ts`):**点了会做错事,比没这个钮更糟**。
 */
export function isRunnableCode(model: Extract<BlockModel, { kind: 'code' }>): boolean {
  if (!model.closed) return false
  return RUNNABLE_LANGS.has((model.lang ?? '').toLowerCase())
}
