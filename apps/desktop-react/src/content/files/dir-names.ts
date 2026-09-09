import { baseNameOf } from '../../data/files-source'
import { flattenContent, refId } from '../../workbench/kinds'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import { DIR_KIND } from '../kinds/dir-ref'

/**
 * **目录面板的名字**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。
 *
 * 一句话:名字是 `basename`;屏幕上同时开着两个**同名**目录时,名字后面带上
 * 父目录(`docs · a` / `docs · b`)。Tooltip 永远是全路径(那一格由种类自述给,
 * 不在这里)。
 *
 * ── 它为什么是一只纯函数 + 一个非响应式读 ────────────────────────────────
 * `ContentKind.title` 不是 hook,它答的是「静态那一半」;而这一句要知道**此刻树上
 * 还开着哪些目录**,那是一份运行期事实。两件事的接法与叶檐读 `live-title` 同型:
 * **判据本体是纯函数**(`disambiguate`,可以脱开 store 测),取数那一句现读
 * (`useWorkbenchStore.getState()`)。重算的时机白拿:开 / 关一个目录一定会改到
 * 那片叶,而标签的数据表 memo 在 `[leaf, titles]` 上 —— 叶一变就重算。
 */

/** 一条路径的父目录名(顶到根时是空串)。 */
export function parentNameOf(path: string): string {
  const at = path.replace(/\/+$/, '').lastIndexOf('/')
  if (at <= 0) return ''
  return baseNameOf(path.slice(0, at))
}

/**
 * **判据本体**:在 `all` 这些目录里,`path` 该叫什么。
 *
 * 同名的只有它自己 = `basename`;有别人同名 = `basename · 父目录名`。
 * 父目录名也空(两个都在根下)= 退回全路径 —— 说不清楚就说全,不编一个更短的谎。
 */
export function disambiguate(path: string, all: readonly string[]): string {
  const name = baseNameOf(path)
  if (!name) return path
  const clashes = all.filter((other) => other !== path && baseNameOf(other) === name)
  if (clashes.length === 0) return name
  const parent = parentNameOf(path)
  return parent ? `${name} · ${parent}` : path
}

/** 此刻各棵树上开着的那些目录面板(按阅读序,去重)。 */
export function openDirRoots(): string[] {
  const { regions } = useWorkbenchStore.getState()
  const out = new Set<string>()
  for (const tree of Object.values(regions)) {
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) {
        /*
         * **两格标签里那一格也算在场** —— 它的名字同样画在屏幕上(标签的左半边、
         * 格头上那一条)。摊开那一句走**种类自述**(`flattenContent`),所以这只
         * 文件不认识「两格」这个概念,只认识「一格标签可能装着好几格内容」。
         */
        for (const part of flattenContent(tab)) {
          if (part.kind === DIR_KIND) out.add(part.key)
        }
      }
    }
  }
  return [...out]
}

/** 一个目录面板此刻该叫什么(上面两只合起来)。 */
export function disambiguatedDirName(path: string): string {
  return disambiguate(path, openDirRoots())
}

/** 这个目录面板的 refId(给门与用例的取件口)。 */
export const dirRefId = (path: string): string => refId({ kind: DIR_KIND, key: path })
