import type { ContentRef } from '../workbench/kinds'

/**
 * **Dock 上那些瓦在拼贴台里的名字**(W4,设计 `apps/desktop-react/docs/workbench-2026-09.md` §1.1)。
 *
 * W1-a 把那几块瓦(当时 12 块,2026-09-13「模型服务」退役后 11 块)整体登记成 `panel`
 * 这一种内容(`content/kinds/panel.tsx`),但那时
 * 树里还没有它们的消费者 —— 瓦仍旧走形态机那条老路。W4 把架子与浮窗换成树之后,
 * **瓦就是树里的一格 tab**,身份是 `{ kind: 'panel', key: <瓦 id> }`。
 *
 * ── 这三行为什么单独一个文件 ──────────────────────────────────────────────
 * 因为它是**两层之间那条缝**:形态机(`stage/*`)说的是「瓦 id」,拼贴台
 * (`workbench/*`)说的是「内容引用」。缝上那句翻译只该有一份 —— 散成三处
 * `{ kind: 'panel', key: id }` 的字面量,改一处漏两处是这类 bug 的全部来源。
 *
 * 放在 `stage/` 而不是 `workbench/` 是法条要求的:**核心层里不许出现种类名**
 * (`workbench/tree.ts` / `store.ts` / `layout.ts` grep `'panel'` 零命中,那是 W1-a
 * 立下的自证)。而 stage 本来就认识这些瓦 —— `stage/items.ts` 就是它们的名册。
 *
 * `content/kinds/panel.tsx` 从这里取 id,所以「这一种叫什么」全仓也只有一个产地。
 */
export const PANEL_KIND = 'panel'

/** 一块瓦的内容引用。 */
export const panelRef = (id: string): ContentRef => ({ kind: PANEL_KIND, key: id })

/** 反过来:这一格 tab 装的是不是一块瓦?是就给出瓦 id,不是就是 null。 */
export function panelIdOf(ref: ContentRef): string | null {
  return ref.kind === PANEL_KIND ? ref.key : null
}
