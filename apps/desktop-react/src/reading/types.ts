/**
 * 阅读轴的词汇 —— 四根轴,每根一张封闭档表。
 *
 * 档值**就是写进 DOM 属性的那个字符串**(`data-reading-fs="14"` 等)。不搞一层
 * 「语义名 → 属性值」的映射:多一层就多一处可以对不上的地方,而 CSS 那边的
 * `:root[data-reading-fs='14']` 已经是这张表的另一半了。
 */

/** 字号档。值即 px 数 —— CSS 那边 `--pr-fs: 14px` 是它加个单位。 */
export const READING_FONT_SIZES = ['13', '14', '15', '16'] as const
export type ReadingFontSize = (typeof READING_FONT_SIZES)[number]

/** 密度档:留白的节奏。em 系,随字号等比缩放(见 styles/tokens.css 阅读轴一节)。 */
export const READING_DENSITIES = ['compact', 'comfortable', 'relaxed'] as const
export type ReadingDensity = (typeof READING_DENSITIES)[number]

/** 列宽档:一行能有多长。 */
export const READING_COLUMNS = ['standard', 'wide', 'full'] as const
export type ReadingColumn = (typeof READING_COLUMNS)[number]

/** 动效档:装饰时长的缩放。档位表在 styles/motion.css。 */
export const MOTION_TIERS = ['standard', 'calm', 'none'] as const
export type MotionTier = (typeof MOTION_TIERS)[number]

export interface ReadingAxes {
  fontSize: ReadingFontSize
  density: ReadingDensity
  column: ReadingColumn
  /**
   * 动效档的**用户选择**。它与「此刻实际生效的档」不是一回事 ——
   * 没显式选过时,系统的 prefers-reduced-motion 说了算(见 motionTier())。
   */
  motion: MotionTier
  /**
   * 用户是不是**亲手**选过动效档。
   *
   * 为什么要这一格而不是给 motion 一个 'system' 档:'system' 会让「我选了标准」
   * 与「我没选过、系统也没要求减弱」在存盘里长得不一样却表现一样,而用户下次
   * 打开系统的减弱开关时,前者应当**不动**、后者应当跟着变。一个布尔说清楚这件事,
   * 一个第四档说不清楚。
   */
  motionChosen: boolean
}

export const DEFAULT_READING_AXES: ReadingAxes = {
  fontSize: '14',
  density: 'comfortable',
  column: 'standard',
  motion: 'standard',
  motionChosen: false,
}

/** 存盘里读回来的值可能是任何东西(手改过、旧版本、别的应用)。不认识就退回默认。 */
function clamp<T extends string>(table: readonly T[], value: unknown, fallback: T): T {
  return table.includes(value as T) ? (value as T) : fallback
}

export function clampReadingAxes(raw: Partial<ReadingAxes> | undefined): ReadingAxes {
  return {
    fontSize: clamp(READING_FONT_SIZES, raw?.fontSize, DEFAULT_READING_AXES.fontSize),
    density: clamp(READING_DENSITIES, raw?.density, DEFAULT_READING_AXES.density),
    column: clamp(READING_COLUMNS, raw?.column, DEFAULT_READING_AXES.column),
    motion: clamp(MOTION_TIERS, raw?.motion, DEFAULT_READING_AXES.motion),
    motionChosen: raw?.motionChosen === true,
  }
}

/**
 * **此刻生效的动效档** —— 纯函数,系统偏好作为参数递进来(判据可测,取数在外面,
 * 与 theme-source 的 decideTheme 同一条纪律)。
 *
 * 规则一句话:**用户选过就听用户的,没选过就听系统的**。
 * 系统要求减弱而用户没表过态 → none;其余一律就是存着的那一档。
 */
export function motionTier(axes: ReadingAxes, systemPrefersReduced: boolean): MotionTier {
  if (axes.motionChosen) return axes.motion
  return systemPrefersReduced ? 'none' : axes.motion
}
