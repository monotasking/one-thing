import { memo, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { FocusScope } from '../focus/FocusScope'
import { useT } from '../i18n'
import {
  ContentSlotScope,
  claimContentSlot,
  registerContentHolder,
  releaseContentSlot,
  slotKeyOf,
  unregisterContentHolder,
} from './content-slots'
import { useFullSlot } from './full-slot'
import { useKeptContents } from './kept-contents'
import { centerStripOnTopBar } from './layout'
import { flattenContent, partsOfContent, refId, stripHeaderOf } from './kinds'
import { LeafActions } from './LeafActions'
import { openLeafMenuAt } from './leaf-menu'
import { LeafStrip } from './LeafStrip'
import { useReportOverflow } from './leaf-overflow'
import { useLeafCommands } from './leaf-commands'
import { useCloseLeafTab, useLeafTabSpecs } from './leaf-tabs'
import { CENTER_REGION } from './regions'
import { renderRef } from './render'
import { usePanelVisibility } from '../content/visibility'
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
 *   `region === CENTER_REGION` 且中央区只有一片叶   叶身上零檐(顶栏画,`TopBarTabs`)
 *   中央区分了屏 / 其余区域(edge:* / float:*)      檐画在叶顶(下面那一格 `PaneLeafStrip`)
 *   (09-24 起中央区也能分屏;判据是 `layout.centerStripOnTopBar`,顶栏与叶读同一句)
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
   * **宿主自己那几行菜单项**(W7-c 裁定 4),挂在叶动作表的末尾。**只挂在根叶上**。
   *
   * 檐上的钮做减法之后(架子只剩「收起」、浮窗只剩 ✕),被拿掉的那几件不能凭空
   * 消失 —— 它们搬进了**同一张叶菜单**。做成宿主自述的一段 `ReactNode` 而不是
   * 「菜单按宿主类型分支」,是这一条的字面兑现:**动作表的判据 / 项目 / 动作整件
   * 在 `LeafActions` 里,而它一个宿主名都不认识**;宿主交什么就多什么,加第三种
   * 宿主时那只组件一个字不改。
   *
   * 交进来的项**必须调与它从前那颗钮同一只 store 动作**(parity 测试逐项钉着):
   * 菜单与钮走两个动作,迟早在某一条上悄悄分叉。
   */
  menuRows?: ReactNode
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
  const active = leaf.tabs[leaf.active] ?? null

  /**
   * **这片叶额外要挂、但没有标签的那几格**(组件级停靠,2026-09-10)。
   * 表在 `./kept-contents.ts`,写它的是能力自己(会话那一种:`content/session-park`)
   * —— 这只文件读表,不认识任何能力的名字。
   */
  const kept = useKeptContents(leaf.id)
  /**
   * **这片叶要挂的全集** = 标签 ∪ 停靠。标签优先(同一格两边都在时只算一次:
   * 停靠那一头的对账下一拍会把它摘掉,而屏幕上不许有中间那一帧的两层)。
   */
  const held = useMemo(() => {
    if (kept.length === 0) return leaf.tabs
    const seen = new Set(leaf.tabs.flatMap((ref) => flattenContent(ref)).map(refId))
    const extra = kept.filter((ref) => !seen.has(refId(ref)))
    return extra.length === 0 ? leaf.tabs : [...leaf.tabs, ...extra]
  }, [leaf.tabs, kept])
  /**
   * 这片叶里那几格**内容**(复合的摊开)。判词在 `./content-slots.ts`:
   * 二合一改的是标签的身份,内容那一格的身份一个字都不该跟着变。
   */
  const contents = useMemo(() => held.flatMap((ref) => flattenContent(ref)), [held])
  /** 此刻活着(= 属于活动那一格标签)的那几格内容。 */
  const liveIds = useMemo(
    () => new Set((active ? flattenContent(active) : []).map(refId)),
    [active],
  )
  /** **有标签的那几格**(停靠的没有)—— 两层的取件口按它分叉,见 `PaneContentLayer`。 */
  const tabbedIds = useMemo(
    () => new Set(leaf.tabs.flatMap((ref) => flattenContent(ref)).map(refId)),
    [leaf.tabs],
  )
  /**
   * 画法层的排法(出生序,判词在 `useFrameOrder` 上)与「哪一格是活动的」。
   *
   * **喂的是全集**:一格从标签变成停靠(原位换会话)时它仍旧在这张表上、仍旧
   * 在出生序里的老位置,于是 React 只翻一个 `on` —— 层不重挂、槽不换、
   * `content-slots` 连试一次配对都不必。那正是「切回 = 改属性」的落点。
   */
  const frames = useFrameOrder(held)
  const activeId = active ? refId(active) : null

  /** 檐在不在这片叶身上。**唯一判据**,见文件头那张区域表。 */
  const centerOnTopBar = useWorkbenchStore((st) => centerStripOnTopBar(st.regions[CENTER_REGION]))
  const stripInLeaf = region !== CENTER_REGION || !centerOnTopBar
  /**
   * **标签条让给内容自带的头**(待办 B 形 U1):叶里只有一格、那一种自述了 `stripHeader`、
   * 而且这片叶有自己的条(中央区的标签在顶栏上,头只能画在正文顶上)。判据只有这一处 ——
   * 条那一半与内容那一半读的是同一个 `headerRef`,两边不可能各说各的。
   */
  const soleRef = leaf.tabs.length === 1 ? leaf.tabs[0] : null
  const headerRef = stripInLeaf && soleRef && stripHeaderOf(soleRef) ? soleRef : null

  /**
   * **宿主此刻把这块地露出来了吗**(2026-09-12「收起 ≠ 关闭」)。
   *
   * 从今天起一条架子收起来**不卸载树身**(判词在 `components/EdgeShelf.tsx` 上),
   * 于是「这片叶的活动 tab 露脸了」这句话多了一个前提:装着它的那块地自己得露着。
   * 没有这一句,收起来的架子里那一格照样 `visible: true / interactive: true` ——
   * `expose/components/use-live` 的归位、通知面的「算不算被看见」、原生视图的
   * 显隐,统统会当它还在屏幕上(真机症状:收起再展开,总览停在 Quick Look 而不是
   * 回到总览;那正是这条链的第一处显形)。
   *
   * 读的是**宿主的自述**(`PanelVisibility.visible`)而不是「我在不在架子上、
   * 那条架子收没收」—— 后者要这只文件认识宿主。缺席即缺省 `true`,所以中央区 /
   * 浮窗 / 全屏三个宿主一个字都没变。
   */
  const hostShown = usePanelVisibility().visible

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
   * **这片叶此刻答得出的那几条命令**(⌘W 关这一格、⌘T 同类再开一格、⌘⇧T 重开、
   * ⌘⇧[ ⌘⇧] 与 ⌃Tab 换格、⌘1–9 直达)。声明在 `focus/scopes.ts` 的
   * `FOCUS_SCOPES.leaf.answers`,表本身在 `./leaf-commands.ts`。
   *
   * 中央区那一组标签在顶栏上也注入**同一张表**(同一个 `owner`,两份实例)——
   * 于是焦点在**叶的身体里**还是在**它的标签上**,这一族都接得住。少了这一边,
   * 「在查看器里按 ⌘W」就没人接;而 K2 之后这张表有十四条,所以它是一只共用的
   * hook 而不是两处各写一遍(判词整段在 `leaf-commands.ts` 的文件头上)。
   */
  const leafKeys = useLeafCommands(leaf)

  return (
    /*
     * **叶不声明落点** —— 它是家具,进它就是进它装着的那块内容。那一句自述写在
     * `focus/scopes.ts` 的 `leaf` 行上(`passThrough: true`),内核据此穿过叶根与
     * 那一格 tab 的层,一直走到内容自己那一格。判词全文在
     * `FocusScopeSpec.passThrough` 上。
     */
    <FocusScope scope="leaf" owner={leaf.id} rootRef={rootRef} commands={leafKeys} inert={occluded}>
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
          {stripInLeaf && <PaneLeafStrip leaf={leaf} host={host} headerRef={headerRef} />}

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
            /* 配对只在这一片叶里发生(判词在 `./content-slots.ts`「键是片叶 + 内容」)。 */
            <ContentSlotScope.Provider value={leaf.id}>
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
                <PaneTabFrame key={refId(ref)} tabRef={ref} on={refId(ref) === activeId} hostShown={hostShown} />
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
                  hostShown={hostShown}
                  tabbed={tabbedIds.has(refId(ref))}
                  headerInStrip={headerRef !== null && refId(headerRef) === refId(ref)}
                />
              ))}
            </ContentSlotScope.Provider>,
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
  headerRef,
}: {
  leaf: PaneLeafNode
  host?: PaneHostChrome
  /** 非空 = 条上不画标签,改画这一格自带的头(判据在 `PaneLeaf` 的 `headerRef`)。 */
  headerRef: ContentRef | null
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
   * **右键一格标签 = 这片叶的动作表**(W6-c;W7-c 起点由标签条量)。开的是 `LeafActions`
   * 那**同一张**表(判词在 `workbench/leaf-menu.ts`),不是第二张;所以「右键搬过去」
   * 与「按钮搬过去」与「拖过去」三条路调的仍旧是同一只动作。
   *
   * `preventDefault` 由 `ui/Tabs` 那一口自己发(它是量点的那一头,也是收事件的那一头)。
   */
  /* **表作用在被右键的那一格**(U3;判词在 `LeafMenuAt.tabId`)。 */
  const onTabMenu = useCallback(
    (id: string, at: { x: number; y: number }) => {
      openLeafMenuAt(leaf.id, at, id)
    },
    [leaf.id],
  )
  /*
   * **右键檐上的空白处 = 同一张表**(W7-c 裁定 4)。架子那两件与浮窗那两件搬进
   * 叶菜单之后,那两处的檐上再没有第二个入口 —— 右键标签条右边那片空白是它们
   * 最顺手的开口(浮窗的「标题栏右键」说的正是这块地)。
   *
   * **只在宿主自己有话说的时候接**(`host?.menuRows`):中央区那一档的「空白」
   * 是窗口的拖拽把手,右键归系统;而判据不写成「是不是中央区」,写成「这个宿主
   * 有没有交东西进来」—— 后者是宿主自述,前者是这只文件认识宿主。
   */
  const onChromeContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLElement>) => {
      if (!host?.menuRows) return
      /* 落在一格标签上的那一下**已经被标签自己接了**(`ui/Tabs` 先 preventDefault
       * 再报点)。不让开的话同一张表会被开两次、开在两个点上 —— 后一次赢,
       * 于是右键标签开出来的表贴着的是标签条,不是光标。 */
      if (e.defaultPrevented) return
      e.preventDefault()
      openLeafMenuAt(leaf.id, { x: e.clientX, y: e.clientY })
    },
    [host?.menuRows, leaf.id],
  )

  /** 条上有几格没露全 → 这条檐右端那颗 ⋯(W7-t / B1,与顶栏那一档同一只 hook)。 */
  const onOverflow = useReportOverflow(leaf.id)

  const Header = headerRef ? stripHeaderOf(headerRef) : undefined
  return (
    <LeafStrip
      header={Header && headerRef ? <Header contentRef={headerRef} /> : undefined}
      tabs={tabs}
      activeId={active ? refId(active) : null}
      label={t('workbench.leafTabs')}
      chromeId={leaf.id}
      onSelect={onSelect}
      onClose={onClose}
      onTabPointerDown={onTabPointerDown}
      onTabMenu={onTabMenu}
      onOverflow={onOverflow}
      onChromePointerDown={host?.onChromePointerDown}
      onChromeContextMenu={onChromeContextMenu}
      actions={
        <>
          <LeafActions leaf={leaf} hostMenuRows={host?.menuRows} />
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
  hostShown,
  tabbed,
  headerInStrip,
}: {
  refKind: string
  refKey: string
  /** 这一格的头此刻画在叶的标签条上(`PanelVisibility.headerInStrip`)。 */
  headerInStrip: boolean
  on: boolean
  /**
   * **宿主此刻把这块地露出来了吗**(2026-09-12「收起 ≠ 关闭」)。
   *
   * 它**只窄化「自述」那一格**(`PanelVisibility`),`on` 那一格一个字不碰 ——
   * 判据是真机门抓出来的:`on` 同时驱动 `inert`,而架子收起来时**整条
   * `shelf-layer` 已经 `inert` 了**;再让里面每一格 `leaf` 也翻 `inert`,
   * 焦点树就要结算两遍 —— 第一遍(leaf)把第一响应者挪到 `shelf-layer`,
   * 第二遍(shelf-layer)再问归还席位时,记着席位的那一任已经不是它了,
   * `returnTo` 当场落空:焦点落回 `root`,而不是按键之前那个输入框
   * (`gate:focus` 场景 ④-b 逐字量的就是这一条)。
   * **树的截断由最外面那一格说一次就够**,这一层只管「我这一份算不算在屏幕上」。
   */
  hostShown: boolean
  /**
   * **这一格此刻有没有标签**(组件级停靠,2026-09-10)。没有 = 它是一格
   * **停靠**的内容:照旧挂着、照旧走这一层的 `inert` 两遍,只是取件口画的是
   * `data-pane-kept` 而不是 `data-pane-tab` —— 判词整段在
   * `./kept-contents.ts` 的「排出去的那一格是有意的」。
   */
  tabbed: boolean
}) {
  const id = `${refKind}:${refKey}`
  const contentRef = useMemo<ContentRef>(() => ({ kind: refKind, key: refKey }), [refKind, refKey])
  const shown = on && hostShown
  const visibility = useMemo(() => ({ visible: shown, interactive: shown, headerInStrip }), [shown, headerInStrip])
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
  const slotKey = slotKeyOf(useContext(ContentSlotScope), id)
  const anchor = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) registerContentHolder(slotKey, holder)
    },
    [slotKey, holder],
  )
  useLayoutEffect(() => () => void unregisterContentHolder(slotKey, holder), [slotKey, holder])
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
              data-pane-tab={tabbed ? id : undefined}
              data-pane-kept={tabbed ? undefined : id}
              data-pane-on={on || undefined}
              inert={!on || undefined}
              /*
               * `inert` 已经把这一层从辅助树上摘掉了(规范如此),这一句是**说第二遍**
               * —— 与上面「`inert` 说两遍」同一条纪律的第三面:浏览器实现漂移时
               * 辅助技术仍旧读不到后台那一层。停靠的会话叶在读屏器里必须是不存在的,
               * 不是「存在但读不到」。`gate:a11y` 的口径不变(它扫的是活动那一层)。
               */
              aria-hidden={!on || undefined}
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
 *
 * ── 2026-09-10:收的是「标签 ∪ 停靠」的全集,不再只是标签 ──────────────────
 * 组件级停靠靠的正是这条出生序:一格从标签变成停靠(原位换会话)时它在这张表上
 * **一格没动**,于是那一层连同它的槽、槽里那块内容的身子全都留在原处 ——
 * 「切回 = 改属性」这句话如果没有出生序就不成立(按 `leaf.tabs` 排的话,换会话
 * 会把那一层从名单里摘掉再补一个新的,正是上面那段病历的形状)。
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
const PaneTabFrame = memo(function PaneTabFrame({
  tabRef,
  on,
  hostShown,
}: {
  tabRef: ContentRef
  on: boolean
  /** 同 `PaneContentLayer.hostShown`:只窄化自述,不碰 `on`(判词在那一格上)。 */
  hostShown: boolean
}) {
  const id = refId(tabRef)
  const parts = partsOfContent(tabRef)
  const shown = on && hostShown
  const visibility = useMemo(() => ({ visible: shown, interactive: shown }), [shown])
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
  const slotKey = slotKeyOf(useContext(ContentSlotScope), id)
  // 记着自己交出去的是哪个节点:收到 `null` 时只摘自己那一份(判词在 `releaseContentSlot`)。
  const mounted = useRef<HTMLDivElement | null>(null)
  const mount = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        mounted.current = el
        claimContentSlot(slotKey, el)
      } else if (mounted.current) {
        releaseContentSlot(slotKey, mounted.current)
        mounted.current = null
      }
    },
    [slotKey],
  )
  /*
   * **取件口叫 `data-content-slot`,不叫 `data-pane-slot`** —— 后者早就有主:
   * `PaneTree` 用它标「一片叶的格子」,而 `workbench/drop-geometry.ts` 与三条真机门
   * 都按那个名字量叶的矩形。两件事同名会让落点几何把「一格内容」读成「一片叶」,
   * 而屏幕上什么都看不出来(它只是把矩形算错)。
   */
  return <div ref={mount} className={className ?? s.slot} data-content-slot={id} />
}
