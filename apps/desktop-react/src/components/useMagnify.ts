import { useCallback, useEffect, useRef, useState } from 'react'
import { DOCK_AXIS } from '../stage/types'
import type { DockAlign, DockEdge, DockSize } from '../stage/types'
import {
  damperStep,
  dockRestCenters,
  GROWTH_BIAS,
  magnifyAt,
  magnifyLayout,
  REST_FACTOR,
} from './dock-magnify'
import type { DockRestLayout, DockRestMetrics } from './dock-magnify'
import { MAGNIFY_TAU_MS, currentMotionTier } from './motion'

/**
 * Dock 磁性放大的**宿主半边** —— 全系统唯一的 hover 位移豁免(动效板·位移豁免
 * 清单 ②)。纯几何(曲线 / 静止坐标系 / shift 式子 / 插值一步)在 `dock-magnify.ts`,
 * 这里只做三件事:量那**一个**锚点、跑那**一条** rAF 环、把指针位置翻译成命令。
 *
 * ── ① 生命周期 ─────────────────────────────────────────────────────────────
 * | 事件 | 静止坐标系(锚点) | rAF 环 | 显示值 |
 * | --- | --- | --- | --- |
 * | 挂载 | 不量(条可能还没画完) | 不起 | 全 1、零速度 |
 * | 首次进条 | **就地量**(此刻各瓦必然在静止位) | 起 | 从 1 开始鼓 |
 * | 跟手 | 不再量(算出来的坐标系不随放大而变) | 跑着 | 逐帧朝目标走 |
 * | 离条 | 留着 | 继续跑到收干净 | 收回 1 后停环 |
 * | 瓦数 / 大小档 / 停靠边 / 沿边对齐 变 | **作废**,等下一次静止再量 | 不受影响 | 数组按新瓦数补齐 |
 * | 视口 resize | **作废**(居中 / 靠后两档的锚点跟着视口走) | 不受影响 | 不变 |
 * | 作废时正放大着 | 量不了(此刻不是静止态),**沿用上一次已知值** | — | — |
 * | 卸载 | — | cancelAnimationFrame | — |
 *
 * 「换宿主」这一行是空的:Dock 只有一种落点(fixed 浮层),它不进面板 / 浮窗 / 架子。
 * 停靠边换了不是换宿主,是同一个宿主换了轴 —— 上表里那一行就是它。
 *
 * ── ② UI 生命状态 ──────────────────────────────────────────────────────────
 * 这只 hook 不取数,所以没有 empty / loading / error 三态。它有的是**几何在不在**:
 * | 状态 | 何时 | 画什么 |
 * | --- | --- | --- |
 * | 无坐标系 | 挂载后到第一次进条之前、或作废后还没等到静止 | 全静止(不放大),shift = 0 |
 * | 有坐标系 | 量到过一次锚点之后 | 照算 |
 * | 超量 | 瓦数再多也只是数组更长(条本身会被视口挤,那是 Dock 的事) | 照算 |
 *
 * ── ③ UI 交互状态 ──────────────────────────────────────────────────────────
 * | 状态 | 触发 | 行为 |
 * | --- | --- | --- |
 * | rest | 指针不在条上 | 全 1、shift 0、环停 |
 * | 跟手 | 指针在条的**两个维度**里 | 目标逐帧照算,τ = --dur-dock-follow |
 * | 释放 | 指针离开条(mouseleave,或交叉轴出界) | 目标全 1,同一个 τ、同一条环收回 |
 * | reduced-motion / 动效档「无」 | 系统偏好或设置 | τ = 0,当帧瞬到(不是不放大) |
 * 没有 disabled / pending 档 —— 放大不是一个可以按坏的控件。
 *
 * ── 进 / 跟 / 放三段同一条机制,没有切换点 ──────────────────────────────────
 * 09-02 之前是「进条后 setTimeout(160ms) 才把 tracking 置真」:这 160ms 里瓦吃一条
 * 160ms 的 CSS 过渡,而 rAF 每帧都在改目标,过渡永远追不上;闸一开
 * `--tile-size-dur` 掰成 0ms,当帧把累积滞后一次性补齐 —— 那一帧就是用户报的
 * 「不顺手」。真机读数:一边进一边扫时第 20 帧涨幅 0.088,而那一帧的几何上限是
 * 0.027(`npm run gate:dock` 的 ②b)。现在瓦的 width/height **没有 CSS 过渡**,
 * 三段都由这一条 rAF 环上的临界阻尼走,快慢只差一个 τ。
 */

/** 显示值与目标差到这个数以内、且速度也可以忽略了,就收针停环。0.005 在 md 档 = 0.22px。 */
const SNAP_EPSILON = 0.005
/**
 * 一帧最多按多久算。标签在后台 / 断点停住时 rAF 会隔很久才来一发,
 * 按真实 dt 算等于当帧瞬移;夹到 64ms(约四帧)让它"慢慢补",而不是跳。
 */
const MAX_FRAME_MS = 64

export interface MagnifyInput {
  /** 条上摆了几块瓦(分隔线不算 —— 放大按格子的线性次序索引)。 */
  count: number
  /** 分隔线插在第几块之后;-1 = 这一刻没有。它占主轴一段长度,静止中心算式要知道。 */
  sepAfter: number
  /** 停在哪条边 —— 轴向由它推出(DOCK_AXIS)。 */
  edge: DockEdge
  /** 沿边对齐档 —— 决定条长大时朝哪边退(GROWTH_BIAS)。 */
  align: DockAlign
  /** 大小档 —— 换档就是换瓦尺寸,静止坐标系作废。 */
  size: DockSize
}

/**
 * 这一刻的 τ(ms)。0 = 瞬到。
 *
 * 进 / 跟 / 放三段是同一个 τ(为什么不是两档,见 tokens.css 的 --dur-dock-follow
 * 那一节:算下来两档收敛到同一个数)。唯一会换的是**动效档**:
 * reduced-motion 或档位「无」时 τ = 0,当帧瞬到 —— 注意是瞬到,不是不放大,
 * 放大本身不是装饰而是这块面的读法。
 */
function currentTau(reduced: boolean): number {
  if (reduced || currentMotionTier() === 'none') return 0
  return MAGNIFY_TAU_MS
}

export function useMagnify({ count, sepAfter, edge, align, size }: MagnifyInput) {
  const axis = DOCK_AXIS[edge]
  const strip = useRef<HTMLDivElement | null>(null)
  /** 指针的两个坐标:主轴的进算式,交叉轴的只用来判「还在条上吗」。 */
  const pointer = useRef<{ main: number; cross: number } | null>(null)
  /** 当前有效的**量出来那半边**;作废即置空(声明那半边永远现取,不进这里)。 */
  const metrics = useRef<DockRestMetrics | null>(null)
  /** 上一次量到过的那份 —— 作废时正放大着就用它(见生命周期表最后一行)。 */
  const lastMetrics = useRef<DockRestMetrics | null>(null)
  const shown = useRef<number[]>(Array.from({ length: count }, () => REST_FACTOR))
  const speed = useRef<number[]>(Array.from({ length: count }, () => 0))
  const frame = useRef<number | null>(null)
  const lastTick = useRef(0)
  /** 只造一次:没有监听器就不是订阅,不需要 dispose。 */
  const reducedQuery = useRef<MediaQueryList | null>(null)

  const [view, setView] = useState<{ factors: number[]; shift: number }>(() => ({
    factors: Array.from({ length: count }, () => REST_FACTOR),
    shift: 0,
  }))

  /**
   * 量锚点。**只在此刻各瓦都在静止位时才量** —— 量的是条,不是瓦,但条的主轴
   * 前缘同样会被放大推着走(居中 / 靠后两档),所以这条判据一样成立。
   * 其余几个数(瓦宽 / 缝 / 分隔线宽)从计算样式现读:它们的产地是 tokens.css,
   * 在这里抄一份就是第二处会分叉的地方。
   */
  const measure = useCallback((): DockRestMetrics | null => {
    const el = strip.current
    if (!el) return null
    const box = el.getBoundingClientRect()
    const css = getComputedStyle(el)
    const vertical = axis === 'y'
    const anchor = vertical
      ? box.top + Number.parseFloat(css.borderTopWidth) + Number.parseFloat(css.paddingTop)
      : box.left + Number.parseFloat(css.borderLeftWidth) + Number.parseFloat(css.paddingLeft)
    const tileSize = Number.parseFloat(css.getPropertyValue('--tile-size'))
    const gap = Number.parseFloat(vertical ? css.rowGap : css.columnGap)
    const sepSize = Number.parseFloat(css.getPropertyValue('--dock-sep-w'))
    if (!Number.isFinite(anchor) || !Number.isFinite(tileSize) || tileSize <= 0) return null
    return {
      anchor,
      tileSize,
      gap: Number.isFinite(gap) ? gap : 0,
      sepSize: Number.isFinite(sepSize) ? sepSize : 0,
    }
  }, [axis])

  const tick = useCallback(
    (now: number) => {
      frame.current = null
      const dt = Math.min(Math.max(now - lastTick.current, 0), MAX_FRAME_MS)
      lastTick.current = now

      if (shown.current.length !== count) {
        shown.current = Array.from({ length: count }, (_, i) => shown.current[i] ?? REST_FACTOR)
        speed.current = Array.from({ length: count }, (_, i) => speed.current[i] ?? 0)
      }

      const atRest = shown.current.every((v) => Math.abs(v - REST_FACTOR) <= SNAP_EPSILON)
      if (!metrics.current && atRest) {
        const measured = measure()
        if (measured) {
          metrics.current = measured
          lastMetrics.current = measured
        }
      }
      // 量出来的那半边可能是上一次的(此刻不是静止态,量不了);
      // 声明的那半边**每帧现取** —— 瓦数 / 分隔线 / 对齐档在悬停期间变了立刻算数。
      const known = metrics.current ?? lastMetrics.current
      const geometry: DockRestLayout | null = known
        ? { ...known, count, sepAfter, growthBias: GROWTH_BIAS[align] }
        : null

      // 交叉轴判据:指针离开条的**另一个维度**就算不在条上了。放大的瓦朝内长出
      // 条外,鼠标事件仍从那一截冒泡到条上 —— 没有这一句,悬在条外的那一截上
      // 照样会放大。条的交叉轴尺寸是钉死的(见 Dock.module.css 的 height/width),
      // 所以这里读活矩形不会自激;自动隐藏滑进滑出时它还必须是活的。
      const box = strip.current?.getBoundingClientRect()
      const at = pointer.current
      const onStrip =
        at !== null &&
        box !== undefined &&
        (axis === 'x'
          ? at.cross >= box.top && at.cross <= box.bottom
          : at.cross >= box.left && at.cross <= box.right)

      const targets =
        onStrip && at && geometry
          ? magnifyAt(at.main, dockRestCenters(geometry))
          : shown.current.map(() => REST_FACTOR)
      const tau = currentTau(reducedQuery.current?.matches ?? false)

      let moving = false
      for (let i = 0; i < count; i += 1) {
        const target = targets[i] ?? REST_FACTOR
        const next = damperStep(shown.current[i] ?? REST_FACTOR, speed.current[i] ?? 0, target, tau, dt)
        if (Math.abs(next.value - target) <= SNAP_EPSILON && Math.abs(next.velocity) * tau <= SNAP_EPSILON) {
          shown.current[i] = target
          speed.current[i] = 0
        } else {
          shown.current[i] = next.value
          speed.current[i] = next.velocity
          moving = true
        }
      }

      // shift 吃的是**显示值**不是目标值 —— 它补偿的是此刻真实的布局,
      // 鼓起的那几帧里用目标算等于超前补偿,脚下那块反而会晃。
      const shift =
        onStrip && at && geometry ? magnifyLayout(at.main, geometry, shown.current).shift : 0
      setView({ factors: shown.current.slice(), shift })

      // 目标没变、显示值也收针了就停环 —— 悬停不动时不该有一条 rAF 空转。
      // 指针再动一下由 onMouseMove 的 ensureRunning 重新起。
      if (moving) frame.current = requestAnimationFrame(tick)
    },
    [axis, count, sepAfter, align, measure],
  )

  const ensureRunning = useCallback(() => {
    if (frame.current !== null) return
    lastTick.current = performance.now()
    frame.current = requestAnimationFrame(tick)
  }, [tick])

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!reducedQuery.current && typeof window !== 'undefined' && window.matchMedia) {
        reducedQuery.current = window.matchMedia('(prefers-reduced-motion: reduce)')
      }
      pointer.current =
        axis === 'x' ? { main: e.clientX, cross: e.clientY } : { main: e.clientY, cross: e.clientX }
      ensureRunning()
    },
    [axis, ensureRunning],
  )

  const onMouseLeave = useCallback(() => {
    pointer.current = null
    ensureRunning()
  }, [ensureRunning])

  /**
   * 量出来那半边的作废由头。
   *
   * `size` 换档 = 瓦宽 / 圆角换了一批 token;`edge` 换边 = 换了轴,前缘要重新问;
   * `count` / `sepAfter` / `align` 本身不进那半边(它们是声明,每帧现取),但它们
   * 一变**条的宽度就变**,居中 / 靠后两档的前缘会跟着挪 —— 所以照样得作废重量。
   */
  useEffect(() => {
    metrics.current = null
  }, [count, sepAfter, edge, align, size])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const invalidate = () => {
      metrics.current = null
    }
    // 不用 ResizeObserver 看条自己:条**每一帧都在长**,那样等于每帧作废一次。
    // 真正会挪动锚点的是视口(居中 / 靠后两档的起点跟着它走),所以看视口。
    window.addEventListener('resize', invalidate)
    return () => window.removeEventListener('resize', invalidate)
  }, [])

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
    },
    [],
  )

  return { stripRef: strip, factors: view.factors, shift: view.shift, onMouseMove, onMouseLeave }
}
