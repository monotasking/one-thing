import { memo, useMemo, useRef } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { refId } from './kinds'
import { useCloseLeafTab } from './leaf-tabs'
import { renderRef } from './render'
import { useWorkbenchStore } from './store'
import type { ContentRef } from './kinds'
import type { PaneLeafNode } from './tree'
import s from './PaneLeaf.module.css'

/**
 * **一片叶 = 一组 tab 的身体**(W1,设计 §2.2「一格一檐」)。
 *
 * 规则只有一条:**一片叶只有一条檐,那条檐就是 tab 条;内容自己不画檐。**
 * 于是从前那两颗语义不同的 ✕(查看器自己那颗 = 关文件 / 宿主檐那颗 = 收回 Dock)
 * 塌成一颗:**tab 上那颗 ✕ = 关闭这一格**。
 *
 * ── W1-b:那条檐搬进了窗口顶栏,这只文件因此只剩身体 ──────────────────────
 * 设计 §2.2 的 D 稿(用户原话:「标签不要占聊天区域,聊天区现在多宽以后就多宽,
 * 把标签放到红绿灯那一栏上」)把中央叶的檐整条搬到了顶栏
 * (`workbench/TopBarTabs.tsx`):一片叶一组标签,**各坐各叶的正上方**,活动标签
 * 与它下面这片叶连成一块。所以这里去掉的是「画檐」那一段 —— 檐的**件**
 * (`LeafStrip`)、它的**数据表**(`leaf-tabs.ts`)、它的**动作组**(`LeafActions`)
 * 一件都没重写,只是换了挂载点。这片叶自己留下的只有:
 *  · 身体(每一格 tab 各一层,keep-alive);
 *  · 焦点作用域与「点哪片哪片就是焦点叶」;
 *  · 焦点边那一圈(下面那张状态表的最后一格)。
 * 顶边与顶圆角本来就没画过,所以「中央叶去顶边直接接在顶栏底下」在这只文件里
 * 是一句**已经成立**的话;要补的只有一格底色(见 `.leaf`,连体那条契约的另一半)。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载      树里出现这片叶(出厂那一片、或一次分屏)
 *   首载      第一个 tab 的内容异步到达 —— 由内容自己说(查看器的「正在读取…」)
 *   换宿主    整棵树随区域搬(center → edge → float,W4):**叶不重挂,只换外框** ——
 *             结构共享保证的(`tree.mapLeaf` 没改到的支原样带过),不是靠自觉
 *   卸载      最后一个 tab 关掉 / 藏起来,叶被 `prune` 剪掉
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   (檐的那几格 —— 单 tab / 多 tab / 预览 / 超量 —— 写在 `LeafStrip` 上,
 *    它有三个宿主,那张表不该跟着某一个宿主走)
 *   这一层自己只有一格:**空叶**(没有一格 tab)——`prune` 会当场把它剪掉,
 *   所以它在屏幕上停留不到一帧,不画任何空态。
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   焦点叶     一圈内描边(只有多于一片叶时画)
 *   被悬停     顶栏上它那一组标签被悬停时,亮一圈 `--accent-soft`
 *              (判据由顶栏那一侧写进 `data-pane-hint`,理由写在那只组件上)
 *   分隔杆     随 `ui/Splitter`(在 `PaneTree` 上,不在这里)
 */
export const PaneLeaf = memo(function PaneLeaf({ leaf }: { leaf: PaneLeafNode }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  const setFocusLeaf = useWorkbenchStore((st) => st.setFocusLeaf)
  const closeAt = useCloseLeafTab(leaf)
  const active = leaf.tabs[leaf.active] ?? null

  /**
   * ⌘W:关当前 tab。表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.leaf.keys`。
   *
   * 顶栏上那一组也注入同名的一口(同一个 `owner`,两份实例)—— 于是焦点在**叶的
   * 身体里**还是在**它的标签上**,⌘W 都关得掉这一格。少了这一边,「在查看器里
   * 按 ⌘W」就没人接。
   */
  const leafKeys = useMemo(
    () => ({ closeTab: active ? () => void closeAt(leaf.active) : undefined }),
    [active, closeAt, leaf.active],
  )

  return (
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} keyHandlers={leafKeys}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.leaf}
          data-pane-leaf={leaf.id}
          data-pane-focus={focusLeafId === leaf.id || undefined}
          /*
           * 点这片叶的任何地方 = 它成为焦点叶(「新标签开在哪一片」的答案)。
           * 用 `onPointerDownCapture` 而不是 click:分屏菜单那颗钮按下去时就该
           * 先把焦点叶指过来,不然新叶会长在隔壁那片上。
           */
          onPointerDownCapture={() => setFocusLeaf(leaf.id)}
        >
          {/*
            身 = 这片叶里**每一个** tab 的内容(keep-alive,与架子同一条判据):
            切 tab 只换哪一层显形,不卸载谁 —— 重面板(会话总览那 400 张卡)
            不必每次切回都重建,查看器的滚动位与草稿也不会因为切走一格就没了。
          */}
          <div className={s.body} data-pane-body={leaf.id}>
            {leaf.tabs.map((ref, index) => (
              <PaneTabLayer key={refId(ref)} tabRef={ref} on={index === leaf.active} />
            ))}
          </div>
        </div>
      )}
    </FocusScope>
  )
})

/**
 * 一格 tab 的内容层。**`inert` 说两遍,而且是同一个判据**(逐字照 `EdgeShelf`):
 * 一遍给 DOM(浏览器据此把这一层移出焦点序与辅助树),一遍给树
 * (`<FocusScope inert>` —— 注册表据此不选它当第一响应者,而且**路径经过它就在
 * 那儿截断**)。少了给树的那一遍,后台那格照样能被算成第一响应者,它的局部键
 * 会在看不见的地方响;少了给 DOM 的那一遍,焦点能 Tab 进一块看不见的面。
 *
 * ── 为什么它也是一格 `leaf` 作用域 ───────────────────────────────────────
 * 树上同一个 scope id 可以有好几份实例(`ScopeNode.instanceId`),取哪一份靠
 * `owner`。这里的 owner 是**这一格的 refId**,而叶根那一格的 owner 是**叶 id** ——
 * 于是 `activateScope('leaf', { owner: leafId })`(跟焦那条路)精确取到叶根,
 * 而这一层只做一件事:**把看不见的那一格从活动路径上摘掉**。
 *
 * `memo` 不许省:切一次 tab 只有翻了 `on` 的那两层该重渲,别的 tab 一动不动
 * (与 `ShelfTabLayer` 同一条读数背书)。
 */
const PaneTabLayer = memo(function PaneTabLayer({ tabRef, on }: { tabRef: ContentRef; on: boolean }) {
  const visibility = useMemo(() => ({ visible: on, interactive: on }), [on])
  return (
    <FocusScope scope="leaf" inert={!on} owner={refId(tabRef)}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={on ? s.layer : `${s.layer} ${s.layerHidden}`}
          data-pane-tab={refId(tabRef)}
          data-pane-on={on || undefined}
          inert={!on || undefined}
        >
          {renderRef(tabRef, visibility)}
        </div>
      )}
    </FocusScope>
  )
})
