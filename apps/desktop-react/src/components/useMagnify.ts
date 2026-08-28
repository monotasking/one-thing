import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Dock 磁性放大 —— 全系统唯一的位移豁免。
 * 纯几何:d = |指针 x − 瓷砖中心 x|,线性衰减到 d ≥ RADIUS 归 1。
 * 这些数字是「行为常量」不是样式字面量,所以留在这里而不是 token 文件。
 */
const MAX_SCALE = 1.35
const MAX_LIFT = 8 // px,向上
const RADIUS = 96 // px,影响半径

export interface MagnifyTransform {
  scale: number
  lift: number
}

const REST: MagnifyTransform = { scale: 1, lift: 0 }

/** 纯函数,便于将来单测:给定指针位置与各瓷砖中心,算出每块的形变。 */
export function magnifyAt(pointerX: number, centers: number[]): MagnifyTransform[] {
  return centers.map((c) => {
    const k = Math.max(0, 1 - Math.abs(pointerX - c) / RADIUS)
    return { scale: 1 + (MAX_SCALE - 1) * k, lift: -MAX_LIFT * k }
  })
}

export function useMagnify(count: number) {
  const stripRef = useRef<HTMLDivElement | null>(null)
  const tiles = useRef<Array<HTMLElement | null>>([])
  const [transforms, setTransforms] = useState<MagnifyTransform[]>(() => Array.from({ length: count }, () => REST))

  useEffect(() => {
    tiles.current.length = count
    setTransforms(Array.from({ length: count }, () => REST))
  }, [count])

  const setTileRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      tiles.current[index] = el
    },
    [],
  )

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const strip = stripRef.current
    if (!strip) return
    const x = e.clientX - strip.getBoundingClientRect().left
    // offsetLeft/offsetWidth 是布局值,不受自身 transform 影响 —— 中心点因此稳定,
    // 否则放大会推着中心跑,产生自激振荡。
    const centers = tiles.current.map((el) => (el ? el.offsetLeft + el.offsetWidth / 2 : Number.POSITIVE_INFINITY))
    setTransforms(magnifyAt(x, centers))
  }, [])

  const onMouseLeave = useCallback(() => {
    setTransforms(Array.from({ length: count }, () => REST))
  }, [count])

  return { stripRef, setTileRef, transforms, onMouseMove, onMouseLeave }
}
