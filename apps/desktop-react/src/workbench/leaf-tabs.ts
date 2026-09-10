import { useCallback, useMemo } from 'react'
import { announce } from '../ui/a11y/live-region'
import { t, useT } from '../i18n'
import { previewIndexOf } from './tree'
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
      /*
       * ── **关不掉的那一格要说话**(W7-t / B12)───────────────────────────
       * 屏幕上那颗 ✕ 对这一格是不画的(`ui/Tabs`:「一颗按不动的 ✕ 与『按了没
       * 反应』在屏幕上是同一件事」),所以走到这里的只可能是**键盘**那条路
       * (⌘W / Delete)—— 而键盘那条路从前是一次**静默的空动作**:真机读数
       * 「before 5 / after 5」,人听不出是坏了还是不许。
       *
       * 判据一个字都不新写:`canDetachTab`(种类自述,不是种类名)。播报走的是
       * 拖拽拒绝那同一口 `announce` —— 「这里不能放」与「这一格不能关」是同一
       * 族的话,只该有一个出口。
       *
       * 它排在 `beforeClose` **之前**:先问用户「存不存」再告诉他「反正也关不掉」
       * 是把两次打断叠在一起。
       */
      const before = useWorkbenchStore.getState()
      const beforeRegion = regionOfLeaf(before.regions, leaf.id)
      const beforeTree = beforeRegion ? before.regions[beforeRegion] : undefined
      if (beforeTree && !canDetachTab(beforeTree, leaf.id, index, beforeRegion)) {
        announce(t('workbench.tabNotClosable'))
        return
      }
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
  /*
   * **预览格那句状态词**(C2)。在这一层读 i18n 而不是在 `ui/Tabs` 里,是那件库件
   * 的纪律:`ui/` 不落界面文案(判词整段在 `TabSpec.preview` 上)。
   */
  const previewWord = useT()('workbench.tabPreview')
  const previewAt = previewIndexOf(leaf)
  return useMemo(
    () =>
      leaf.tabs.map((ref, index) =>
        tabSpecOf(ref, titles, {
          closable: canDetachTabIn(leaf, ref),
          // 「这一组的家」= 这一种自述自己是**常驻**的(设计 §2.2:会话标签的图标
          // 用主题色)。判据问的是种类的自述,不是种类名 —— W5 会话多开之后
          // 这一行一个字都不用改。
          home: Boolean(contentKindOf(ref.kind)?.resident),
          /*
           * 判据是**这片叶上的那个下标**,不是这一格装着谁(C2)—— 同一条会话
           * 可以在一片叶里是预览格、在另一片叶里是普通标签,所以它问不到种类表上。
           */
          preview: index === previewAt ? previewWord : undefined,
        }),
      ),
    // `titles` 是整张表 —— 它变就重算,那正是「未保存丸 / 会话改名要跟着动」要的。
    [leaf, titles, previewAt, previewWord],
  )
}

/**
 * **「这一格挪得走吗」的那一句读法**(U3-b 从下面 `canDetachTabIn` 里抬出来)。
 *
 * 判据本身整件在 `store.canDetachTab`(种类自述,不是种类名);这一只只做它
 * 前面那两步 —— **这片叶在哪个区域、那个区域是哪棵树**。抬出来是因为它有了
 * 第二个消费方(`LeafActions` 那张右键表要按同一条判据禁灰),而两处各查一遍
 * 「区域 + 树」正是判据分叉的第一个入口:少交一个 `region`,一条被拖进架子的
 * 会话就会在架子上被判成「最后一格常驻」(09-08 报障「放进去之后关不掉」)。
 *
 * 交的是 `regions` 整张表而不是读 `getState()`:调用方可以把它塞进一格 zustand
 * 选择器里(菜单要的是**活的**答案 —— 树在菜单开着时变了,那三项要跟着解禁)。
 * 树都找不到 = 这片叶不在任何区域上,不拦(与修前逐字同一答案)。
 */
export function canDetachTabAt(
  regions: Readonly<Record<string, PaneNode>>,
  leafId: string,
  index: number,
): boolean {
  const region = regionOfLeaf(regions, leafId)
  const tree = region ? regions[region] : undefined
  if (!tree) return true
  return canDetachTab(tree, leafId, index, region)
}

/**
 * 这一格画不画 ✕。判据整件在 `store.canDetachTab`(种类自述,不是种类名)——
 * **区域一起交过去**(U3):那条守卫只对常驻那一种自己的家成立,而「这片叶在
 * 哪个区域」只有这里查得出(判词整段在 `canDetachTab` 上)。少了这一格,一条
 * 被拖进架子的会话会在架子上被判成「最后一格常驻」,✕ 就此不画 —— 那正是
 * 09-08 报障「放进去之后关不掉」。
 */
function canDetachTabIn(leaf: PaneLeafNode, ref: ContentRef): boolean {
  return canDetachTabAt(useWorkbenchStore.getState().regions, leaf.id, leaf.tabs.indexOf(ref))
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
