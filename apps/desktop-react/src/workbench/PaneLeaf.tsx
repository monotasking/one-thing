import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import { useFullSlot } from './full-slot'
import { refId } from './kinds'
import { LeafActions } from './LeafActions'
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
            leaf.tabs.map((ref, index) => (
              <PaneTabLayer key={refId(ref)} tabRef={ref} on={index === leaf.active} />
            )),
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

  return (
    <LeafStrip
      tabs={tabs}
      activeId={active ? refId(active) : null}
      label={t('workbench.leafTabs')}
      chromeId={leaf.id}
      onSelect={onSelect}
      onClose={onClose}
      onTabPointerDown={onTabPointerDown}
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
