import { useCallback, useEffect, useRef, useState } from 'react'
import { RELEASE_MS } from './motion'

/**
 * Dock 磁性放大 —— 全系统唯一的 hover 位移豁免(动效板·位移豁免清单 ②)。
 *
 * 机制是 macOS 的原法:**改布局尺寸,不用 transform**。瓷砖宽高真的变大,
 * flex 布局自动把邻居推开、Dock 条随之变宽 —— 天然无重叠、无 z 序问题。
 * (曾用 transform: scale 实现过一版:布局位置不变,放大的瓷砖压住左邻、
 * 又被右邻盖住,08-28 用户录屏里"鼓包挤成一坨"就是它。)
 *
 * 坐标系:布局驱动意味着「边测边算」会自激振荡 —— 瓷砖长大推着邻居的中心跑,
 * 中心一跑放大量就变,放大量一变中心又跑。所以进条那一刻把**静止几何冻结**
 * (各瓷砖中心的 clientX),跟手期间一律在静止坐标系里算,离开清冻结。
 * (坑史第一层:offsetLeft 曾量出「瓷砖在 position:relative 的 wrap 里的偏移」
 * = 全 0,六个中心叠在同一点,整条 Dock 同胀同缩。)
 *
 * 跟手定律(动效板):指针在条上时逐帧照算、零过渡;离开才用 --dur-release
 * 缓回静止位。过渡开关由 tracking 经 CSS 类切换。
 *
 * 纯几何:d = |指针 x − 瓷砖静止中心 x|,余弦钟形衰减(08-28 试衣间拍定:
 * 峰圆、半径边缘平滑接 0,macOS 的"波浪感"来自这条),d ≥ RADIUS 归 1。
 * 这些数字是「行为常量」不是样式字面量,所以留在这里而不是 token 文件。
 *
 * 轴向:Dock 停在竖边时条排成一列,「沿条的方向」就从 x 变成 y。变的只有
 * **量哪个坐标** —— 静止中心取 box.top+h/2、指针取 clientY,几何一模一样,
 * 所以 magnifyAt 一个字都不用改(它算的是一维距离,不是横向距离)。
 */
const MAX_GROW = 0.35 // 尺寸最多长大 35%
const RADIUS = 96 // px,影响半径

/** 静止系数:1 = 原尺寸。 */
export const REST_FACTOR = 1

/** 纯函数,给定指针位置与各瓷砖静止中心(同一坐标系),算每块的尺寸系数。 */
export function magnifyAt(pointerX: number, centers: number[]): number[] {
  return centers.map((c) => {
    const d = Math.abs(pointerX - c)
    const k = d >= RADIUS ? 0 : (1 + Math.cos((Math.PI * d) / RADIUS)) / 2
    return 1 + MAX_GROW * k
  })
}

export function useMagnify(count: number, axis: 'x' | 'y' = 'x') {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tiles = useRef<Array<HTMLElement | null>>([])
  const restCenters = useRef<number[] | null>(null)
  const [factors, setFactors] = useState<number[]>(() => Array.from({ length: count }, () => REST_FACTOR))
  const [tracking, setTracking] = useState(false)
  /**
   * 入场那一下**不跟手,先缓一段**(09-01 修「从上/下方进 Dock 突然变大不流畅」)。
   *
   * 跟手定律说的是「指针在条上时逐帧照算、零过渡」,而**入场那一帧**指针是从
   * 1.0 直接落到目标档的:零过渡 = 一帧之内从 44px 蹦到 59px,看上去就是「啪」一下。
   * 所以 tracking 推迟 --dur-release 再上岗:这一段里每次改档都吃 CSS 过渡,
   * 从 1.0 平滑长到目标档;窗口一过转入跟手,后面的逐帧照算一个字没变。
   * (不是把跟手改软 —— 跟手期仍然零过渡,改的只是**第一下**。)
   */
  const rampTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 逐帧合帧:pointermove 一帧能来好几发,系数一帧只算一次、只渲染一次。 */
  const raf = useRef<number | null>(null)
  const pending = useRef<number | null>(null)

  const setTileRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      tiles.current[index] = el
    },
    [],
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const entering = !restCenters.current
      if (entering) {
        // 入场冻结:此刻各 wrap 还在(或几乎在)静止位。量 wrap 而不量瓷砖,
        // 是因为 wrap 的盒子不直接受瓷砖尺寸动画中间态影响得那么剧烈。
        restCenters.current = tiles.current.slice(0, count).map((el) => {
          const box = el?.parentElement?.getBoundingClientRect()
          if (!box) return Number.POSITIVE_INFINITY
          return axis === 'x' ? box.left + box.width / 2 : box.top + box.height / 2
        })
        // 入场缓冲期:先让 CSS 过渡把第一下从 1.0 送到目标档,过后再转跟手。
        if (rampTimer.current) clearTimeout(rampTimer.current)
        rampTimer.current = setTimeout(() => {
          rampTimer.current = null
          setTracking(true)
        }, RELEASE_MS)
      }
      pending.current = axis === 'x' ? e.clientX : e.clientY
      if (raf.current !== null) return
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        const at = pending.current
        if (at === null || !restCenters.current) return
        setFactors(magnifyAt(at, restCenters.current))
      })
    },
    [count, axis],
  )

  const onMouseLeave = useCallback(() => {
    restCenters.current = null
    pending.current = null
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current)
      raf.current = null
    }
    if (rampTimer.current) {
      clearTimeout(rampTimer.current)
      rampTimer.current = null
    }
    setFactors(Array.from({ length: count }, () => REST_FACTOR))
    setTracking(false)
  }, [count])

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
      if (rampTimer.current) clearTimeout(rampTimer.current)
    },
    [],
  )

  return { stripRef, setTileRef, factors, tracking, onMouseMove, onMouseLeave }
}
