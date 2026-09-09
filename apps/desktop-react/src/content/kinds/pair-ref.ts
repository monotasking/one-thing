import { parseRefId, refId } from '../../workbench/kinds'
import type { ContentRef } from '../../workbench/kinds'

/**
 * **「一个标签装两格」在拼贴台里的名字**(W6-a,设计
 * `apps/desktop-react/docs/workbench-tabs-2026-09.md` §2.1)。
 *
 * ── 这几行为什么单独一个文件 ──────────────────────────────────────────────
 * 与 `stage/panel-ref.ts` / `./dir-ref.ts` 逐字同一条理由:它是**两层之间
 * 那条缝**。菜单、拖拽落定、会话投影都要认得出「这一格是两格并起来的」,而它们
 * 都不该 import 那一种内容的**实现**(`./pair.tsx` 的 import 闭包里有查看器、
 * 聊天流、Splitter)。种类实现自己也从这里取 id 与那两只纯函数,所以
 * 「这一种叫什么」「key 怎么拼 / 怎么拆」全仓各只有一个产地。
 *
 * ── key 的形:`${refId(a)}|${refId(b)}` ─────────────────────────────────
 * 设计 §2.1 明写的就是这个形。两条实现上的注意,都由用例钉着:
 *  · **冒号无碍** —— `parseRefId` 在**第一个**冒号处切,而这里切的是 `|`;
 *    一格 `pair` 的 refId 长成 `pair:file:/a.ts|session:x`,拆的时候先剥掉
 *    最前面那个 `pair:`(`parseRefId` 干的就是这件事),剩下的整串按 `|` 拆;
 *  · **路径里真有 `|` 也不会拆错** —— unix 路径允许这个字符。所以两边各自把
 *    字面的 `|` 转义成 `%7C`(拆的时候转回来)。转义只发生在这一格分隔符上,
 *    所以绝大多数 refId 写出来与设计里那个形逐字相同,而**往返是无损的**。
 */

/** 种类名。登记在 `./pair.tsx`。 */
export const PAIR_KIND = 'pair'

/** 两格之间那个分隔符(见文件头的转义那一条)。 */
const SEP = '|'
const SEP_ESCAPED = '%7C'

const encodeSide = (id: string): string => id.split(SEP).join(SEP_ESCAPED)
const decodeSide = (id: string): string => id.split(SEP_ESCAPED).join(SEP)

/** 两格 → 这一格的 key。**唯一产地**。 */
export function pairKeyOf(a: ContentRef, b: ContentRef): string {
  return `${encodeSide(refId(a))}${SEP}${encodeSide(refId(b))}`
}

/** 两格 → 这一格的 ref。 */
export function pairRefOf(a: ContentRef, b: ContentRef): ContentRef {
  return { kind: PAIR_KIND, key: pairKeyOf(a, b) }
}

/**
 * 反过来:这一格 tab 是不是两格并起来的?是就给出**左、右**两格,不是就是 null。
 * 拆不出两格合法的 ref(手改过的档案、被截断)也答 null —— 那时它不是一格
 * 能画出来的复合内容,`sanitize` 会把它当结构烂了处理。
 */
export function pairPartsOf(ref: ContentRef): [ContentRef, ContentRef] | null {
  if (ref.kind !== PAIR_KIND) return null
  const at = ref.key.indexOf(SEP)
  if (at <= 0 || at === ref.key.length - 1) return null
  const a = parseRefId(decodeSide(ref.key.slice(0, at)))
  const b = parseRefId(decodeSide(ref.key.slice(at + 1)))
  if (!a || !b) return null
  return [a, b]
}
