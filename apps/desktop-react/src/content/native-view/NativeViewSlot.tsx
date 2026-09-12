import { useCallback, useEffect, useRef, useState } from 'react'
import { focusTree } from '../../focus/registry'
import { useFocusScope } from '../../focus/useFocusScope'
import { dispatchSyntheticKey } from '../../focus/dispatch'
import { nativeViewBridge } from '../../data/browser-port'
import { useStageStore } from '../../stage/store'
import { useWorkbenchStore } from '../../workbench/store'
import { startNativeViewKeymapDownlink } from './keymap-downlink'
import s from './NativeViewSlot.module.css'
import type { MutableRefObject } from 'react'
import type { FocusScopeId } from '../../focus/types'
import type { NativeViewBounds, NativeViewPush } from '../../data/browser-port'

/**
 * **一片原生视图在壳里的占位格**(B2,方案 §2.2-4)。
 *
 * ── 它**不认识浏览器** ──────────────────────────────────────────────────
 * 它回答的问题是「我这片地此刻的矩形、显隐、堆叠序是多少」,而答得上这句话的
 * 将来有好几种视图(方案 §7 演练乙的 PDF 阅读器是第一个排队的)。所以这只文件
 * 里没有一个 tab、url、导航的字:它收一个 `viewId` 与一个作用域名,别的都由那
 * 条通道的词汇表(`electron/native-view-protocol.ts`)说。第二种原生视图不会长
 * 出第二只占位格,也不会长出第二条 IPC —— 它只会多几个 id。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ② UI 生命状态(这块地此刻画的是什么)
 * ══════════════════════════════════════════════════════════════════════════
 * | 态 | 判据 | 屏幕上 |
 * | --- | --- | --- |
 * | 无宿主 | `nativeViewBridge()` 缺席(`--mode web`) | 这只组件根本不渲染(调用方先问,见 `BrowserLeaf`) |
 * | 空 | 还没报过帧 / 主进程还没建视图 | 一块底色。**不画骨架、不转圈** —— 那一瞬要出现的是一页网页,而网页本来就是从白开始的 |
 * | 活 | 报过 `visible: true` 的帧 | 原生视图压在这块地上(DOM 这一侧永远是空的) |
 * | 被遮 | 三判据之一命中 | 主进程推来的那张快照铺满;没收到图就仍然是底色 |
 * | 隐藏 | 容器尺寸为 0(切走 tab / `content-visibility` 隐藏层) | 视图 `setVisible(false)`,DOM 这一格照旧在树上 |
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ③ 交互状态
 * ══════════════════════════════════════════════════════════════════════════
 * | 交互 | 这一侧做什么 |
 * | --- | --- |
 * | 树把焦点交给这块地 | 占位格 DOM `focus` → 发 `focus` 动词 → 主进程 `webContents.focus()` |
 * | 页面自己拿到焦点 | 主进程推 `focus` → `activate()` 这一格作用域(I1:activeElement = 占位格,视图是它的「里面」) |
 * | 页面失去焦点 | 推 `blur` → **什么都不做**(焦点去哪由那一边决定,抢回来只会打架) |
 * | 页面里按下一个保留键 | 主进程 `preventDefault` + 推 `key` → `dispatchSyntheticKey` → 壳里**唯一那个派发器** |
 * | 拖拽 / 弹层 / 浮窗盖上来 | 发 `occlude` → 收 `snapshot` → 铺图;走了发 `unocclude` |
 *
 * ── `visible` 与「被遮」是**两格,不是一格** ─────────────────────────────
 * 派工单那一行写的是「`visible` = 容器可见 ∧ 未被遮」。这里**没有**把它们并起来,
 * 而这是一次有理由的偏差:
 *  ① 主进程那边本来就是两格(`layout.ts` 的 `applyVisibility` = `visible &&
 *     !occluded`),并进来等于同一个判据算两遍;
 *  ② 更要命的是**惰性视图**:`electron/browser/index.ts` 的帧处理器第一句是
 *     `if (frame.visible) service.materialize(viewId)` —— 一格「生下来就被遮」的
 *     tab(开的时候正好有一扇浮窗压在上面)如果 `visible` 恒 false,视图**永远建
 *     不出来**,于是也永远拍不到快照,人看见的是一块底色而不是一张图。
 * 所以这一侧:`visible` 只说「容器看不看得见」,遮挡走它自己那两个动词。
 *
 * ── 单位:DIP = CSS px(方案 §9-10)────────────────────────────────────────
 * `setBounds` 收 DIP,`getBoundingClientRect` 给 CSS px;两者相等的前提是**渲染
 * 进程缩放因子为 1** —— 今天壳里零处 `setZoomFactor`(核过)。将来谁加 ⌘+/− 缩放,
 * 要在**这一侧**乘回去:主进程收到的永远是 DIP。
 *
 * ── 遮挡的三条判据(方案 §9-11)──────────────────────────────────────────
 *  ① 压在这片地**上面**的浮窗与它相交。「上面」是硬的:一片长在浮窗里的视图,
 *     它自己那扇窗的矩形当然与它相交 —— 不比名次的话它会把自己永远遮住;
 *  ② `focus/registry` 里挂着 `kind: 'float' | 'modal'` 的作用域(菜单 / 弹层 /
 *     命令面板 / 对话框 / 提示条)。原生视图永远压在 DOM 之上,这一族一旦开着
 *     就会被它盖回去;
 *  ③ 拼贴树的 `dragging`。
 * 三者之一 → `occlude`;全不命中 → `unocclude`。
 */

/** 一次量出来的帧。与协议里 `verb:'frame'` 那一条逐格对应。 */
interface Frame {
  bounds: NativeViewBounds
  visible: boolean
  z: number
}

function sameFrame(a: Frame | null, b: Frame): boolean {
  return (
    a !== null &&
    a.visible === b.visible &&
    a.z === b.z &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  )
}

/**
 * 这块地坐在哪个区域里。**从 DOM 上读**(`data-pane-region`,中央区 / 四条边 /
 * 每扇浮窗各自戴着它),而不是让调用方把区域当 prop 递进来:递进来的话每一种
 * 原生视图都得自己再算一遍同一件事,而这件事宿主自己已经写在树上了。
 */
function regionOf(el: HTMLElement): string {
  return el.closest<HTMLElement>('[data-pane-region]')?.dataset.paneRegion ?? ''
}

const FLOAT_PREFIX = 'float:'

/** 一扇浮窗此刻的名次(末位最上)。不在表里 = -1。 */
function floatRank(order: readonly string[], floatId: string): number {
  return order.indexOf(floatId)
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** 此刻树上挂着的浮层 / 模态作用域有几格(判据②)。 */
function overlayScopeCount(): number {
  let count = 0
  for (const node of focusTree.nodes().values()) {
    if ((node.kind === 'float' || node.kind === 'modal') && node.root && !node.inert) count += 1
  }
  return count
}

export interface NativeViewSlotProps {
  /** 主进程按它路由。浏览器那一侧就是 tab id。 */
  viewId: string
  /**
   * 这块地坐在哪个作用域里。键位下沉要它 —— **那个作用域的局部键也是保留键**
   * (浏览器的 ⌘L 得先于页面拿到)。
   */
  scope: FocusScopeId
  /** 把那个 DOM 节点交出去(调用方拿它当 `restingTarget`)。 */
  elementRef?: MutableRefObject<HTMLDivElement | null>
  className?: string
}

export function NativeViewSlot({ viewId, scope, elementRef, className }: NativeViewSlotProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const { activate } = useFocusScope()
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const [snapshotShown, setSnapshotShown] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const setHost = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el
      if (elementRef) elementRef.current = el
    },
    [elementRef],
  )

  /* ── 键位下沉:整壳一次,不是每片视图一次 ──────────────────────────── */
  useEffect(() => startNativeViewKeymapDownlink(scope), [scope])

  /* ── 帧与遮挡 ────────────────────────────────────────────────────────── */
  useEffect(() => {
    const bridge = nativeViewBridge()
    const host = hostRef.current
    if (!bridge || !host) return

    let lastFrame: Frame | null = null
    /*
     * **出厂就是「没被遮」**,不是「还不知道」。主进程那边新登记的一片视图
     * `occluded: false`(`layout.register`),所以一片刚挂上来、什么都没盖着的地
     * 报一句 `unocclude` 是在说一件对方已经知道的事 —— 它不会出错,但会让
     * 「发了几条」这个读数从此说不清,而那正是这只组件唯一好量的东西。
     */
    let lastOccluded = false
    /** 「撤图」那一帧的排期(见下面 `unocclude` 那一段)。 */
    let clearing = 0
    let scheduled = 0
    let disposed = false

    const measure = (): void => {
      scheduled = 0
      if (disposed || !host.isConnected) return
      const rect = host.getBoundingClientRect()
      const region = regionOf(host)
      const order = useStageStore.getState().floatOrder
      const myFloat = region.startsWith(FLOAT_PREFIX) ? region.slice(FLOAT_PREFIX.length) : null
      const myRank = myFloat ? floatRank(order, myFloat) : -1

      /*
       * 「看得见」= 这块地**真的占着面积**。`content-visibility: hidden` 的隐藏层
       * 里容器尺寸为 0(T1 的 9-9 是同一条),`display:none` 亦然 —— 一个判据同时
       * 管住两种藏法,不必逐种藏法各写一句。
       */
      const visible = rect.width > 0 && rect.height > 0
      const frame: Frame = {
        bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        visible,
        z: myRank >= 0 ? myRank + 1 : 0,
      }
      if (!sameFrame(lastFrame, frame)) {
        lastFrame = frame
        bridge.send({ verb: 'frame', viewId, ...frame })
      }

      // 判据①:压在**上面**的浮窗与我相交。名次从 DOM 上现读(拖窗那一段
      // store 里的矩形是落后的,而 `[data-float-body]` 的 rect 是活的)。
      let coveredByFloat = false
      if (visible) {
        for (const el of document.querySelectorAll<HTMLElement>('[data-float-body]')) {
          const floatId = el.dataset.floatBody ?? ''
          if (!floatId || floatId === myFloat) continue
          if (floatRank(order, floatId) <= myRank) continue
          if (intersects(rect, el.getBoundingClientRect())) {
            coveredByFloat = true
            break
          }
        }
      }
      const occluded =
        visible &&
        (coveredByFloat || overlayScopeCount() > 0 || useWorkbenchStore.getState().dragging)
      if (occluded !== lastOccluded) {
        lastOccluded = occluded
        bridge.send({ verb: occluded ? 'occlude' : 'unocclude', viewId })
        /*
         * **不再被遮 = 把图扔了**,而扔图这件事只有壳这一侧知道:主进程在
         * `unocclude` 上什么都不推(它只是让视图回来)。
         *
         * **扔晚一帧**:`unocclude` 这一发出去之后,主进程要在它自己那一拍
         * `setVisible(true)`,视图才重新画上来。这一侧当场把图撤掉的话,中间
         * 那一帧是空的 —— 真机上就是一下闪白。所以排下一帧再撤(反过来写,
         * 单测里那条「撤图要多留一帧」当场红)。
         */
        if (!occluded && !clearing) {
          clearing = requestAnimationFrame(() => {
            clearing = 0
            setSnapshot(null)
          })
        }
      }
    }

    /** rAF 合批:一帧至多量一次,量出来一样就不发(派工单原话)。 */
    const schedule = (): void => {
      if (disposed || scheduled) return
      scheduled = requestAnimationFrame(measure)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(host)

    /*
     * 拖拽期间逐帧跟:拖一扇浮窗 / 拉一条分隔线的时候,矩形是**别人**在改,
     * 我这只 ResizeObserver 与那几条 store 订阅都不会响(浮窗拖移走的是本地
     * state,跟手定律要求它不落 store)。所以按下就跟、松手就停 —— 一次有边界
     * 的轮询,而不是长开一条 rAF 链。
     */
    let chasing = 0
    const chase = (): void => {
      measure()
      chasing = requestAnimationFrame(chase)
    }
    const onPointerDown = (): void => {
      if (!chasing) chasing = requestAnimationFrame(chase)
    }
    const onPointerUp = (): void => {
      if (chasing) cancelAnimationFrame(chasing)
      chasing = 0
      schedule()
    }

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    /*
     * ui-consume-allow: float-handwritten — 这不是「点外关」。`ui/float` 的
     * `useFloatDismiss` 管的是「点到浮层外面就把它收起来」;这两发 pointer 监听
     * 一格都不关任何东西,它们是**跟手那一段的开关**:按下就逐帧量矩形、松手就停
     * (判词在上面 `chase` 那一段 —— 拖一扇浮窗时矩形是别人在改,ResizeObserver
     * 与那几条 store 订阅都不会响)。把它塞进 `useFloatDismiss` 拿不到这件事。
     */
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    const offStage = useStageStore.subscribe(schedule)
    const offWorkbench = useWorkbenchStore.subscribe(schedule)
    const offFocus = focusTree.subscribe(schedule)

    measure()

    return () => {
      disposed = true
      if (scheduled) cancelAnimationFrame(scheduled)
      if (clearing) cancelAnimationFrame(clearing)
      if (chasing) cancelAnimationFrame(chasing)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      offStage()
      offWorkbench()
      offFocus()
      /*
       * 摘掉这块地 = 告诉主进程「它不该再看得见了」。**不发 `close`** ——
       * 这一格在不在是数据面的事(`browser: do close`),占位格只管几何与显隐:
       * 拖到别的叶去只是换个宿主,视图一格都不该掉。
       */
      bridge.send({
        verb: 'frame',
        viewId,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        visible: false,
        z: 0,
      })
    }
    // `setSnapshot` 是 React 给的稳定口,不必进依赖表(进了这只 effect 就会跟着
    // 每一次快照重挂,而重挂 = 重新观察 + 重发一帧)。
  }, [viewId])

  /* ── 主进程推过来的四条 ──────────────────────────────────────────────── */
  useEffect(() => {
    const bridge = nativeViewBridge()
    if (!bridge) return
    return bridge.on((message: NativeViewPush) => {
      if (message.viewId !== viewId) return
      switch (message.kind) {
        case 'snapshot':
          setSnapshot(message.dataUrl)
          return
        case 'focus':
          // 页面自己拿到了键盘焦点 → 让树知道第一响应者换人了(I1 在这一格的
          // 读法:activeElement = 占位格,原生视图是它的「里面」)。
          activate('pointer')
          return
        case 'blur':
          // **什么都不做**。焦点去哪由那一边决定;抢回来只会与真正接手的那一格打架。
          return
        case 'key':
          dispatchSyntheticKey(message)
          return
      }
    })
  }, [viewId, activate])

  /*
   * 快照的显与隐。**次序是这一格的全部内容**:
   *  · 图到了 → `img.decode()` 落地 → **再等一帧** → 才显。抢在解码之前显,
   *    人看见的是一格白;
   *  · 盖的东西走了 → `unocclude` 先发出去(视图在主进程那一拍回来)→ **快照
   *    多留一帧** → 再撤(那一帧排在 `measure` 里,见上)。反过来的话中间那
   *    一帧是空的,真机上就是一下闪白。
   * 这一段的反证在单测里:把「撤图晚一帧」改成当场撤,那一条当场红。
   */
  useEffect(() => {
    if (snapshot === null) {
      // 图已经没了(上面那一帧把它撤了),显隐标记跟着归零。
      if (snapshotShown) setSnapshotShown(false)
      return
    }
    let raf = 0
    let cancelled = false
    const show = (): void => {
      if (cancelled) return
      raf = requestAnimationFrame(() => {
        if (!cancelled) setSnapshotShown(true)
      })
    }
    const img = imgRef.current
    const decoding = img?.decode?.()
    if (decoding) void decoding.then(show, show)
    else show()
    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
    }
  }, [snapshot, snapshotShown])

  return (
    <div
      ref={setHost}
      className={className ? `${className} ${s.slot}` : s.slot}
      data-native-view={viewId}
      data-native-view-snapshot={snapshotShown || undefined}
      /*
       * `tabIndex={-1}` —— 这块地是作用域的**落点**(`restingTarget`)。拿到
       * DOM 焦点就等于「树把键盘交给了里面那片视图」,所以顺手告诉主进程。
       */
      tabIndex={-1}
      onFocus={() => nativeViewBridge()?.send({ verb: 'focus', viewId })}
    >
      {snapshot !== null && (
        <img
          ref={imgRef}
          className={s.snapshot}
          src={snapshot}
          alt=""
          aria-hidden="true"
          data-testid="native-view-snapshot"
          hidden={!snapshotShown}
        />
      )}
    </div>
  )
}

