import type { ContentRef } from '../../workbench/kinds'

/**
 * **「以这个目录为根的一棵文件树」在拼贴台里的名字**(W3,设计 §3.1;种类名
 * 09-09 由 `files-root` 改成 `dir`,见下)。
 *
 * ── 这三行为什么单独一个文件 ──────────────────────────────────────────────
 * 与 `stage/panel-ref.ts` 逐字同一条理由:它是**两层之间那条缝**。`FilesPanel`
 * 与 `expose/Rail` 这两个来源要造这个 ref,而它们都不该 import 那一种内容的
 * **实现**(`./dir.tsx` 的 import 闭包里有查看器、有面板、有 store)——
 * 拖一行只需要知道它叫什么。种类实现自己也从这里取 id,所以「这一种叫什么」
 * 全仓只有一个产地。
 *
 * ── `files-root` → `dir`(K2b-1,`docs/design/atom-2026-09.md` §7 盲点 2 点名)──
 * 原子方案要求壳与 core 用同一张 scheme 表,而那张表里目录这一格叫 `dir`
 * (§2 的地址例子:`file:<abs>` / `dir:<abs>`)。**改名只在这一行**,别处全是
 * 读它;存量档案由 `content/legacy-refs.ts` 翻一遍(persist v4)。
 */
export const DIR_KIND = 'dir'

/**
 * **打开一个目录之前先把路径归一:去掉尾部的 `/`,根目录 `/` 除外。**
 *
 * 病历(09-23):聊天里那枚目录引用 chip 的路径**故意**带着尾斜杠 —— 那是句子里
 * 「这是个目录」的判据(`references/kinds/dir.ts` 文件头)。它原样交给打开目录那条
 * 路,于是同一个目录在拼贴台里有了两个身份:`dir:/a/Java/` 与 `dir:/a/Java`,
 * 点 chip 开一格、从文件树 / 启动瓦再开一格。尾斜杠是**呈现**上的事实,不是身份
 * 的一部分,所以在进拼贴台之前归一。幂等:归过的再归一次一个字不动。
 */
export function normalizeDirPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' && path.startsWith('/') ? '/' : trimmed
}

/** 一棵以某目录为根的文件树的内容引用。 */
export const dirRef = (path: string): ContentRef => ({ kind: DIR_KIND, key: path })

/** 反过来:这一格 tab 装的是不是一棵目录树?是就给出目录,不是就是 null。 */
export function dirPathOf(ref: ContentRef): string | null {
  return ref.kind === DIR_KIND ? ref.key : null
}
