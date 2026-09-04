import { registerPreviewRenderer } from './registry'
import { compositePreviewRenderer } from './kinds/composite'
import { fileExcerptPreviewRenderer } from './kinds/file-excerpt'
import { messageContextPreviewRenderer } from './kinds/message-context'
import { noteExcerptPreviewRenderer } from './kinds/note-excerpt'
import { sessionOverviewPreviewRenderer } from './kinds/session-overview'

/**
 * **注册只发生在这一个 barrel**(与 `../targets/index.ts`、
 * `content/viewer/kinds/index.ts`、`content/blocks/registry.ts` 逐条同款):
 * import 这个文件就是「这台上画得出哪几种预览」,一眼看全。
 *
 * **加一种预览媒介 = 一个渲染器文件 + 这里一行**(设计
 * `docs/design/search-index-2026-09.md` §4.5 ②那张表)。预览窗、列表、tab 条、
 * 过滤片一个字都不用改。
 *
 * 五行,按 kind 的字母序 —— 次序在这里**没有语义**(画哪一种由载荷的 `kind` 决定),
 * 所以取一个不会引发讨论的排法。
 *
 * ── §4.5 那张表里今天**没有**注册的几行,以及为什么 ──────────────────────
 * `text` / `markdown` / `code` / `image` / `audio` / `video` / `pdf` / `html` /
 * `diff` / `symbol-definition` / `descriptor` —— **今天没有一个能力产出它们**
 * (六个内置能力的 `preview` 只答四种 kind,服务层再组出第五种 `composite`)。
 * 先注册一个没有产地的渲染器,等于写一段永远跑不到的代码,而且它会在「这一类
 * 到底长什么样」这个问题上先替将来的能力作者拍板。缺席时的行为已经是对的:
 * 注册表答 `undefined`,预览窗画 Row 放大版并 warn 一次。
 */
for (const renderer of [
  compositePreviewRenderer,
  fileExcerptPreviewRenderer,
  messageContextPreviewRenderer,
  noteExcerptPreviewRenderer,
  sessionOverviewPreviewRenderer,
]) {
  registerPreviewRenderer(renderer)
}

export {
  previewRendererKinds,
  registerPreviewRenderer,
  resetPreviewRenderers,
  resolvePreviewRenderer,
} from './registry'
export type { SearchPreviewProps, SearchPreviewRenderer } from './registry'
