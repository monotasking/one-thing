import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { focusTree } from '../../focus/registry'
import { DRAG_START_PX } from './constants'

/** 拖拽进行中挂在根上的那一格属性;消费者只有 `styles/global.css` 那条 `user-select` 规则。 */
const DRAG_ACTIVE_ATTR = 'data-drag-active'

/**
 * **一次拖拽的会话**(W3,设计 `apps/desktop-react/docs/workbench-2026-09.md` §3)。
 *
 * ── 它为什么住在 `ui/` 而不是 `components/` ──────────────────────────────
 * 「浮影」是这台壳里第一次出现的**拖替身**,而 CLAUDE.md 那条「基础件先行」
 * 的判据是一句话:动手写任何交互行为之前先查 `src/ui/` —— 没有就**先立件入库
 * 再消费**,禁止在业务面就地手写。`components/snap-hint.ts` 是同类瞬态的先例,
 * 但它长在 components 下,于是没人能消费它;这一件从第一天起就在库里。
 *
 * ── 它不认识拼贴台 ──────────────────────────────────────────────────────
 * 载荷是 `unknown`:谁起的拖谁知道那是什么。这只文件里 grep `workbench` /
 * `region` / `leaf` / `panel` 零命中,所以「加一种能拖的东西」不会到达这里。
 * 它只回答四件事:**这一下算不算在拖**、**指针在哪**、**浮影画什么**、
 * **松手 / 取消了**。
 *
 * ── 指针自绘,不是 HTML5 DnD(裁定 1)────────────────────────────────────
 * 全仓内部拖拽 100% 是 pointer capture(`ui/Splitter`、`EdgeShelf` 的厚度杆、
 * `FloatWindow` 的标题栏),唯一的 HTML5 DnD 是 Composer 接收**系统**文件 ——
 * 两者不混。理由是可测:CDP 的 `Input.dispatchMouseEvent` 派得出真 pointer 事件,
 * 派不出一次系统级的 dragstart。
 *
 * ── Esc 走响应链的瞬态口,禁 window listener(裁定 8 / 不变量 I2)──────────
 * `keydown` 监听全仓只许住在 `src/focus/`。拖拽中的 Esc 因此登记成一格
 * **瞬态 Esc 口**(`focusTree.registerTransient`,与 `ui/Tooltip` /
 * `ui/inline-edit` 同一口):起拖时登记、结束时注销,由那唯一的派发器在问活动
 * 路径之前先问到它。它答 `true`(拖拽中的 Esc 是明确的「取消这一下」,该吃掉),
 * 与 tooltip 那一族答 false 不同。
 *
 * ── 三张状态表 ①:生命周期 ───────────────────────────────────────────────
 *   按下      记起点、抢指针 capture、装三条元素级监听。**还不是一次拖拽**
 *             (`current()` 仍是 null,浮影不画,一次没动的按下松开是普通点击)
 *   起拖      指针走过 `DRAG_START_PX` 的那一帧:`onStart` 说得出载荷才真开始
 *             (答 null = 这一下不许拖,整场作废,后续与普通点击逐字相同)
 *   跟随      每一发 pointermove 写一次指针坐标 + 一次 `onMove` 回调;
 *             消费方在回调里算落点,再用 `setDropFeedback` 把结论交回来
 *   落定      pointerup:先注销一切,再叫 `onDrop`(次序即语义 —— 落定动作会
 *             改树,而那时不该还有一格活着的拖拽态)
 *   取消      pointercancel / window blur / Esc:同一只 `cancel()`,幂等
 *   卸载      来源行**不会**在拖拽中卸载(树 / 面常驻铁律),但 capture 掉了也
 *             无妨:监听挂在元素上,丢 capture 最多丢「指针滑出元素后的帧」
 *
 * ── ②:UI 生命状态 ───────────────────────────────────────────────────────
 *   idle      `useDragState()` 答 null —— `DragLayer` / `DropOverlay` 一个 DOM
 *             节点都不画(不是画一个透明的)
 *   dragging  有 `ghost`(图标 + 名)与 `pointer`
 *   条内       `presentation === 'inline'`:**浮影一个节点都不画** —— 拖着的那个
 *             东西是来源自己(W3-b 裁定 4/5)
 *   有落点    `drop` 非 null:`DropOverlay` 按 `drop.shape` 画那一块
 *   拒绝      `drop.tone === 'refuse'`:浮影变灰 + 一句理由(叶身上不再写字)
 *
 * ── ③:UI 交互状态 ───────────────────────────────────────────────────────
 * 浮影**没有交互状态** —— 它 `pointer-events: none`,鼠标穿过去落在底下那块面上
 * (落点判定要的正是「指针底下是什么」)。所以 rest / hover / focus / active
 * 这一列在这件上恒为空,这是它的设计而不是遗漏。
 */

/** 浮影上画什么。图标是 `components/icons` 的名字(与 `TabSpec.icon` 同一种)。 */
export interface DragGhostSpec {
  icon?: string
  label: string
}

/**
 * **高亮长什么样**(W3-b 裁定 7:落点反馈改轻)。
 *
 * 四档,一个开放的枚举而不是几个布尔 —— 「铺一层膜」「描一圈环」「画一根杠」
 * 「画一圈虚线轮廓」是**互斥**的四种画法,两个布尔表达不了互斥。
 *
 *   `film`     一层薄膜 + 一圈实线(窗口边带那一档,W3 的原样)
 *   `ring`     只在那块矩形里描一圈细环,里面什么都不画 —— **并入一片叶**
 *              (用户原话:色块 + 边框 + 文字盖在内容上太重)
 *   `bar`      那块矩形本身就是一根 4px 的实心杠 —— **在这一侧分屏**
 *   `outline`  一圈虚线轮廓、里面是空的 —— 撕成浮窗时那扇窗的预示
 */
export type DropShape = 'film' | 'ring' | 'bar' | 'outline'

/** 落点反馈:消费方每一帧算出来交回来的那一句结论。 */
export interface DropFeedback {
  /**
   * 要高亮的那块矩形(视口坐标)。null = 这一帧没有可指的落区(比如落在一条
   * 标签条上 —— 那一档的预示是**条自己腾出来的空位**,不是盖一块高亮),
   * 此时只有浮影在动。
   */
  rect: { left: number; top: number; width: number; height: number } | null
  /** `accept` = 松手会发生点什么;`refuse` = 松手什么都不会发生。 */
  tone: 'accept' | 'refuse'
  /**
   * 一句人话。拒绝时**必须**给(裁定 7:结构化拒绝,不静默);接受时**只有
   * 窗口边带与撕浮窗给** —— 叶身上不再写字(W3-b 裁定 7:那句话盖在内容上)。
   */
  label?: string
  /** 画法。缺席 = `film`(W3 的那一档,窗口边带还在用)。 */
  shape?: DropShape
}

/**
 * **这一帧「拖着的那个东西」画在哪儿**(W3-b 裁定 4/5)。
 *
 *   `ghost`   一枚浮影跟着指针 —— 来源那一头原地不动(或折起来)
 *   `inline`  **来源自己在动**(条内换序:那一格 tab 被抬起来横向跟手),
 *             此时浮影**一个节点都不画** —— 屏幕上同时有两个「拖着的东西」
 *             正是用户报的那句「手按着 tab,动的却是旁边一枚芯片」
 *
 * 它是一格**画法**,不是一格业务事实:`ui/drag` 仍旧不认识 tab、不认识条。
 */
export type DragPresentation = 'ghost' | 'inline'

export interface DragSessionState {
  payload: unknown
  ghost: DragGhostSpec
  pointer: { x: number; y: number }
  drop: DropFeedback | null
  presentation: DragPresentation
}

/*
 * ── 模块级瞬态,三行订阅(照 `components/snap-hint.ts` 的形,但住在 ui/)──────
 * 它有多个生产者(五种来源)与多个消费者(`DragLayer` / `DropOverlay`),所以
 * 不能是某个组件的私有 state;它活不过松手那一刻,所以也不该是一个 persist 的
 * store —— 存进去等于让持久化与形态不变式都为它多担一份心。
 */
let current: DragSessionState | null = null
const subscribers = new Set<() => void>()

function emit(next: DragSessionState | null): void {
  current = next
  for (const notify of subscribers) notify()
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  return () => {
    subscribers.delete(notify)
  }
}

/** 服务端快照恒为 null:拖拽只在有指针的地方存在(与 `useSnapSide` 同一句)。 */
export function useDragState(): DragSessionState | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  )
}

/**
 * 把这一帧的落点结论交回来。**只有正在拖的时候才写得动** —— 松手之后来的那一发
 * (比如一次迟到的 rAF)什么都不做,不会凭空造出一格拖拽态。
 */
export function setDropFeedback(drop: DropFeedback | null): void {
  if (!current) return
  if (sameFeedback(current.drop, drop)) return
  emit({ ...current, drop })
}

/**
 * 这一帧「拖着的东西」画在哪儿。与 `setDropFeedback` 同一条纪律:**只有正在拖的
 * 时候才写得动**,而且同值不惊动订阅者(条内换序时它每帧都被写成同一个值)。
 */
export function setDragPresentation(presentation: DragPresentation): void {
  if (!current) return
  if (current.presentation === presentation) return
  emit({ ...current, presentation })
}

function sameFeedback(a: DropFeedback | null, b: DropFeedback | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.tone !== b.tone || a.label !== b.label || a.shape !== b.shape) return false
  if (a.rect === b.rect) return true
  if (!a.rect || !b.rect) return false
  return (
    a.rect.left === b.rect.left
    && a.rect.top === b.rect.top
    && a.rect.width === b.rect.width
    && a.rect.height === b.rect.height
  )
}

/**
 * **「带」**(W3-b 裁定 5)—— 一次手势里那块「还没离开原位」的区域。
 *
 * 它是这一件里唯一一格**与来源有关的几何**,而且仍旧不认识来源是什么:交回来一块
 * 矩形,这一层每帧只回答三个字 —— 在里面 / 在外面 / 刚出来。tab 条拿它区分
 * 「条内换序」与「撕下来」;别的来源不给这一格,于是恒在外面,行为与 W3 逐字相同。
 *
 * ── 为什么它必须住在这一件里,而不是消费方自己每帧比一次 ────────────────
 * 「从 inside 到 outside 的**那一帧**」是一次状态跃迁,而跃迁只有拿得到上一帧
 * 的人算得出来。消费方自己存一格「上一帧在不在里面」,就等于**第二条会话**:
 * 它会在 Esc 取消、pointercancel、窗口失焦这三条路上各漏一次归零(裁定 5 的
 * 原话:一次手势一条 DragSession)。所以上一帧存在这里,与 `phase` 同寿。
 */
export interface DragBandState {
  /** 这一帧指针在不在带里。 */
  phase: 'inside' | 'outside'
  /** 这一帧是不是**刚**离开带(撕下就发生在这一帧)。 */
  left: boolean
  /** 这一帧是不是**刚**回到带里(折起来的那一格该展回来)。 */
  entered: boolean
}

export interface DragSourceSpec<T> {
  /**
   * 走过阈值的那一帧问一次:这一下拖的是什么、浮影画什么。
   * **答 null = 这一下不许拖**(整场作废,与一次普通点击逐字相同)。
   */
  onStart(e: PointerEvent): { payload: T; ghost: DragGhostSpec } | null
  /**
   * 这次拖拽的「带」此刻在哪儿(视口坐标)。缺席 / 答 null = 这一下没有带,
   * `onMove` 收到的 `band.phase` 恒为 `outside`。
   *
   * 每帧问一次而不是起拖时量一次:条会横滚、会因为邻居让位而重排,而「指针还在
   * 不在这条条上」问的正是**此刻**那块矩形。它读的是一个元素的 `getBoundingClientRect`
   * —— 每帧一次,和拖拽本来就有的那一次合成同一帧,不构成额外的强制排版链。
   */
  band?(): { top: number; bottom: number; left: number; right: number } | null
  /** 带的上下外扩:离带这么近仍算「在带内」。缺省 0。 */
  bandSlack?: number
  /** 每一发 pointermove。消费方在这里算落点并 `setDropFeedback`。 */
  onMove?(pointer: { x: number; y: number }, payload: T, band: DragBandState): void
  /** 松手。**在会话已经拆干净之后**才叫(见文件头生命周期表)。 */
  onDrop?(pointer: { x: number; y: number }, payload: T): void
  /** Esc / pointercancel / 窗口失焦。同样在拆干净之后叫。 */
  onCancel?(payload: T): void
  /** 起拖阈值。缺省 `DRAG_START_PX`;给 0 = 按下即拖(单测反证用)。 */
  threshold?: number
}

/**
 * 把一个元素变成拖拽来源。交回一口 `onPointerDown` —— 挂上去就完事,
 * 别的什么都不必做。
 *
 * `spec` 走 ref、不进依赖表:消费方每渲染一次那几只回调通常都是新闭包,进依赖
 * 等于每渲染重造一次 handler(与 `useFloatDismiss` 的 `closeRef` 同一条判据)。
 */
export function useDragSource<T>(spec: DragSourceSpec<T>): (e: ReactPointerEvent<Element>) => void {
  const specRef = useRef(spec)
  specRef.current = spec

  return useCallback((e: ReactPointerEvent<Element>) => {
    // 只认主键。右键要留给上下文菜单(「动作单产地 = 右键菜单」那条判例)。
    if (e.button !== 0) return
    const el = e.currentTarget
    if (!(el instanceof HTMLElement)) return
    const startX = e.clientX
    const startY = e.clientY
    const threshold = specRef.current.threshold ?? DRAG_START_PX
    let payload: T | null = null
    /**
     * 三态,不是一个布尔(`cancelled` 那一格是 09-05 真机门量出来的,见
     * `swallowNextClick` 的判词):
     *   idle       按下了,还没过阈值 —— 这一下随时可能只是一次普通点击
     *   dragging   在拖
     *   cancelled  Esc 取消了,**但手指还按着** —— 后面那一发 pointerup 与它
     *              带出来的 click 仍旧要被这一场吃掉,不能让它变成一次点击
     */
    let phase: 'idle' | 'dragging' | 'cancelled' = 'idle'
    let offEscape: (() => void) | null = null
    /** 上一帧在不在带里。见 `DragBandState` 的判词:跃迁只有拿得到上一帧的人算得出来。 */
    let inBand = false

    /** 指针在不在这一下的带里。没有带 = 恒在外面。 */
    const bandPhaseAt = (pointer: { x: number; y: number }): boolean => {
      const rect = specRef.current.band?.()
      if (!rect) return false
      const slack = specRef.current.bandSlack ?? 0
      return (
        pointer.x >= rect.left
        && pointer.x <= rect.right
        && pointer.y >= rect.top - slack
        && pointer.y <= rect.bottom + slack
      )
    }

    /** 拆干净。幂等 —— 每条结束路径都先走它。 */
    const teardown = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', abort)
      window.removeEventListener('blur', abort)
      offEscape?.()
      offEscape = null
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        /* 已经丢了就算了 —— 拆卸不该因为一次无害的失败中断 */
      }
      if (phase === 'dragging') emit(null)
      document.documentElement.removeAttribute(DRAG_ACTIVE_ATTR)
      phase = 'idle'
    }

    /**
     * **真拖过一次之后,把紧跟着的那一发 `click` 吃掉**(09-05 真机门当场抓到的
     * 一条真 bug,读数写在这里)。
     *
     * 病历:`gate:drag` 场景 5 —— 从会话总览里拖一行到窗口右边带(结构化拒绝),
     * 松手之后树**变了**:`float:sessions` 整格没了。真因不是落定那条路(拒绝是
     * 空动作),而是**浏览器补的那一下 click**:pointer capture 把 pointerdown 与
     * pointerup 都重定向到了那一行,于是两者的最近公共祖先就是那一行,click 照发
     * —— 那一下等于「点了这条会话」,`enterSession` 跟着把总览收了。
     * 同一条链在文件树行上是「拖一份文件顺手把它打开」,在 Dock 瓦上是
     * 「拖一块瓦顺手把它开关一次」。三处一个病。
     *
     * 修法是这套手势的**标准配方**:在 pointerup 那一刻往 window 的**捕获相位**
     * 挂一发一次性的 click 拦截,再用一拍宏任务把它摘掉 —— click 恒在同一串输入
     * 派发里紧跟 pointerup / mouseup 之后,而 `setTimeout(…, 0)` 排在那之后。
     * 没过阈值的那一次按下松开**不装**这一发,所以「点一下还是点一下」。
     *
     * 它是 `click` 不是 `keydown`,与不变量 I2 无关(那条管的是键盘)。
     */
    const swallowNextClick = (): void => {
      const swallow = (ev: Event): void => {
        ev.preventDefault()
        ev.stopPropagation()
        window.removeEventListener('click', swallow, true)
      }
      window.addEventListener('click', swallow, true)
      setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    }

    /**
     * Esc 取消:**手指还按着**,所以不能把 pointerup 那条监听一起拆掉 ——
     * 拆了的话那一发 pointerup 带出来的 click 就没人吃(见 `swallowNextClick`)。
     * 这一格与 `abort` 的分工就是这一句话:那一条是「指针没了」(pointercancel /
     * 窗口失焦),不会再有 click,可以整个拆干净。
     */
    const escapeCancel = (): void => {
      if (phase !== 'dragging') {
        teardown()
        return
      }
      const held = payload as T
      phase = 'cancelled'
      emit(null)
      offEscape?.()
      offEscape = null
      specRef.current.onCancel?.(held)
    }

    const move = (ev: PointerEvent): void => {
      if (phase === 'cancelled') return
      const pointer = { x: ev.clientX, y: ev.clientY }
      if (phase === 'idle') {
        if (Math.abs(pointer.x - startX) < threshold && Math.abs(pointer.y - startY) < threshold) {
          return
        }
        const opened = specRef.current.onStart(ev)
        if (!opened) {
          // 来源自己说「这一下不许拖」:整场作废,后面与普通点击逐字相同。
          teardown()
          return
        }
        payload = opened.payload
        phase = 'dragging'
        /*
         * 整页选区关掉(规则在 `styles/global.css` 的 `:root[data-drag-active]`,判词在
         * 那儿):按住横扫的缺省动作是拉选区,起拖这一刻 pointerdown 早过了,
         * `preventDefault` 来不及;阈值内已经拉出的那一小段也一并清掉。
         */
        document.documentElement.setAttribute(DRAG_ACTIVE_ATTR, '')
        document.getSelection()?.removeAllRanges()
        /*
         * **capture 也只在真的起拖之后才抢**(09-05 真机门 `gate:focus` 场景 12
         * 当场抓到的第二条真 bug,读数与判据都写在这里)。
         *
         * 病历:第一版在 `pointerdown` 里就 `setPointerCapture`,于是**兼容鼠标事件
         * 一并被重定向**(规范原话:compatibility mouse events 也 target 到 capture
         * 元素)—— `mousedown` / `mouseup` 双双落在外框 `.rowWrap` 上,浏览器算出的
         * `click` 目标就是那个 div 而不是里面那颗 `<button>`。表现:**单击文件树的
         * 一行不再打开文件**(gate:focus 场景 12 红:「单击开出了查看器」✗)。
         * 一次纯点击本来与拖拽无关,不该被拖拽改掉事件路由。
         *
         * 所以次序改成:**过了阈值 = 这一下确实是拖,才抢 capture**。抢之前那几个
         * 像素靠 window 上的监听收(pointer 事件会冒泡到 window),所以「按下之后
         * 手指飞快甩出这一行」也不会漏 —— 这正是监听挂在 window 而不是元素上的理由。
         */
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          /* 抢不到不阻断:监听在 window 上,最多丢「指针滑出这扇窗」的那几帧 */
        }
        /*
         * Esc 那一格**只在真的起拖之后**才登记 —— 没起拖时按 Esc 该归别人
         * (比如把浮层关掉),这一件不该在那时抢。
         */
        offEscape = focusTree.registerTransient(() => {
          escapeCancel()
          return true
        })
        emit({ payload: opened.payload, ghost: opened.ghost, pointer, drop: null, presentation: 'ghost' })
        /*
         * 起拖那一帧的带态:`entered` 恒 false —— 「刚进来」说的是一次跃迁,
         * 而这一帧之前压根没有「上一帧」。一格 tab 起拖时通常已经在自己的条里,
         * 消费方从 `phase === 'inside'` 就读得出来,不必再骗它有过一次跃迁。
         */
        inBand = bandPhaseAt(pointer)
        specRef.current.onMove?.(pointer, opened.payload, {
          phase: inBand ? 'inside' : 'outside',
          left: false,
          entered: false,
        })
        return
      }
      if (current) emit({ ...current, pointer })
      const was = inBand
      inBand = bandPhaseAt(pointer)
      specRef.current.onMove?.(pointer, payload as T, {
        phase: inBand ? 'inside' : 'outside',
        left: was && !inBand,
        entered: !was && inBand,
      })
    }

    const up = (ev: PointerEvent): void => {
      const was = phase
      if (was === 'idle') {
        // 一次没拖动的按下松开:整场没开始过,后面那一下 click 照常派给它。
        teardown()
        return
      }
      const held = payload as T
      const pointer = { x: ev.clientX, y: ev.clientY }
      // 次序即语义:先把这一格拖拽态拆干净,再落定 —— 落定会改树,
      // 那一刻不该还有一个活着的会话在别人的订阅里晃。
      teardown()
      swallowNextClick()
      if (was === 'dragging') specRef.current.onDrop?.(pointer, held)
    }

    /** 指针没了(pointercancel / 窗口失焦):不会再有 click,整个拆干净。 */
    const abort = (): void => {
      if (phase !== 'dragging') {
        teardown()
        return
      }
      const held = payload as T
      teardown()
      specRef.current.onCancel?.(held)
    }

    /*
     * **监听挂在 window,不挂在来源元素上**(见 `move` 里那段 capture 判词)。
     * 两个理由,缺一个都不成立:
     *  ① capture 要等过了阈值才抢(不抢的话一次纯点击的事件路由会被改掉),
     *    而在那之前指针可能已经飞出这一行 —— 挂元素上就收不到那几发 move 了;
     *  ② pointer 事件冒泡,所以 window 上一份监听把「在元素里」与「已经出去了」
     *    两种情形一并收下,没有第二条分支。
     * 抢到 capture 之后事件仍旧冒泡到 window,所以这一份监听全程管用。
     */
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', abort)
    // 窗口失焦 = 这一下拖拽作废(点了系统 Dock、切了应用)。它不是 keydown,
    // 与 I2 无关。
    window.addEventListener('blur', abort)
  }, [])
}

/** 只给单测与真机门:把这一格瞬态归零。产品代码不该调它。 */
export function resetDragSession(): void {
  emit(null)
}

/*
 * 模块级瞬态 = 这个模块实例的寿命,所以配一段 HMR 退役(CLAUDE.md 那条法)。
 * **复用已有的那一口拆卸**(`resetDragSession`),不写第二套;订阅表一并清掉 ——
 * 旧模块的订阅者还挂着的话,热更后会有两份浮影同时活着。
 * 幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetDragSession()
    subscribers.clear()
  })
}
