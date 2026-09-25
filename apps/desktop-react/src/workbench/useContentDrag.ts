import { useCallback, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { setDragPresentation, setDropFeedback, useDragSource } from '../ui/drag'
import { useT } from '../i18n'
import { floatMinOfItem } from '../stage/items'
import { useLiveTitleStore } from '../stage/live-title'
import { panelIdOf } from '../stage/panel-ref'
import { defaultFloatRect, floatRectForGrab, FALLBACK_VIEWPORT } from '../stage/transitions'
import { dropRef } from './drop-commit'
import { stickyDropTargetAt, targetRectOf } from './drop'
import { measureDropGeometry } from './drop-geometry'
import { tabStripChoreo } from '../ui/tab-reorder'
import { contentKindOf, parseRefId, partsOfContent, refId } from './kinds'
import { edgeRegion, floatRegion } from './regions'
import { useWorkbenchStore } from './store'
import type { DragBandState, DragGhostSpec, DragRect } from '../ui/drag'
import type { TabStripChoreo } from '../ui/tab-reorder'
import type { DropGeometry, DropLive, DropRules, DropTarget } from './drop'
import type { ContentRef } from './kinds'
import type { RegionId } from './regions'
import type { MessageKey } from '../i18n'
import type { ShelfSide } from '../stage/types'
import type { SplitSide } from './tree'

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
  /**
   * **来源自己那条标签条是哪一片叶的**(U2,2026-09-08)。缺席 / 答 null =
   * 「我没有自己的条」,于是下面那条让路规则对这一次拖拽不成立(与 U2 之前逐字
   * 相同)。今天只有 tab 那一种来源答得出:它答 `leaf.id`。
   *
   * ── 它治的是什么:**自己的外扩带不许赢过别人的条** ──────────────────────
   * 带的上下外扩是 `TEAR_OFF_DISTANCE` 24(「离条这么近仍算在带里」)。顶栏那条
   * 标签条的 24px 下沿外扩**盖住了左右架子标签条的上半截** —— 架子檐从 y≈44 起,
   * 条 34px 高,两者在屏幕上就是叠着的。于是拖一格顶栏标签到架子条的上半截时,
   * 「自己的带」先判,这一帧被判成**回换序**,而用户看见的是指针明明压在架子那条
   * 条上、那条条却一动不动。
   *
   * 修法与 `drop.stripAt` 的 W7-c 那条「落在条上的赢过只是够得着的」是**一对**:
   * 那一条在条与条之间排序(先找真的含住这一点的,没有再找够得着的),这一条在
   * 「自己的带」与「别人的条」之间排同一个序 —— 指针**真的落在**(不算外扩)另一条
   * 条的矩形上时,自己的外扩这一帧让开,走统一那条路;`dropTargetAt` 的两遍扫描
   * 随后会把它判成那条条的 `strip`。两处是同一句话的两个方向,所以判词互相指认。
   */
  ownStripLeafId?(): string | null
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
   * **来源自己画着的那个落点在哪儿**(W6-b)。答一块矩形 = 卡片飞进它。
   *
   * 今天只有一种来源答得出:标签条那一格空位是 `ui/tab-reorder` 造的 DOM,
   * 判据这一头压根不知道它在哪(`targetRectOf` 对 `strip` 故意答 null)。
   * 缺席 / 答 null = 按落区那块矩形飞,没有落区就弹回来源。
   */
  landing?(): DragRect | null
  /**
   * 起拖阈值,直透 `ui/drag`。给一对数 = 两轴各一个门槛(标签横向 6 / 竖向 24,
   * 设计 v3 §4.2)。缺席 = `DRAG_START_PX` 8,与从前逐字相同。
   */
  threshold?: number | { x: number; y: number }
  /**
   * 这一场结束了(落定 / Esc / 指针没了,**三条路都叫**,在闸开之后、落定之前)。
   * 来源在这里收拾自己画过的东西。幂等 —— 它是「每条结束路径都先走它」的那一只。
   *
   * **`reason` 是 U2 加的**(2026-09-08):三条路收拾的东西一样,但**那一格来源
   * 怎么回去**不一样 —— 落定那条路它有新槽位可去(来源自己在 `inline.drop` 里
   * 排好了滑入),取消那两条路它要**滑回原位**。从前这里不分,于是取消 = 一摘
   * transform 的**瞬移**(设计 §4.2 写的是 150ms 滑回,真机探针读到 5ms 到家、
   * 连 `data-settle` 都没挂过)。分成两个理由码而不是加第二口回调:收拾这件事
   * 仍旧只有一处、仍旧幂等。
   *
   *   `drop`    松手落定(带内自己落定的那一形也算 —— 它先跑,见 `onDrop` 的次序)
   *   `cancel`  Esc / pointercancel / 窗口失焦,**三条都是它**
   */
  onEnd?(reason: 'drop' | 'cancel'): void
}

interface DragHeld {
  ref: ContentRef
  geometry: DropGeometry
  /**
   * 这一场的规矩(来源自述 + 种类自述 + 这一格拖的是谁),**起拖时算一次**。
   * 从前它每帧现算一遍 —— 那是三处 `find` 加一次闭包分配 × 每发 pointermove;
   * 而它答的是同一份东西(规矩在一场拖拽里不变,与几何同理)。
   */
  rules: DropRules
  target: DropTarget
  /** `target` 是判据交出来的,还是起拖时填的占位(占位不参与迟滞)。 */
  judged: boolean
  /**
   * 此刻是不是正走在「带内」那一形上。**存在这一格 payload 里而不是一个 ref**:
   * 它是这一场手势的一部分,与 `DragSession` 那条会话同生共死 —— 存在组件的 ref
   * 上就等于第二条会话,而那一条会在 Esc / pointercancel / 窗口失焦三条路上
   * 各漏一次归零。
   */
  inBand: boolean
  /**
   * **这一场画在某条标签条上的那格空位 / 那一圈**(W6-b:五种来源统一)。
   *
   * 它住在 payload 里而不是组件的 ref 上,与 `inBand` 同一条判词:它是这一场
   * 手势的一部分,与 `DragSession` 那条会话同生共死。W3-b 时这件事只有 tab 那一种
   * 来源做得到(它自己拿着编舞),于是**文件行 / 会话行 / 项目行 / Dock 瓦拖到
   * 标签条上时屏幕上什么都不出现** —— 判据答得好好的「插到第 3 位」,用户看不见。
   * 真机门当场量到:七站全是 `gapWidth: null`。搬到这一层之后五种来源一次全通。
   */
  strip: {
    leafId: string
    list: HTMLElement
    choreo: TabStripChoreo
    /** 那格空位此刻插在第几格、有多宽 —— 下一帧判据的 `DropLive.gap` 就是它。 */
    gap: { at: number; width: number } | null
  } | null
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
    (_event: PointerEvent, source: HTMLElement) => {
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
      const geometry = measureDropGeometry()
      const held: DragHeld = {
        ref,
        geometry,
        rules: rulesFor(ref, specRef.current.rules, geometry, source),
        target: { kind: 'float' },
        judged: false,
        inBand: false,
        strip: null,
        cleanup: () => {},
      }
      // 起拖 = 闸住树形(判词在 `WorkbenchState.dragging` 上)。
      useWorkbenchStore.getState().setDragging(true)
      const onResize = () => {
        held.geometry = measureDropGeometry()
        held.rules = rulesFor(ref, specRef.current.rules, held.geometry, source)
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
      /*
       * **带内那一形还要问一句:指针是不是真的落在别人那条条上**(U2)。
       * 判词整段在 `ContentDragSpec.ownStripLeafId` 上 —— 一句话:自己的外扩带
       * 不许赢过一条指针真的落在上面的条。
       */
      const wants =
        Boolean(inline)
        && band.phase === 'inside'
        && !onForeignStrip(pointer, held, specRef.current.ownStripLeafId?.() ?? null)
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
        /*
         * **进带那一发才写这三样,带内每一帧一个字都不写**(W6-b 真机门量出来的
         * 一条真 bug)。
         *
         * 病历:来源自己在「放到标签上」那一形把浮影切成 `hint` 档并交上那句
         * 「与 X 二合一」,而门一边微动一边读 —— 读到的 `hint` 恒为空。真因是
         * 这里每一帧都 `setDropFeedback(null)`:那一句被下一发 pointermove
         * **当场抹掉**,一个 24ms 的窗口谁也看不见。
         *
         * 修法不是「让来源再写一遍」(那是两个写者抢同一格),是**只在跃迁时写**
         * ——「进入换序」这件事发生一次,写一次;带内之后这三样归来源管
         * (它的 `leaveOnto()` 自己会把它们写回 inline / null)。
         *
         * 换序期间什么都不变色(§4.5 第 2 条):落区不画 —— 这一形拖的是条自己
         * 的一格,它挪到哪儿眼睛直接看得见。
         */
        if (!held.inBand) {
          held.inBand = true
          clearStrip(held)
          setDragPresentation('inline')
          setDropFeedback(null)
          inline.enter(pointer)
        }
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
      /*
       * **判据吃上一帧那格空位的位移**(U1,判词整段在 `drop.stripIndexAt` 上)。
       * 次序是「先按上一帧的空位判,再按这一帧的落点挪空位」—— 反过来的话判据
       * 读到的是它自己这一帧刚造出来的位移,那才是真会自激的一环。
       * `stripIndexAt` 是个幂等的夹取算子,所以这条环在同一个 x 上收敛,不来回。
       */
      /*
       * **带迟滞**(09-25,`drop.stickyDropTargetAt`):分界线上的一像素抖动不再换预示。
       * 第一帧(`judged === false`)没有「上一个」可留,照判据交。
       */
      const target = stickyDropTargetAt(
        pointer,
        held.judged ? held.target : null,
        held.geometry,
        held.rules,
        liveOf(held),
      )
      held.judged = true
      held.target = target
      setDropFeedback(feedbackOf(target, held.geometry, pointer, held.ref, t))
      paintStrip(held, target)
      specRef.current.onTarget?.(target)
    },
    [t],
  )

  const finish = useCallback((held?: DragHeld) => {
    if (held) clearStrip(held)
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
      specRef.current.onEnd?.('drop')
      if (settle) return
      if (specRef.current.onDrop?.(target, held.ref) === true) return
      dropRef(held.ref, target, { pointer })
    },
    [finish],
  )

  const onCancel = useCallback(
    (held: DragHeld) => {
      finish(held)
      specRef.current.onEnd?.('cancel')
    },
    [finish],
  )

  return useDragSource<DragHeld>({
    onStart,
    onMove,
    onDrop,
    onCancel,
    /**
     * **卡片飞去哪儿**(设计 v3 §5「落定卡片飞入空位」/「弹回」)。
     *
     * 三档,一张表:
     *   来源自己画着落点(条上那格空位)→ 飞进那格空位(`landing()` 由来源答);
     *   落区有矩形(并入 / 并排 / 边带)→ 飞进那块矩形;
     *   拒绝 / 放回 / 取消 → **弹回来源**(`source`)。
     * 条内换序答 null:那一形压根没有卡片,收笔是 `ui/tab-reorder` 的 FLIP。
     */
    landingRect: (held, source) => {
      if (held.inBand) return null
      const own = specRef.current.landing?.() ?? gapRectOf(held)
      if (own) return own
      const target = held.target
      if (target.kind === 'refuse' || target.kind === 'back') return source
      return targetRectOf(target, held.geometry) ?? source
    },
    band: () => specRef.current.band?.() ?? null,
    bandSlack: specRef.current.bandSlack,
    threshold: specRef.current.threshold,
  })
}

/**
 * **指针是不是真的落在「别人那条条」上**(U2,2026-09-08)。
 *
 * 「真的落在」= 不算任何外扩,矩形闭区间含住这一点;「别人的」= `leafId` 不是
 * 来源自述的那一条(`ContentDragSpec.ownStripLeafId`)。答 `true` 的那一帧,
 * 来源自己那条带让开,这一帧走统一那条路。
 *
 * ── 它是 `drop.stripAt` 那条两遍扫描的**对偶** ─────────────────────────────
 * 那一条排的是「条 vs 条」:先找真的含住这一点的,没有再找够得着的(W7-c,起因
 * 是顶栏标签改成从红绿灯右边起排之后与左架子那条条横向重叠了)。这一条排的是
 * 「自己的带 vs 别人的条」,判据逐字相同 —— **落在上面的赢过只是够得着的**。
 * 两条都不许用「把外扩改小」来躲:那是拿一个魔法数去躲另一个,而这两条带各自
 * 都有正当的理由(24 是撕下的门槛,同时也是「瞄准附近也算」)。
 *
 * 扫描按 DOM 逆序,与 `scanStrips` 同一条纪律(条重叠时靠后的盖在上面)——
 * 虽然这里只答一个布尔,序仍旧照着写:哪天它要答「是哪一条」,不必再改一次判据。
 *
 * 缺 `ownLeafId`(来源没有自己的条,如文件行 / 会话行 / Dock 瓦)= 这条规则对
 * 这一次拖拽不成立,恒答 false;它们本来就没有带,`band.phase` 恒 `outside`。
 */
function onForeignStrip(
  pointer: { x: number; y: number },
  held: DragHeld,
  ownLeafId: string | null,
): boolean {
  const strips = held.geometry.strips
  if (!strips || !ownLeafId) return false
  for (let i = strips.length - 1; i >= 0; i -= 1) {
    const box = strips[i]
    if (box.leafId === ownLeafId) continue
    const r = box.rect
    if (pointer.x < r.left || pointer.x > r.left + r.width) continue
    if (pointer.y < r.top || pointer.y > r.top + r.height) continue
    return true
  }
  return false
}

/**
 * **此刻活布局与那份基准差了什么**(U1)。今天只差那一格空位;它不在条上时
 * 交一个空对象 —— 判据于是逐字按基准算,与 U1 之前相同。
 */
function liveOf(held: DragHeld): DropLive {
  const strip = held.strip
  if (!strip?.gap) return {}
  return { gap: { leafId: strip.leafId, at: strip.gap.at, width: strip.gap.width } }
}

/**
 * **标签条上那一格空位**(W6-b:五种来源统一;U1 收成一档)。
 *
 * 一档,一句话:`strip` 那一档在目标条的第 `at` 格之前腾一个空位(宽照那条条上
 * 第一格的宽 ——「它落进来会占多少」问的是**目标条**的尺寸,不是卡片自己的);
 * 别的落点收掉。
 *
 * **同一个节点在挪**(§4.5 第 3 条):条换人才重造编舞,落点在同一条条上变来变去
 * 只是把那格空位 `insertBefore` 到别处 —— `tabStripChoreo.gapAt` 自己认这件事
 * (同下标当场 no-op,换下标只挪不重建,宽度不回 0)。
 *
 * ── U1 删掉的两档,以及为什么 ────────────────────────────────────────────
 * `pairTab`(那一格描一圈)整件没了 —— 从外面拖东西进来时条上只剩一种落点,
 * 判词在 `drop.ts` 的文件头。它一走,「空位与圈按 28% 线交替、每交替一次就
 * `clearGap()` + 重插」这条链在结构上就不存在了,那正是用户报的「拖到标签正中
 * 闪烁」。
 *
 * `open`(内容区中间那一档,从前也在条的末尾腾一格)也不在这里画了。它与设计
 * §5 那一行的后半句「标签条末尾腾空位」出入,记在交卷报里:今天落到内容区中间
 * 时屏幕上只有内容区那块板,条上一动不动 —— 一个落点画在**两处**正是这一批治的
 * 「同一件事说两遍」,而且空位只在「落点真的是条」时存在,`DropLive.gap` 那条
 * 回环因此只有一种解释。
 */
function paintStrip(held: DragHeld, target: DropTarget): void {
  if (target.kind !== 'strip') {
    clearStrip(held)
    return
  }
  const list = document.querySelector<HTMLElement>(
    `[data-pane-chrome="${CSS.escape(target.leafId)}"] [role="tablist"]`,
  )
  if (!list) {
    clearStrip(held)
    return
  }
  if (held.strip?.list !== list) {
    held.strip?.choreo.reset()
    held.strip = { leafId: target.leafId, list, choreo: tabStripChoreo(list), gap: null }
  }
  const sample = list.querySelector<HTMLElement>('[data-tab-id]')
  const width = sample?.getBoundingClientRect().width ?? 0
  held.strip.choreo.gapAt(target.at, width)
  held.strip.gap = { at: target.at, width }
}

/** 收掉这一层画在条上的东西。幂等 —— 每条结束路径与「进带」那一发都走它。 */
function clearStrip(held: DragHeld): void {
  held.strip?.choreo.reset()
  held.strip = null
}

/** 那格空位此刻的矩形(卡片飞进去的落点)。 */
function gapRectOf(held: DragHeld): DragRect | null {
  const rect = held.strip?.choreo.gapRect() ?? null
  if (!rect) return null
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
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
  source: HTMLElement,
): DropRules {
  const allowed = contentKindOf(ref.kind)?.regions
  const base: DropRules = {
    ...rules,
    /*
     * **这一格自述两件事**(W6-b):它的 id、它装了几份。判据用前者答「拖回自己
     * 身上不算一次并」,用后者答「两格的标签不能再并」——两条都不必认识
     * `pair` 这四个字母(判词在 `drop.DropRules.dragged` 上)。
     * 「几份」问的是**种类自述的复合表**(`ContentKind.composite.parts`),
     * 所以下一种复合内容出现时这一行照旧成立。
     */
    dragged: { id: refId(ref), slots: partsOfContent(ref)?.length ?? 1 },
    /*
     * **浮窗不接住自己**(设计 v3 §8)。判据是「**这一下是从哪儿按下去的**」,
     * 不是「这一格内容此刻住在哪儿」—— 后者第一版写过,真机门当场证伪:
     * 从会话总览那扇浮窗里拖一条会话行出来时,那条会话**根本没开在树上**
     * (它是列表里的一行),`regionOfRefIn` 答 undefined,于是一格都没挡住,
     * 落区就是那扇窗自己(读数:band 与 float 两个矩形逐数相同)。
     * 按下的那个元素是它唯一诚实的出处:行在哪扇窗里,那扇窗就是「自己」。
     */
    excludeLeaves: leavesOfSourceFloat(source, geometry),
  }
  if (!allowed) return base
  return {
    ...base,
    accepts: (target) => rules?.accepts?.(target) ?? regionRefusal(target, allowed, geometry),
  }
}

/**
 * **这一下是从哪扇浮窗里按下去的**,那扇窗里有哪几片叶(§8)。不在浮窗里就答
 * undefined ——
 * **一个空数组也不答**:`undefined` 与 `[]` 在 `excludeLeaves` 那一头行为相同,
 * 但前者在读 `rules` 的人眼里是「这次没有这条规矩」,后者像是「有,只是空的」。
 */
function leavesOfSourceFloat(
  source: HTMLElement,
  geometry: DropGeometry,
): readonly string[] | undefined {
  const region = source.closest('[data-pane-region]')?.getAttribute('data-pane-region') ?? null
  if (!region?.startsWith('float:')) return undefined
  const leaves = geometry.leaves.filter((leaf) => leaf.region === region).map((leaf) => leaf.leafId)
  return leaves.length > 0 ? leaves : undefined
}

function regionRefusal(
  target: DropTarget,
  allowed: readonly RegionId[],
  geometry: DropGeometry,
): MessageKey | null {
  const region = regionOfTarget(target, leafRegionIn(geometry))
  if (region === null) return null
  return allowed.includes(region) ? null : 'drag.regionRefused'
}

/**
 * **「这片叶住在哪个区域」的一种答法:问起拖时量的那份几何**(每一格 `leaves`
 * 都自带 `region`)。它与 store 那一只(`store.regionOfLeafIn`)在拖拽期间答的
 * 是同一份东西 —— 树被 `dragging` 那道闸冻住了 —— 差别只在**谁手上有**:
 * 这一层有几何,来源那一层(`useTabDrag`)只有 store。
 */
const leafRegionIn = (geometry: DropGeometry) => (leafId: string): RegionId | null =>
  geometry.leaves.find((leaf) => leaf.leafId === leafId)?.region ?? null

/**
 * 一个落点最终会把内容放进哪个区域。`refuse` 已经是拒绝,不必再问一次。
 *
 * ── 它为什么收一只 `leafRegion` 而不是那份几何(U3,2026-09-08)──────────────
 * 「落点 → 区域」这句话有了**第二个**读者:`useTabDrag` 的 `rules.accepts` 要拿它
 * 答「这一下会不会把内容带离本区域」,而那一层手上没有几何(它是**来源**,几何
 * 住在这一层的 payload 里)。同一句话写两遍就是两条会漂的判据 —— 所以把「叶住在
 * 哪个区域」抽成一只回调:这一层交几何那一份(`leafRegionIn`),来源那一层交
 * store 那一份(拖拽期间树冻着,两份逐字相同)。
 *
 * **标签条那一支是 W3-b×W5-b 的合树接缝**:`strip` 这一种落点是 W3-b 才有的,
 * 它只带 `leafId` 不带区域 —— 而「插到那条条的第 n 格」最终就是把这一格放进
 * 那片叶所在的区域(`drop-commit.dropIntoStrip` → `store.moveRefIntoLeaf`,
 * 那一只自己也读 `kind.regions`,不合格就**一声不响地什么都不做**)。
 * 不在这里补上,拖拽期间那句诚实的拒绝就会漏掉一整类落点,而漏掉的下场正是
 * 「松手了,没反应,也没人说为什么」—— 裁定 8 要杀的就是这个。
 * 叶的区域从起拖时量好的那份几何里查(`leaves` 每一格都自带 `region`)。
 */
export function regionOfTarget(
  target: DropTarget,
  leafRegion: (leafId: string) => RegionId | null,
): RegionId | null {
  if (target.kind === 'open' || target.kind === 'pair' || target.kind === 'split') {
    return target.region
  }
  if (target.kind === 'strip') {
    return leafRegion(target.leafId)
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
 * 一个落点该怎么画、下面那行字说什么(W6-b,设计 v3 §5 那张表的后两列)。
 *
 * 七种落点,一张表:
 *   标签条 `strip`      **不画高亮**(预示是那条条腾出来的一格空位),字 = 「放到第 n 位」
 *   窗口边带 `edge`     `film`:窗口那条轴 30% 的一层薄膜(新架子开出来就是这么厚,
 *                       薄膜正是它的预示),字 = 「钉成左侧架子」—— 只在那条边**还没有架子**时出现
 *   叶四边 `split`      `slab`:分屏之后新叶会占的那一半,字 = 「分屏到右侧」(09-24)
 *   `pair` / `open`     拖拽不再产生(菜单直接点名落定),这里保留它们的画法只为类型完整
 *   自己那片叶 `back`   不画,字 = 「松手放回」
 *   撕成浮窗 `float`    `outline`:那扇窗将来的轮廓(`floatRectForGrab` —— 与从架子上
 *                       撕一块瓦、与落定时那一句**同一只函数**,所以预示的位置就是
 *                       松手后窗子真正的位置)
 *   拒绝 `refuse`       不画高亮,字 = 那句理由(裁定 7:结构化拒绝,不静默)
 *
 * **每一档都有字,而且只有这一处有字**(§5 贯穿规则 2)。W3-b 时字写在落区上,
 * 于是叶身上那两档只好不写 —— 一句「这里能落」说三遍里有两遍盖住了正在读的内容。
 * 收进浮影下那一行之后,「说什么」与「画在哪」各只有一个产地。
 */
function feedbackOf(
  target: DropTarget,
  geometry: DropGeometry,
  pointer: { x: number; y: number },
  ref: ContentRef,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
) {
  if (target.kind === 'refuse') {
    return { rect: null, tone: 'refuse' as const, hint: t(target.reasonKey) }
  }
  if (target.kind === 'back') {
    return { rect: null, tone: 'accept' as const, hint: t('drag.hint.back') }
  }
  if (target.kind === 'strip') {
    /*
     * 标签那一档不画高亮 —— 预示是条自己腾出来的那一格空位。**内容自带头的那一档没有格可腾**
     * (U1-fix,2026-09-18):条上画的是那条头,悬停时屏幕上于是一点动静都没有,要松手之后
     * 才知道落不落得进。所以这一档改画一层薄膜盖住那条头 —— 与边带同一种板,说的是同一句
     * 「松手落在这条带上」。
     */
    const strip = geometry.strips?.find((box) => box.leafId === target.leafId)
    if (strip?.header) {
      return { rect: strip.rect, tone: 'accept' as const, shape: 'film' as const, hint: t('drag.hint.strip', { at: target.at + 1 }) }
    }
    return { rect: null, tone: 'accept' as const, hint: t('drag.hint.strip', { at: target.at + 1 }) }
  }
  if (target.kind === 'float') {
    const viewport =
      typeof window === 'undefined'
        ? FALLBACK_VIEWPORT
        : { w: window.innerWidth, h: window.innerHeight }
    /* 轮廓的身量与**落定那一句**逐字同源(`drop-commit` 的撕窗那一支):默认身量
     * 也要读一次那块内容自述的浮窗下限(W7-d 裁定 1)。两处不同源的下场是预示画
     * 640、松手落出 800 —— 预示就不再是预示。 */
    const rect = floatRectForGrab(
      pointer,
      defaultFloatRect(viewport, floatMinOfItem(panelIdOf(ref))),
      viewport,
    )
    return {
      rect: { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
      tone: 'accept' as const,
      hint: t('drag.hint.float'),
      shape: 'outline' as const,
    }
  }
  const rect = targetRectOf(target, geometry)
  if (target.kind === 'edge') {
    return { rect, tone: 'accept' as const, hint: t(EDGE_HINT[target.side]), shape: 'film' as const }
  }
  if (target.kind === 'split') {
    return { rect, tone: 'accept' as const, hint: t(SPLIT_HINT[target.side]), shape: 'slab' as const }
  }
  if (target.kind === 'pair') {
    const strip = geometry.strips?.find((row) => row.leafId === target.leafId)
    const host = strip && strip.activeAt >= 0 ? (strip.tabs[strip.activeAt] ?? null) : null
    return { rect, tone: 'accept' as const, hint: pairHint(host, target.side, t), shape: 'slab' as const }
  }
  return { rect, tone: 'accept' as const, hint: t('drag.hint.open'), shape: 'slab' as const }
}

/** 一格标签的名字 —— 提示行要说「与**谁**二合一」,而名字只有活的那一份算数。 */
function tabTitle(id: string | undefined): string {
  if (!id) return ''
  const live = useLiveTitleStore.getState().titles[id]
  if (live?.text) return live.text
  const parsed = parseRefId(id)
  const still = parsed ? contentKindOf(parsed.kind)?.title(parsed) : null
  return still?.text ?? parsed?.key ?? id
}

/**
 * 「与「X」二合一」还是「替换「X」」—— 判据是 **host 装了几份**:
 * 一格 = 并进去(两格都留着);两格 = 那一侧被换下来(它不消失,落在后面成为一格
 * 普通标签,判词在 `store.pairRefs` 上),所以字说的是「替换」。
 */
function pairHint(
  host: { id: string; slots: number } | null,
  side: 'left' | 'right',
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (!host) return t('drag.hint.open')
  const name = tabTitle(host.id)
  if (host.slots > 1) {
    return t(side === 'left' ? 'drag.hint.replaceLeft' : 'drag.hint.replaceRight', { name })
  }
  return t(side === 'left' ? 'drag.hint.pairLeft' : 'drag.hint.pairRight', { name })
}

/** 分屏带四侧各一句话。 */
const SPLIT_HINT: Readonly<Record<SplitSide, MessageKey>> = {
  left: 'drag.hint.splitLeft',
  right: 'drag.hint.splitRight',
  top: 'drag.hint.splitTop',
  bottom: 'drag.hint.splitBottom',
}

/** 三条边各一句话。**一张表**,不是三处 if。 */
const EDGE_HINT: Readonly<Record<ShelfSide, MessageKey>> = {
  left: 'drag.hint.edgeLeft',
  right: 'drag.hint.edgeRight',
  bottom: 'drag.hint.edgeBottom',
}
