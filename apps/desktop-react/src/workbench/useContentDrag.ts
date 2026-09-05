import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { setDropFeedback, useDragSource } from '../ui/drag'
import { useT } from '../i18n'
import { defaultFloatRect, floatRectForGrab, FALLBACK_VIEWPORT } from '../stage/transitions'
import { dropRef } from './drop-commit'
import { dropTargetAt, targetRectOf } from './drop'
import { measureDropGeometry } from './drop-geometry'
import { contentKindOf } from './kinds'
import { useWorkbenchStore } from './store'
import type { DragGhostSpec } from '../ui/drag'
import type { DropGeometry, DropRules, DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { MessageKey } from '../i18n'

/**
 * **把一样东西变成「能拖进拼贴台的东西」**(W3)——五种来源共用的这一只。
 *
 * ── 它治的是什么 ────────────────────────────────────────────────────────
 * 五种来源(文件树行 / 项目行 / tab / Dock 瓦 / 会话行)要做的事逐字相同:
 * 起拖时量一次几何并闸住树、每一帧算落点并把高亮交回去、松手落定、Esc 取消。
 * 五处各写一遍就是五份会漂的判据 —— 而「拖到这儿会发生什么」与「屏幕上高亮画
 * 在哪儿」一旦在某一处分叉,用户看到的就是「高亮说的和松手做的不是一件事」。
 *
 * 所以来源那一头只剩**两句自述**:拖的是哪个 `ref`、这次拖拽自己的规矩
 * (`rules` —— 分不分屏、哪些落点不收)。`ui/drag` 那一层更是一个业务名字都
 * 不认识,判据整件在纯函数 `./drop`。
 *
 * ── 落定不一定要动树:`onDrop` 那一格 ────────────────────────────────────
 * 会话行走的正是这一格(裁定 7):它落到中央**不是**把一格 tab 插进树,而是
 * 「切换当前会话」。所以这只 hook 收一口可选的 `onDrop(target)` —— 答 `true`
 * 表示「我自己处理了」,缺省那条路才走 `dropRef`。W5 会话真成一种内容之后,
 * 那一口自然消失,这只 hook 一个字不用改。
 */

export interface ContentDragSpec {
  /** 拖的是什么。答 null = 这一下不许拖(整场作废,与普通点击逐字相同)。 */
  ref(): ContentRef | null
  /** 浮影画什么。缺席 = 问种类表(名字与图标都是它自述的)。 */
  ghost?(ref: ContentRef): DragGhostSpec
  /** 这次拖拽自己的规矩(分不分屏 / 哪些落点不收)。 */
  rules?: DropRules
  /**
   * 自己处理落定。答 `true` = 处理完了,不再走 `dropRef`;答 `false` / 缺席 =
   * 走缺省那条(把这一格搬到落点上)。
   */
  onDrop?(target: DropTarget, ref: ContentRef): boolean
}

interface DragHeld {
  ref: ContentRef
  geometry: DropGeometry
  target: DropTarget
}

export function useContentDrag(spec: ContentDragSpec): (e: ReactPointerEvent<Element>) => void {
  const t = useT()
  const specRef = useRef(spec)
  specRef.current = spec

  /*
   * `resize` 期间重量(裁定 4 的后半句)。它挂在拖拽的生命周期上而不是组件上:
   * 不拖的时候一条监听都不该在(五种来源加起来可能是几百行,各挂一条就是几百条)。
   */
  const rewire = useRef<(() => void) | null>(null)

  const onStart = useCallback(
    () => {
      /*
       * **全屏铺着的时候一下都不许起拖**(W2×W3 合树接缝 a)。
       *
       * 判据不是「好看」而是结构:落点的那份几何量的是**底下那棵树**
       * (`measureDropGeometry`),而全屏层此刻正盖着它 —— 被盖的叶带 `inert`、
       * 顶栏与四条架子全在层底下。真让它起拖,高亮会画在一块用户根本看不见的
       * 矩形上,而 FullLayer 的檐带上也没有任何一件是可拖的。所以这一下当场
       * 作废,与「`ref()` 答 null」逐字同一条路(整场不成立,不是中途取消)。
       *
       * 读 store 一格、不订阅:起拖是个事件,不是渲染。
       */
      if (useWorkbenchStore.getState().full !== null) return null
      const ref = specRef.current.ref()
      if (!ref) return null
      const held: DragHeld = {
        ref,
        geometry: measureDropGeometry(),
        target: { kind: 'float' },
      }
      // 起拖 = 闸住树形(判词在 `WorkbenchState.dragging` 上)。
      useWorkbenchStore.getState().setDragging(true)
      const onResize = () => {
        held.geometry = measureDropGeometry()
      }
      window.addEventListener('resize', onResize)
      rewire.current = () => window.removeEventListener('resize', onResize)
      return { payload: held, ghost: specRef.current.ghost?.(ref) ?? ghostOf(ref) }
    },
    [],
  )

  const onMove = useCallback(
    (pointer: { x: number; y: number }, held: DragHeld) => {
      const target = dropTargetAt(pointer, held.geometry, specRef.current.rules)
      held.target = target
      setDropFeedback(feedbackOf(target, held.geometry, pointer, t))
    },
    [t],
  )

  const finish = useCallback(() => {
    rewire.current?.()
    rewire.current = null
    // 落定 / 取消都先开闸 —— 落定那条路自己要改树。
    useWorkbenchStore.getState().setDragging(false)
  }, [])

  const onDrop = useCallback(
    (pointer: { x: number; y: number }, held: DragHeld) => {
      finish()
      const target = held.target
      if (specRef.current.onDrop?.(target, held.ref) === true) return
      dropRef(held.ref, target, { pointer })
    },
    [finish],
  )

  return useDragSource<DragHeld>({ onStart, onMove, onDrop, onCancel: finish })
}

/** 浮影的缺省:名字与图标都问种类表(拖拽因此不认识任何一种内容)。 */
function ghostOf(ref: ContentRef): DragGhostSpec {
  const kind = contentKindOf(ref.kind)
  return { label: kind?.title(ref).text ?? ref.key, icon: kind?.icon(ref) }
}

/**
 * 一个落点该怎么画。
 *
 * 三种形:**叶 / 边带**画那块矩形(纯函数算的,与判据同一块);**撕浮窗**画
 * 那扇窗将来的轮廓(`floatRectForGrab` —— 与从架子上撕一块瓦、与落定时那一句
 * **同一只函数**,所以预示的位置就是松手后窗子真正的位置);**拒绝**沿用上一种
 * 的矩形但换成拒绝色,并且**必须带一句理由**(裁定 7)。
 */
function feedbackOf(
  target: DropTarget,
  geometry: DropGeometry,
  pointer: { x: number; y: number },
  t: (key: MessageKey) => string,
) {
  if (target.kind === 'refuse') {
    return { rect: null, tone: 'refuse' as const, label: t(target.reasonKey) }
  }
  if (target.kind === 'float') {
    const viewport =
      typeof window === 'undefined'
        ? FALLBACK_VIEWPORT
        : { w: window.innerWidth, h: window.innerHeight }
    const rect = floatRectForGrab(pointer, defaultFloatRect(viewport), viewport)
    return {
      rect: { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
      tone: 'accept' as const,
      label: t('drag.toFloat'),
      outline: true,
    }
  }
  const rect = targetRectOf(target, geometry)
  return {
    rect,
    tone: 'accept' as const,
    label: target.kind === 'edge' ? t(EDGE_LABEL[target.side]) : undefined,
  }
}

/** 四条边各一句话。**一张表**,不是四处 if。 */
const EDGE_LABEL: Readonly<Record<'left' | 'right' | 'top' | 'bottom', MessageKey>> = {
  left: 'drag.toEdgeLeft',
  right: 'drag.toEdgeRight',
  top: 'drag.toEdgeTop',
  bottom: 'drag.toEdgeBottom',
}
