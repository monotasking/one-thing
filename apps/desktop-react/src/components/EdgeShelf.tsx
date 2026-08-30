import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useStageStore } from '../stage/store'
import { findItem } from '../stage/items'
import {
  clampShelfThickness,
  defaultFloatRect,
  floatRectForGrab,
  shelfViewportExtent,
  shouldTearOff,
  snapSideAt,
  thicknessFromPointer,
} from '../stage/transitions'
import { setSnapSide } from './snap-hint'
import { renderContent } from '../content'
import { perfMark } from '../services/perf'
import { useT } from '../i18n'
import type { MessageKey } from '../i18n'
import { Tabs } from '../ui/Tabs'
import type { TabSpec } from '../ui/Tabs'
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
 * 架子 body 里的一层 = 一个 tab 的内容,**始终挂着**(keep-alive),只有显不显形在变。
 *
 * `memo` 不是优化点缀,是这套 keep-alive 的**前提**:EdgeShelf 每重渲染一次
 * (拖厚度那一路是逐帧重渲的),没有 memo 的话每一层的元素树都会重造,React 就要
 * 把后台那块 400 张卡的面板整棵对一遍 —— 于是「拖架子边」会比「切 tab」更卡。
 * 有了 memo,只有 `on` 真的翻了的那两层才重渲。
 *
 * `inert` 与 `content-visibility: hidden` 分工不同,两个都要:前者管**可交互性**
 * (焦点序、指针、辅助树),后者管**渲染开销**。少哪一个都会留下一个能摸到却看不见的面板。
 */
const ShelfTabLayer = memo(function ShelfTabLayer({ id, on }: { id: string; on: boolean }) {
  const visibility = useMemo(() => ({ visible: on, interactive: on }), [on])
  return (
    <div
      className={on ? s.layer : `${s.layer} ${s.layerHidden}`}
      data-panel-layer={id}
      data-panel-on={on || undefined}
      inert={!on || undefined}
    >
      {renderContent(id, visibility)}
    </div>
  )
})

/**
 * 一条边上的架子。W1 只有右边有 UI(那时它叫 PinnedPanel),W2 起四条边共用这一个组件 ——
 * 边是 prop,不是组件身份:同一套 tab 条 / 同一套收展 / 同一套拖厚度,换个轴读而已。
 *
 * 它做五件事:把 shelf.tabs 翻成 TabSpec、渲染活动 tab 的内容、拖厚度、收/展、
 * 以及把 tab 从架子上**撕成浮窗**(拖离内缘超过阈值)。判定全在 transitions 的纯函数里。
 *
 * 收起态是「同一个 <aside> 变薄」,不是换一个组件:aside 在 React 树里位置不变,
 * DOM 节点复用,所以厚度那一次过渡真的会跑;里面的内容当场换掉,不叠第二段动画。
 *
 * ── 同组 tab 是 keep-alive 的(08-30) ────────────────────────────────────
 * body 里挂的是**这条架子上的每一个 tab**,不是「活动那一个」。切 tab 只换
 * 哪一层显形,不卸载谁 —— 于是重面板(会话总览那 400 张卡)不必每次切回都重建。
 *
 * 修之前:切到会话总览一次 65–130ms(点击回调里 React 重渲 ~36ms + Layout ~21ms,
 * 随后一次 ~31ms 的 Commit),十次切换里出 2–4 帧 >50ms 的长帧;
 * 轻面板 13–24ms。这就是用户报的「切 tab 感觉很卡」。
 *
 * 隐藏用 `content-visibility: hidden` 而不是 `display: none`,理由只有一条且可验证:
 * **`display:none` 会销毁盒子,滚动位置当场归零**;`content-visibility: hidden` 跳过
 * 后代的渲染却**保留渲染状态**,所以「切走再切回,滚回原处」成立 —— 门里有一条
 * 断言逐帧钉着它(gate-perf 场景②的滚动位置检查)。代价写在门的「脚印」那两行里。
 *
 * 边界只画到**这一条架子这一组**:撕成浮窗 / 收回 Dock / 关掉都会让 tab 离开
 * `shelf.tabs`,这一层随之卸载。舞台与浮窗各自只有一份内容,一行都不改。
 * ──────────────────────────────────────────────────────────────────────
 */
export function EdgeShelf({ side }: Props) {
  const t = useT()
  const shelf = useStageStore((st) => st.shelves[side])
  const flashPinned = useStageStore((st) => st.flashPinned)
  const flashSide = useStageStore((st) => st.flashSide)
  const setShelfThickness = useStageStore((st) => st.setShelfThickness)
  const toggleShelfCollapsed = useStageStore((st) => st.toggleShelfCollapsed)
  const closeShelf = useStageStore((st) => st.closeShelf)
  const closeToDock = useStageStore((st) => st.closeToDock)
  const activateShelfTab = useStageStore((st) => st.activateShelfTab)
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
   * 切 tab。埋的是 `perfMark` 而不是 `perfSpan`,理由是**开销不在这一刻发生**:
   * 这里只派发一次 store 更新,真正的代价(React 重渲 + 布局 + 提交)落在随后那一帧里。
   * perfSpan 在这儿只会量到一个 0.1ms 的假读数;一个时间点标记才有用 ——
   * dump 里「这条长帧发生在 shelf.activate 之后」,以及 gate-perf 的 trace 里
   * (它录着 blink.user_timing)时间轴上直接看到这一竖线。
   */
  const activate = useCallback(
    (id: string) => {
      perfMark(`shelf.activate:${side}`)
      activateShelfTab(side, id)
    },
    [activateShelfTab, side],
  )

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
   *  1) 还没过阈值 —— 什么都不做,所以一次没拖动的按下松开仍然是普通点击(Tabs 的 onClick);
   *  2) 过了阈值 —— edgeToFloat 之后这一帧起它已经是浮窗,后续每一帧直接写 moveFloat
   *     (浮窗自己没有过渡,所以逐帧写 store 依旧跟手),顺带算吸附预示,
   *     于是「撕下来顺势再吸去别的边」不需要第二套代码。
   */
  const onTabPointerDown = useCallback(
    (id: string, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
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

  // 持久化过的 id 可能已经不在 items 表里(将来 items 换来源时),查不到就当它不存在。
  const tabs = useMemo<TabSpec[]>(
    () =>
      shelf.tabs.flatMap((id) => {
        const item = findItem(id)
        return item ? [{ id: item.id, label: t(item.titleKey), icon: item.icon }] : []
      }),
    [shelf.tabs, t],
  )

  if (tabs.length === 0) return null
  const active = tabs.some((tab) => tab.id === shelf.activeId) ? shelf.activeId : null
  const name = t(LABEL_KEY[side])
  const CollapseIcon = COLLAPSE_ICON[side]
  const thickness = liveThickness ?? shelf.thickness

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
        <button
          type="button"
          className={s.rail}
          onClick={toggleCollapsed}
          aria-label={t('shelf.expand', { name })}
        >
          {(() => {
            const ExpandIcon = EXPAND_ICON[side]
            return <ExpandIcon className={s.railIcon} strokeWidth={1.75} aria-hidden="true" />
          })()}
        </button>
      ) : (
        <>
          <div
            className={s.handle}
            onPointerDown={onHandleDown}
            role="separator"
            aria-label={t('shelf.resize', { name })}
            aria-orientation={side === 'left' || side === 'right' ? 'vertical' : 'horizontal'}
          />
          <div className={s.head}>
            <div className={s.tabsWrap}>
              <Tabs
                items={tabs}
                activeId={active}
                onSelect={activate}
                onClose={closeToDock}
                onTabPointerDown={onTabPointerDown}
                label={name}
              />
            </div>
            <button
              type="button"
              className={s.collapse}
              onClick={() => active && edgeToFloat(active)}
              aria-label={t('shelf.popOut', { name })}
            >
              <PictureInPicture2 className={s.collapseIcon} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={s.collapse}
              onClick={toggleCollapsed}
              aria-label={t('shelf.collapse', { name })}
            >
              <CollapseIcon className={s.collapseIcon} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={s.collapse}
              onClick={() => closeShelf(side)}
              aria-label={t('shelf.closeAll', { name })}
            >
              <X className={s.collapseIcon} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <div className={s.body} data-shelf-body={side} data-panel={active ?? ''}>
            {tabs.map((tab) => (
              <ShelfTabLayer key={tab.id} id={tab.id} on={tab.id === active} />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
