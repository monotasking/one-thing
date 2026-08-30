import { useEffect, useState } from 'react'
import { systemPrefersReducedMotion } from './apply'

/**
 * 系统的「减弱动态效果」偏好,作为 React 状态。
 *
 * 只有设置面用得着:面上那枚动效分段器要高亮的是**此刻生效的档**,而没显式选过
 * 时那一档由系统说了算(判据在 types.ts 的 motionTier)。屏幕上真正的换档不走
 * 这条 —— 走 reading/apply.ts 里那个订阅,它连 React 都不需要。
 *
 * 这个 hook 与 apply.ts 里那段订阅**读的是同一个媒体查询**,但职责不同:
 * 那边负责让屏幕跟着变,这边负责让设置面上的高亮跟着变。两处各订一次比让
 * 设置面去问 apply 要一个「当前值」更简单,也不会引入一个跨模块的活状态。
 */
export function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(systemPrefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    onChange()
    // Safari < 14 只有 addListener —— 两条路都走(同 apply.ts)。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    if (typeof query.addListener === 'function') {
      query.addListener(onChange)
      return () => query.removeListener(onChange)
    }
    return undefined
  }, [])

  return reduced
}
