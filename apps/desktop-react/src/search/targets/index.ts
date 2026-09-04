import { registerTargetRenderer } from './registry'
import { actionTargetRenderer } from './action'
import { chatTargetRenderer } from './chat'
import { dailyTargetRenderer } from './daily'
import { fileTargetRenderer } from './file'
import { messageTargetRenderer } from './message'
import { promptTargetRenderer } from './prompt'

/**
 * **注册只发生在这一个 barrel**(与 `content/viewer/kinds/index.ts`、
 * `content/blocks/registry.ts` 逐条同款):import 这个文件就是「这台上有哪些目标形」,
 * 一眼看全。
 *
 * **加一类能搜的东西 = 一个渲染器文件 + 这里一行**(设计
 * `docs/design/search-index-2026-09.md` §4.2b 那张演练表的最后两行)。面板、tab 条、
 * 分组、分页、过滤片一个字都不用改 —— 那正是 §4.0 的硬指标。
 *
 * 六行,按 kind 的字母序 —— 次序在这里**没有语义**(展示次序由自述的 `order` 说),
 * 所以取一个不会引发讨论的排法。
 */
for (const renderer of [
  actionTargetRenderer,
  chatTargetRenderer,
  dailyTargetRenderer,
  fileTargetRenderer,
  messageTargetRenderer,
  promptTargetRenderer,
]) {
  registerTargetRenderer(renderer)
}

export { registerTargetRenderer, resolveTargetRenderer, resetTargetRenderers, targetRendererKinds } from './registry'
export type { SearchTargetContext, SearchTargetRenderer, SearchTargetRowProps } from './registry'
export type { ActionTargetPayload } from './action'
export type { ChatTargetPayload } from './chat'
export type { DailyTargetPayload } from './daily'
export type { FileTargetPayload } from './file'
export type { MessageTargetPayload } from './message'
export type { PromptTargetPayload } from './prompt'
