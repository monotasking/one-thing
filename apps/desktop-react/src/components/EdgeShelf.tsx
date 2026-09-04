import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import {
  clampShelfThickness,
  defaultFloatRect,
  floatRectForGrab,
  shelfViewportExtent,
  shouldTearOff,
  snapSideAt,
  thicknessFromPointer,
} from '../stage/transitions'
import { panelIdOf } from '../stage/panel-ref'
import { setSnapSide } from './snap-hint'
import { useWorkbenchStore } from '../workbench/store'
import { edgeRegion } from '../workbench/regions'
import { PaneTree } from '../workbench/PaneTree'
import { parseRefId } from '../workbench/kinds'
import { leafCount } from '../workbench/layout'
import { FocusScope } from '../focus/FocusScope'
import { perfMark } from '../services/perf'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import type { PaneHostChrome } from '../workbench/PaneLeaf'
import { ButtonBase } from '../ui/ButtonBase'
import { IconButton } from '../ui/IconButton'
import { ChevronsDown, ChevronsLeft, ChevronsRight, ChevronsUp, PictureInPicture2, X } from './icons'
import type { LucideIcon } from './icons'
import { FLASH_MS } from './motion'
import type { FloatRect, Point, ShelfSide, Viewport } from '../stage/types'
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

/** 架子贴着视口的那一侧(拖厚度时量它)与朝主区的那一侧(撕 tab 时量它)。 */
function outerEdgeOf(side: ShelfSide, rect: DOMRect): number {
  if (side === 'left') return rect.left
  if (side === 'right') return rect.right
  if (side === 'top') return rect.top
  return rect.bottom
}

function innerEdgeOf(side: ShelfSide, rect: DOMRect): number {
  if (side === 'left') return rect.right
  if (side === 'right') return rect.left
  if (side === 'top') return rect.bottom
  return rect.top
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
 *   三颗钮     随 `ui/IconButton`(本地只剩落点几何:与 tab 同高、直角、下轨)
 *   tab / ✕ / 分屏 / ⋯   随 `LeafStrip` 与 `PaneLeaf`(这一层不重画)
 */
export function EdgeShelf({ side }: Props) {
  const t = useT()
  const region = edgeRegion(side)
  const tree = useWorkbenchStore((st) => st.regions[region])
  const shelf = useStageStore((st) => st.shelves[side])
  const flashPinned = useStageStore((st) => st.flashPinned)
  const flashSide = useStageStore((st) => st.flashSide)
  const setShelfThickness = useStageStore((st) => st.setShelfThickness)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const closeShelf = useStageStore((st) => st.closeShelf)
  const edgeToFloat = useStageStore((st) => st.edgeToFloat)
  const floatToEdge = useStageStore((st) => st.floatToEdge)
  const moveFloat = useStageStore((st) => st.moveFloat)
  const resizeFloat = useStageStore((st) => st.resizeFloat)

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
   */
  const onHandleDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      const box = asideRef.current?.getBoundingClientRect()
      if (!box) return
      // 捕获失败(如 pen 抬笔竞态、合成指针)不放弃拖拽:capture 只是锦上添花,
      // 监听本来就挂在元素上,丢 capture 最多丢"指针滑出元素后的帧"。
      try { el.setPointerCapture(e.pointerId) } catch { /* 不阻断 */ }
      // 外缘在整个拖拽期间不动,所以只测这一次。
      const outer = outerEdgeOf(side, box)
      const extent = shelfViewportExtent(side, readViewport())
      let last = shelf.thickness

      const move = (ev: PointerEvent) => {
        last = clampShelfThickness(
          thicknessFromPointer(side, { x: ev.clientX, y: ev.clientY }, outer),
          extent,
        )
        setLiveThickness(last)
      }
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.removeEventListener('pointercancel', up)
        setLiveThickness(null)
        setShelfThickness(side, last)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
    },
    [side, shelf.thickness, setShelfThickness],
  )

  /**
   * tab 拖出去 = 变浮窗。两段:
   *  1) 还没过阈值 —— 什么都不做,所以一次没拖动的按下松开仍然是普通点击;
   *  2) 过了阈值 —— `edgeToFloat` 之后这一帧起它已经是浮窗,后续每一帧直接写
   *     `moveFloat`,顺带算吸附预示,于是「撕下来顺势再吸去别的边」不需要第二套代码。
   *
   * **只有瓦撕得出去**(W4 的诚实降级):浮窗的矩形、置顶序与位置记忆三张表都按
   * **瓦 id** 记,而一个文件没有瓦 id。把文件也撕出去是 W3 拖拽那一批的事
   * (那时落点与来源统一走 `DragSession`);在那之前,按住一个文件 tab 与从前
   * 按住一个不可撕的 tab 逐字相同:什么都不发生,松手就是普通点击。
   */
  const onTabPointerDown = useCallback(
    (refIdValue: string, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      const ref = parseRefId(refIdValue)
      const id = ref ? panelIdOf(ref) : null
      if (id === null) return
      const box = asideRef.current?.getBoundingClientRect()
      if (!box) return
      const inner = innerEdgeOf(side, box)
      const viewport = readViewport()
      let grabbed: FloatRect | null = null

      const move = (ev: PointerEvent) => {
        const pointer: Point = { x: ev.clientX, y: ev.clientY }
        if (!grabbed) {
          if (!shouldTearOff(side, pointer, inner)) return
          // 有记忆就用记忆身量,没有就用新浮窗的默认身量 —— 位置一律以指针为标题栏中心。
          // 就地取一次而不是订阅 floats:订阅了,别处每拖一帧浮窗这条架子都要重渲一次。
          const remembered = useStageStore.getState().floats[id] ?? defaultFloatRect(viewport)
          grabbed = floatRectForGrab(pointer, remembered, viewport)
          edgeToFloat(id)
          resizeFloat(id, grabbed)
          return
        }
        // 每一帧都问同一个纯函数,所以「指针 = 标题栏中心」这条约定撕下来那一刻与之后逐字相同。
        const next = floatRectForGrab(pointer, grabbed, viewport)
        moveFloat(id, next.x, next.y)
        setSnapSide(snapSideAt(pointer, viewport))
      }
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        if (!grabbed) return
        const landing = snapSideAt({ x: ev.clientX, y: ev.clientY }, viewport)
        setSnapSide(null)
        if (landing) floatToEdge(id, landing)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    },
    [side, edgeToFloat, resizeFloat, moveFloat, floatToEdge],
  )

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

  const host = useMemo<PaneHostChrome>(
    () => ({
      onTabPointerDown,
      actions: (
        <>
          {/* 檐上三颗图标钮全部消费 `ui/IconButton`(09-01 立法)。本地只剩
            * **落点几何**:与 tab 同高的 36×36 与下轨(`.collapse`)。 */}
          <IconButton
            icon={PictureInPicture2}
            className={s.collapse}
            onClick={() => activeItemId && edgeToFloat(activeItemId)}
            label={t('shelf.popOut', { name })}
          />
          <IconButton
            icon={COLLAPSE_ICON[side]}
            className={s.collapse}
            onClick={toggleCollapsed}
            label={t('shelf.collapse', { name })}
          />
          <IconButton
            icon={X}
            className={s.collapse}
            onClick={() => closeShelf(side)}
            label={t('shelf.closeAll', { name })}
          />
        </>
      ),
    }),
    [onTabPointerDown, activeItemId, edgeToFloat, t, name, side, toggleCollapsed, closeShelf],
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
          <FocusScope scope="shelf-layer" owner={ownerId}>
            {({ scopeProps }) => (
              <div
                {...scopeProps}
                className={s.body}
                data-shelf-body={side}
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
