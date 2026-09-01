import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * **浮层的两件行为**,收成两个原语:怎么散(`useFloatDismiss`)、摆在哪
 * (`useFloatPosition`)。09-01「基础件先行」的落实 —— Menu 与 Popover 从前
 * 各自手写了逐字相同的三段(Esc 捕获相位关、点外关、开帧 clamp),
 * Tooltip 与 Select 又各自写了一份一次性的坐标快照。四份实现、四种缺陷面。
 *
 * 这只文件不认识任何业务,也不画一个像素:它只回答「什么时候散」和「摆哪儿」。
 *
 * ── 状态表 ────────────────────────────────────────────────────────────────
 * 生命周期:关(`active=false`,零监听)→ 开(装监听 + 首帧定位)
 *          → 跟随(仅 rect 档:锚点一动就重算)→ 关 / 卸载(全部拆掉,幂等)。
 * 交互:Esc 认领关、点外关、程序关(消费方自己 setState)三条路,同一个 `onClose`。
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * Esc 关 + 点外关。`active=false` 时一个监听都不装。
 *
 * ── Esc 走**捕获**相位,不是冒泡(08-31)──────────────────────────────
 * 光 preventDefault 不够。外壳那条退层链(components/useEscapeChain)也听
 * window,而它在**应用启动时**就挂上了,浮层是后来才开的 —— 同相位下注册序
 * 说了算,于是外壳先跑、先把浮层底下那块面收了,浮层这一手根本轮不上。
 * 08-31 报障「文件面板里开详情浮层,一下 Esc 两层一起关」正是这一条。
 *
 * 捕获相位的监听器永远跑在同一个 window 上的冒泡监听器之前,与谁先注册无关 ——
 * 于是「内层先退」成了结构保证。这条判例第一次立是在 StageOverlay 与
 * ExposeView 之间(那次还试过 queueMicrotask,同样失效)。
 * 点外关那条照旧冒泡:它与退层链没有次序纠纷。
 *
 * 关掉自己之后**认领这一下**(08-31 补):不认领的话同一下 Esc 会继续
 * 往外传,把浮层底下那块面一起收掉 —— 用户想退的只有一层。
 * 认领的说法就是 preventDefault:外壳那条退层链读的正是 defaultPrevented。
 * 这是「内层先退,退得动就把这一下吃掉」那条契约的内层半边。
 */
export function useFloatDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose()
    }
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [ref, onClose, active])
}

/** 摆法。`below-start` = 贴锚点下缘、左对齐;`above-center` = 锚点正上方居中。 */
export type FloatPlace = 'below-start' | 'above-center'

/**
 * 锚 —— 两档,差别是**它会不会动**。
 *
 * `point` 是一次性的坐标(右键菜单的光标处):那一下点在哪儿,它就在哪儿,
 * 页面滚了也不跟 —— 光标那个点本来就不属于页面里的任何东西。
 * `rect` 是一个活的矩形(触发器 / 锚元素):它属于页面,页面滚它就跟着走,
 * 所以浮层必须一起走,否则就与锚点脱开了。
 */
export type FloatAnchor =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'rect'; get: () => DOMRect | null; place: FloatPlace }

export interface FloatPosition {
  left: number
  top: number
  /** 只有 `above-center` 会翻:上方摆不下就翻到锚点下缘。 */
  flipped: boolean
}

export interface FloatPositionOptions {
  /** 浮层此刻在不在场。false = 零监听、位置不动。默认 true。 */
  active?: boolean
  /** 首帧兜底:`rect` 档的 getter 此刻答不出矩形时用它开局。 */
  fallback?: { left: number; top: number }
}

/**
 * 算一次位置。纯函数(除了读 window 的视口尺寸),好断言。
 * `w`/`h` 是浮层的身量 —— 还没量到的时候传 0,得到的就是「未 clamp 的理想位」。
 */
function place(anchor: FloatAnchor, w: number, h: number): FloatPosition | null {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (anchor.kind === 'point') {
    return {
      left: Math.max(0, Math.min(anchor.x, vw - w)),
      top: Math.max(0, Math.min(anchor.y, vh - h)),
      flipped: false,
    }
  }
  const r = anchor.get()
  if (!r) return null
  if (anchor.place === 'below-start') {
    return {
      left: Math.max(0, Math.min(r.left, vw - w)),
      top: Math.max(0, Math.min(r.bottom, vh - h)),
      flipped: false,
    }
  }
  /*
   * above-center 的 left 是**中线**(消费方的 CSS 用 translateX(-50%) 落地),
   * 所以夹的是中线,不是左缘 —— 按左缘夹会把一个居中的浮层夹歪半个身子。
   * 垂直方向不夹:它挂在锚点上缘之上,夹 top≥0 等于把它按回锚点头上。
   * 摆不下这件事由**翻转**回答,不由夹回答。
   */
  const flipped = r.top - h < 0
  const half = w / 2
  return {
    left: Math.max(half, Math.min(r.left + r.width / 2, vw - half)),
    top: flipped ? r.bottom : r.top,
    flipped,
  }
}

/**
 * 浮层摆在哪儿。返回值直接进 style。
 *
 * 三条纪律:
 *  ① **先画一帧、量到真身量后在同一帧内修正** —— useLayoutEffect 跑在浏览器
 *     绘制之前,所以用户看不到那个未 clamp 的中间态(Menu 从 08-31 起就是这么做的);
 *  ② **rect 档跟随**:scroll(**捕获**相位 —— 冒泡收不到内层滚动容器的 scroll,
 *     而浮层的锚点十有八九就长在某个内层滚动容器里)+ resize,rAF 合并成一帧一次;
 *     point 档只听 resize:光标那个点不属于页面,滚动时不该跟。
 *  ③ **getter 答不出矩形就原地不动**:锚点此刻量不到(正在卸载 / 还没挂上)是
 *     一种合法的中间态,归零位置会让浮层闪到左上角。
 */
export function useFloatPosition(
  floatRef: RefObject<HTMLElement | null>,
  anchor: FloatAnchor,
  opts: FloatPositionOptions = {},
): FloatPosition {
  const active = opts.active ?? true
  // 锚每帧都可能是个新对象字面量(getter 通常是就地闭包)。进依赖等于每帧重装
  // 监听,所以它走 ref;要不要重算由下面那枚 key 说了算。
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor

  const [pos, setPos] = useState<FloatPosition>(
    () =>
      place(anchor, 0, 0) ?? {
        left: opts.fallback?.left ?? 0,
        top: opts.fallback?.top ?? 0,
        flipped: false,
      },
  )

  // 「什么变了才要重算」:point 档是那对坐标,rect 档是摆法(矩形自己会变,
  // 但那是 scroll/resize 负责发现的事,不是 render 负责发现的)。
  const key = anchor.kind === 'point' ? `point:${anchor.x}:${anchor.y}` : `rect:${anchor.place}`

  const measure = useCallback(() => {
    const el = floatRef.current
    if (!el) return
    const next = place(anchorRef.current, el.offsetWidth, el.offsetHeight)
    if (!next) return
    // 同一个位置就交出同一个对象:scroll 一路上百次,位置没动就不该重渲染一次。
    setPos((prev) =>
      prev.left === next.left && prev.top === next.top && prev.flipped === next.flipped
        ? prev
        : next,
    )
  }, [floatRef])

  useLayoutEffect(() => {
    if (!active) return
    measure()
  }, [active, key, measure])

  useEffect(() => {
    if (!active) return
    const follows = anchorRef.current.kind === 'rect'
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }
    window.addEventListener('resize', schedule)
    if (follows) window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      if (follows) window.removeEventListener('scroll', schedule, true)
    }
  }, [active, key, measure])

  return pos
}
