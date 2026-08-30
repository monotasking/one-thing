import { useReadingStore, readingAxes } from './store'
import { motionTier, type MotionTier, type ReadingAxes } from './types'

/**
 * 把四轴贴到 `documentElement` 上 —— 这个文件是**唯一**碰 DOM 的那一半。
 *
 * 贴的是四个属性,不是一堆行内变量:
 *   data-reading-fs / data-reading-density / data-reading-col / data-motion-tier
 * 值全在 styles/tokens.css 与 styles/motion.css 的属性选择器里,所以 JS 这边
 * **一个色值、一个时长都不知道**。这与主题桥那条纪律同源(theme-source.ts):
 * 换一档是换一个属性,不是重算一遍样式。
 *
 * 行内样式(`documentElement.style.setProperty`)是刻意不用的:行内优先级压过
 * 一切样式表,今后主题层想按皮肤微调阅读轴就再没有机会 —— 主题桥吃过这个亏,
 * 判例记在 theme-source.ts 的文件头。
 */

const ATTR_FS = 'data-reading-fs'
const ATTR_DENSITY = 'data-reading-density'
const ATTR_COL = 'data-reading-col'
const ATTR_MOTION = 'data-motion-tier'

/** 系统的减弱偏好。拿不到(非浏览器 / 老引擎)按「没要求」算 —— 不替系统作主。 */
export function systemPrefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface ReadingProbe {
  applied: boolean
  fs?: string
  density?: string
  col?: string
  /** 真正生效的动效档(已经把系统偏好算进去了)。 */
  motion?: MotionTier
}

declare global {
  interface Window {
    __reading?: ReadingProbe
  }
}

const probe: ReadingProbe = { applied: false }
if (typeof window !== 'undefined') window.__reading = probe

/** 贴一次。纯粹的「状态 → 属性」,没有副作用之外的返回值。 */
export function applyReadingAxes(axes: ReadingAxes, systemPrefersReduced: boolean): ReadingProbe {
  if (typeof document === 'undefined') return probe
  const tier = motionTier(axes, systemPrefersReduced)
  const root = document.documentElement
  root.setAttribute(ATTR_FS, axes.fontSize)
  root.setAttribute(ATTR_DENSITY, axes.density)
  root.setAttribute(ATTR_COL, axes.column)
  root.setAttribute(ATTR_MOTION, tier)
  probe.applied = true
  probe.fs = axes.fontSize
  probe.density = axes.density
  probe.col = axes.column
  probe.motion = tier
  return probe
}

let unsubscribe: (() => void) | undefined
let unwatchMedia: (() => void) | undefined

/**
 * 开工:贴一次当下的档,然后订两条来源 —— store 的变化(用户在设置面改了)
 * 与系统减弱偏好的变化(用户在系统设置里改了)。幂等。
 *
 * 在 main.tsx 里排在主题桥之后:两者互不依赖,但**都在 createRoot 之前** ——
 * 首帧就该是最终的字号与列宽,不该先画一屏 14px 再跳成 16px。
 */
export function startReadingAxes(): ReadingProbe {
  const push = () => applyReadingAxes(readingAxes(useReadingStore.getState()), systemPrefersReducedMotion())

  unsubscribe?.()
  unsubscribe = useReadingStore.subscribe(push)

  unwatchMedia?.()
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => push()
    // Safari < 14 只有 addListener。两条路都走 —— 少一条就是在某些机器上静默失效。
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      unwatchMedia = () => query.removeEventListener('change', onChange)
    } else if (typeof query.addListener === 'function') {
      query.addListener(onChange)
      unwatchMedia = () => query.removeListener(onChange)
    }
  }

  return push()
}

/** 测试用:把模块级的一次性状态清干净(同 theme-source 的 reset*ForTest)。 */
export function stopReadingAxesForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  unwatchMedia?.()
  unwatchMedia = undefined
  probe.applied = false
  probe.fs = undefined
  probe.density = undefined
  probe.col = undefined
  probe.motion = undefined
  if (typeof document !== 'undefined') {
    for (const attr of [ATTR_FS, ATTR_DENSITY, ATTR_COL, ATTR_MOTION]) {
      document.documentElement.removeAttribute(attr)
    }
  }
}
