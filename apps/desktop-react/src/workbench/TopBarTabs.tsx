import { memo, useCallback, useMemo, useRef } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { refId } from './kinds'
import { LeafActions } from './LeafActions'
import { openLeafMenuAt } from './leaf-menu'
import { LeafStrip } from './LeafStrip'
import { useReportOverflow } from './leaf-overflow'
import { useLeafCommands } from './leaf-commands'
import { useCloseLeafTab, useLeafTabSpecs } from './leaf-tabs'
import { topStrips } from './layout'
import { CENTER_REGION } from './regions'
import { focusLeafOf, useWorkbenchStore } from './store'
import { useTabDrag } from './useTabDrag'
import { findLeaf } from './tree'
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
 *    没有任何报错。所以标签组 **DOM 一步都不离开顶栏** —— W7-c 之前它靠两格 CSS
 *    变量把自己摆到叶的正上方(而不是 portal 过去),今天它连摆都不必摆了。
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
 * ③ **标签从顶栏自己的开头排**(W7-c 裁定 1)。W1-b 到 W6 之间它不是这样:每一组
 *    精确坐在**它那片叶的正上方**,左右界读两格 CSS 变量,由 `leaf-geometry.ts` 在
 *    真实排版之后量出来。那条规则的前提是「中央区可能有好几片叶」,而 v3 把中央区
 *    收成**一条标签条**之后它没有对象了 —— 屏幕上只有一组,「对准哪片叶」是一句
 *    没有内容的话。它同时是 `gate:perf` ⑤a 第 4 次强制排版的来源(W6-p 留账:
 *    `useLeafGeometry` 的每渲染重量,2.1ms / 11 个元素)。
 *    今天:红绿灯让位右边就是第一格,组是带子里的普通 flex 项。`leaf-geometry.ts`
 *    与 `spanXVar` / `spanWVar` / `data-pane-span` 整条随之删除 —— 零消费者。
 */

/**
 * 顶栏上那条**标签带**:中央区每片叶一组,各坐各叶的正上方。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:挂载 = 顶栏挂载(恒有);**叶分屏 / 合并**改的是 `topStrips` 那张表
 *    (React 重渲、组的 key = 叶 id,所以留下来的组不重挂);架子收展与拖杆
 *    **一次渲染都不引**(W7-c 起组不再量叶的跨度);卸载 = 整台壳卸载。
 * ② UI 生命状态:**单叶**(一组,今天恒是这一形 —— 中央区收成一条标签条)/
 *    **多叶**(多组按序铺开;这一形今天在中央区不成立,留着是因为这只组件读的是
 *    `topStrips` 那张表,而不是「中央区只有一片叶」这句话)/
 *    **窄档溢出**(组内先按 `--tab-max-w` 收窄,再由 `ui/Tabs` 自己横滚;
 *    **永不换行、永不挤掉右端两件** —— 后者靠「带子是 flex 项、止于尾格左缘」
 *    在结构上保证,不靠算)。
 * ③ UI 交互状态:**焦点组**亮(活动标签吃满 `--pane-face`,与下面那片叶连成一块)/
 *    **非焦点组只降活动标签的字色、不降底色**(W3-b 裁定 2:`--tab-joined-ink`
 *    改成 `--text-2`;「哪一组是活的」由叶自己的焦点圈与这一档字色说)/
 *    **hover 一组** → 对应那片叶亮一圈(`--accent-soft` 内描边);tab 自身的
 *    rest/hover/focus/selected 随 `ui/Tabs` 的 `joined` 档。
 */
export function TopBarLeafTabs() {
  const t = useT()
  const tree = useWorkbenchStore((st) => st.regions[CENTER_REGION])
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  const bandRef = useRef<HTMLDivElement>(null)

  const slots = useMemo(() => (tree ? topStrips(tree) : []), [tree])

  return (
    /*
     * 带子是顶栏里的一格 **flex 项**,吃掉让位与尾格之间的全部剩余宽度;组是它的
     * 普通 flex 子项,**从它的左缘起排**(W7-c 裁定 1)。于是「标签永不挤掉右端
     * 那两件」这句话仍旧由**布局**保证:组越不过带子的右缘,而它的右缘就是尾格的
     * 左缘 —— 变的只是组从哪儿开始,不是它到哪儿为止。
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
  focused,
}: {
  leaf: PaneLeafNode
  focused: boolean
}) {
  const t = useT()
  const rootRef = useRef<HTMLDivElement>(null)
  const activateTab = useWorkbenchStore((st) => st.activateTab)
  const setFocusLeaf = useWorkbenchStore((st) => st.setFocusLeaf)
  const tabs = useLeafTabSpecs(leaf)
  const closeAt = useCloseLeafTab(leaf)
  const active = leaf.tabs[leaf.active] ?? null

  /**
   * 这片叶此刻答得出的那几条命令(⌘W / ⌘T / ⌘⇧T / ⌘⇧[ ] / ⌃Tab / ⌘1–9)。
   * **与叶身上那一份是同一张表** —— 判词在 `./leaf-commands.ts` 的文件头上。
   */
  const leafKeys = useLeafCommands(leaf)

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
   * **右键 / Shift+F10 一格标签 = 这片叶的动作表**(W6-c 立;W7-c 起它是**唯一**
   * 的开口 —— 那颗「分屏」钮删掉了,判词写在 `LeafActions` 上)。
   *
   * 中央区这一档是这条路非有不可的理由:标签条(这只组件)与那张表
   * (`TopBarLeafActions`,顶栏尾格)在 `TopBar` 里是**两兄弟**,谁也够不着谁的
   * 状态 —— 「开不开、开在哪」因此住在 `workbench/leaf-menu` 那一格里,两个开口读同一格。
   * 上面那句 `onPointerDownCapture` 已经把焦点叶指过来了(右键的 pointerdown 一样派得出),
   * 所以尾格此刻画的正是这片叶的表。
   */
  /* **表作用在被右键的那一格**(U3):`id` 一路交到表上,不再落在 `leaf.active`
   * 上 —— U2 让右键不再切标签之后,那两者不再恒等(判词在 `LeafMenuAt.tabId`)。 */
  const onTabMenu = useCallback(
    (id: string, at: { x: number; y: number }) => {
      openLeafMenuAt(leaf.id, at, id)
    },
    [leaf.id],
  )

  /** 条上有几格没露全 → 叶动作组那颗 ⋯(W7-t / B1,判词在 `useReportOverflow`)。 */
  const onOverflow = useReportOverflow(leaf.id)

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
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} commands={leafKeys}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.group}
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
            onTabMenu={onTabMenu}
            onOverflow={onOverflow}
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
