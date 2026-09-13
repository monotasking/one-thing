import type { ContentRef } from '../../workbench/kinds'

/**
 * **「这个工作目录此刻改了什么」在拼贴台里的名字**(「改动」面,正本
 * `apps/desktop-react/docs/changes-panel-2026-09.md` §3.1)。
 *
 * ── 这三行为什么单独一个文件 ──────────────────────────────────────────────
 * 与 `kinds/dir-ref.ts` / `terminal/terminal-ref.ts` 逐字同一条理由:它是**两层
 * 之间那条缝**。启动瓦(`content/diff-launcher.tsx`)、伴随面的 seed、将来聊天
 * 气泡里的「看改动」都要造这个 ref,而它们都不该 import 那一种内容的**实现**
 * (`./diff.tsx` 的 import 闭包里有整块面板、数据层与 diff 块)。种类实现自己也
 * 从这里取 id,所以「这一种叫什么」全仓只有一个产地。
 *
 * `key` = **工作目录的绝对路径**,不是仓库根:提问的人手里有的是「我在哪」(一条
 * 会话的工作目录),而根由后端 `rev-parse` 出来(判词在 `files/git-resource-spec.ts`
 * 的文件头)。同一个仓的两个子目录因此是两格 tab —— 它们答出来的根一样,而这
 * 一格的身份是**从哪儿问的**。
 *
 * 种类名 `diff` 与 core 的 scheme 语法相容(`^[a-z][a-z0-9-]*$`),
 * `__tests__/ref-syntax` 那一条自动覆盖它。
 */
export const DIFF_KIND = 'diff'

/** 一份改动面的内容引用。 */
export const diffRef = (workdir: string): ContentRef => ({ kind: DIFF_KIND, key: workdir })

/** 反过来:这一格 tab 装的是不是一份改动面?是就给出目录,不是就是 null。 */
export function diffWorkdirOf(ref: ContentRef): string | null {
  return ref.kind === DIFF_KIND ? ref.key : null
}
