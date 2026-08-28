import { useCallback, useRef, useState } from 'react'

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
 * 纯几何:d = |指针 x − 瓷砖静止中心 x|,线性衰减到 d ≥ RADIUS 归 1。
 * 这些数字是「行为常量」不是样式字面量,所以留在这里而不是 token 文件。
 */
const MAX_GROW = 0.35 // 尺寸最多长大 35%
const RADIUS = 96 // px,影响半径

/** 静止系数:1 = 原尺寸。 */
export const REST_FACTOR = 1

/** 纯函数,给定指针位置与各瓷砖静止中心(同一坐标系),算每块的尺寸系数。 */
export function magnifyAt(pointerX: number, centers: number[]): number[] {
  return centers.map((c) => {
    const k = Math.max(0, 1 - Math.abs(pointerX - c) / RADIUS)
    return 1 + MAX_GROW * k
  })
}

export function useMagnify(count: number) {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tiles = useRef<Array<HTMLElement | null>>([])
  const restCenters = useRef<number[] | null>(null)
  const [factors, setFactors] = useState<number[]>(() => Array.from({ length: count }, () => REST_FACTOR))
  const [tracking, setTracking] = useState(false)

  const setTileRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      tiles.current[index] = el
    },
    [],
  )

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!restCenters.current) {
        // 入场冻结:此刻各 wrap 还在(或几乎在)静止位。量 wrap 而不量瓷砖,
        // 是因为 wrap 的盒子不直接受瓷砖尺寸动画中间态影响得那么剧烈。
        restCenters.current = tiles.current.slice(0, count).map((el) => {
          const box = el?.parentElement?.getBoundingClientRect()
          return box ? box.left + box.width / 2 : Number.POSITIVE_INFINITY
        })
      }
      setFactors(magnifyAt(e.clientX, restCenters.current))
      setTracking(true)
    },
    [count],
  )

  const onMouseLeave = useCallback(() => {
    restCenters.current = null
    setFactors(Array.from({ length: count }, () => REST_FACTOR))
    setTracking(false)
  }, [count])

  return { stripRef, setTileRef, factors, tracking, onMouseMove, onMouseLeave }
}
