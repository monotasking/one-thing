import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { claimContentSlot, registerContentHolder, unregisterContentHolder } from './content-slots'
import { useFullSlot } from './full-slot'
import { flattenContent, partsOfContent, refId } from './kinds'
import { LeafActions } from './LeafActions'
import { openLeafMenuAtPointer } from './leaf-menu'
import { LeafStrip } from './LeafStrip'
import { useCloseLeafTab, useLeafTabSpecs } from './leaf-tabs'
import { CENTER_REGION } from './regions'
import { renderRef } from './render'
import { regionOfLeafIn, useWorkbenchStore } from './store'
import { useTabDrag } from './useTabDrag'
import type { ContentRef } from './kinds'
import type { PaneLeafNode } from './tree'
import s from './PaneLeaf.module.css'

/**
 * **一片叶 = 一组 tab 的身体,檐画在哪儿由它住在哪个区域决定**(W1 / W1-b / W4)。
 *
 * 规则仍旧只有一条:**一片叶只有一条檐,那条檐就是 tab 条;内容自己不画檐。**
 * 于是从前那两颗语义不同的 ✕(查看器自己那颗 = 关文件 / 宿主檐那颗 = 收回 Dock)
 * 塌成一颗:**tab 上那颗 ✕ = 关闭这一格**。
 *
 * ── 那条檐坐在哪儿:一格判据,不是四处各写一遍(W1-b × W4 的接缝)────────
 * 设计 §2.2 的 D 稿把**中央区**那条檐整条搬进了窗口顶栏(`workbench/TopBarTabs.tsx`,
 * 用户原话:「标签不要占聊天区域,把标签放到红绿灯那一栏上」);W4 又把**架子与
 * 浮窗**的身子换成了同一棵拼贴树,而那两处没有第二条顶栏可借 —— 浮窗那一形更是
 * 「标题栏**就是**它里面那棵树根叶的 tab 条」。
 *
 * 两件事合起来只有一句话:**檐的位置由区域决定**。
 *
 *   `region === CENTER_REGION`   叶身上零檐(顶栏画,`TopBarTabs`)
 *   其余区域(edge:* / float:*)  檐画在叶顶(下面那一格 `PaneLeafStrip`)
 *
 * 判据落在**这一处**,取的是叶自己住在哪儿(`store.regionOfLeafIn`)——
 * 不是「宿主给没给 host」:host 缺席只意味着这一片不是根叶,不意味着它在中央区
 * (架子上分屏出来的第二片叶没有 host,但它照样要有自己的檐)。
 *
 * 檐的**件**(`LeafStrip`)、它的**数据表**(`leaf-tabs.ts`)、它的**动作组**
 * (`LeafActions`)三件东西四个宿主共用同一份 —— 中央顶栏、两条架子叶、浮窗根叶
 * 画的是同一件,这只文件里一行都不重抄。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载      树里出现这片叶(出厂那一片、或一次分屏)
 *   首载      第一个 tab 的内容异步到达 —— 由内容自己说(查看器的「正在读取…」)
 *   换宿主    整棵树随区域搬(center → edge → float,W4):**叶不重挂,只换外框** ——
 *             结构共享保证的(`tree.mapLeaf` 没改到的支原样带过),不是靠自觉。
 *             换过去之后檐的位置跟着 `region` 翻面,那是**渲染**的事,不是重挂
 *   卸载      最后一个 tab 关掉 / 藏起来,叶被 `prune` 剪掉
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   (檐的那几格 —— 单 tab / 多 tab / 预览 / 超量 —— 写在 `LeafStrip` 上,
 *    它有四个宿主,那张表不该跟着某一个宿主走)
 *   这一层自己只有两格:**空叶**(没有一格 tab)——`prune` 会当场把它剪掉,
 *   所以它在屏幕上停留不到一帧,不画任何空态;以及**檐在不在这片叶身上**(上面
 *   那张区域表)。
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   焦点叶     一圈内描边(只有多于一片叶时画)
 *   被悬停     顶栏上它那一组标签被悬停时,亮一圈 `--accent-soft`
 *              (判据由顶栏那一侧写进 `data-pane-hint`,理由写在那只组件上)
 *   分隔杆     随 `ui/Splitter`(在 `PaneTree` 上,不在这里)
 *   被全屏盖住  `inert`(DOM 与树各说一遍;判据 `store.occludedByFull`)——
 *              全屏开着时,除了**装着那一格的这一片**,别的叶都不接键盘
 *
 * ── 真全屏:身子搬家,内容一次都不重挂(W2,设计 §4.1)───────────────────
 * 全屏是**投影**不是搬家:树一个字不动,只是这片叶的身子暂时挂到全屏层那格
 * `data-full-slot` 里去。要做到「零重挂」只有一条路,而它有实测背书:
 *
 *   · 把身子在「本地 JSX」与「portal」之间切 —— **重挂**(fiber 类型换了);
 *   · 换 `createPortal` 的第二个参数 —— **也重挂**(React 19 `updatePortal` 比对
 *     `containerInfo`,不同就新建 fiber);
 *   · 叶自己持有一格**身份恒定的 holder**(一个 `<div>`,`display: contents`),
 *     永远 portal 进它,搬家搬的是 holder 这个 DOM 节点 —— **同一个节点**,
 *     React 那一侧一格都没动。三种写法在 React 19.2 上各跑过一次,读数依次是
 *     重挂 / 重挂 / **不重挂**。
 *
 * holder **首次挂进身子那一格是在 ref 回调里**,而不是 layout effect:
 * 内容的 layout effect 排在这只组件之前(子先父后),layout effect 里挂的话
 * 首挂那一帧内容量到的是一个游离节点(高度恒 0)。ref 回调排在渲染 portal 之前
 * 那一次提交里,于是内容永远在**已经进文档**的容器里挂载。
 */

/**
 * **宿主自己那一份檐**(W4)。架子与浮窗把它们的钮(弹出 / 收起 / 关整栏、
 * 钉边 / 放大 / ✕)挂在**根叶**那条檐的右端,而不是另画一条 40px 的带子 ——
 * 设计 §2.2 的原话:「一片叶只有一条檐,那条檐就是 tab 条」。
 *
 * 三格各管一件事,都缺席时这只叶与中央区那一路逐字相同。
 */
export interface PaneHostChrome {
  /** 挂在檐右端、叶自己那一组动作之后的那一组。**只挂在根叶上**。 */
  actions?: ReactNode
  /**
   * 按住一格 tab 意味着什么。**W3 起没有宿主再给这一格** —— 拖拽是全壳统一的
   * 一件事(`workbench/useTabDrag`),不是每个宿主自己的手势。这一格留着是因为
   * `PaneHostChrome` 是宿主与檐之间的契约,而将来可能有宿主要在按下时插一句
   * 自己的话(比如浮窗置顶)。给了就在统一拖拽**之前**先叫它。
   */
  onTabPointerDown?: (id: string, e: ReactPointerEvent<HTMLElement>) => void
  /** 按在檐的空白处意味着什么(浮窗:拖窗)。**只在根叶上**。 */
  onChromePointerDown?: (e: ReactPointerEvent<HTMLElement>) => void
}

export const PaneLeaf = memo(function PaneLeaf({
  leaf,
  host,
}: {
  leaf: PaneLeafNode
  /** 宿主自己那一份檐(架子 / 浮窗给;中央区不给)。 */
  host?: PaneHostChrome
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const focusLeafId = useWorkbenchStore((st) => st.focusLeafId)
  const setFocusLeaf = useWorkbenchStore((st) => st.setFocusLeaf)
  /*
   * **选出来的是一个字符串,不是整张 `regions`**。订整张表的话,别处任何一棵树
   * 动一下(隔壁架子切个 tab)全场每一片叶都要重渲一遍 —— `PaneLeaf` 那层 memo
   * 挡不住 store 订阅(09-03「面自己不许订阅焦点树」同型)。区域名只在这片叶
   * 真的搬家时才变。
   */
  const region = useWorkbenchStore((st) => regionOfLeafIn(st.regions, leaf.id))
  const closeAt = useCloseLeafTab(leaf)
  const active = leaf.tabs[leaf.active] ?? null

  /**
   * 这片叶里那几格**内容**(复合的摊开)。判词在 `./content-slots.ts`:
   * 二合一改的是标签的身份,内容那一格的身份一个字都不该跟着变。
   */
  const contents = useMemo(
    () => leaf.tabs.flatMap((ref) => flattenContent(ref)),
    [leaf.tabs],
  )
  /** 此刻活着(= 属于活动那一格标签)的那几格内容。 */
  const liveIds = useMemo(
    () => new Set((active ? flattenContent(active) : []).map(refId)),
    [active],
  )
  /** 画法层的排法(出生序,判词在 `useFrameOrder` 上)与「哪一格是活动的」。 */
  const frames = useFrameOrder(leaf.tabs)
  const activeId = active ? refId(active) : null

  /** 檐在不在这片叶身上。**唯一判据**,见文件头那张区域表。 */
  const stripInLeaf = region !== CENTER_REGION

  /*
   * ── 全屏那三个读数(W2)──────────────────────────────────────────────
   * 订的都是**标量**,不是整张表:全屏开合是全局事件,而它只该让「装着它的那一片」
   * 与「被盖住的那些片」各重渲一次,不该把每一片叶都拴上一个对象订阅
   * (与上面那句 `regionOfLeafIn` 只选一个字符串同一条判据)。
   */
  const fullId = useWorkbenchStore((st) => (st.full ? refId(st.full.ref) : null))
  /** 这一片就是持有全屏那一格的那一片(它的活动 tab 正是那一格)。 */
  const mine = fullId !== null && active !== null && refId(active) === fullId
  /** 全屏开着,而不是我 → 被盖住:`inert`(DOM 与树各说一遍,判词在 `PaneTabLayer` 上)。 */
  const occluded = fullId !== null && !mine
  const slot = useFullSlot((st) => st.slot)

  /*
   * 身份恒定的 holder(见文件头那一段)。`useState` 的惰性初始化只跑一次,
   * 造一个游离的 `<div>` 是纯分配 —— 它此刻还不在任何文档里。
   */
  const [holder] = useState(() => {
    const el = document.createElement('div')
    el.className = s.holder
    el.setAttribute('data-pane-holder', '')
    return el
  })
  const bodyRef = useRef<HTMLDivElement | null>(null)

  /**
   * 身子那一格的 ref。**holder 在这里就挂进去**(而不是等 layout effect)。
   *
   * 这一句能成立,靠的是**次序**:React 的提交阶段按子树顺序走,而下面那棵 JSX 里
   * `.body` 排在 portal **前面** —— 于是 `.body` 的 ref 回调先跑(它没有孩子),
   * portal 里那些内容的 layout effect 后跑。内容因此永远在一个**已经进了文档**的
   * 容器里挂载,不会量到一个游离节点的 0 高度。
   *
   * (第一版把 portal 写在 `.body` **里面**、并用一格 state 等 ref 到位才渲染 ——
   *  那样内容晚一次提交才挂,而跟焦那条 effect 排在两次提交之间:
   *  `keymap/dispatch.test` 的两条「从 Dock 开一块面 → 焦点进那块面」当场红。
   *  次序是判据,不是巧合。)
   */
  const mountBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el
      if (el && holder.parentNode === null) el.appendChild(holder)
    },
    [holder],
  )

  /**
   * 搬家:全屏开着且是我 → 挂进全屏层那格空容器;否则回自己身上。
   * `appendChild` 是**移动**不是复制,所以前后是同一个 DOM 节点(`gate:files` 钉着)。
   */
  const toSlot = mine && slot !== null
  useLayoutEffect(() => {
    const target = toSlot ? slot : bodyRef.current
    if (!target) return
    if (holder.parentNode !== target) target.appendChild(holder)
  }, [holder, slot, toSlot])

  /*
   * 卸载时把 holder 摘掉。**只有搬去全屏层那一路真的需要它**:留在自己身上那一路
   * 由 React 拆掉身子时一并带走。不写这一口的话,叶在全屏期间被剪掉(整栏关闭)
   * 会在全屏层里留下一个谁都够不着的空容器。
   */
  useLayoutEffect(() => () => holder.remove(), [holder])

  /**
   * ⌘W:关当前 tab。表在 `focus/scopes.ts` 的 `FOCUS_SCOPES.leaf.keys`。
   *
   * 中央区那一组标签在顶栏上也注入同名的一口(同一个 `owner`,两份实例)—— 于是
   * 焦点在**叶的身体里**还是在**它的标签上**,⌘W 都关得掉这一格。少了这一边,
   * 「在查看器里按 ⌘W」就没人接。
   */
  const leafKeys = useMemo(
    () => ({ closeTab: active ? () => void closeAt(leaf.active) : undefined }),
    [active, closeAt, leaf.active],
  )

  return (
    /*
     * **叶不声明落点** —— 它是家具,进它就是进它装着的那块内容。那一句自述写在
     * `focus/scopes.ts` 的 `leaf` 行上(`passThrough: true`),内核据此穿过叶根与
     * 那一格 tab 的层,一直走到内容自己那一格。判词全文在
     * `FocusScopeSpec.passThrough` 上。
     */
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} keyHandlers={leafKeys} inert={occluded}>
      {({ scopeProps }) => (
        <div
          {...scopeProps}
          className={s.leaf}
          data-pane-leaf={leaf.id}
          data-pane-focus={focusLeafId === leaf.id || undefined}
          /* 被全屏盖住的那些片:`inert` 说两遍(这一遍给 DOM,树那一遍在上面)。 */
          inert={occluded || undefined}
          /*
           * 点这片叶的任何地方 = 它成为焦点叶(「新标签开在哪一片」的答案)。
           * 用 `onPointerDownCapture` 而不是 click:分屏菜单那颗钮按下去时就该
           * 先把焦点叶指过来,不然新叶会长在隔壁那片上。
           */
          onPointerDownCapture={() => setFocusLeaf(leaf.id)}
        >
          {stripInLeaf && <PaneLeafStrip leaf={leaf} host={host} />}

          {/*
            身 = 这片叶里**每一个** tab 的内容(keep-alive,与架子同一条判据):
            切 tab 只换哪一层显形,不卸载谁 —— 重面板(会话总览那 400 张卡)
            不必每次切回都重建,查看器的滚动位与草稿也不会因为切走一格就没了。

            那几层住在 holder 里(`display: contents`,零盒子),holder 挂在这一格
            身子里;全屏期间它整块搬去全屏层 —— 判词与三条实测读数写在文件头。

            **portal 写在 `.body` 的后面而不是里面**:提交阶段按子树顺序走,
            `.body` 的 ref 回调(它把 holder 挂进文档)因此排在内容的 layout effect
            之前。次序是判据,不是巧合 —— 理由写在 `mountBody` 上。
          */}
          <div className={s.body} data-pane-body={leaf.id} ref={mountBody} />
          {createPortal(
            <>
              {/*
                **画法那一半:一格 tab 一层**(key = 那一格 tab 的 refId)。
                普通 tab 画的是一个空槽;两格标签画的是它那一种自述的身子
                (分隔杆 + 两个格头 + 两个空槽)—— 这一层因此随标签的身份变,
                二合一那一下它确实重挂,而它是**檐**,不是内容。

                **次序是「出生序」,不是标签条上的次序**(W6-p,读数见 `useFrameOrder`):
                这几层是绝对定位、同时只有一层可见的**画法层**,它们在 DOM 里谁前谁后
                屏幕上看不出来;而按 `leaf.tabs` 排就意味着一次换序要 React 搬一层
                —— 那一层里挂着整块内容的身子(`content-slots` 把 holder
                `appendChild` 进它的槽),搬一次 = 整棵内容子树换爹。
              */}
              {frames.map((ref) => (
                <PaneTabFrame key={refId(ref)} tabRef={ref} on={refId(ref) === activeId} />
              ))}
              {/*
                **内容那一半:一格内容一层**(key = 那一格**内容**的 refId,复合的
                摊开)。二合一 / 拆开改的是上面那一半,这一半的 key 一个都没变 ——
                于是两块内容的 DOM 与 React 状态全程不动(判词与那张配对表在
                `./content-slots.ts`)。
                **排在画法之后**:同一次提交里槽的 ref 回调按树序跑,槽先到位,
                身子当场就能挂进去。
              */}
              {contents.map((ref) => (
                <PaneContentLayer
                  key={refId(ref)}
                  refKind={ref.kind}
                  refKey={ref.key}
                  on={liveIds.has(refId(ref))}
                />
              ))}
            </>,
            holder,
          )}
        </div>
      )}
    </FocusScope>
  )
})

/**
 * **非中央区那片叶头上那条檐**(架子 / 浮窗)。
 *
 * 它自己是一只组件而不是 `PaneLeaf` 里的一段 JSX,理由是**订阅**:这条檐要读
 * `live-title` 那整张表(未保存丸 / 会话改名要跟着动),而中央区的叶不该为此
 * 付一次订阅 —— 那张表一变,全中央区的叶就会跟着重渲一遍。分成两只之后:
 * 中央叶根本不挂这只组件,架子叶也只有**这条檐**重渲,身一动不动。
 *
 * 交出去的只有叶自己知道的那几样:哪几格(树)、切/关这两口(`leaf-tabs.ts`,
 * 与顶栏那一组共用同一份)、叶自己的动作组(`LeafActions`),以及**宿主的**
 * 那一组钮 —— 次序是**叶的在前、宿主的在后**,于是四条边与浮窗上那一排处处相同。
 */
const PaneLeafStrip = memo(function PaneLeafStrip({
  leaf,
  host,
}: {
  leaf: PaneLeafNode
  host?: PaneHostChrome
}) {
  const t = useT()
  const activateTab = useWorkbenchStore((st) => st.activateTab)
  const tabs = useLeafTabSpecs(leaf)
  const closeAt = useCloseLeafTab(leaf)
  const active = leaf.tabs[leaf.active] ?? null
  /*
   * **拖一格 tab**(W3)。宿主自己那一句(若有)先叫,再起统一拖拽 ——
   * 架子从前在这一格里手写的「撕成浮窗」整段退役了(它只对瓦成立,而且是
   * 第二套拖拽实现);现在架子、浮窗、分屏出来的每一片叶走的是同一条路。
   */
  const dragTab = useTabDrag(leaf)
  const onTabPointerDown = useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      host?.onTabPointerDown?.(id, e)
      dragTab(id, e)
    },
    [host, dragTab],
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
   * **右键一格标签 = 这片叶的动作表**(W6-c,设计 v3 §7)。开的是 `LeafActions`
   * 那**同一张**表(判词在 `workbench/leaf-menu.ts`),不是第二张;所以「右键搬过去」
   * 与「按钮搬过去」与「拖过去」三条路调的仍旧是同一只动作。
   *
   * `preventDefault` 挡掉宿主自己的上下文菜单 —— 两张菜单同时开是这类接管的经典漏法。
   */
  const onTabContextMenu = useCallback(
    (_id: string, e: ReactMouseEvent<HTMLElement>) => {
      e.preventDefault()
      openLeafMenuAtPointer(leaf.id, e)
    },
    [leaf.id],
  )

  return (
    <LeafStrip
      tabs={tabs}
      activeId={active ? refId(active) : null}
      label={t('workbench.leafTabs')}
      chromeId={leaf.id}
      onSelect={onSelect}
      onClose={onClose}
      onTabPointerDown={onTabPointerDown}
      onTabContextMenu={onTabContextMenu}
      onChromePointerDown={host?.onChromePointerDown}
      actions={
        <>
          <LeafActions leaf={leaf} />
          {/* 宿主自己那几颗排在最后 —— 叶的动作在前、宿主的在后。 */}
          {host?.actions}
        </>
      }
    />
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
 * 而 `activateScope('leaf', { owner: refId })`(**切 tab 进内容**那条裁定,产地在
 * `LeafStrip`)精确取到这一格;这一层自己只做一件事:**把看不见的那一格从活动
 * 路径上摘掉**。
 *
 * `memo` 不许省:切一次 tab 只有翻了 `on` 的那两层该重渲,别的 tab 一动不动
 * (与 `ShelfTabLayer` 同一条读数背书)。
 */
const PaneContentLayer = memo(function PaneContentLayer({
  refKind,
  refKey,
  on,
}: {
  refKind: string
  refKey: string
  on: boolean
}) {
  const id = `${refKind}:${refKey}`
  const contentRef = useMemo<ContentRef>(() => ({ kind: refKind, key: refKey }), [refKind, refKey])
  const visibility = useMemo(() => ({ visible: on, interactive: on }), [on])
  /*
   * **身份恒定的 holder**(`display: contents`,零盒子)。它是这一格内容在
   * 屏幕上的那个节点,由 `content-slots` 那张表挂进当下该去的槽里 —— 换序、
   * 二合一、拆开、换比例四步之后它都是同一个 DOM 节点。
   */
  const [holder] = useState(() => {
    const el = document.createElement('div')
    el.className = s.holder
    el.setAttribute('data-pane-content', '')
    return el
  })
  /**
   * **holder 在一个 ref 回调里登记,不在 layout effect 里**(与 `PaneLeaf.mountBody`
   * 逐字同一条判例,而且是同一个坑的第二次)。
   *
   * 次序:提交阶段按子树顺序走,**孩子先于父亲**。内容自己那些 layout effect
   * (`SearchPanel` 的 `activateOnMount`、查看器量高度)是这只组件 portal 出去的
   * **孩子**,所以它们排在这只组件自己的 layout effect **之前** —— 在那里登记的话,
   * 内容首挂那一帧量到的是一个**游离节点**:高度恒 0,而 `.focus()` 对不在文档里的
   * 元素**静默无效**。真机上它的样子是「⌘P 开出检索面,焦点还留在输入框里」——
   * `gate:focus` 场景 16 的 ①-b / ③ / ④-a 五条一起红,而屏幕上什么都看不出来。
   *
   * 下面那格锚点 `<div>` 排在 portal **前面**,于是它的 ref 回调先跑;holder 因此
   * 在内容挂载之前就已经进了文档。锚点自己 `display: contents`,零盒子。
   */
  const anchor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) registerContentHolder(id, holder)
    },
    [id, holder],
  )
  useLayoutEffect(() => () => void unregisterContentHolder(id, holder), [id, holder])
  return (
    <>
      {/* 锚点:零盒子(`display: contents`),只为让 holder 在内容挂载**之前**
        * 就进文档 —— 判词整段在上面 `anchor` 那一格上。 */}
      <div ref={anchor} className={s.holder} />
      {createPortal(
        <FocusScope scope="leaf" inert={!on} owner={id}>
          {({ scopeProps }) => (
            <div
              {...scopeProps}
              className={on ? s.layer : `${s.layer} ${s.layerHidden}`}
              data-pane-tab={id}
              data-pane-on={on || undefined}
              inert={!on || undefined}
            >
              {renderRef(contentRef, visibility)}
            </div>
          )}
        </FocusScope>,
        holder,
      )}
    </>
  )
})

/**
 * **画法层按「出生序」排,不按标签条上的次序**(W6-p,09-05;起因是 `gate:perf`
 * 场景⑤c 逐任务归因)。
 *
 * ── 病历(真机 trace,一趟条内换序)──────────────────────────────────────
 * 从前这几层按 `leaf.tabs` 排。两格标签换一次序,React 必须在 DOM 里搬走其中一层
 * (它的算法搬的是「原本靠前、现在靠后」的那一个),而那一层的槽里 `appendChild`
 * 着整块内容的身子 —— 于是一次「什么都没改」的换序变成**整棵内容子树换爹**:
 * `UpdateLayoutTree n=33085` 31.1ms + `Layout n=65422` **153.5ms**,再加上焦点被
 * 搬走的那一下让 React 走 `restoreSelection`(逐个祖先读 `scrollTop` 再 `focus()`)。
 * 20 趟里一半是这一形,读数因此逐趟跳:`259 501 210 448 241 437 …`。
 *
 * ── 为什么可以换个次序排 ────────────────────────────────────────────────
 * 这几层是 `position: absolute; inset: 0` 的**画法层**,而且**同时只有一层可见**
 * (`.layerHidden` 给看不见的那几层挂 `content-visibility: hidden` + `inert`)。
 * 它们在 DOM 里谁前谁后既不影响布局也不影响绘制次序 —— 屏幕上的标签次序由
 * `LeafStrip` / `TopBarTabs` 那条真的标签条画,与这里无关。
 *
 * ── 为什么是「出生序」而不是排序 ────────────────────────────────────────
 * 换个稳定的排法(比如按 refId 字典序)同样能让换序不动 DOM,但**新开一格标签**
 * 时那一格会插到中间去,于是把已有的那几层往后搬 —— 把一次换序的代价挪成了一次
 * 开标签的代价。出生序只追加:换序不动,开标签也不动,只有关掉那一格才从表里消失。
 *
 * 一格 `useRef` 存这张表 —— 它是**这只组件实例**的缓存(不是模块级状态,没有跨模块
 * 存活的东西,不需要 HMR dispose)。渲染中改 ref 在这里是安全的:同样的输入跑两遍
 * 得到同样的输出(StrictMode 的双渲染因此无感),而且它只决定次序,不决定画什么。
 */
function useFrameOrder(tabs: readonly ContentRef[]): readonly ContentRef[] {
  const born = useRef<string[]>([])
  const byId = new Map(tabs.map((ref) => [refId(ref), ref]))
  const kept = born.current.filter((id) => byId.has(id))
  for (const id of byId.keys()) if (!kept.includes(id)) kept.push(id)
  born.current = kept
  return kept.map((id) => byId.get(id) as ContentRef)
}

/**
 * **一格 tab 的画法层**(W6-a)。它只管「这一格标签占的那块地长什么样」,
 * 内容的身子由 `PaneContentLayer` 交、由 `content-slots` 挂进来。
 *
 * 两形,判据是**种类自述**(`ContentKind.composite`),不是核心层按名字点人:
 *  · 原子内容 —— 整块地就是它自己的一个槽;
 *  · 复合内容 —— 那一种自己画(分隔杆 + 两个格头 + 两个槽),这一层只把它
 *    的 `render` 交出去。于是「一个标签装两格」在这只文件里连一句 if 都不占。
 *
 * `memo` 不许省:切一次 tab 只有翻了 `on` 的那两层该重渲。
 */
const PaneTabFrame = memo(function PaneTabFrame({ tabRef, on }: { tabRef: ContentRef; on: boolean }) {
  const id = refId(tabRef)
  const parts = partsOfContent(tabRef)
  const visibility = useMemo(() => ({ visible: on, interactive: on }), [on])
  return (
    <div
      className={on ? s.layer : `${s.layer} ${s.layerHidden}`}
      data-pane-frame={id}
      data-pane-on={on || undefined}
    >
      {parts
        ? renderRef(tabRef, visibility)
        : <ContentSlot id={id} />}
    </div>
  )
})

/**
 * **一格内容的槽**(W6-a)。它是一个空盒子,身子由 `content-slots` 那张表挂进来。
 *
 * 它是导出的:两格标签那一种(`content/kinds/pair.tsx`)画的左右两格就是它 ——
 * 「槽长什么样」只有这一处产地,普通 tab 与两格标签里的一格逐像素相同。
 */
export function ContentSlot({ id, className }: { id: string; className?: string }) {
  const mount = useCallback(
    (el: HTMLDivElement | null) => claimContentSlot(id, el),
    [id],
  )
  /*
   * **取件口叫 `data-content-slot`,不叫 `data-pane-slot`** —— 后者早就有主:
   * `PaneTree` 用它标「一片叶的格子」,而 `workbench/drop-geometry.ts` 与三条真机门
   * 都按那个名字量叶的矩形。两件事同名会让落点几何把「一格内容」读成「一片叶」,
   * 而屏幕上什么都看不出来(它只是把矩形算错)。
   */
  return <div ref={mount} className={className ?? s.slot} data-content-slot={id} />
}
