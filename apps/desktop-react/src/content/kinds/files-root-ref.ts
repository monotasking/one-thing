import type { ContentRef } from '../../workbench/kinds'

/**
 * **「以这个目录为根的一棵文件树」在拼贴台里的名字**(W3,设计 §3.1 的
 * `files-root:<path>`)。
 *
 * ── 这三行为什么单独一个文件 ──────────────────────────────────────────────
 * 与 `stage/panel-ref.ts` 逐字同一条理由:它是**两层之间那条缝**。`FilesPanel`
 * 与 `expose/Rail` 这两个来源要造这个 ref,而它们都不该 import 那一种内容的
 * **实现**(`./files-root.tsx` 的 import 闭包里有查看器、有面板、有 store)——
 * 拖一行只需要知道它叫什么。种类实现自己也从这里取 id,所以「这一种叫什么」
 * 全仓只有一个产地。
 */
export const FILES_ROOT_KIND = 'files-root'

/** 一棵以某目录为根的文件树的内容引用。 */
export const filesRootRef = (path: string): ContentRef => ({ kind: FILES_ROOT_KIND, key: path })

/** 反过来:这一格 tab 装的是不是一棵目录树?是就给出目录,不是就是 null。 */
export function filesRootPathOf(ref: ContentRef): string | null {
  return ref.kind === FILES_ROOT_KIND ? ref.key : null
}
