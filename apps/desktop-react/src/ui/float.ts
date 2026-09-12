import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/* ── 浮层栈退役了(09-02 R1)────────────────────────────────────────────────
 *
 * 这只文件从前顶着一段模块级的**浮层栈**:每个认 Esc 的浮层挂载入栈、卸载出栈,
 * 一下 Esc 只有栈顶那层认领。它回答的是「这一下 Esc 属于最上面的哪一层」,
 * 而判据得靠两条**猜**出来 —— DOM 包含(portal 出去的菜单与对话框面板是兄弟,
 * 答不出)加入栈序(React 的 effect 子先于父跑,同一次提交里一起挂载的父子
 * 层序整个倒过来,也答不出)。两条互相兜,才勉强兜住了那几种形。
 *
 * 响应链把那个问题变成了结构问题:菜单在 React 树上就是对话框的孩子,
 * 由深到浅问下来第一个答 true 的消费掉(设计 §4.4)。于是栈、`topFloatLayer`、
 * 那条 window 捕获监听、`escape` 那格 prop,连同它们的三轮判例一起退役 ——
 * 判例本身没作废,它搬进了 `focus/dispatch.ts` 的相位表与 `focus/transitions.ts`
 * 的 `routeEscape`。
 *
 * 留在这里的是**点外关**与**定位**:前者各浮层各自判「点没点在我身上」,
 * 互不干扰、从来没有次序问题;后者与键盘无关。
 */

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
 * 交互:点外关、程序关(消费方自己 setState)两条路,同一个 `onClose`;
 *      Esc 归响应链(`<FocusScope onEscape>`),不在这只原语里。
 * 几何:**视口 = 窗口减安全区**,安全区是宿主用 token 声明的
 *      (`--float-inset-top` 是顶上那条 chrome 带,`--float-inset-edge` 是左右与
 *      底边三边的留白;见 `readInsets`)—— 这只原语只知道「有一圈不许画」,
 *      不知道那圈里画着什么。
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * 点外关。`active=false` 时一个监听都不装。
 *
 * **Esc 不在这儿了**(09-02 R1):它是响应链上「退一层」的那件事,由
 * `<FocusScope onEscape>` 声明、由唯一那个派发器沿活动路径由深到浅问下来。
 * 见文件头那段退役记。
 */
export interface FloatDismissOptions {
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
  const outside = opts.outside ?? 'bubble'

  /*
   * onClose 走 ref、不进依赖表:消费方每渲染一次它通常都是个新闭包,进依赖表
   * 等于每渲染一次就拆装一遍监听 —— 一次后台重渲染就能把一发正在派送的
   * pointerdown 漏掉。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

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
/**
 * `cover` 是第四档,W3 补的(裁定 2 的字面兑现:`DropOverlay` 不许在自己身上
 * 手写几何)。它与前三档**不是同一类问题**:那三档回答「贴着锚点的哪一边」,
 * 这一档回答「**盖住锚点整个矩形**」—— 落区高亮、撕浮窗的轮廓预示都是这一形。
 *
 * 所以它是唯一一档会交出**身量**的:`FloatPosition.width / height` 只在这一档
 * 非 null(见那只接口)。别的三档浮层的身量由内容自己决定,这一档的身量**就是
 * 锚**,消费方直接把两个数写进 style,一句 `getBoundingClientRect` 都不必自己调。
 *
 * 它**不夹视口**:落区的锚本来就是屏幕上一块真实存在的矩形(一片叶、一条边带),
 * 夹一次只会把高亮从它该盖的地方挪开。前三档夹视口是因为浮层要被看全,
 * 而这一档的「看全」就是「与锚重合」。
 */
export type FloatPlace = 'below-start' | 'below-end' | 'above-center' | 'cover' | 'right-start'

/*
 * `right-start` 是第五档(W7-c)。前四档回答的都是「贴着锚点的上 / 下 / 整个」,
 * 而**子菜单**要的是第三个方向:贴着锚点这一行的**右缘**、顶缘对齐。它与
 * `below-start` 是同一句话换一根轴,所以是这张表的一行,不是子菜单自己算坐标
 * (「浮层摆哪儿」全仓只有这一个产地 —— 这是 `ui/float` 存在的全部理由)。
 */

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
  /**
   * 身量。**只有 `cover` 档答得出**(它的身量就是锚);别的三档恒 null ——
   * 那三档的身量由浮层的内容决定,原语无从知道也不该猜。
   */
  width: number | null
  height: number | null
}

export interface FloatPositionOptions {
  /** 浮层此刻在不在场。false = 零监听、位置不动。默认 true。 */
  active?: boolean
  /** 首帧兜底:`rect` 档的 getter 此刻答不出矩形时用它开局。 */
  fallback?: { left: number; top: number }
}

/**
 * 安全区 —— 这只原语的「视口」不是整扇窗,是**窗减去宿主声明的那一圈**。
 *
 * 两枚数不是同一件事的两个方向:
 *  · `top` —— 顶上那一段是窗口的 chrome(拖拽带 + 画在网页之上、z-index 管不着的
 *    原生红绿灯),浮层摆进去就是**被压住**;左架子最上排 tab 的 tooltip 正是
 *    这么消失的(09-12)。
 *  · `edge` —— 左、右、底**三边的留白**:那三边没有东西压人,浮层齐着窗口边线
 *    摆是看得见的,只是难看。所以它是一个数管三边,名字不叫 `x`(叫 x 会让人
 *    以为底边那句 `vh - h - edge` 是抄错的)。
 *
 * 这里**只认识「有一圈不许画」**,不认识红绿灯是什么:声明与理由都在
 * `styles/tokens.css` 的 `--float-inset-*` 上,换宿主(Windows / 浏览器壳)改的是
 * 那两个值,不是这里的分支。
 *
 * 每次 `place()` 现读,不缓存:它跑在 show 与 rAF 合并后的 scroll / resize 里,
 * 一帧最多一次,一次 getComputedStyle 不值得记一格状态 —— 而记了就会在换主题 /
 * 换宿主的那一刻说谎。jsdom 里 custom property 读出来是空串、`parseFloat` 给 NaN,
 * 那一档按 0 走,所以不设 token 的环境读数与从前逐字相同。
 */
function readInsets(): { top: number; edge: number } {
  const cs = getComputedStyle(document.documentElement)
  const num = (name: string): number => {
    const v = parseFloat(cs.getPropertyValue(name))
    return Number.isFinite(v) ? v : 0
  }
  return { top: num('--float-inset-top'), edge: num('--float-inset-edge') }
}

/**
 * 算一次位置。纯函数(除了读 window 的视口尺寸与根元素上那两枚安全区 token),好断言。
 * `w`/`h` 是浮层的身量 —— 还没量到的时候传 0,得到的就是「未 clamp 的理想位」。
 */
function place(anchor: FloatAnchor, w: number, h: number): FloatPosition | null {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const { top: insetTop, edge: insetEdge } = readInsets()
  if (anchor.kind === 'point') {
    return {
      left: Math.max(insetEdge, Math.min(anchor.x, vw - w - insetEdge)),
      top: Math.max(insetTop, Math.min(anchor.y, vh - h - insetEdge)),
      flipped: false,
      width: null,
      height: null,
    }
  }
  const r = anchor.get()
  if (!r) return null
  // 盖住锚:位置与身量都是锚自己的,不夹视口(理由写在 `FloatPlace` 上)。
  if (anchor.place === 'cover') {
    return { left: r.left, top: r.top, flipped: false, width: r.width, height: r.height }
  }
  // 贴右缘、顶对齐(子菜单那一档)。视口右边放不下就往左夹 —— 夹到贴着安全区内沿为止。
  if (anchor.place === 'right-start') {
    return {
      left: Math.max(insetEdge, Math.min(r.right, vw - w - insetEdge)),
      top: Math.max(insetTop, Math.min(r.top, vh - h - insetEdge)),
      flipped: false,
      width: null,
      height: null,
    }
  }
  if (anchor.place === 'below-start' || anchor.place === 'below-end') {
    // `below-end` 对的是锚点的**右缘**:左缘 = 右缘 − 身量。首帧 w=0 时它退化成
    // 「贴着锚点右缘」,量到真身量之后在同一个 layout 相位里修正(纪律①)。
    const ideal = anchor.place === 'below-end' ? r.right - w : r.left
    return {
      // 两头夹的不是同一个数:下界是 `insetTop`(菜单开进顶栏带就会被拖拽带与
      // 红绿灯压住,与 tooltip 同一个病,09-12),上界是底边那道留白 `insetEdge`。
      left: Math.max(insetEdge, Math.min(ideal, vw - w - insetEdge)),
      top: Math.max(insetTop, Math.min(r.bottom, vh - h - insetEdge)),
      flipped: false,
      width: null,
      height: null,
    }
  }
  /*
   * above-center 的 left 是**中线**(消费方的 CSS 用 translateX(-50%) 落地),
   * 所以夹的是中线,不是左缘 —— 按左缘夹会把一个居中的浮层夹歪半个身子。
   * 垂直方向不夹:它挂在锚点上缘之上,夹 top≥0 等于把它按回锚点头上。
   * 摆不下这件事由**翻转**回答,不由夹回答。
   *
   * 「摆不下」的线是**顶上那条 chrome 带的内沿**而不是 0:上方还剩 20px、而顶上
   * 44px 是顶栏带时,按 0 判是「摆得下」,摆出来的提示正落在红绿灯底下(09-12
   * 左架子最上排 tab 的报障就是这一格)。左右两头则各留一道 `insetEdge`(三边留白
   * 里的两边),不再齐着窗口边线零留白。
   */
  const flipped = r.top - h < insetTop
  const half = w / 2
  return {
    left: Math.max(half + insetEdge, Math.min(r.left + r.width / 2, vw - half - insetEdge)),
    top: flipped ? r.bottom : r.top,
    flipped,
    width: null,
    height: null,
  }
}

/** `cover` 档的重算键:锚矩形的四个数。答不出矩形时是空串(位置原地不动)。 */
function coverKeyOf(r: DOMRect | null): string {
  return r ? `${r.left}:${r.top}:${r.width}:${r.height}` : ''
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
        width: null,
        height: null,
      },
  )

  // 「什么变了才要重算」:point 档是那对坐标,rect 档是摆法(矩形自己会变,
  // 但那是 scroll/resize 负责发现的事,不是 render 负责发现的)。
  /*
   * `cover` 档的锚是一块**随拖拽每帧换值**的矩形(落区),它既不是页面上某个元素
   * 的活矩形、也不是一次性的光标坐标 —— 所以它的重算判据必须是那块矩形本身,
   * 而不是「摆法没变就不重算」。四个数进 key,拖到隔壁那片叶时当场重摆。
   */
  const key =
    anchor.kind === 'point'
      ? `point:${anchor.x}:${anchor.y}`
      : anchor.place === 'cover'
        ? `cover:${coverKeyOf(anchor.get())}`
        : `rect:${anchor.place}`

  const measure = useCallback(() => {
    const el = floatRef.current
    if (!el) return
    const next = place(anchorRef.current, el.offsetWidth, el.offsetHeight)
    if (!next) return
    // 同一个位置就交出同一个对象:scroll 一路上百次,位置没动就不该重渲染一次。
    setPos((prev) =>
      prev.left === next.left
      && prev.top === next.top
      && prev.flipped === next.flipped
      && prev.width === next.width
      && prev.height === next.height
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
 * 这只文件从前有一段 HMR dispose(09-01 立法),因为 `floatStack` 是模块作用域里的
 * 可变状态 —— 换掉模块时旧那一份栈会连同层一起留下,新浮层永远当不上栈顶。
 * 栈退役之后**模块作用域里一格状态都没有了**(两只 hook 的监听都长在组件的 effect
 * 里,React 卸载时自然拆),所以那段 dispose 一并删掉:判据是那条法自己的一句话 ——
 * 「这东西的寿命是不是『这个模块实例』」。这里的答案现在是「没有这东西」。
 * 同一条纪律的活例子在 `focus/registry.ts` 末尾(那棵树才是模块级单例)。
 */
