import { useMemo } from 'react'
import { useWorkbenchStore } from '../workbench/store'
import { leavesOf, regionsInReadOrder } from '../workbench/tree'
import { flattenContent, referenceRootOfContent } from '../workbench/kinds'
import type { ContentRef } from '../workbench/kinds'
import type { PaneNode } from '../workbench/tree'
import type { PickRoot } from './kind'

/**
 * **`@` 从哪些目录里找 —— 唯一产地**(09-18,正本 `docs/composer-open-dir-mentions-2026-09.md` §2.2)。
 *
 * 用户那句话:「打开的一个 dir,如果不是 workdir,那么 composer 可以 @」。所以根是两家的并:
 *
 *  1. **会话工作目录**,永远第一格(`primary`),不论它有没有开成面板;
 *  2. **此刻开着的内容里自述了 `referenceRoot` 的那几格**,按工作台阅读序
 *     (区域序 → 叶序 → 标签序;两格标签摊开算)。
 *
 * 规则三条:
 *  · **在树上即算** —— 后台标签也算(它开着,只是没在前面);被藏起来的不在 `regions` 里,
 *    自然不算。
 *  · **被覆盖的丢** —— 与前面某根相同,或者落在前面某根之下(工作目录里的子目录面板),
 *    它的文件早已在那个根的候选里了。
 *  · **包住前面的留** —— 开着 `~` 时它仍是一个根;同一条路径由先到的根认领(后端按根序去重),
 *    所以工作目录里的文件仍然念相对路径、排在前面。
 *
 * ── 这只文件不认识「目录面板」 ────────────────────────────────────────────────
 * 它只问每一格内容一句 `referenceRootOfContent`。终端哪天也想让它的 cwd 能被 `@`,是终端那一种
 * 自己多答一格,这里一字不改(正本 §4 陌生能力演练)。
 */

/** 去掉尾斜杠(根自己 `/` 除外)。根的身份按这个比,`/a/b` 与 `/a/b/` 是同一个根。 */
export function normalizeRootPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed || '/'
}

/** `child` 是不是 `parent` 自己或它底下的路径。两边都要先归一。 */
export function isWithinRoot(child: string, parent: string): boolean {
  if (child === parent) return true
  const prefix = parent === '/' ? '/' : `${parent}/`
  return child.startsWith(prefix)
}

/**
 * **判据本体**(纯函数,脱开 store 测)。
 *
 * `rootOf` 缺省走内容种类表;测试可以递一只假的,不必登记种类。
 */
export function collectReferenceRoots(
  workdir: string | null,
  regions: Readonly<Record<string, PaneNode>>,
  rootOf: (ref: ContentRef) => string | null = referenceRootOfContent,
): PickRoot[] {
  const roots: PickRoot[] = []
  const admit = (raw: string, primary: boolean) => {
    if (!raw || !raw.startsWith('/')) return
    const path = normalizeRootPath(raw)
    if (roots.some((root) => isWithinRoot(path, root.path))) return
    roots.push({ path, primary })
  }

  if (workdir) admit(workdir, true)
  for (const regionId of regionsInReadOrder(regions)) {
    const tree = regions[regionId]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) {
        for (const part of flattenContent(tab)) {
          const root = rootOf(part)
          if (root) admit(root, false)
        }
      }
    }
  }
  return roots
}

/**
 * 抽屉读根表的那一口。
 *
 * **订阅的是一个字符串,不是 `regions`**:拼贴树每换一次标签、挪一次分隔线都会换一个 `regions`
 * 对象,而根表在那些时刻一个字都没变。选择器每次都算一遍(纯函数,几格标签的量),但交给 React 的
 * 是它的编码 —— 值没变,字符串就相等,输入面板**不重渲染**,`@` 候选的取数 effect 也不重发
 * (第 5 轴:切标签不该带出一次多余的渲染或往返)。
 */
export function usePickRoots(workdir: string | null): readonly PickRoot[] {
  const key = useWorkbenchStore((st) => JSON.stringify(collectReferenceRoots(workdir, st.regions)))
  return useMemo(() => JSON.parse(key) as PickRoot[], [key])
}
