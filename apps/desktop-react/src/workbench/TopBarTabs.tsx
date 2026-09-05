import { memo, useCallback, useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { refId } from './kinds'
import { LeafActions } from './LeafActions'
import { LeafStrip } from './LeafStrip'
import { useLeafGeometry } from './leaf-geometry'
import { useCloseLeafTab, useLeafTabSpecs } from './leaf-tabs'
import { spanWVar, spanXVar, topStrips } from './layout'
import { CENTER_REGION } from './regions'
import { focusLeafOf, useWorkbenchStore } from './store'
import { useTabDrag } from './useTabDrag'
import { findLeaf } from './tree'
import type { TopStripSlot } from './layout'
import type { PaneLeafNode } from './tree'
import s from './TopBarTabs.module.css'

/**
 * **中央区的檐就是窗口顶栏**(W1-b,设计 §2.2「中央区的檐就是窗口顶栏(D 稿)」)。
 *
 * 用户原话:标签不要占聊天区域,聊天区现在多宽以后就多宽,把标签放到红绿灯那一栏上。
 * 这是「浮窗的标题栏就是它的标签条」那条规则推到主窗口:**宿主窗的标题栏就是中央区
 * 的标签条**,聊天区里一个像素的檐都不画。
 *
 * ── 三件事定死了这只组件的形 ────────────────────────────────────────────
 *
 * ① **DOM 必须留在 `.bar` 子树里,不许 portal**(坑 ①,08 月拖拽区判例)。
 *    `-webkit-app-region: no-drag` 只在 drag 元素**同一分支的子孙**上才生效;
 *    portal 到 body 之后那句声明**静默失效** —— 屏幕上一模一样,点标签变成拖窗,
 *    没有任何报错。所以位置靠 CSS 变量(`leaf-geometry.ts` 量、`calc()` 读),
 *    DOM 一步都不离开顶栏。
 *
 * ② **焦点归属靠 `FocusScope` 的 `owner`,不靠 DOM 位置**。顶栏上的标签**属于它
 *    所代表的那片叶的作用域**(设计 §2.2 原话)。响应链按活动路径判、不按 DOM
 *    祖先判(portal 判例),所以这里给每一组再登记一格 `scope="leaf"
 *    owner=<叶 id>` ——它与叶身体那一格是**同一个 owner 的两份实例**,`⌘W` 因此
 *    在两边都响。**留账**:这两份实例在树上是兄弟(父都是 root),不是父子 ——
 *    `FocusScope` 的父由 React context 给,而顶栏不在叶里。中央叶今天不会被
 *    `inert`,所以「叶 inert 时它的标签一并不可达」那一句还没有落点;W4 架子 /
 *    浮窗进来时再谈。
 *
 * ③ **几何是算出来的,一帧不经过 React**。每一组的左右界读两格 CSS 变量;拖分隔杆
 *    时 `ui/Splitter` 把活值写进树根那格比例变量 → 叶的盒变 → `ResizeObserver`
 *    重写这两格 → 标签组跟着挪,整条链上没有一次 setState。
 */

/**
 * 顶栏上那条**标签带**:中央区每片叶一组,各坐各叶的正上方。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 顶栏挂载(恒有);**叶分屏 / 合并 / 架子收展时几何重算** ——
 *    分屏与合并改的是 `topStrips` 那张表(React 重渲、组的 key = 叶 id 所以留下来
 *    的组不重挂),架子收展与拖杆改的只是叶的盒(`ResizeObserver`,零渲染);
 *    卸载 = 整台壳卸载(带子把写过的几何变量逐格抹掉)。
 * ② UI 生命状态:**单叶**(一组,退化成一条身份带 = 今天的会话标题,左对齐,
 *    零视觉回退)/ **多叶**(多组,各坐各的;上下切分横向重叠时按序平分)/
 *    **窄档溢出**(组内先按 `--tab-max-w` 收窄,再由 `ui/Tabs` 自己横滚;
 *    **永不换行、永不挤掉右端动作组** —— 后者靠「组是绝对定位、带子止于尾格左缘」
 *    在结构上保证,不靠算)。
 * ③ UI 交互状态:**焦点组**亮(活动标签吃满 `--pane-face`,与下面那片叶连成一块)/
 *    **非焦点组**活动标签底色降一档(`--topbar-tab-face-dim`)/ **hover 一组** →
 *    对应那片叶亮一圈(`--accent-soft` 内描边);tab 自身的 rest/hover/focus/
 *    selected 随 `ui/Tabs`。
 */
export function TopBarLeafTabs() {
  const t = useT()
  const tree = useWorkbenchStore((st) => st.regions[CENTER_REGION])
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  const bandRef = useRef<HTMLDivElement>(null)

  const slots = useMemo(() => (tree ? topStrips(tree) : []), [tree])
  /*
   * 要量哪几个节点的跨度。**去重**:上下切分那一形里两组共用同一个 `spanId`,
   * 量两遍是白量(而且会让 `ResizeObserver` 对同一个元素 observe 两次)。
   */
  const spanIds = useMemo(() => [...new Set(slots.map((slot) => slot.spanId))], [slots])
  useLeafGeometry(bandRef, spanIds)

  return (
    /*
     * 带子是顶栏里的一格 **flex 项**,吃掉让位与尾格之间的全部剩余宽度。
     * 于是「标签永不挤掉右端动作组」这句话由**布局**保证:组是它的绝对定位子孙,
     * 越不过它的右缘;而它的右缘就是尾格的左缘。
     */
    <div
      ref={bandRef}
      className={s.band}
      data-testid="topbar-tabs"
      role="group"
      aria-label={t('workbench.topbarTabs')}
    >
      {slots.map((slot) => {
        const leaf = tree ? findLeaf(tree, slot.leafId) : null
        if (!leaf) return null
        return (
          <LeafTabGroup
            // key = 叶 id:分屏 / 关叶时留下来的那几组**不重挂**(零重挂断言)。
            key={leaf.id}
            leaf={leaf}
            slot={slot}
            focused={focusLeafId === leaf.id}
          />
        )
      })}
    </div>
  )
}

/**
 * 一片叶在顶栏上的那一组标签。
 *
 * `memo` 不许省:切一次 tab、换一次焦点叶,只该重渲翻了那一格的组。
 */
const LeafTabGroup = memo(function LeafTabGroup({
  leaf,
  slot,
  focused,
}: {
  leaf: PaneLeafNode
  slot: TopStripSlot
  focused: boolean
}) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const activateTab = useWorkbenchStore((st) => st.activateTab)
  const setFocusLeaf = useWorkbenchStore((st) => st.setFocusLeaf)
  const tabs = useLeafTabSpecs(leaf)
  const closeAt = useCloseLeafTab(leaf)
  const active = leaf.tabs[leaf.active] ?? null

  /** ⌘W:关当前 tab。表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.leaf.keys`。 */
  const leafKeys = useMemo(
    () => ({ closeTab: active ? () => void closeAt(leaf.active) : undefined }),
    [active, closeAt, leaf.active],
  )

  const onSelect = useCallback(
    (id: string) => {
      const at = leaf.tabs.findIndex((ref) => refId(ref) === id)
      if (at >= 0) activateTab(leaf.id, at)
    },
    [activateTab, leaf.id, leaf.tabs],
  )
  const onClose = useCallback(
    (id: string) => {
      const at = leaf.tabs.findIndex((ref) => refId(ref) === id)
      if (at >= 0) void closeAt(at)
    },
    [closeAt, leaf.tabs],
  )
  /*
   * **顶栏上的标签也是拖拽来源**(W3 的 W4 修正那一条)。
   *
   * 拖拽区判例在这里恰好白拿:浮影是 `DragLayer` 的一个 fixed 元素,**不在
   * `.bar` 里**,而且 `pointer-events: none` —— 所以它一个像素都碰不到
   * `-webkit-app-region: drag` 那件事(那条法说的是 `no-drag` 只在同分支子孙上
   * 生效,而浮影压根不在那条分支上)。标签本身仍旧留在这一组里不离开
   * (设计 §3.1 末句),所以顶栏的 `no-drag` 覆盖面一格没变 —— `gate:drag-region`
   * 因此照旧绿。
   */
  const onTabPointerDown = useTabDrag(leaf)

  /*
   * **联动靠空间与光,不靠文字**(设计 §2.2:用户看过第一版后指出「跟 Chat 的联动
   * 很少,不知道这一排是这个 Chat 的」)。悬停这一组 → 它下面那片叶亮一圈。
   *
   * 直接写 DOM 属性而不是进一格 React 状态:那格状态无论住在带子上还是 store 里,
   * 都会让**每一片叶**在鼠标划过顶栏时重渲一遍 —— 代价与「谁需要这个布尔」无关,
   * 而与叶里装了多少东西成正比(09-03「面自己不许订阅焦点树」那条判例的同型)。
   * 这是一格纯视觉、无语义的提示,与 `ui/Splitter` 的 `liveVar`、
   * `useComposerGeometry` 写变量同一条纪律:**不改语义的东西不必经过 React**。
   */
  const hint = useCallback((on: boolean) => {
    const el = document.querySelector(`[data-pane-leaf="${leaf.id}"]`)
    if (!(el instanceof HTMLElement)) return
    if (on) el.dataset.paneHint = ''
    else delete el.dataset.paneHint
  }, [leaf.id])

  return (
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} keyHandlers={leafKeys}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.group}
          style={
            {
              /*
               * 这一组的跨度:整段宽度按序平分(上下切分横向重叠时 `count > 1`)。
               * 两个数都是**结构**给的,所以它们只在树的形状变了之后才换;像素那一半
               * 住在两格 CSS 变量里,由 `leaf-geometry.ts` 写,拖杆时不经过 React。
               */
              '--tabgrp-x': `calc(var(${spanXVar(slot.spanId)}, 0px) + var(${spanWVar(slot.spanId)}, 0px) * ${slot.index} / ${slot.count})`,
              '--tabgrp-w': `calc(var(${spanWVar(slot.spanId)}, 0px) / ${slot.count})`,
            } as CSSProperties
          }
          data-topbar-leaf={leaf.id}
          data-pane-focus={focused || undefined}
          /*
           * 点这一组的任何地方 = 它成为焦点叶(与叶身体上那一句同源)。
           * 用 `onPointerDownCapture` 而不是 click:按下去时就该把焦点叶指过来。
           */
          onPointerDownCapture={() => setFocusLeaf(leaf.id)}
          onPointerEnter={() => hint(true)}
          onPointerLeave={() => hint(false)}
        >
          {/*
            **同一件檐**(`./LeafStrip`),只换了挂载点 —— 面板内那条分栏、W4 的架子
            与浮窗画的都是它。这里交出去的只有叶自己知道的三样:哪几格、切/关两口。
            动作组不在这儿:D 稿把它摆在顶栏右端,而且只画焦点叶那一组。
          */}
          <LeafStrip
            tabs={tabs}
            activeId={active ? refId(active) : null}
            label={t('workbench.leafTabs')}
            chromeId={leaf.id}
            onSelect={onSelect}
            onClose={onClose}
            onTabPointerDown={onTabPointerDown}
          />
        </div>
      )}
    </FocusScope>
  )
})

/**
 * 顶栏尾格里的那一组动作 —— **焦点叶的**(设计 §2.2:「右端是焦点叶的动作组」)。
 *
 * 它读的是「此刻哪一片是焦点叶」,所以焦点叶换人时换的是住户,不是组件
 * (`LeafActions` 不重挂)。中央区那棵树永远至少有一片叶,所以它恒在场。
 */
export function TopBarLeafActions() {
  const tree = useWorkbenchStore((st) => st.regions[CENTER_REGION])
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  if (!tree) return null
  return <LeafActions leaf={focusLeafOf(tree, focusLeafId)} />
}
