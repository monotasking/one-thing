import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { setDragPresentation, setDropFeedback, useDragSource } from '../ui/drag'
import { useT } from '../i18n'
import { defaultFloatRect, floatRectForGrab, FALLBACK_VIEWPORT } from '../stage/transitions'
import { dropRef } from './drop-commit'
import { dropTargetAt, targetRectOf } from './drop'
import { measureDropGeometry } from './drop-geometry'
import { contentKindOf } from './kinds'
import { edgeRegion, floatRegion } from './regions'
import { useWorkbenchStore } from './store'
import type { DragBandState, DragGhostSpec } from '../ui/drag'
import type { DropGeometry, DropRules, DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { RegionId } from './regions'
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

/**
 * **「带内」那一形由来源自己画**(W3-b 裁定 4/5)。
 *
 * 一格 tab 在**自己那条条的带内**时,拖着的东西不是浮影而是它自己(抬起来横向
 * 跟手、邻居让位),落定也不是 `dropRef` 而是一次同叶换序。这两件事只有 tab
 * 那一种来源做得到,而这只 hook 是五种来源共用的 —— 所以它不做,只**让位**:
 * 带内这几帧整条交给来源,带外照旧走统一那条路。
 *
 * 不给这一格 = 没有带 = 与 W3 逐字相同(文件行 / 项目行 / 会话行 / Dock 瓦)。
 */
export interface InlineDragHandlers {
  /** 进带(含起拖就在带里那一帧):把那一格抬起来。 */
  enter(pointer: { x: number; y: number }): void
  /** 带内每一帧。 */
  move(pointer: { x: number; y: number }): void
  /** 出带:抬起收掉,交回统一那条路(来源那一格通常在这里折起来)。 */
  leave(): void
  /** 在带内松手。答 `true` = 我自己落定了,不再走 `dropRef`。 */
  drop(pointer: { x: number; y: number }): boolean
}

export interface ContentDragSpec {
  /** 拖的是什么。答 null = 这一下不许拖(整场作废,与普通点击逐字相同)。 */
  ref(): ContentRef | null
  /**
   * 这次拖拽的「带」在哪儿(见 `InlineDragHandlers`)。缺席 / 答 null = 没有带。
   * 它直接透给 `ui/drag` —— 「在不在带里」「哪一帧刚出来」由那一件唯一那条会话答。
   */
  band?(): { top: number; bottom: number; left: number; right: number } | null
  /** 带的上下外扩(离带这么近仍算在带里)。 */
  bandSlack?: number
  /** 带内那一形。给了 `band` 才有意义。 */
  inline?: InlineDragHandlers
  /** 浮影画什么。缺席 = 问种类表(名字与图标都是它自述的)。 */
  ghost?(ref: ContentRef): DragGhostSpec
  /** 这次拖拽自己的规矩(分不分屏 / 哪些落点不收)。 */
  rules?: DropRules
  /**
   * 自己处理落定。答 `true` = 处理完了,不再走 `dropRef`;答 `false` / 缺席 =
   * 走缺省那条(把这一格搬到落点上)。
   */
  onDrop?(target: DropTarget, ref: ContentRef): boolean
  /**
   * **带外**每一帧,落点算完之后叫一次(W3-b)。给来源画只有它才画得出来的那种
   * 预示 —— tab 那一种在这里让目标标签条腾出一个空位。
   *
   * 它拿到的是**判据算出来的那个落点**,不是自己再算一遍:屏幕上的预示与松手的
   * 结果因此在结构上不可能对不上(与 `DropOverlay` 读同一块矩形是同一条纪律)。
   */
  onTarget?(target: DropTarget): void
  /**
   * 这一场结束了(落定 / Esc / 指针没了,**三条路都叫**,在闸开之后、落定之前)。
   * 来源在这里收拾自己画过的东西。幂等 —— 它是「每条结束路径都先走它」的那一只。
   */
  onEnd?(): void
}

interface DragHeld {
  ref: ContentRef
  geometry: DropGeometry
  target: DropTarget
  /**
   * 此刻是不是正走在「带内」那一形上。**存在这一格 payload 里而不是一个 ref**:
   * 它是这一场手势的一部分,与 `DragSession` 那条会话同生共死 —— 存在组件的 ref
   * 上就等于第二条会话,而那一条会在 Esc / pointercancel / 窗口失焦三条路上
   * 各漏一次归零。
   */
  inBand: boolean
  /** 收拾这一场留下的一切。落定 / 取消都先走它,幂等。 */
  cleanup(): void
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
        inBand: false,
        cleanup: () => {},
      }
      // 起拖 = 闸住树形(判词在 `WorkbenchState.dragging` 上)。
      useWorkbenchStore.getState().setDragging(true)
      const onResize = () => {
        held.geometry = measureDropGeometry()
      }
      window.addEventListener('resize', onResize)
      held.cleanup = () => window.removeEventListener('resize', onResize)
      return { payload: held, ghost: specRef.current.ghost?.(ref) ?? ghostOf(ref) }
    },
    [],
  )

  const onMove = useCallback(
    (pointer: { x: number; y: number }, held: DragHeld, band: DragBandState) => {
      const inline = specRef.current.inline
      const wants = Boolean(inline) && band.phase === 'inside'
      if (wants && inline) {
        /*
         * **带内:整条交给来源**。浮影一个节点都不画(`inline`),落区高亮也不画
         * —— 换序的预示就是那几格 tab 自己在动,再盖一块高亮就是同一件事说两遍。
         *
         * 「进带」这一发看的是 `held.inBand` 的翻面,**不是** `band.entered`:
         * 起拖那一帧手指通常已经在自己那条条里(phase 是 inside,而「刚进来」
         * 恒 false —— 那一帧之前没有上一帧)。看跃迁标志会让抬起那一下整场不发生,
         * 表现是「按住 tab 横拖,什么都不动」。
         */
        if (!held.inBand) {
          held.inBand = true
          setDragPresentation('inline')
          inline.enter(pointer)
        }
        setDropFeedback(null)
        inline.move(pointer)
        return
      }
      // 出带:抬起收掉(来源那一格通常在这里折成 0 宽),浮影接手。
      if (held.inBand && inline) {
        held.inBand = false
        inline.leave()
      }
      setDragPresentation('ghost')
      /*
       * 规矩过一道 `rulesFor`:来源自己那一口 `accepts` 之外,再加上**那一种
       * 内容自述的 `regions`**(W5-b 裁定 8)。带内那一形不经过这里 —— 换序
       * 压根不换区域,没有区域可判。
       */
      const rules = rulesFor(held.ref, specRef.current.rules, held.geometry)
      const target = dropTargetAt(pointer, held.geometry, rules)
      held.target = target
      setDropFeedback(feedbackOf(target, held.geometry, pointer, t))
      specRef.current.onTarget?.(target)
    },
    [t],
  )

  const finish = useCallback((held?: DragHeld) => {
    held?.cleanup()
    rewire.current?.()
    rewire.current = null
    // 落定 / 取消都先开闸 —— 落定那条路自己要改树。
    useWorkbenchStore.getState().setDragging(false)
  }, [])

  const onDrop = useCallback(
    (pointer: { x: number; y: number }, held: DragHeld) => {
      const inline = specRef.current.inline
      const inBand = held.inBand
      finish(held)
      const target = held.target
      /*
       * 次序:**先让来源收拾自己画的东西,再落定**。空位与折起那一格都是这一场
       * 造出来的 DOM;落定会让 React 重排这条条的子节点,而那一刻不该还有一个
       * 外人插在里面(`ui/tab-reorder` 那段「树冻住所以插得安全」的判词,反过来
       * 就是「闸一开就得先收干净」)。
       */
      const settle = inBand ? inline?.drop(pointer) === true : false
      specRef.current.onEnd?.()
      if (settle) return
      if (specRef.current.onDrop?.(target, held.ref) === true) return
      dropRef(held.ref, target, { pointer })
    },
    [finish],
  )

  const onCancel = useCallback(
    (held: DragHeld) => {
      finish(held)
      specRef.current.onEnd?.()
    },
    [finish],
  )

  return useDragSource<DragHeld>({
    onStart,
    onMove,
    onDrop,
    onCancel,
    band: () => specRef.current.band?.() ?? null,
    bandSlack: specRef.current.bandSlack,
  })
}

/**
 * **「这一种开不到这里」那句拒绝,由 `ContentKind.regions` 生成**(W5-b 裁定 8)。
 *
 * W3 时这句话是**手写**的:会话行自己在 `rules.accepts` 里判「不是中央区就拒」,
 * 连理由文案(`drag.sessionOnlyCenter`,「会话多开在下一期」)都是那一处专用的。
 * 那是一处「按内容枚举」的判据 —— 而每一种内容能开在哪些区域**本来就写在它自己
 * 的自述上**(`ContentKind.regions`,`workbench/store.openRef` / `moveRef` /
 * `moveRefIntoLeaf` 三处早就在读它)。
 *
 * 于是这里把它接上:拖拽期间那句拒绝与落定时那道闸从此是同一条判据的两次读取,
 * 不可能分叉。会话那一种删掉 `regions` 之后自然全域解禁,而**将来任何一种**
 * 自述了 `regions` 的内容都白拿这句诚实的拒绝 —— 一行代码都不用写。
 *
 * 来源自己那一口 `accepts` **先问**(它可能有比区域更细的规矩),它放行才轮到这一条。
 */
function rulesFor(
  ref: ContentRef,
  rules: DropRules | undefined,
  geometry: DropGeometry,
): DropRules {
  const allowed = contentKindOf(ref.kind)?.regions
  if (!allowed) return rules ?? {}
  return {
    ...rules,
    accepts: (target) => rules?.accepts?.(target) ?? regionRefusal(target, allowed, geometry),
  }
}

function regionRefusal(
  target: DropTarget,
  allowed: readonly RegionId[],
  geometry: DropGeometry,
): MessageKey | null {
  const region = regionOfTarget(target, geometry)
  if (region === null) return null
  return allowed.includes(region) ? null : 'drag.regionRefused'
}

/**
 * 一个落点最终会把内容放进哪个区域。`refuse` 已经是拒绝,不必再问一次。
 *
 * **标签条那一支是 W3-b×W5-b 的合树接缝**:`strip` 这一种落点是 W3-b 才有的,
 * 它只带 `leafId` 不带区域 —— 而「插到那条条的第 n 格」最终就是把这一格放进
 * 那片叶所在的区域(`drop-commit.dropIntoStrip` → `store.moveRefIntoLeaf`,
 * 那一只自己也读 `kind.regions`,不合格就**一声不响地什么都不做**)。
 * 不在这里补上,拖拽期间那句诚实的拒绝就会漏掉一整类落点,而漏掉的下场正是
 * 「松手了,没反应,也没人说为什么」—— 裁定 8 要杀的就是这个。
 * 叶的区域从起拖时量好的那份几何里查(`leaves` 每一格都自带 `region`)。
 */
function regionOfTarget(target: DropTarget, geometry: DropGeometry): RegionId | null {
  if (target.kind === 'leaf') return target.region
  if (target.kind === 'strip') {
    return geometry.leaves.find((leaf) => leaf.leafId === target.leafId)?.region ?? null
  }
  if (target.kind === 'edge') return edgeRegion(target.side)
  // 撕成浮窗:窗号是落定那一刻才铸的,所以这里问的是「浮窗**这一类**收不收」。
  if (target.kind === 'float') return floatRegion('*')
  return null
}

/** 浮影的缺省:名字与图标都问种类表(拖拽因此不认识任何一种内容)。 */
function ghostOf(ref: ContentRef): DragGhostSpec {
  const kind = contentKindOf(ref.kind)
  return { label: kind?.title(ref).text ?? ref.key, icon: kind?.icon(ref) }
}

/**
 * 一个落点该怎么画(W3-b 裁定 7:**落点反馈改轻**)。
 *
 * 五种形,一张表:
 *   标签条  **不画高亮**(`rect: null`)—— 预示是那条条自己腾出来的一格空位
 *   叶身    `ring`:叶的四边描一圈细环,里面一个像素都不盖,**也不写字**
 *   叶四带  `bar`:贴那条边的一根 4px 杠(矩形由 `zoneRectOf` 算,与判据同一块)
 *   窗口边带 `film`:一层薄膜 + 一句话(架子会长在那儿,薄膜正是它的预示)
 *   撕浮窗  `outline`:那扇窗将来的轮廓(`floatRectForGrab` —— 与从架子上撕一块瓦、
 *           与落定时那一句**同一只函数**,所以预示的位置就是松手后窗子真正的位置)
 *   拒绝    不画高亮,只让浮影变灰,并且**必须带一句理由**(裁定 7)
 *
 * 「叶上不写字」这一句是用户原话的直译:那句话盖在正在读的内容上。它去哪儿了?
 * 哪儿也没去 —— 环与杠自己就说清了「并入」还是「在这一侧切」,一句话是第三遍。
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
  if (target.kind === 'strip') {
    return { rect: null, tone: 'accept' as const }
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
      shape: 'outline' as const,
    }
  }
  const rect = targetRectOf(target, geometry)
  if (target.kind === 'edge') {
    return { rect, tone: 'accept' as const, label: t(EDGE_LABEL[target.side]), shape: 'film' as const }
  }
  return { rect, tone: 'accept' as const, shape: target.zone === 'center' ? ('ring' as const) : ('bar' as const) }
}

/** 四条边各一句话。**一张表**,不是四处 if。 */
const EDGE_LABEL: Readonly<Record<'left' | 'right' | 'top' | 'bottom', MessageKey>> = {
  left: 'drag.toEdgeLeft',
  right: 'drag.toEdgeRight',
  top: 'drag.toEdgeTop',
  bottom: 'drag.toEdgeBottom',
}
