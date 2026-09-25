import { useCallback, useEffect, useRef } from 'react'
import { DOCK_AXIS } from '../stage/types'
import type { DockAlign, DockEdge } from '../stage/types'
import { dockLens, dockPitch, GROWTH_BIAS } from './dock-lens'

/**
 * Dock 磁性放大的**宿主半边**(09-02 第二轮重做)—— 全系统唯一的 hover 位移豁免
 * (动效板·位移豁免清单 ②)。纯几何在 `dock-lens.ts`,这里只做三件事:
 * 把指针位置翻成条内坐标、把布局现读成静止坐标系、把答案写进几格自定义属性。
 *
 * **它不插值、不留几何状态、不跑常驻的 rAF 环。** 进 / 出那一下的柔和由 CSS 的
 * `--dock-amount: 0 → 1` 过渡给(`@property` 注册在 styles/motion.css,时长
 * `--dur-dock-lens`,缓动 `--ease-soft`,动效档「无」/ reduced-motion 下归 0ms)。
 * 跟手期 amount 恒为 1,几何直接写。三段(进 / 跟 / 放)因此没有任何开关可掰,
 * 也就没有「掰的那一帧把累积滞后一次性补齐」这种病的产地。
 *
 * ── ① 生命周期 ─────────────────────────────────────────────────────────────
 * | 事件 | 静止坐标系 | 写什么 |
 * | --- | --- | --- |
 * | 挂载 | 不量(没人问就不用量) | 什么都不写;`--dock-amount` 的初值 0 就是静息 |
 * | 指针进条 | 当场从布局现读 | **先写几何、再挂 `data-lens="on"`**(反过来会让第一帧从满格起跳) |
 * | 跟手 | 每帧现读(rAF 合帧,一次 pointermove 至多算一次) | 只改几何,开关不动 |
 * | 指针出坞(条外**且**脚下不是瓦) | — | 只摘 `data-lens`,**几何留着最后一帧** —— 于是它原地缩回去,不会先跳一下再缩 |
 * | 瓦数 / 分隔线 / 大小档 / 对齐档 变 | 自动跟上(基准是现读的,没有旧值可过期) | 渲染后补写一次,手不动也算数 |
 * | 视口 resize | 同上(条挪窝时条内坐标会变) | 收到 resize 补写一次 |
 * | 卸载 | — | cancelAnimationFrame |
 * | **设置里关掉放大** | 不量 | 一格几何都不写、开关不挂;已经挂着的当场摘掉,条与瓦回静息 |
 * 没有「冻结」「作废」「上次已知值」这三格 —— 基准是**布局值**(offsetLeft /
 * offsetWidth),放大走 transform,所以放大着的时候读到的基准和静止时逐字节相同,
 * 压根不存在「此刻量不了」的时刻。上一版整整三格状态就是为了绕开这件事。
 *
 * ── ② UI 生命状态 ──────────────────────────────────────────────────────────
 * 这只 hook 不取数,所以没有 empty / loading / error。它有的是**镜头开没开**:
 * | 状态 | 何时 | 画什么 |
 * | --- | --- | --- |
 * | 关 | 指针不在条上(条还没画出来也算) | 全静止:amount 0,底板齐条身 |
 * | 开 | 指针在条的感应面里(外侧到窗边、镜头开着时内侧到放大后的瓦顶),**或**脚下压着一块瓦 | 照算,amount 1 |
 * | 开合中 | 上面两者之间的 --dur-dock-lens | 几何不变,amount 在路上 |
 * | 超量 | 瓦再多也只是数组更长(条被视口挤是 Dock 的事) | 照算 |
 *
 * ── ③ UI 交互状态 ──────────────────────────────────────────────────────────
 * | 状态 | 触发 | 行为 |
 * | --- | --- | --- |
 * | rest | 指针不在坞上 | amount 0 |
 * | hover / 跟手 | 指针在坞上(感应面 ∪ 瓦身) | 几何逐次 pointermove 现算,零延迟;交叉轴上挪动不改大小 |
 * | 释放 | mouseleave,或交叉轴出界且脚下不是瓦 | amount 1 → 0,几何原地不动 |
 * | reduced-motion / 动效档「无」 | 系统偏好或设置 | --dur-dock-lens = 0ms,当帧瞬到(是瞬到,不是不放大 —— 放大是这块面的读法,不是装饰) |
 * | **配置态:放大关** | 设置 → Dock → 磁性放大 | 这条链**根本不跑**:指针滑过条时一格几何都不写,条与瓦纹丝不动(对齐 macOS 那枚「放大」开关关掉之后的样子) |
 * | **配置态:幅度档** | 设置 → Dock → 放大幅度 | 只换条上那格 `--dock-lens-max`,几何现读 —— 这只 hook 一个数都不认识 |
 * 没有 focus / disabled / pending 档 —— 放大不是一个可以按坏的控件,也不吃键盘焦点
 * (键盘走的是瓦自己的 `:focus-visible` 环)。
 */

/** 瓦的位移落到哪一格自定义属性 —— 两条轴各一格,CSS 侧一条 translate() 合起来。 */
const TILE_DX_VAR: Record<'x' | 'y', string> = {
  x: '--tile-dx-x',
  y: '--tile-dx-y',
}
/** 缩放只有一格(它不分轴)。 */
const TILE_SCALE_VAR = '--tile-scale'
/** 底板朝主轴两头各长出多少(px)。哪一头落到哪条边由 Dock.module.css 按轴分。 */
const PLATE_BEFORE_VAR = '--dock-grow-before'
const PLATE_AFTER_VAR = '--dock-grow-after'
/** 镜头开关。CSS 侧 `[data-lens='on']` 把 --dock-amount 拨到 1。 */
const LENS_ATTR = 'data-lens'

export interface DockLensInput {
  /** 停在哪条边 —— 轴向由它推出(DOCK_AXIS)。 */
  edge: DockEdge
  /** 沿边对齐档 —— 决定条长大时朝哪边退(GROWTH_BIAS)。 */
  align: DockAlign
  /**
   * 磁性放大开不开(设置 → Dock)。**关 = 这条链不跑**,不是「放大到 1 倍」:
   * 后者仍然每帧写 13 组自定义属性、仍然挂着开关,只是数字碰巧是 1;
   * 前者一格都不写。差别在真机上看得见 —— gate:dock 的 ⑨ 判的就是「关掉之后
   * 匀速扫一遍,所有矩形逐字不变」,写 1 也能过,但那是在假装关掉了。
   */
  enabled: boolean
}

/**
 * 条上那几块瓦的**外壳** div(`data-dock-tile`)。
 *
 * 量的是外壳不是里头那颗按钮:按钮身上挂着缩放,而外壳只挂位移 —— 位移用
 * `offsetLeft/offsetTop` 读,那是**布局值**,transform 改不动它。分隔线是
 * `<span>` 且没有这个标记,天然不进这张表(放大按格子的线性次序索引,漏一格
 * 就对不上号)。
 */
function tilesOf(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>(':scope > [data-dock-tile]')]
}

function num(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function useDockLens({ edge, align, enabled }: DockLensInput) {
  const strip = useRef<HTMLDivElement | null>(null)
  /**
   * 指针的两个坐标 + **脚下是不是一块瓦**。
   *
   * 主轴的进算式;交叉轴的与 `onTile` 合起来回答「还在坞上吗」——
   * 为什么要第二问,见 `paint` 里交叉轴判据那一段。
   */
  const pointer = useRef<{ main: number; cross: number; onTile: boolean } | null>(null)
  const frame = useRef<number | null>(null)
  /*
   * 轴与退让比例走 ref 而不是进 useCallback 的依赖表:`paint` 每一帧都可能被叫到,
   * 换一个身份就等于换一个 rAF 回调,而它俩换的频率是「用户改设置」那个量级。
   */
  const axis = useRef(DOCK_AXIS[edge])
  axis.current = DOCK_AXIS[edge]
  const bias = useRef(GROWTH_BIAS[align])
  bias.current = GROWTH_BIAS[align]
  const on = useRef(enabled)
  on.current = enabled

  /** 收起镜头:只摘开关,**几何留着** —— 让它从当下这个形原地缩回去。 */
  const close = useCallback((el: HTMLElement) => {
    el.removeAttribute(LENS_ATTR)
  }, [])

  const paint = useCallback(() => {
    frame.current = null
    const el = strip.current
    if (!el) return
    const at = pointer.current
    // 关掉放大就是**这条链不跑**:不量、不算、不写,只保证开关是摘着的。
    if (!at || !on.current) {
      close(el)
      return
    }

    const vertical = axis.current === 'y'
    /*
     * ── 交叉轴判据:**指针在感应面里,或者脚下压着一块瓦**(09-25 改)──────────
     *
     * 09-13 那一版问的是「在条的盒子里 ∪ 脚下是瓦」,补上了放大后探出条外的瓦身,
     * 却留下两段死带,四条边各撞各的(09-25 用户:「不管是在哪个方向,从应用边到
     * 图标距离边最远的地方时,icon 的大小应该不变」):
     *   · 条与窗边之间那截缝 —— 指针贴着窗边镜头是熄的,往里一挪才亮;
     *   · 探出条外那一截里**瓦与瓦之间的缝** —— 脚下不是瓦,镜头熄,同一条横线上
     *     一会儿大一会儿小。
     * 今天「在坞上」是一个盒子:条自己的感应面(`[data-dock="hit"]`,几何全在
     * Dock.module.css 的 `.hit`),外侧伸到窗边、镜头开着时内侧伸到放大后瓦的最远处。
     * 于是交叉轴上只有「窗边 → 瓦顶」一个区间,区间里瓦的大小只随主轴变。
     * 读活矩形不会自激:它的交叉轴尺寸只随 `data-lens` 开合换档,不随几何变。
     *
     * `at.onTile` 仍留着:名字条、角标这类挂在瓦上的东西可能探出感应面,脚下是瓦
     * 就算在坞上(macOS 那一句「指针在放大着的图标身上就算在坞上」)。
     * 反过来,右键菜单是条的 React 子树(事件照样冒泡上来),却不在感应面里、脚下
     * 也不是瓦 —— 这一问把它挡在外面,在菜单上移动不会点亮镜头。
     */
    const box = el.getBoundingClientRect()
    const hit = el.querySelector<HTMLElement>(':scope > [data-dock="hit"]')
    const band = hit ? hit.getBoundingClientRect() : box
    const inBand = vertical
      ? at.cross >= band.left && at.cross <= band.right
      : at.cross >= band.top && at.cross <= band.bottom
    if (!inBand && !at.onTile) {
      close(el)
      return
    }

    const tiles = tilesOf(el)
    if (tiles.length === 0) {
      close(el)
      return
    }

    /*
     * 条内坐标。`offsetLeft` 量的是「到 offsetParent **内边距**前缘」的距离,
     * 所以指针那一侧也要减掉边框:rect.left 是**边框**前缘,clientLeft 是边框宽。
     * 两边同一个原点,式子才对得上。
     */
    const origin = vertical ? box.top + el.clientTop : box.left + el.clientLeft
    const centers = tiles.map((t) =>
      vertical ? t.offsetTop + t.offsetHeight / 2 : t.offsetLeft + t.offsetWidth / 2,
    )
    const size = vertical ? tiles[0].offsetHeight : tiles[0].offsetWidth
    if (!(size > 0)) {
      close(el)
      return
    }

    const css = getComputedStyle(el)
    const max = num(css.getPropertyValue('--dock-lens-max'), 1)
    const reaches = num(css.getPropertyValue('--dock-lens-reach'), 2)
    const lens = dockLens(at.main - origin, {
      centers,
      size,
      max,
      // 半径以「几倍瓦距」声明 —— 整数倍才不呼吸,理由(COLA)在 dock-lens.ts 文件头。
      reach: reaches * dockPitch(centers, size),
      bias: bias.current,
    })

    const dxVar = TILE_DX_VAR[vertical ? 'y' : 'x']
    /*
     * **另一轴那一格要摘掉**(09-13 补):CSS 侧是一条 `translate()` 合两轴的,
     * 从底边切到右边之后瓦身上旧的 `--tile-dx-x` 还在(真机量:第一块瓦 −3.79,
     * 扫完整条底边再切可到 −15),竖排放大时每块瓦都沿交叉轴乱挪一截。
     * 摘而不是写 '0':CSS 那头 `var(--tile-dx-x, 0)` 本来就有缺省,摘掉更干净,
     * 也与「关掉放大时一格都不写」同一个口径 —— 瓦身上只留此刻真在用的那一格。
     */
    const staleVar = TILE_DX_VAR[vertical ? 'x' : 'y']
    for (let i = 0; i < tiles.length; i += 1) {
      tiles[i].style.removeProperty(staleVar)
      tiles[i].style.setProperty(dxVar, String(lens.dx[i]))
      tiles[i].style.setProperty(TILE_SCALE_VAR, String(lens.scale[i]))
    }
    el.style.setProperty(PLATE_BEFORE_VAR, String(lens.growth * bias.current))
    el.style.setProperty(PLATE_AFTER_VAR, String(lens.growth * (1 - bias.current)))
    // **最后一句**:几何先落地,开关后挂。反过来的话第一帧 amount 已经是 1 而几何
    // 还是上一次的,镜头会先跳到旧形再改 —— gate:dock 的 ③ 抓的就是这个。
    el.setAttribute(LENS_ATTR, 'on')
  }, [close])

  /**
   * 合到下一帧算一次。
   *
   * 合帧**不是插值**:一帧之内指针来几发 mousemove 只算最后那一发,画出来的仍是
   * 那一发对应的几何。它买到的是「布局读一次、样式写一次」,而 rAF 回调本就跑在
   * 这一帧绘制之前,所以一帧的延迟都不欠。
   */
  const schedule = useCallback(() => {
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(paint)
  }, [paint])

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      /*
       * 「脚下是不是一块瓦」**现读事件目标**,不是拿坐标去算 —— 放大着的瓦是
       * transform 出来的,它的命中区归浏览器说了算,自己按几何重算一遍就是第二真相。
       * 记在指针那一格里(而不是 paint 里再查一次):paint 跑在 rAF 上,那时
       * `e.target` 早没了。
       */
      const target = e.target as Element | null
      const onTile = Boolean(target?.closest?.('[data-dock-tile]'))
      pointer.current =
        axis.current === 'x'
          ? { main: e.clientX, cross: e.clientY, onTile }
          : { main: e.clientY, cross: e.clientX, onTile }
      schedule()
    },
    [schedule],
  )

  const onMouseLeave = useCallback(() => {
    pointer.current = null
    schedule()
  }, [schedule])

  /*
   * 渲染后补写一次。瓦数 / 分隔线 / 大小档 / 对齐档变了而手没动时,新的那一格没有
   * 几何可用(它是刚挂上来的),补这一发就够 —— 不需要一张「谁变了要作废什么」的表,
   * 因为基准本来就是现读的。手不在条上时 `paint` 自己会走到 close 那一支。
   */
  useEffect(() => {
    if (pointer.current) schedule()
  })

  /*
   * 设置里当场关掉放大时,手可能正压在条上 —— 上面那发 effect 会补一次 paint,
   * 它走到 `!on.current` 那一支把开关摘掉,条与瓦当帧(按 --dur-dock-lens)回静息。
   * 关掉之后**几何留在最后一帧**是有意的:与手离开走的是同一条路,收回的样子一致。
   */

  useEffect(() => {
    if (typeof window === 'undefined') return
    // 条挪窝(居中 / 靠后两档的前缘跟着视口走)时条内坐标会变,而手可能一动不动。
    const onResize = () => {
      if (pointer.current) schedule()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [schedule])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  return { stripRef: strip, onMouseMove, onMouseLeave }
}
