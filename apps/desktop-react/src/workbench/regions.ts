import type { ShelfSide } from '../stage/types'

/**
 * **区域 = 一棵拼贴树的持有者**(设计 `docs/design/…` → `apps/desktop-react/docs/workbench-2026-09.md` §1.3)。
 *
 * ── 为什么这一个联合可以被枚举,而内容种类不可以 ────────────────────────────
 * 设计 §7「演练三」逐字写着:区域是**壳的家具**,不是能力 —— 中央区一格、四条边
 * 各一格、每扇浮窗一格,这是外壳的版式自己数得出来的一个封闭小集合(加一个区域
 * 要动的是 `AppShell` 的网格与拖拽的几何,本来就是壳的事)。而**内容种类**是
 * 开放的:加一种内容不许惊动核心层,所以 `ContentRef.kind` 是一个字符串,
 * 核心层一个种类名都不出现(`workbench/tree.ts` / `workbench/store.ts` 里 grep
 * `'file'` / `'chat'` / `'panel'` 零命中,这是本批的自证之一)。
 *
 * W1-a 只点亮 `center` 一格。`edge:*` / `float:*` 的形先在这里定下来,好让
 * `PaneLocation` 与「回哪儿去」的记账从第一天起就说得出完整的坐标 —— W4 把架子
 * 与浮窗换成树时,这个类型一个字都不用改。
 */
export type RegionId = 'center' | `edge:${ShelfSide}` | `float:${string}`

/** 中央区。永远在(设计 §1.3:`regions` 里 center 是必选那一格)。 */
export const CENTER_REGION = 'center' as const satisfies RegionId

/** 一条边的架子区域 id。W1-a 还没有人建它,形先定下。 */
export const edgeRegion = (side: ShelfSide): RegionId => `edge:${side}`

/** 一扇浮窗的区域 id。 */
export const floatRegion = (id: string): RegionId => `float:${id}`

/**
 * **区域的阅读序排位**(W7-p 修一轮裁定 9):中央区 0、四条边 1、浮窗 2。
 *
 * 「同一格内容可以同时开在两处」(会话不是单例那一种),而「切过去」必须每次都
 * 切到同一格,否则同一下按出两种结果 —— 所以要一张**确定的**次序表,
 * `Object.keys` 的次序不是判据。中央区打头是因为那是用户眼里的主区。
 *
 * 三种区域的形只有这只文件说得出,所以判据也只该在这里:前缀是拿
 * `edgeRegion` / `floatRegion` **自己**造出来的,不是抄一遍 `'edge:'` 这三个字。
 */
const EDGE_PREFIX = edgeRegion('' as ShelfSide)
const FLOAT_PREFIX = floatRegion('')

export function regionReadRank(region: string): number {
  if (region === CENTER_REGION) return 0
  if (region.startsWith(EDGE_PREFIX)) return 1
  if (region.startsWith(FLOAT_PREFIX)) return 2
  // 认不得的区域排在最后 —— 存量档案里可能有,而它绝不该抢在中央区前面。
  return 3
}
