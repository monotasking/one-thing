import { foldLeaves } from './tree'
import type { ContentRef } from './kinds'
import type { PaneNode } from './tree'

/**
 * **落盘档案的通用改写器**(W5-b)。
 *
 * 一种内容改了名字(`chat` → `session`)或者改了 key 的写法,存量档案里那些格子
 * 就得跟着翻译一遍。这只文件知道**档案长什么形**(`byWorkspace` → 每个空间一份
 * `{regions, hidden}` → 每棵树 → 每片叶 → 每一格 ref),但**一个种类名都不知道**
 * —— 翻译那一句由调用方递进来(产地 `content/legacy-refs.ts`,那儿才是种类的地盘)。
 *
 * 两条硬要求,都由用例钉着:
 *  · **幂等** —— 翻译过一遍的档案再翻一遍,结果逐字相同;
 *  · **引用恒等** —— 一格都没改到时**原样交回同一个对象**(每一层都比对了才重建)。
 *    没有这一条,每次启动都会写回一份「内容相同、身份不同」的档案,而
 *    zustand 的 `merge` 之后紧接着就是一次 `partialize` 写盘。
 */

/** 一格 ref 的翻译。答 `null` = 这一格该整个丢掉;答同一个对象 = 不动。 */
export type RefRewrite = (ref: ContentRef) => ContentRef | null

/**
 * 走一遍整份落盘档案。**形状闸在每一层**:落盘的 JSON 可能是任何东西
 * (手改过、版本对不上、被截断),遇到不认得的形就原样带过 —— 迁移不是校验器,
 * 洗形状那件事有它自己的产地(`tree.sanitize`,在 merge 里跑)。
 */
export function rewriteRefsInPersisted(
  persisted: Record<string, unknown>,
  rewrite: RefRewrite,
): Record<string, unknown> {
  const spaces = persisted.byWorkspace
  if (!spaces || typeof spaces !== 'object') return persisted
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [spaceId, furniture] of Object.entries(spaces as Record<string, unknown>)) {
    const migrated = rewriteFurniture(furniture, rewrite)
    if (migrated !== furniture) changed = true
    next[spaceId] = migrated
  }
  return changed ? { ...persisted, byWorkspace: next } : persisted
}

function rewriteFurniture(furniture: unknown, rewrite: RefRewrite): unknown {
  if (!furniture || typeof furniture !== 'object') return furniture
  const row = furniture as { regions?: unknown; hidden?: unknown }
  const regions = rewriteRegions(row.regions, rewrite)
  const hidden = rewriteHidden(row.hidden, rewrite)
  if (regions === row.regions && hidden === row.hidden) return furniture
  return { ...row, regions, hidden }
}

function rewriteRegions(regions: unknown, rewrite: RefRewrite): unknown {
  if (!regions || typeof regions !== 'object') return regions
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [region, tree] of Object.entries(regions as Record<string, unknown>)) {
    const migrated = rewriteNode(tree, rewrite)
    if (migrated !== tree) changed = true
    next[region] = migrated
  }
  return changed ? next : regions
}

function rewriteNode(node: unknown, rewrite: RefRewrite): unknown {
  if (!node || typeof node !== 'object') return node
  const shape = node as Partial<PaneNode>
  if (shape.kind === 'split') {
    const split = node as { a: unknown; b: unknown }
    const a = rewriteNode(split.a, rewrite)
    const b = rewriteNode(split.b, rewrite)
    if (a === split.a && b === split.b) return node
    return { ...split, a, b }
  }
  if (shape.kind !== 'leaf') return node
  const leaf = node as { tabs?: unknown }
  if (!Array.isArray(leaf.tabs)) return node
  let changed = false
  const tabs: ContentRef[] = []
  for (const tab of leaf.tabs) {
    if (!isRef(tab)) {
      tabs.push(tab as ContentRef)
      continue
    }
    const to = rewrite(tab)
    if (to === tab) {
      tabs.push(tab)
      continue
    }
    changed = true
    if (to) tabs.push(to)
  }
  if (!changed) return node
  return { ...leaf, tabs }
}

function rewriteHidden(hidden: unknown, rewrite: RefRewrite): unknown {
  if (!Array.isArray(hidden)) return hidden
  let changed = false
  const out: unknown[] = []
  for (const entry of hidden) {
    const ref = (entry as { ref?: unknown })?.ref
    if (!isRef(ref)) {
      out.push(entry)
      continue
    }
    const to = rewrite(ref)
    if (to === ref) {
      out.push(entry)
      continue
    }
    changed = true
    if (to) out.push({ ...(entry as object), ref: to })
  }
  return changed ? out : hidden
}

function isRef(value: unknown): value is ContentRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<ContentRef>
  return typeof ref.kind === 'string' && typeof ref.key === 'string'
}

/* ── v3(W6-a):一个区域折成一片叶 + 预览那一格退役 ─────────────────────────
 *
 * 两件事一起走一遍,因为它们**走的是同一棵树**,而这只文件的两条硬要求
 * (幂等、引用恒等)是逐层比对出来的 —— 分两遍就得比两次,而第一遍造出来的
 * 新对象会让第二遍永远认为「变了」。
 *
 *  ① **折叶**:`foldRegions` 里点名的那些区域(今天只有中央区),多叶存档按
 *     阅读序并成一条标签列表,比例(split 节点)整个丢掉。算术不在这里 ——
 *     它与运行期那一遍共用 `tree.foldLeaves`,不许两处各写一份;
 *  ② **删 `preview`**:每一片叶身上那一格字段抹掉。留着不会让今天的形状闸
 *     报错(它已经不判这一格了),但它会在下一次写盘时原样落回去 ——
 *     一份档案里永远躺着一个谁都不读的字段是下一个人的陷阱。
 *
 * 与 v2 那只改写器同一个体例:**每一层都比对了才重建**,一格都没改到时原样
 * 交回同一个对象;跑过一遍的档案再跑一遍逐字相同(用例钉着两条)。
 */
export function foldRegionsInPersisted(
  persisted: Record<string, unknown>,
  foldRegions: readonly string[],
): Record<string, unknown> {
  const spaces = persisted.byWorkspace
  if (!spaces || typeof spaces !== 'object') return persisted
  const fold = new Set(foldRegions)
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [spaceId, furniture] of Object.entries(spaces as Record<string, unknown>)) {
    const migrated = foldFurniture(furniture, fold)
    if (migrated !== furniture) changed = true
    next[spaceId] = migrated
  }
  return changed ? { ...persisted, byWorkspace: next } : persisted
}

function foldFurniture(furniture: unknown, fold: ReadonlySet<string>): unknown {
  if (!furniture || typeof furniture !== 'object') return furniture
  const row = furniture as { regions?: unknown }
  const regions = row.regions
  if (!regions || typeof regions !== 'object') return furniture
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [region, tree] of Object.entries(regions as Record<string, unknown>)) {
    // 折叶只作用在点名的那些区域;`preview` 那一格**每一棵树都抹**。
    const stripped = stripPreview(tree)
    const migrated = fold.has(region) ? foldNode(stripped) : stripped
    if (migrated !== tree) changed = true
    next[region] = migrated
  }
  return changed ? { ...row, regions: next } : furniture
}

/** 把一格 `preview` 从每一片叶身上抹掉。没有那一格时原样交回。 */
function stripPreview(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const shape = node as Partial<PaneNode>
  if (shape.kind === 'split') {
    const split = node as { a: unknown; b: unknown }
    const a = stripPreview(split.a)
    const b = stripPreview(split.b)
    if (a === split.a && b === split.b) return node
    return { ...split, a, b }
  }
  if (shape.kind !== 'leaf') return node
  if (!('preview' in (node as object))) return node
  const { preview: _drop, ...rest } = node as Record<string, unknown>
  void _drop
  return rest
}

/**
 * 一棵存档里的树折成一片叶。**判据本体是 `tree.foldLeaves`** —— 这里只负责
 * 「档案里那坨 JSON 是不是一棵认得出的树」这一句形状闸(落盘的东西可能是任何
 * 东西:手改过、被截断、版本对不上),认不出就原样带过。
 */
function foldNode(node: unknown): unknown {
  if (!isPersistedNode(node)) return node
  const folded = foldLeaves(node)
  return folded === node ? node : folded
}

/* ── v5(C3):每个空间补一格家具字段 ────────────────────────────────────────
 *
 * 「加一格家具」这件事此后每一批都会再来一次(C3 是 `sessionCompanions`),所以
 * 它是**一只通用的**而不是一段专用代码 —— 与这只文件里另外两只同一个体例:
 * 知道**档案长什么形**(`byWorkspace` → 每个空间一份家具),但**一个字段的含义
 * 都不知道**(叫什么、缺省是什么,由调用方递进来)。
 *
 * 两条硬要求照旧:**幂等**(已经有那一格的原样放行 —— 存量实例的写盘会带着新
 * 版本号落旧值,那时 migrate 不再跑)与**引用恒等**(一格都没补到时原样交回
 * 同一个对象,免得每次启动都写回一份「内容相同、身份不同」的档案)。
 */
export function defaultFurnitureFieldInPersisted(
  persisted: Record<string, unknown>,
  key: string,
  make: () => unknown,
): Record<string, unknown> {
  const spaces = persisted.byWorkspace
  if (!spaces || typeof spaces !== 'object') return persisted
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [spaceId, furniture] of Object.entries(spaces as Record<string, unknown>)) {
    if (!furniture || typeof furniture !== 'object' || key in (furniture as object)) {
      next[spaceId] = furniture
      continue
    }
    changed = true
    next[spaceId] = { ...(furniture as object), [key]: make() }
  }
  return changed ? { ...persisted, byWorkspace: next } : persisted
}

function isPersistedNode(value: unknown): value is PaneNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<PaneNode>
  if (node.kind === 'leaf') {
    const leaf = value as Partial<{ id: string; tabs: unknown; active: unknown }>
    return typeof leaf.id === 'string' && Array.isArray(leaf.tabs) && typeof leaf.active === 'number'
  }
  if (node.kind === 'split') {
    const split = value as Partial<{ a: unknown; b: unknown }>
    return isPersistedNode(split.a) && isPersistedNode(split.b)
  }
  return false
}
