import { useCallback, useMemo } from 'react'
import { useLiveTitleStore } from '../stage/live-title'
import { contentKindOf, mayCloseContent, refId } from './kinds'
import { tabSpecOf } from './LeafStrip'
import { canDetachTab, useWorkbenchStore } from './store'
import type { TabSpec } from '../ui/Tabs'
import type { ContentRef } from './kinds'
import type { PaneLeafNode, PaneNode } from './tree'

/**
 * **一片叶的那几格 tab,以及关掉其中一格**(W1-b 从 `PaneLeaf` 抽出来)。
 *
 * 抽出来的理由与 `LeafStrip` 当初出文件逐字同型:**这两件事有了第二个消费方**。
 * W1-b 之后中央叶的那条檐画在**窗口顶栏**上(设计 §2.2 的 D 稿),于是
 *  · tab 的数据表由顶栏那一组算(`TopBarTabs`);
 *  · 「关一格」这一口**两处都要**:顶栏那颗 ✕,以及焦点落在叶身体里时的 ⌘W。
 * 两处各写一遍的下场是它们迟早分叉,而分叉的第一处必然是 `await` 之后那一段
 * (下面写着病历)。
 */

/**
 * 关一格。先问种类(`beforeClose` —— 脏文件那一问),答 `'close'` 才真关。
 *
 * 这一问必须在**檐**这一侧发起:被关掉的那棵树自己问不了自己。
 *
 * ── 病历:`await` 之后不许拿旧下标 ────────────────────────────────────────
 * 那一问是异步的 —— 回来之后 `index` 可能已经不指着同一格了(隔壁被关掉、别处
 * 插了一格)。所以按 **refId 重新定位**,定位不到就当这一次作废。
 */
export function useCloseLeafTab(leaf: PaneLeafNode): (index: number) => Promise<void> {
  return useCallback(
    async (index: number) => {
      const ref = leaf.tabs[index]
      if (!ref) return
      if (!(await mayCloseContent(ref))) return
      const live = useWorkbenchStore.getState()
      const region = regionOfLeaf(live.regions, leaf.id)
      const tree = region ? live.regions[region] : undefined
      const at = tree ? leafTabsOf(tree, leaf.id).findIndex((tab) => refId(tab) === refId(ref)) : -1
      if (at < 0) return
      live.closeTab(leaf.id, at)
    },
    [leaf.id, leaf.tabs],
  )
}

/**
 * 这片叶交给 tab 条的那张**数据表**。身份两半合在这里:静态那一半问种类
 * (`kind.title`),活的那一半读 `live-title`(键 = refId,由内容自己发布)——
 * **活的盖静的**。
 */
export function useLeafTabSpecs(leaf: PaneLeafNode): TabSpec[] {
  const titles = useLiveTitleStore((st) => st.titles)
  return useMemo(
    () =>
      leaf.tabs.map((ref) =>
        tabSpecOf(ref, titles, {
          closable: canDetachTabIn(leaf, ref),
          // 「这一组的家」= 这一种自述自己是**常驻**的(设计 §2.2:会话标签的图标
          // 用主题色)。判据问的是种类的自述,不是种类名 —— W5 会话多开之后
          // 这一行一个字都不用改。
          home: Boolean(contentKindOf(ref.kind)?.resident),
        }),
      ),
    // `titles` 是整张表 —— 它变就重算,那正是「未保存丸 / 会话改名要跟着动」要的。
    [leaf, titles],
  )
}

/** 这一格画不画 ✕。判据整件在 `store.canDetachTab`(种类自述,不是种类名)。 */
function canDetachTabIn(leaf: PaneLeafNode, ref: ContentRef): boolean {
  const state = useWorkbenchStore.getState()
  const region = regionOfLeaf(state.regions, leaf.id)
  const tree = region ? state.regions[region] : undefined
  if (!tree) return true
  return canDetachTab(tree, leaf.id, leaf.tabs.indexOf(ref))
}

/** 这片叶住在哪个区域。 */
export function regionOfLeaf(
  regions: Readonly<Record<string, PaneNode>>,
  leafId: string,
): string | null {
  for (const [region, tree] of Object.entries(regions)) {
    if (hasLeaf(tree, leafId)) return region
  }
  return null
}

function hasLeaf(node: PaneNode, leafId: string): boolean {
  if (node.kind === 'leaf') return node.id === leafId
  return hasLeaf(node.a, leafId) || hasLeaf(node.b, leafId)
}

/** 这片叶此刻那几格 —— `useCloseLeafTab` 在 await 之后重新定位时用。 */
function leafTabsOf(node: PaneNode, leafId: string): readonly ContentRef[] {
  if (node.kind === 'leaf') return node.id === leafId ? node.tabs : []
  const a = leafTabsOf(node.a, leafId)
  return a.length > 0 ? a : leafTabsOf(node.b, leafId)
}
