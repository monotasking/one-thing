import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/* ── 浮层栈:Esc 只退一层的产地(09-01 批 4)───────────────────────────────
 *
 * 病(0.5 复核发现):Dialog 与 Menu / Popover 都在 window 的**捕获**相位听 Esc。
 * 捕获相位解决的是「浮层 vs 外壳退层链」那一对(捕获永远先于冒泡),但**同相位
 * 之间**靠的仍是注册序 —— 先开的那个先收到。于是「对话框里开一张菜单」这个层叠
 * 场景里,一下 Esc 先被 Dialog 接走,菜单和对话框一起关。
 * 「用户想退的只有一层」那条契约在层叠场景下是破的。
 *
 * 修法不是给每个浮层加判据(谁在谁上面,浮层自己不知道),而是立一个**栈**:
 * 挂载入栈、卸载出栈,Esc 到来时**只有最上面那一层认领**(preventDefault + onClose),
 * 其余的监听器一个字不做。谁在最上面由 `topFloatLayer` 判 —— 两条判据(DOM 包含,
 * 平手看入栈序),理由写在那只函数上。
 *
 * 进栈的判据是「这个浮层认不认 Esc」:`escape: false` 档(Dialog 之外的另一头 ——
 * 自己另有 Esc 语义的消费方,如 composer)**不进栈**,也就不会挡住别人。
 * 点外关同样不进栈:那条路各浮层各自判「点没点在我身上」,互不干扰,没有次序问题。
 *
 * 与外壳退层链(components/useEscapeChain)的关系没有变:栈顶认领之后
 * `defaultPrevented` 为真,冒泡相位的退层链照旧让位;整个栈空了才轮到外壳。
 */

/** 栈里的一格。身份牌 + 它那块元素(判「谁套着谁」要用)。 */
interface FloatLayer {
  readonly ref: RefObject<HTMLElement | null>
}

const floatStack: FloatLayer[] = []

/** 入栈。 */
function pushFloatLayer(ref: RefObject<HTMLElement | null>): FloatLayer {
  const layer: FloatLayer = { ref }
  floatStack.push(layer)
  return layer
}

/**
 * 出栈。用 `lastIndexOf` 而不是 `pop`:卸载序不保证是入栈序的逆
 * (React 卸载一棵树时子在前、父在后,而两个平级浮层的卸载序由各自的 state 决定),
 * 按身份删才不会误伤别人那一格。幂等 —— 已经不在表上就什么都不做。
 */
function popFloatLayer(layer: FloatLayer): void {
  const at = floatStack.lastIndexOf(layer)
  if (at >= 0) floatStack.splice(at, 1)
}

/**
 * 谁在最上面。两条判据,**套着的先于后开的**:
 *
 *  ① **DOM 包含**:一层的元素长在另一层的元素里,里面那层就在上面。
 *  ② 平手时看**入栈序**:后开的在上面。
 *
 * 为什么不能只要②(这是第一版写法,当场被自己的用例逮住):入栈发生在 effect 里,
 * 而 React 的 effect **子先于父**跑 —— 同一次提交里一起挂载的父子两层,父反而
 * 后入栈、成了「栈顶」,层序整个倒过来。真机上层叠多半是先后开出来的
 * (要开内层那张菜单,得先有外层那张对话框),②答得对;但「一进来就是层叠」
 * 这一形(初次渲染时两层都在场)②答得反,所以要①兜。
 *
 * 为什么不能只要①:菜单 / 气泡多半是 portal 到 body 的,它与对话框面板在 DOM 上
 * 是**兄弟**,谁也不套着谁 —— ①在那一形上什么都答不出,得由②说话。
 *
 * 元素此刻量不到(还没挂上 / 正在卸载)按「谁也不套着它」算,即退回②。
 */
function topFloatLayer(): FloatLayer | null {
  let top: FloatLayer | null = null
  let topDepth = -1
  floatStack.forEach((layer) => {
    const el = layer.ref.current
    const depth = el
      ? floatStack.filter((other) => other !== layer && other.ref.current?.contains(el)).length
      : 0
    // `>=` 而不是 `>`:同深度时后遍历到的(= 后入栈的)胜出,这就是判据②。
    if (depth >= topDepth) {
      top = layer
      topDepth = depth
    }
  })
  return top
}

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
 *
 * ── 层叠时只退一层:栈顶认领(09-01 批 4)────────────────────────────────
 * 捕获相位只摆平了「浮层 vs 外壳」。浮层**互相之间**同相位,靠注册序 = 挂载序,
 * 先开的先收到 —— 于是对话框里开一张菜单,一下 Esc 两层齐关。判据换成上面那只
 * 模块级浮层栈:每个认 Esc 的浮层挂载时入栈,**只有栈顶那一个**认领,其余不动。
 * 见文件头「浮层栈」那节。
 */
export interface FloatDismissOptions {
  /**
   * Esc 认领关闭。默认 **true**(Menu / Popover 就是这一档,一个字都不用写)。
   * 传 false = 这个浮层的 Esc 另有语义、由消费方自己写(composer 的三层 Esc);
   * 它**不进浮层栈**,也就不会挡住别人那一层。
   */
  escape?: boolean
  /**
   * 点浮层外关。默认 **`'bubble'`**(与退层链没有次序纠纷,照旧走冒泡)。
   *  · `false` —— 关掉这条路。Dialog 是这一档:它的「点外面」是遮罩自己的
   *    mousedown(按下和松开都要落在遮罩上才算),不是一条 window 上的监听。
   *  · `'capture'` —— 走捕获相位。给「屏幕别处有件把 pointerdown 掐断」的场合:
   *    React 合成事件的 stopPropagation 会连原生冒泡一起停(Select / Tabs /
   *    FloatWindow / AgentChip 各有一句),冒泡档在那些地方点下去收不到,
   *    浮层就关不掉。捕获跑在任何 stopPropagation 之前,所以关得掉。
   */
  outside?: false | 'bubble' | 'capture'
}

export function useFloatDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active = true,
  opts: FloatDismissOptions = {},
): void {
  const escape = opts.escape ?? true
  const outside = opts.outside ?? 'bubble'

  /*
   * onClose 走 ref、不进依赖表。理由是栈:进了依赖表的话,消费方每渲染一次
   * (onClose 通常是就地闭包)这一格就出栈再入栈一次 —— 一个后台重渲染会把
   * 底层浮层顶到栈顶去,层序当场失真。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!active || !escape) return
    const layer = pushFloatLayer(ref)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // 不是最上面那一层就一个字都不做:这一下不属于我,让别人去认领。
      if (topFloatLayer() !== layer) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popFloatLayer(layer)
    }
  }, [ref, active, escape])

  useEffect(() => {
    if (!active || outside === false) return
    const capture = outside === 'capture'
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeRef.current()
    }
    window.addEventListener('pointerdown', onDown, capture)
    return () => window.removeEventListener('pointerdown', onDown, capture)
  }, [ref, active, outside])
}

/**
 * 摆法。`below-start` = 贴锚点下缘、左对齐;`below-end` = 贴下缘、**右对齐**;
 * `above-center` = 锚点正上方居中。
 *
 * `below-end` 是 09-02 批 12 补的第三档,理由是**锚点自己贴着右边线**:
 * 一行尾巴上的 ⋯ 左对齐开出去,菜单整个探到那块面外面(密钥池那一行实测
 * 探出面板右缘一大截,只靠视口 clamp 兜着)。左对齐与右对齐不是口味问题 ——
 * 它是「锚点在这一行的哪一头」的函数,所以是一格 prop,不是各面自己算坐标。
 */
export type FloatPlace = 'below-start' | 'below-end' | 'above-center'

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
  if (anchor.place === 'below-start' || anchor.place === 'below-end') {
    // `below-end` 对的是锚点的**右缘**:左缘 = 右缘 − 身量。首帧 w=0 时它退化成
    // 「贴着锚点右缘」,量到真身量之后在同一个 layout 相位里修正(纪律①)。
    const ideal = anchor.place === 'below-end' ? r.right - w : r.left
    return {
      left: Math.max(0, Math.min(ideal, vw - w)),
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

/*
 * 热更退役(09-01 立法)。`floatStack` 是模块作用域里的可变状态,寿命 = 这个模块
 * 实例:换掉模块时旧那一份栈会连同它里面的层一起留下,新模块开出来的浮层永远
 * 排在那些尸体下面、当不上栈顶,Esc 当场全哑。拆卸**复用既有的那一口**
 * `popFloatLayer`(不写第二套),从顶往下逐格摘;栈空了跑一遍什么都不做,所以幂等。
 * 生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    while (floatStack.length > 0) popFloatLayer(floatStack[floatStack.length - 1])
  })
}
