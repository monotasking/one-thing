import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import {
  clampShelfThickness,
  shelfThicknessBudget,
  shelfViewportExtent,
  thicknessFromPointer,
} from '../stage/transitions'
import { panelIdOf } from '../stage/panel-ref'
import { occludedByFull, useWorkbenchStore } from '../workbench/store'
import { edgeRegion } from '../workbench/regions'
import { PaneTree } from '../workbench/PaneTree'
import { leafCount } from '../workbench/layout'
import { FocusScope } from '../focus/FocusScope'
import { perfMark } from '../services/perf'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import type { PaneHostChrome } from '../workbench/PaneLeaf'
import { ButtonBase } from '../ui/ButtonBase'
import { PointerTrack } from '../ui/drag'
import { IconButton } from '../ui/IconButton'
import { MenuItem, MenuSection, MenuSeparator } from '../ui/Menu'
import { ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp } from './icons'
import type { LucideIcon } from './icons'
import { FLASH_MS } from './motion'
import type { ShelfSide, Viewport } from '../stage/types'
import s from './EdgeShelf.module.css'

/** 边 → 它自己的名字。四条边各一句,所以「收起{name}」这类句子只需要一个 key。 */
const LABEL_KEY: Record<ShelfSide, MessageKey> = {
  left: 'shelf.labelLeft',
  right: 'shelf.labelRight',
  top: 'shelf.labelTop',
  bottom: 'shelf.labelBottom',
}

const SIDE_CLASS: Record<ShelfSide, string> = {
  left: s.sideLeft,
  right: s.sideRight,
  top: s.sideTop,
  bottom: s.sideBottom,
}

/** 收起箭头永远指向**这条架子自己那条边** —— 「往那边收」是它的动作方向。 */
const COLLAPSE_ICON: Record<ShelfSide, LucideIcon> = {
  left: ChevronsLeft,
  right: ChevronsRight,
  top: ChevronsUp,
  bottom: ChevronsDown,
}

/* 细梁上的展开把手:方向 = 收起的反向(往主区里长) */
const EXPAND_ICON: Record<ShelfSide, LucideIcon> = {
  left: ChevronsRight,
  right: ChevronsLeft,
  top: ChevronsDown,
  bottom: ChevronsUp,
}

/** 竖边的厚度写进 width,横边写进 height —— CSS 侧「换个轴读」的唯一一处。 */
function thicknessStyle(side: ShelfSide, px: string): { width?: string; height?: string } {
  return side === 'left' || side === 'right' ? { width: px } : { height: px }
}

/**
 * 架子贴着视口的那一侧 —— 拖厚度时量它。
 *
 * 它从前有一只对称的兄弟 `innerEdgeOf`(朝主区那一侧,「撕 tab 撕出去多远」的
 * 基准)。撕 tab 那一整段随 W3 退役了,它跟着走 —— 而「离窗口边多近算吸」
 * 那件事仍旧由形态机的 `snapSideAt` 统一回答,不需要架子自己量一个内缘。
 */
function outerEdgeOf(side: ShelfSide, rect: DOMRect): number {
  if (side === 'left') return rect.left
  if (side === 'right') return rect.right
  if (side === 'top') return rect.top
  return rect.bottom
}

function readViewport(): Viewport {
  return { w: window.innerWidth, h: window.innerHeight }
}

interface Props {
  side: ShelfSide
}

/**
 * 一条边上的架子。W1 只有右边有 UI(那时它叫 PinnedPanel),W2 起四条边共用这一个组件 ——
 * 边是 prop,不是组件身份:同一套收展 / 同一套拖厚度,换个轴读而已。
 *
 * ── W4:身子换成一棵拼贴树 ───────────────────────────────────────────────
 * 从前这里自己画一条 tab 条(`ui/Tabs` + 一串 `ShelfTabLayer`),tab 的内容是
 * **一串瓦 id**(`ShelfState.tabs: string[]`)。那张表装不下别的东西 —— 于是
 * 「把一个文件钉到右边」在 W1-a 里只能禁灰。
 *
 * 现在这条边的身子就是 `workbench.regions['edge:<side>']` 那棵树,画法与中央区
 * **逐字同一件**(`PaneTree` → `PaneLeaf` → `LeafStrip`)。三件事因此白拿:
 * 瓦与文件在同一条 tab 条上、架子里能分屏、keep-alive 与 `inert` 那两遍话由
 * `PaneLeaf` 统一说(从前这只文件里有一份自己的 `ShelfTabLayer`,两份迟早分叉)。
 *
 * 这只文件因此只剩**外壳**:厚度(拖 / 钳 / 写进哪个轴)、收展、闪烁、
 * 以及把一格 tab **撕成浮窗**那条手势。判定全在 transitions 的纯函数里。
 *
 * 收起态是「同一个 <aside> 变薄」,不是换一个组件:aside 在 React 树里位置不变,
 * DOM 节点复用,所以厚度那一次过渡真的会跑。
 *
 * ── 状态表 ①:生命周期 ──────────────────────────────────────────────────
 *   挂载    这条边那棵树长出来(第一格插进来)
 *   首载    **不画载入态** —— 树是同步已知的;内容的载入由内容自己说
 *   换宿主  一格从这条边搬到别处:树里摘掉,这条架子的叶随之剪掉
 *   卸载    这条边那棵树空了(`regions['edge:<side>']` 没了)
 *
 * ── 状态表 ②:UI 生命状态 ───────────────────────────────────────────────
 *   空       整条不渲染(不占一丝布局)
 *   展开     厚度 = `shelf.thickness`,身子是那棵树
 *   收起     折成一条细梁(`--shelf-rail`),里面一个 tab 的内容都不画
 *   拖厚度   零过渡、逐帧写本地 state,松手才落 store
 *   闪烁     `flashSide` 指到自己时闪两下
 *   分屏     树自己的事(`PaneTree` 画杆),这一层不知道
 *
 * ── 状态表 ③:UI 交互状态 ───────────────────────────────────────────────
 *   厚度把手   不可见热区,hover 一层薄膜(`--st-hover`)
 *   细梁       整条可点,hover 一层薄膜 + 箭头转正色
 *   那一颗钮   随 `ui/IconButton`(本地只剩落点几何:与 tab 同高、直角、下轨);
 *              另两件(弹出 / 关整栏)W7-c 进了叶菜单,右键檐上的空白处开
 *   tab / ✕ / 分屏 / ⋯   随 `LeafStrip` 与 `PaneLeaf`(这一层不重画)
 */
export function EdgeShelf({ side }: Props) {
  const t = useT()
  const region = edgeRegion(side)
  const tree = useWorkbenchStore((st) => st.regions[region])
  /*
   * **被全屏盖住了吗**(W2)。盖住 = `inert`,DOM 与树各说一遍(与下面那格 tab 层
   * 的 keep-alive 同一条判据):少了给树的那一遍,这条架子的局部键会在看不见的
   * 地方响;少了给 DOM 的那一遍,焦点能 Tab 进一块被盖住的面。
   * **装着全屏那一格的这条边不算被盖住** —— 那一格内容的 DOM 就住在全屏层里,
   * 它照旧要接键盘(判据整件在 `store.occludedByFull`)。
   */
  const occluded = useWorkbenchStore((st) => occludedByFull(st, region))
  const shelf = useStageStore((st) => st.shelves[side])
  const flashPinned = useStageStore((st) => st.flashPinned)
  const flashSide = useStageStore((st) => st.flashSide)
  const setShelfThickness = useStageStore((st) => st.setShelfThickness)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const closeShelf = useStageStore((st) => st.closeShelf)
  const edgeToFloat = useStageStore((st) => st.edgeToFloat)

  const asideRef = useRef<HTMLElement>(null)

  const [flashing, setFlashing] = useState(false)
  const firstFlash = useRef(true)

  // 拖厚度期间的实时值。松手清空,渲染就自动回到 store 那份(两者此刻相等)。
  const [liveThickness, setLiveThickness] = useState<number | null>(null)

  useEffect(() => {
    if (firstFlash.current) {
      firstFlash.current = false
      return
    }
    if (flashSide !== side) return
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), FLASH_MS)
    return () => clearTimeout(timer)
  }, [flashPinned, flashSide, side])

  const toggleCollapsed = useCallback(() => toggleShelfCollapsed(side), [toggleShelfCollapsed, side])

  /**
   * 厚度把手。跟手定律:过程中零过渡、逐帧写**本地** state,松手才落 store,
   * 两处共用同一个钳制纯函数,所以「拖着看到的」与「存下来的」逐像素相同。
   *
   * **三条结束路径由 `ui/drag` 的 `PointerTrack` 收**(U5,2026-09-08):从前这里
   * 只挂 pointerup / pointercancel、而且挂在**把手自己身上** —— 拖到一半切走应用
   * 或系统弹框抢走指针,那格活厚度会一直挂着(病历整段在 `pointer-track.ts`)。
   * **取消 = 清掉活厚度、不 `setShelfThickness`**:渲染当场回到 store 那份,
   * 屏幕上等于这一下没发生过。松手那条路一个字没改。
   */
  const onHandleDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      const box = asideRef.current?.getBoundingClientRect()
      if (!box) return
      // 外缘在整个拖拽期间不动,所以只测这一次。
      const outer = outerEdgeOf(side, box)
      /*
       * **拖着看到的与存下来的是同一把尺**(既有纪律),而那把尺从 W7-p 裁定 3
       * 起多了一格:**共同预算**(该轴视口 − 中央最小 − 对边此刻厚度)。两个数
       * 在整个拖拽期间都不动(视口不变、对边没人碰),所以照旧只测这一次。
       */
      const vp = readViewport()
      const extent = shelfViewportExtent(side, vp)
      const budget = shelfThicknessBudget(useStageStore.getState(), side, vp)
      let last = shelf.thickness

      PointerTrack.open(el, e.pointerId, {
        move: (ev) => {
          last = clampShelfThickness(
            thicknessFromPointer(side, { x: ev.clientX, y: ev.clientY }, outer),
            extent,
            budget,
          )
          setLiveThickness(last)
        },
        end: () => {
          setLiveThickness(null)
          setShelfThickness(side, last)
        },
        // 只清活值:渲染自动回到 store 那份厚度(两者此刻就是拖之前那个数)。
        cancel: () => setLiveThickness(null),
      })
    },
    [side, shelf.thickness, setShelfThickness],
  )

  /*
   * ── 「tab 撕成浮窗」那一整段退役了(W3)────────────────────────────────
   * W4 交卷时这里有一段自己的拖拽:过阈值 → `edgeToFloat` → 每帧 `moveFloat`,
   * 而它**只对瓦成立**(浮窗的矩形 / 置顶序 / 位置记忆三张表都按瓦 id 记,
   * 一个文件没有瓦 id),留账写着「把文件也撕出去是 W3 拖拽那一批的事」。
   *
   * W3 到了:拖拽是全壳统一的一件事(`workbench/useTabDrag` → `ui/drag` +
   * 纯判据 `workbench/drop`),接线落在**檐**上(`PaneLeaf.PaneLeafStrip`),
   * 四个宿主共用。所以这条架子不再有自己的那一套 —— 它连 `onTabPointerDown`
   * 都不必给了(留账 2 顺带结清:任何一种 ref 都撕得出浮窗,窗号由
   * `nextFloatId` 铸)。
   *
   * **可感知的变化一条**,记在交卷报告里:从架子上撕一格 tab 从前是「过阈值
   * 当场变浮窗、之后每帧跟手」,现在是「浮影跟指针 + 一圈窗子轮廓预示,松手
   * 成窗」——设计 §3 定的统一模型,五种来源同一套。
   */

  const name = t(LABEL_KEY[side])
  /**
   * **这条架子此刻的住户**(响应链上那一格 `shelf-layer` 的 `owner`)。
   *
   * 不变量 I4 说的是「每个 Placement 宿主层的根元素都带 `data-focus-scope`」,
   * 而召唤那条路(`summon` 的 `focus` 档)与跟焦那条路(`focus-follow` 的
   * 「架子切 tab」档)都按 `activateScope('shelf-layer', { owner: 瓦 id })` 精确取 ——
   * 同一种 layer 同时有四条(四条边),取哪一条只能靠住户名。
   *
   * W4 之前这一格挂在**每一个 tab 层**上(一层一格 `shelf-layer`,后台那些 inert);
   * 现在架子的身子是一棵树,一格 tab 的可交互性由 `PaneLeaf` 的 `PaneTabLayer`
   * (`leaf` 作用域 + `inert` 说两遍)管,所以这一层收敛成**整条架子一格** ——
   * 它回答的是「键盘此刻在不在这条架子里」,住户则是它露脸的那一格。
   */
  const activeItemId = useMemo(() => {
    const leaf = tree ? firstLeafOf(tree) : null
    const ref = leaf?.tabs[leaf.active]
    return ref ? panelIdOf(ref) : null
  }, [tree])
  /*
   * 住户名答不出时(根叶此刻露的是个文件)退回**这条边自己**:`owner` 只是
   * 「同一种 layer 有好几份时取哪一份」的选择键,它必须答得出一个稳定的名字。
   */
  const ownerId = activeItemId ?? side

  /**
   * **檐上只剩一颗「收起」**(W7-c 裁定 4;用户 09-05「按钮太多」)。
   *
   * 「弹出为浮窗」与「关闭整栏」搬进了**这片叶的动作菜单**(`menuRows`)。判据是
   * 那条本仓判例的字面兑现(CLAUDE.md「动作单产地=右键上下文菜单」):一条架子
   * 能做的事收进一张表,檐上只留**最顺手的那一件**。留下的是「收起」而不是别的
   * 两件,因为它是三件里**唯一可逆、唯一高频**的一件 —— 关整栏会把架子上的瓦全
   * 收回 Dock(有后果的写操作,与 `keymap/types.ts` 那条「不该被盲按的键直接触发」
   * 同一条纪律),弹成浮窗是一次搬家。
   *
   * 两行菜单项调的是**与从前那两颗钮同一只** store 动作(`edgeToFloat` /
   * `closeShelf`)—— parity 测试逐项钉着这一条。
   */
  const host = useMemo<PaneHostChrome>(
    () => ({
      actions: (
        <IconButton
          icon={COLLAPSE_ICON[side]}
          className={s.collapse}
          onClick={toggleCollapsed}
          label={t('shelf.collapse', { name })}
        />
      ),
      menuRows: (
        <>
          <MenuSeparator />
          <MenuSection>{name}</MenuSection>
          <MenuItem
            disabled={activeItemId === null}
            onClick={() => activeItemId && edgeToFloat(activeItemId)}
          >
            {t('shelf.popOut', { name })}
          </MenuItem>
          <MenuItem onClick={() => closeShelf(side)}>{t('shelf.closeAll', { name })}</MenuItem>
        </>
      ),
    }),
    [activeItemId, edgeToFloat, t, name, side, toggleCollapsed, closeShelf],
  )

  // 空架子不渲染 —— 也就不占一丝布局。
  if (!tree) return null
  const thickness = liveThickness ?? shelf.thickness
  const multi = leafCount(tree) > 1

  return (
    <aside
      ref={asideRef}
      className={[
        s.shelf,
        SIDE_CLASS[side],
        shelf.collapsed && s.collapsed,
        liveThickness !== null && s.dragging,
        flashing && s.flashing,
      ]
        .filter(Boolean)
        .join(' ')}
      style={thicknessStyle(side, shelf.collapsed ? 'var(--shelf-rail)' : `${thickness}px`)}
      aria-label={name}
      data-shelf={side}
    >
      {shelf.collapsed ? (
        /* 细梁不是一颗图标钮:它是**整条边那么长**的一块结构件(展开把手),
         * 所以走裸钮三类判的第③类 —— `ui/ButtonBase` 只清 UA,那条 100%×100%
         * 的皮肤(含 hover 时 railIcon 转正色)原样留在本地。 */
        <ButtonBase
          className={s.rail}
          onClick={toggleCollapsed}
          aria-label={t('shelf.expand', { name })}
        >
          {(() => {
            const ExpandIcon = EXPAND_ICON[side]
            return <ExpandIcon className={s.railIcon} strokeWidth={1.75} aria-hidden="true" />
          })()}
        </ButtonBase>
      ) : (
        <>
          <div
            className={s.handle}
            onPointerDown={onHandleDown}
            role="separator"
            aria-label={t('shelf.resize', { name })}
            aria-orientation={side === 'left' || side === 'right' ? 'vertical' : 'horizontal'}
          />
          {/*
            身 = 这条边那棵树。檐(tab 条 + ⋯ / 分屏 + 上面那三颗)由 `PaneLeaf`
            统一画 —— 这一层不再自绘一条 tab 条,keep-alive 与 `inert` 那两遍话
            也随之只剩一个产地(判词写在 `PaneLeaf` 的 `PaneTabLayer` 上)。
          */}
          <FocusScope scope="shelf-layer" owner={ownerId} inert={occluded}>
            {({ scopeProps }) => (
              <div
                {...scopeProps}
                className={s.body}
                data-shelf-body={side}
                inert={occluded || undefined}
                /*
                 * **这条架子此刻露脸的那格瓦**(门与用例的取件口;`gate:squeeze` /
                 * `gate:perf` 按它认「总览钉上来了没有」)。树是真相,这一格是它的
                 * 一格投影 —— 与 `shelves[side].activeId` 同一个读法、同一处产地。
                 * 露的是文件时它是空串:那是诚实的「此刻没有瓦露脸」。
                 */
                data-panel={activeItemId ?? ''}
                data-pane-region={region}
                data-pane-multi={multi || undefined}
                onPointerDownCapture={() => perfMark(`shelf.activate:${side}`)}
              >
                <PaneTree node={tree} host={host} />
              </div>
            )}
          </FocusScope>
        </>
      )}
    </aside>
  )
}

/** 阅读序第一片叶。`workbench/tree` 的 `leavesOf` 那一句的窄用法。 */
function firstLeafOf(node: import('../workbench/tree').PaneNode): import('../workbench/tree').PaneLeafNode | null {
  if (node.kind === 'leaf') return node
  return firstLeafOf(node.a) ?? firstLeafOf(node.b)
}
