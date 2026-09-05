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
  const leaf = node as { tabs?: unknown; preview?: unknown }
  if (!Array.isArray(leaf.tabs)) return node
  let changed = false
  const tabs: ContentRef[] = []
  const renamed = new Map<string, string | null>()
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
    renamed.set(idOf(tab), to ? idOf(to) : null)
    if (to) tabs.push(to)
  }
  if (!changed) return node
  /*
   * 预览那一格记的是 **refId 字符串**:被翻译掉的那一个要跟着改名,
   * 被丢掉的那一个要清成 null —— 留着一个指不到任何 tab 的 refId,
   * 屏幕上那片叶就永远认为「有一个预览格」。
   */
  const preview = typeof leaf.preview === 'string' && renamed.has(leaf.preview)
    ? renamed.get(leaf.preview) ?? null
    : leaf.preview ?? null
  return { ...leaf, tabs, preview }
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

const idOf = (ref: ContentRef): string => `${ref.kind}:${ref.key}`
