import { clampRgb, converter, formatHex, wcagContrast } from 'culori'
import type { CuloriColor } from 'culori'

export type ThemeColorScheme = 'dark' | 'light'

export interface ParsedColor {
  red: number
  green: number
  blue: number
  alpha: number
}

export interface ThemeSurfaceRoleInput {
  colorScheme: ThemeColorScheme
  app?: string
  sidebar?: string
  chat?: string
  panel?: string
  elevated?: string
  floating?: string
  primaryText?: string
}

export interface ThemeSurfaceRoles {
  appBg: string
  sidebarBg: string
  chatBg: string
  panelBg: string
  tabBarBg: string
  elevatedBg: string
  floatingBg: string
}

export interface NeutralTextRamp {
  primaryText: string
  regularText: string
  secondaryText: string
  placeholderText: string
  disabledText: string
}

export interface StatusSurfaceRamp {
  bg: string
  bgHover: string
  border: string
}

export interface StateOverlayRamp {
  hover: string
  active: string
  selected: {
    bg: string
    border: string
  }
  selectedHover: string
}

/**
 * 区域交互态「墨阶」配方 —— 唯一出处(UI 系统收敛 P4)。
 *
 * `deriveStateOverlays()` 的 OKLCH 亮度偏移适合"面"级状态(chat/panel/tabbar),
 * 但列表行需要**同一条墨色**上的等比阶梯:分组头(全墨)> 行文(72%)>
 * active(14%)> hover(8%)> 底(2.5%)。直接引各主题的 state token 时这几档的
 * 相对关系不可控(实测:分组头与行文同色、hover 看不见),所以 sidebar 从一开始
 * 就在 renderer 里手写了这条派生链。P4 把它原值搬到主题层,组件端只引用 token。
 *
 * 百分比即 renderer 侧 `color-mix(in srgb, <ink> P%, transparent)` 的 P ——
 * 行画在自己的区域底色上,所以"P% 墨 + 透明"合成后等于"P% 墨混区域底色",
 * 主题层直接算成实色,像素不变而 token 可解析(gallery 回归要求实色)。
 */
export const REGION_OVERLAY_STEPS = {
  /** sidebar 列表行:静息文字 */
  sidebarRowFg: 72,
  /** sidebar 列表行:hover 底 */
  sidebarRowHover: 8,
  /** sidebar 列表行:选中底 */
  sidebarRowActive: 14,
  /** rail / ActiveWorkCard 这类嵌套面:自身底 */
  sidebarRailBg: 2.5,
  /** rail / ActiveWorkCard:hover 底 */
  sidebarRailHover: 4.5,
  /** rail / ActiveWorkCard:当前项底 */
  sidebarRailActive: 7.5,
  /** rail / ActiveWorkCard:次要文字 */
  sidebarRailMuted: 47,
  /** 设置区行:hover 底(accent 墨) */
  settingsRowHover: 5,
  /** 设置区行:选中底(accent 墨) */
  settingsRowActive: 10,
  /**
   * 通用「叠 accent 淡底」的 hover 档(accent 墨,画在 panel 面上)。
   *
   * 它不是 settings 分支的别名 —— 全窗那一大批手写
   * `color-mix(in srgb, var(--accent) N%, transparent)` 的 hover/强调底走这一档:
   * 存量实测 N 的众数就是 10(x20),次高 8(x9),所以档位取 10 而不是另立新数。
   * 如实记:它与 `settingsRowActive` 的百分比恰好同为 10,于是两枚 token 在同一
   * 张面上解析出**同一个实色** —— 那是阶梯撞在同一格的巧合,不是别名,两族各自
   * 独立演进(设置行选中要变时不该被这条 hover 拽住)。
   */
  stateHoverAccent: 10,
  /** 同一族的重档:强调行 / 当前项这类要压住的底(存量 15/16/18 三簇的中位)。 */
  stateHoverAccentStrong: 16,
  /**
   * 「hover 底上再进一档」(中性墨,**画在 `--ui-state-hover-bg` 上**)。
   *
   * 补的是波 3 点名的那个缺口:有一批控件的**静息**底本身就已经是
   * `--ui-state-hover-bg`(markdown 的 collab-tag 是原型),它们的 hover 无处可去 ——
   * 迁中性档两态同色、hover 归零,换 `--ui-state-active-bg` 又是按下态(换档不是归位)。
   *
   * 定值 8:全仓「加深一档」的存量常数就是 8(`color-mix(<静息底> 92%, <墨>)` 四处:
   * ActiveWorkCard / Sidebar 房间行 / SessionItem / ModelSelector),collab-tag 自己
   * 手写的也正是墨 8%,只有 Select 的 selected:hover 取 94/6。取众数 8 而不是另立新数。
   *
   * 与前面几档的**基面不同**:这一档压在 hover 底上而不是区域底色上 —— 语义就是
   * "已经在 hover 底上了,再进一档",所以 state-overlay-audit 里它的对照面是
   * `--ui-state-hover-bg`(实测 ΔRGB 中位 15.2 / 最小 12.3,36 组合无一低于门槛)。
   */
  stateHoverRaised: 8,
} as const

export type RegionOverlayStep = keyof typeof REGION_OVERLAY_STEPS

/**
 * 把一档墨阶解析成实色:`percent%` 的 ink 压在 `surface` 上。
 * 任一端解析不出来就返回 undefined —— 调用方保留原有回退链。
 */
export function deriveRegionOverlay(
  ink: string | undefined,
  surface: string | undefined,
  step: RegionOverlayStep
): string | undefined {
  return mixCssColors(ink, surface, REGION_OVERLAY_STEPS[step] / 100)
}

export interface CategoryColor {
  icon: string
  badgeBg: string
  badgeText: string
}

const toOklch = converter('oklch')
const toRgb = converter('rgb')

const CATEGORY_SOURCE_PATHS = [
  ['b30.purple', 'purple', 'base0E', 'text.code.keyword'],
  ['b30.cyan', 'cyan', 'base0C', 'text.code.type', 'text.link', 'color.info'],
  ['b30.green', 'green', 'base0B', 'text.code.string', 'color.success'],
  ['b30.orange', 'orange', 'base09', 'text.code.number', 'color.warning'],
  ['b30.yellow', 'yellow', 'base0A'],
  ['b30.brown', 'brown', 'base0F'],
  ['b30.blue', 'blue', 'b30.nord_blue', 'nord_blue', 'base0D'],
] as const

const CATEGORY_FALLBACK_COLORS = [
  '#8B6FC8',
  '#2D9C96',
  '#6F8F2F',
  '#C77832',
  '#A08B28',
  '#A85F7A',
  '#4B83B9',
] as const

const CATEGORY_MIN_ICON_CONTRAST = 3
const CATEGORY_HUE_COLLISION_THRESHOLD = 25
const CATEGORY_EXTENDED_HUE_COLLISION_THRESHOLD = 18
const CATEGORY_CHROMA_SCALE: Record<ThemeColorScheme, number> = {
  light: 0.7,
  dark: 0.55,
}

const CATEGORY_MAX_CHROMA: Record<ThemeColorScheme, number> = {
  light: 0.105,
  dark: 0.082,
}

const NEUTRAL_TEXT_TARGETS = [
  { token: 'primaryText', contrast: 12, chromaScale: 1 },
  { token: 'regularText', contrast: 8, chromaScale: 0.9 },
  { token: 'secondaryText', contrast: 4.5, chromaScale: 0.8 },
  { token: 'placeholderText', contrast: 3, chromaScale: 0.7 },
  { token: 'disabledText', contrast: 2, chromaScale: 0.6 },
] as const satisfies ReadonlyArray<{
  token: keyof NeutralTextRamp
  contrast: number
  chromaScale: number
}>

const STATUS_SURFACE_RAMP_STOPS = {
  light: [
    { token: 'bg', lightnessOffset: 0.025, chromaScale: 0.18 },
    { token: 'bgHover', lightnessOffset: 0.055, chromaScale: 0.24 },
    { token: 'border', lightnessOffset: 0.105, chromaScale: 0.34 },
  ],
  dark: [
    { token: 'bg', lightnessOffset: 0.035, chromaScale: 0.2 },
    { token: 'bgHover', lightnessOffset: 0.065, chromaScale: 0.28 },
    { token: 'border', lightnessOffset: 0.115, chromaScale: 0.4 },
  ],
} as const satisfies Record<ThemeColorScheme, ReadonlyArray<{
  token: keyof StatusSurfaceRamp
  lightnessOffset: number
  chromaScale: number
}>>

const STATE_LIGHTNESS_OFFSETS = {
  light: {
    hover: -0.04,
    active: -0.07,
    selected: -0.05,
  },
  dark: {
    hover: 0.03,
    active: 0.055,
    selected: 0.04,
  },
} as const satisfies Record<ThemeColorScheme, {
  hover: number
  active: number
  selected: number
}>

export function firstDefinedColor(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(color => typeof color === 'string' && color.length > 0)
}

export function parseCssColor(value: string | undefined): ParsedColor | null {
  if (!value) return null

  const trimmed = value.trim()
  if (trimmed === 'transparent') {
    return { red: 0, green: 0, blue: 0, alpha: 0 }
  }

  const shortHexMatch = /^#([0-9a-f]{3})$/i.exec(trimmed)
  if (shortHexMatch) {
    const [, hex] = shortHexMatch
    return {
      red: Number.parseInt(hex[0] + hex[0], 16),
      green: Number.parseInt(hex[1] + hex[1], 16),
      blue: Number.parseInt(hex[2] + hex[2], 16),
      alpha: 1,
    }
  }

  const hexMatch = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(trimmed)
  if (hexMatch) {
    const [, hex, alphaHex] = hexMatch
    const numericValue = Number.parseInt(hex, 16)
    return {
      red: (numericValue >> 16) & 255,
      green: (numericValue >> 8) & 255,
      blue: numericValue & 255,
      alpha: alphaHex ? Number.parseInt(alphaHex, 16) / 255 : 1,
    }
  }

  const rgbMatch = /^rgba?\((.+)\)$/i.exec(trimmed)
  if (rgbMatch) {
    const body = rgbMatch[1].replace(/\s*\/\s*/g, ', ')
    const parts = body.includes(',')
      ? body.split(',').map(part => part.trim())
      : body.split(/\s+/)
    if (parts.length < 3) return null

    return {
      red: Number.parseFloat(parts[0]),
      green: Number.parseFloat(parts[1]),
      blue: Number.parseFloat(parts[2]),
      alpha: parts[3] === undefined ? 1 : Number.parseFloat(parts[3]),
    }
  }

  return null
}

export function compositeColor(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 }

  return {
    red: ((foreground.red * foreground.alpha) + (background.red * background.alpha * (1 - foreground.alpha))) / alpha,
    green: ((foreground.green * foreground.alpha) + (background.green * background.alpha * (1 - foreground.alpha))) / alpha,
    blue: ((foreground.blue * foreground.alpha) + (background.blue * background.alpha * (1 - foreground.alpha))) / alpha,
    alpha,
  }
}

export function resolveColorOverBackground(value: string | undefined, background: string | undefined): ParsedColor | null {
  const color = parseCssColor(value)
  const backgroundColor = parseCssColor(background)
  if (!color || !backgroundColor) return null
  return color.alpha < 1 ? compositeColor(color, backgroundColor) : color
}

export function colorToRgbString(color: ParsedColor | null): string | undefined {
  if (!color) return undefined
  return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`
}

export function colorToHex(color: ParsedColor): string {
  return `#${[color.red, color.green, color.blue]
    .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`
}

export function relativeLuminance(color: ParsedColor): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map(channel => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

export function contrastRatio(foreground: ParsedColor, background: ParsedColor): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

export function colorDistance(first: ParsedColor, second: ParsedColor): number {
  return Math.abs(first.red - second.red)
    + Math.abs(first.green - second.green)
    + Math.abs(first.blue - second.blue)
}

export function colorMeetsContrast(
  foreground: string | undefined,
  background: string | undefined,
  minContrast: number
): foreground is string {
  const foregroundColor = resolveColorOverBackground(foreground, background)
  const backgroundColor = parseCssColor(background)
  return Boolean(foregroundColor && backgroundColor && contrastRatio(foregroundColor, backgroundColor) >= minContrast)
}

export function readableAgainst(
  background: string | undefined,
  candidates: Array<string | undefined>,
  fallback: string | undefined,
  minimumContrast: number
): string | undefined {
  const backgroundColor = parseCssColor(background)
  if (!backgroundColor) {
    return candidates.find(Boolean) || fallback
  }

  let bestValue: string | undefined
  let bestContrast = -1

  for (const candidate of candidates) {
    const candidateColor = resolveColorOverBackground(candidate, background)
    if (!candidate || !candidateColor) continue

    const contrast = contrastRatio(candidateColor, backgroundColor)
    if (contrast >= minimumContrast) return candidate
    if (contrast > bestContrast) {
      bestContrast = contrast
      bestValue = candidate
    }
  }

  return bestValue || fallback || candidates.find(Boolean)
}

export function mixCssColors(
  foreground: string | undefined,
  background: string | undefined,
  foregroundWeight: number
): string | undefined {
  const foregroundColor = parseCssColor(foreground)
  const backgroundColor = parseCssColor(background)
  if (!foregroundColor || !backgroundColor) return undefined

  const weight = Math.min(1, Math.max(0, foregroundWeight))
  return colorToHex({
    red: (foregroundColor.red * weight) + (backgroundColor.red * (1 - weight)),
    green: (foregroundColor.green * weight) + (backgroundColor.green * (1 - weight)),
    blue: (foregroundColor.blue * weight) + (backgroundColor.blue * (1 - weight)),
    alpha: 1,
  })
}

export function guaranteeMinMixOpacity(
  baseColor: string | undefined,
  backgroundColor: string | undefined,
  currentPercent: number,
  minPerceivedDelta = 0.02
): number {
  if (!baseColor || !backgroundColor) return currentPercent

  const baseOklch = toOklch(baseColor)
  const backgroundOklch = toOklch(backgroundColor)
  if (
    !baseOklch
    || !backgroundOklch
    || !isFiniteNumber(baseOklch.l)
    || !isFiniteNumber(backgroundOklch.l)
  ) {
    return currentPercent
  }

  const current = Math.min(100, Math.max(0, currentPercent))
  const fullDelta = Math.abs(baseOklch.l - backgroundOklch.l)
  if (fullDelta === 0 || !Number.isFinite(fullDelta)) return current
  if (fullDelta * (current / 100) >= minPerceivedDelta) return current

  return Math.min(100, Math.max(current, (minPerceivedDelta / fullDelta) * 100))
}

export function rgbaFromCssColor(value: string | undefined, alpha: number, fallbackRgb = '67, 133, 190'): string {
  const color = parseCssColor(value)
  if (!color) return `rgba(${fallbackRgb}, ${alpha})`
  return `rgba(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}, ${alpha})`
}

export function neutralOverlay(colorScheme: ThemeColorScheme, alpha: number): string {
  return colorScheme === 'dark'
    ? `rgba(255, 255, 255, ${alpha})`
    : `rgba(0, 0, 0, ${alpha})`
}

export function readableColor(
  background: string,
  candidates: Array<string | undefined>,
  fallback: string,
  minContrast = 4.5,
  preferredWeight = 0.72
): string {
  for (const candidate of candidates) {
    if (colorMeetsContrast(candidate, background, minContrast)) return candidate
  }

  const base = firstDefinedColor(...candidates) || fallback
  for (let weight = preferredWeight; weight <= 1; weight += 0.04) {
    const mixed = mixCssColors(base, background, weight)
    if (colorMeetsContrast(mixed, background, minContrast)) return mixed
  }

  return fallback
}

/**
 * Ensures `candidate` is at least `minDelta` apart from `anchor` in OKLCH lightness.
 * In dark mode, candidate should be lighter than anchor (direction = +1).
 * In light mode, candidate should be darker (direction = -1).
 * If the existing delta is already sufficient, returns candidate unchanged (respects theme author).
 * If insufficient, bumps L while preserving the candidate's chroma and hue.
 */
export function guaranteeMinDeltaL(
  anchor: string | undefined,
  candidate: string | undefined,
  minDelta: number,
  isDark: boolean
): string | undefined {
  if (!candidate || !anchor) return candidate
  const anchorOklch = parseOklchColor(anchor)
  const candidateOklch = parseOklchColor(candidate)
  if (!anchorOklch || !candidateOklch) return candidate
  const direction = isDark ? 1 : -1
  const delta = direction * (candidateOklch.lightness - anchorOklch.lightness)
  if (delta >= minDelta) return candidate
  // +0.003 buffer: oklchColor() round-trips through 8-bit hex, losing up to ~0.002 in OKLCH l
  const newL = clampUnit(anchorOklch.lightness + direction * (minDelta + 0.003))
  return oklchColor(newL, candidateOklch.chroma, candidateOklch.hue) ?? candidate
}

function absDeltaL(anchor: string, candidate: string | undefined): number | null {
  const anchorOklch = parseOklchColor(anchor)
  const candidateOklch = parseOklchColor(candidate)
  if (!anchorOklch || !candidateOklch) return null
  return Math.abs(candidateOklch.lightness - anchorOklch.lightness)
}

/**
 * Like guaranteeMinDeltaL, but keeps theme-authored surfaces that are already
 * `minDelta` apart in either direction (e.g. a deliberately recessed input that
 * sits darker than the chat surface in dark mode). When a bump is needed it
 * preserves the author's layering direction, falling back to the mode's raised
 * direction only on exact ties or when clamping prevents reaching the delta.
 * Non-opaque candidates are left alone: their painted lightness depends on
 * what they composite over, so an OKLCH-L comparison would be meaningless.
 */
export function guaranteeMinAbsDeltaL(
  anchor: string | undefined,
  candidate: string | undefined,
  minDelta: number,
  isDark: boolean
): string | undefined {
  if (!candidate || !anchor) return candidate
  const parsedCandidate = parseCssColor(candidate)
  if (parsedCandidate && parsedCandidate.alpha < 0.999) return candidate
  const anchorOklch = parseOklchColor(anchor)
  const candidateOklch = parseOklchColor(candidate)
  if (!anchorOklch || !candidateOklch) return candidate

  const delta = candidateOklch.lightness - anchorOklch.lightness
  if (Math.abs(delta) >= minDelta) return candidate

  const preferredDirection = delta === 0 ? isDark : delta > 0
  const bumped = guaranteeMinDeltaL(anchor, candidate, minDelta, preferredDirection)
  const bumpedDelta = bumped === undefined ? null : absDeltaL(anchor, bumped)
  if (bumpedDelta !== null && bumpedDelta >= minDelta - 0.005) return bumped

  // Clamping at the L extremes blocked the preferred direction; push the other way.
  return guaranteeMinDeltaL(anchor, candidate, minDelta, !preferredDirection)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function oklchColor(lightness: number, chroma: number, hue: number | undefined): string | undefined {
  const color: CuloriColor = {
    mode: 'oklch',
    l: clampUnit(lightness),
    c: Math.max(0, chroma),
  }
  if (isFiniteNumber(hue)) color.h = hue

  const rgb = toRgb(color)
  if (!rgb) return undefined

  return formatHex(clampRgb(rgb)).toUpperCase()
}

function oklchTextColor(lightness: number, chroma: number, hue: number | undefined): string | undefined {
  return oklchColor(lightness, chroma, hue)
}

function parseOklchColor(value: string | undefined): {
  lightness: number
  chroma: number
  hue: number | undefined
} | undefined {
  if (!value) return undefined
  const color = toOklch(value)
  if (!color || !isFiniteNumber(color.l)) return undefined

  return {
    lightness: color.l,
    chroma: isFiniteNumber(color.c) ? color.c : 0,
    hue: isFiniteNumber(color.h) ? color.h : undefined,
  }
}

function categoryColorCandidate(
  themeColors: Record<string, string | undefined>,
  index: number
): string {
  const paths = CATEGORY_SOURCE_PATHS[index % CATEGORY_SOURCE_PATHS.length] || CATEGORY_SOURCE_PATHS[0]
  for (const path of paths) {
    const color = themeColors[path]
    if (color && parseOklchColor(color)) return color
  }
  return CATEGORY_FALLBACK_COLORS[index % CATEGORY_FALLBACK_COLORS.length]
}

function softenCategoryColor(color: string, mode: ThemeColorScheme): string {
  const oklch = parseOklchColor(color)
  if (!oklch) return color

  const chroma = Math.min(
    oklch.chroma * CATEGORY_CHROMA_SCALE[mode],
    CATEGORY_MAX_CHROMA[mode]
  )
  return oklchColor(oklch.lightness, chroma, oklch.hue) || color
}

function categoryContrastColor(
  color: string,
  background: string,
  mode: ThemeColorScheme,
  minContrast = CATEGORY_MIN_ICON_CONTRAST
): string {
  if (colorMeetsContrast(color, background, minContrast)) return color

  const oklch = parseOklchColor(color)
  if (!oklch) return color

  const direction = mode === 'dark' ? 1 : -1
  let bestColor: string = color
  let bestContrast = contrastWithBackground(color, background)

  for (let step = 1; step <= 36; step += 1) {
    const lightness = oklch.lightness + (direction * step * 0.025)
    const candidate = oklchColor(lightness, oklch.chroma, oklch.hue)
    const contrast = contrastWithBackground(candidate, background)
    if (contrast > bestContrast && candidate) {
      bestColor = candidate
      bestContrast = contrast
    }
    if (candidate && colorMeetsContrast(candidate, background, minContrast)) return candidate
  }

  return bestColor
}

function normalizeCategoryIconColor(
  color: string,
  background: string | undefined,
  mode: ThemeColorScheme
): string {
  const softened = softenCategoryColor(color, mode)
  if (!background || !parseCssColor(background)) return softened
  return categoryContrastColor(softened, background, mode)
}

function hueDistance(first: number, second: number): number {
  const distance = Math.abs(first - second) % 360
  return distance > 180 ? 360 - distance : distance
}

function categoryColorsHaveHueCollision(colors: string[]): boolean {
  const hues = colors.map(color => parseOklchColor(color)?.hue)
  if (hues.some(hue => !isFiniteNumber(hue))) return true
  const threshold = colors.length > 4
    ? CATEGORY_EXTENDED_HUE_COLLISION_THRESHOLD
    : CATEGORY_HUE_COLLISION_THRESHOLD

  for (let first = 0; first < hues.length; first += 1) {
    for (let second = first + 1; second < hues.length; second += 1) {
      if (hueDistance(hues[first]!, hues[second]!) < threshold) {
        return true
      }
    }
  }

  return false
}

function deriveCategoryBadgeBg(icon: string, mode: ThemeColorScheme): string {
  const oklch = parseOklchColor(icon)
  if (!oklch) return icon

  const lightness = mode === 'dark'
    ? Math.min(0.34, Math.max(0.18, oklch.lightness - 0.36))
    : Math.max(0.88, Math.min(0.97, oklch.lightness + 0.38))
  const chroma = Math.min(oklch.chroma * (mode === 'dark' ? 0.32 : 0.24), 0.045)

  return oklchColor(lightness, chroma, oklch.hue) || icon
}

function deriveCategoryBadgeText(icon: string, badgeBg: string, mode: ThemeColorScheme): string {
  const oklch = parseOklchColor(icon)
  if (!oklch) return icon

  const preferredLightness = mode === 'dark'
    ? Math.min(0.9, Math.max(0.72, oklch.lightness + 0.12))
    : Math.max(0.24, Math.min(0.42, oklch.lightness - 0.28))
  const preferred = oklchColor(preferredLightness, oklch.chroma * (mode === 'dark' ? 0.76 : 0.9), oklch.hue) || icon

  if (colorMeetsContrast(preferred, badgeBg, 3)) return preferred
  return categoryContrastColor(preferred, badgeBg, mode === 'dark' ? 'dark' : 'light', 3)
}

function completeCategoryColor(icon: string, mode: ThemeColorScheme): CategoryColor {
  const badgeBg = deriveCategoryBadgeBg(icon, mode)
  const badgeText = deriveCategoryBadgeText(icon, badgeBg, mode)
  return { icon, badgeBg, badgeText }
}

function categoryBackgroundAt(
  background: string | undefined | Array<string | undefined>,
  index: number
): string | undefined {
  return Array.isArray(background) ? background[index] : background
}

export function deriveCategoryColors(
  themeColors: Record<string, string | undefined>,
  background: string | undefined | Array<string | undefined>,
  mode: ThemeColorScheme = 'light',
  count = 4
): CategoryColor[] {
  const requestedCount = Math.max(0, Math.floor(count))
  const icons = Array.from({ length: requestedCount }, (_, index) => (
    normalizeCategoryIconColor(categoryColorCandidate(themeColors, index), categoryBackgroundAt(background, index), mode)
  ))

  const finalIcons = categoryColorsHaveHueCollision(icons)
    ? Array.from({ length: requestedCount }, (_, index) => (
      normalizeCategoryIconColor(CATEGORY_FALLBACK_COLORS[index % CATEGORY_FALLBACK_COLORS.length], categoryBackgroundAt(background, index), mode)
    ))
    : icons

  return finalIcons.map(icon => completeCategoryColor(icon, mode))
}

/**
 * 状态叠加可用的亮度区间。端点附近 oklch→sRGB 会被裁,三档全挤成同一个颜色
 * (P4a 审计实测:把浅色主题按 dark 模式解析时 hover 与底只差 ΔRGB 1,
 * 且 hover 与 selected 完全同色)。留出余量,没余量就整组反向走。
 */
const STATE_LIGHTNESS_BOUNDS = { min: 0.03, max: 0.97 } as const

/**
 * 决定这一组状态往哪边走(+1 变亮 / -1 变暗)。
 *
 * **整组同向**是关键:逐档各自判断会出现"hover 变亮、active 变暗",阶梯当场断掉。
 * 所以拿最大的一档(active)探路 —— 正向撞端点就整组反向,两边都没余量就往
 * 区间中间走。默认方向下有余量时返回的就是原来的符号,既有 16 主题逐位不变。
 */
function stateOverlayDirection(
  baseLightness: number,
  offsets: { hover: number; active: number; selected: number }
): number {
  const maxStep = Math.max(Math.abs(offsets.hover), Math.abs(offsets.active), Math.abs(offsets.selected))
  const sign = offsets.active >= 0 ? 1 : -1
  const inBounds = (value: number): boolean => (
    value >= STATE_LIGHTNESS_BOUNDS.min && value <= STATE_LIGHTNESS_BOUNDS.max
  )

  if (inBounds(baseLightness + (sign * maxStep))) return sign
  if (inBounds(baseLightness - (sign * maxStep))) return -sign
  return baseLightness > 0.5 ? -1 : 1
}

export function deriveStateOverlays(
  surfaceColor: string | undefined,
  primaryColor: string | undefined,
  mode: ThemeColorScheme = 'light'
): StateOverlayRamp | undefined {
  if (!surfaceColor || !primaryColor) return undefined

  const surfaceOklch = toOklch(surfaceColor)
  if (!surfaceOklch || !isFiniteNumber(surfaceOklch.l)) return undefined

  const hue = isFiniteNumber(surfaceOklch.h) ? surfaceOklch.h : undefined
  const chroma = isFiniteNumber(surfaceOklch.c) ? surfaceOklch.c : 0
  const baseLightness = surfaceOklch.l
  const offsets = STATE_LIGHTNESS_OFFSETS[mode]
  const direction = stateOverlayDirection(baseLightness, offsets)
  const step = (offset: number): number => baseLightness + (direction * Math.abs(offset))
  const hover = oklchColor(step(offsets.hover), chroma, hue)
  const active = oklchColor(step(offsets.active), chroma, hue)
  const selectedBg = oklchColor(step(offsets.selected), chroma, hue)

  if (!hover || !active || !selectedBg) return undefined

  return {
    hover,
    active,
    selected: {
      bg: selectedBg,
      border: primaryColor,
    },
    selectedHover: active,
  }
}

function contrastWithBackground(color: string | undefined, background: string): number {
  if (!color) return -1
  try {
    const contrast = wcagContrast(color, background)
    return Number.isFinite(contrast) ? contrast : -1
  } catch {
    return -1
  }
}

function selectNeutralTextEndLightness(
  background: string,
  backgroundLightness: number,
  preferredLightness: number,
  chroma: number,
  hue: number | undefined,
  targetContrast: number,
  mode: ThemeColorScheme
): number {
  const modeExtreme = mode === 'dark' ? 1 : 0
  const preferredExtreme = preferredLightness >= backgroundLightness ? 1 : 0
  const candidates = Array.from(new Set([
    preferredLightness,
    preferredExtreme,
    modeExtreme,
    0,
    1,
  ].map(lightness => clampUnit(lightness))))
    .map(lightness => ({
      lightness,
      contrast: contrastWithBackground(
        oklchTextColor(lightness, chroma, hue),
        background
      ),
    }))
    .sort((a, b) => {
      const aMeetsTarget = a.contrast >= targetContrast
      const bMeetsTarget = b.contrast >= targetContrast
      if (aMeetsTarget !== bMeetsTarget) return aMeetsTarget ? -1 : 1
      return b.contrast - a.contrast
    })

  return candidates[0]?.lightness ?? preferredLightness
}

function findContrastDrivenNeutralText(
  background: string,
  backgroundLightness: number,
  endLightness: number,
  chroma: number,
  hue: number | undefined,
  targetContrast: number,
  usedColors: Set<string>
): string | undefined {
  let endColor = oklchTextColor(endLightness, chroma, hue)
  if (!endColor) return undefined

  const endContrast = contrastWithBackground(endColor, background)
  if (endContrast < targetContrast) {
    return endColor
  }

  let low = 0
  let high = 1
  let bestColor = endColor
  let bestPosition = 1

  for (let index = 0; index < 24; index += 1) {
    const mid = (low + high) / 2
    const lightness = backgroundLightness + ((endLightness - backgroundLightness) * mid)
    const candidate = oklchTextColor(lightness, chroma, hue)
    const contrast = contrastWithBackground(candidate, background)

    if (candidate && contrast >= targetContrast) {
      bestColor = candidate
      bestPosition = mid
      high = mid
    } else {
      low = mid
    }
  }

  if (!usedColors.has(bestColor)) return bestColor

  for (let position = bestPosition + 0.01; position <= 1; position += 0.01) {
    const lightness = backgroundLightness + ((endLightness - backgroundLightness) * position)
    const candidate = oklchTextColor(lightness, chroma, hue)
    if (!candidate || usedColors.has(candidate)) continue
    if (contrastWithBackground(candidate, background) >= targetContrast) return candidate
  }

  endColor = oklchTextColor(endLightness, chroma, hue)
  return endColor && !usedColors.has(endColor) ? endColor : bestColor
}

export function deriveStatusSurfaceRamp(
  baseColor: string | undefined,
  surface: string | undefined,
  mode: ThemeColorScheme = 'light'
): StatusSurfaceRamp | undefined {
  if (!baseColor || !surface) {
    return undefined
  }

  const baseOklch = toOklch(baseColor)
  const surfaceOklch = toOklch(surface)
  if (
    !baseOklch ||
    !surfaceOklch ||
    !isFiniteNumber(surfaceOklch.l)
  ) {
    return undefined
  }

  const hue = isFiniteNumber(baseOklch.h) ? baseOklch.h : undefined
  const baseChroma = isFiniteNumber(baseOklch.c) ? baseOklch.c : 0
  const direction = mode === 'dark' ? 1 : -1
  const ramp = {} as StatusSurfaceRamp

  for (const stop of STATUS_SURFACE_RAMP_STOPS[mode]) {
    const lightness = surfaceOklch.l + (direction * stop.lightnessOffset)
    const color = oklchColor(lightness, baseChroma * stop.chromaScale, hue)
    if (!color) return undefined
    ramp[stop.token] = color
  }

  return ramp
}

export function nudgeDangerColorTowardRed(baseColor: string): string {
  const oklch = parseOklchColor(baseColor)
  if (!oklch || !isFiniteNumber(oklch.hue)) return baseColor

  const hue = ((oklch.hue % 360) + 360) % 360
  if (hue < 35 || hue > 85) return baseColor

  const redHue = 25
  const correctedHue = redHue + ((hue - redHue) * 0.25)
  return oklchColor(oklch.lightness, oklch.chroma, correctedHue) || baseColor
}

export function deriveNeutralTextRamp(
  foreground: string | undefined,
  background: string | undefined,
  mode: ThemeColorScheme = 'light'
): NeutralTextRamp | undefined {
  if (!foreground || !background) {
    return undefined
  }

  const foregroundOklch = toOklch(foreground)
  const backgroundOklch = toOklch(background)
  if (
    !foregroundOklch ||
    !backgroundOklch ||
    !isFiniteNumber(foregroundOklch.l) ||
    !isFiniteNumber(backgroundOklch.l)
  ) {
    return undefined
  }

  const hue = isFiniteNumber(foregroundOklch.h) ? foregroundOklch.h : undefined
  const baseChroma = isFiniteNumber(foregroundOklch.c) ? foregroundOklch.c : 0
  const usedColors = new Set<string>()
  const ramp = {} as NeutralTextRamp

  for (const target of NEUTRAL_TEXT_TARGETS) {
    const chroma = baseChroma * target.chromaScale
    const endLightness = selectNeutralTextEndLightness(
      background,
      backgroundOklch.l,
      foregroundOklch.l,
      chroma,
      hue,
      target.contrast,
      mode
    )
    const color = findContrastDrivenNeutralText(
      background,
      backgroundOklch.l,
      endLightness,
      chroma,
      hue,
      target.contrast,
      usedColors
    )
    const fallback = readableColor(background, [foreground, '#000000', '#FFFFFF'], foreground, Math.min(target.contrast, 4.5))

    ramp[target.token] = color || fallback
    usedColors.add(ramp[target.token])
  }

  return ramp
}

function surfaceDistance(first: string | undefined, second: string | undefined): number | null {
  const firstColor = parseCssColor(first)
  const secondColor = parseCssColor(second)
  if (!firstColor || !secondColor) return null
  return colorDistance(firstColor, secondColor)
}

function surfaceLuminance(value: string | undefined): number | null {
  const color = parseCssColor(value)
  return color ? relativeLuminance(color) : null
}

function isDistinctSurface(
  candidate: string | undefined,
  base: string,
  minDistance: number
): candidate is string {
  if (!candidate) return false
  if (candidate === base) return false

  const distance = surfaceDistance(candidate, base)
  return distance === null || distance >= minDistance
}

function deriveRaisedSurface(
  base: string,
  primaryText: string,
  strength: number
): string {
  return mixCssColors(primaryText, base, strength) || base
}

function ensureDistinctSurface(
  current: string,
  base: string,
  candidates: Array<string | undefined>,
  primaryText: string,
  strength: number,
  minDistance = 8
): string {
  if (isDistinctSurface(current, base, minDistance)) return current

  for (const candidate of candidates) {
    if (isDistinctSurface(candidate, base, minDistance)) return candidate
  }

  const mixed = deriveRaisedSurface(base, primaryText, strength)
  return isDistinctSurface(mixed, base, minDistance) ? mixed : current
}

function isDistinctFromSurfaces(
  candidate: string | undefined,
  bases: string[],
  minDistance: number
): candidate is string {
  return bases.every(base => isDistinctSurface(candidate, base, minDistance))
}

function ensureDistinctSurfaceFromMany(
  current: string,
  bases: string[],
  candidates: Array<string | undefined>,
  primaryText: string,
  strength: number,
  minDistance = 6
): string {
  if (isDistinctFromSurfaces(current, bases, minDistance)) return current

  for (const candidate of candidates) {
    if (isDistinctFromSurfaces(candidate, bases, minDistance)) return candidate
  }

  const mixed = deriveRaisedSurface(current, primaryText, strength)
  return isDistinctFromSurfaces(mixed, bases, minDistance) ? mixed : current
}

function ensureSubtleSurfaceFromMany(
  current: string,
  bases: string[],
  primaryText: string,
  strength: number,
  minDistance = 4
): string {
  if (isDistinctFromSurfaces(current, bases, minDistance)) return current

  const mixed = deriveRaisedSurface(current, primaryText, strength)
  return isDistinctFromSurfaces(mixed, bases, minDistance) ? mixed : current
}

function isLightSurfaceBelow(
  candidate: string | undefined,
  base: string,
  minDistance: number,
  minLuminanceDelta = 0.006
): candidate is string {
  if (!isDistinctSurface(candidate, base, minDistance)) return false
  const candidateLuminance = surfaceLuminance(candidate)
  const baseLuminance = surfaceLuminance(base)
  if (candidateLuminance === null || baseLuminance === null) return true
  return candidateLuminance < baseLuminance - minLuminanceDelta
}

function isLightSurfaceAbove(
  candidate: string | undefined,
  base: string,
  minDistance: number,
  minLuminanceDelta = 0.006
): candidate is string {
  if (!isDistinctSurface(candidate, base, minDistance)) return false
  const candidateLuminance = surfaceLuminance(candidate)
  const baseLuminance = surfaceLuminance(base)
  if (candidateLuminance === null || baseLuminance === null) return true
  return candidateLuminance > baseLuminance + minLuminanceDelta
}

function ensureLightSidebarBelowChat(
  sidebar: string,
  chat: string,
  primaryText: string,
  minDistance = 4
): string {
  if (isLightSurfaceBelow(sidebar, chat, minDistance)) return sidebar

  const derived = deriveRaisedSurface(chat, primaryText, 0.035)
  return isLightSurfaceBelow(derived, chat, minDistance) ? derived : sidebar
}

function ensureLightChatAboveSidebar(
  chat: string,
  sidebar: string,
  minDistance = 4
): string {
  if (isLightSurfaceAbove(chat, sidebar, minDistance)) return chat

  const lifted = mixCssColors('#FFFFFF', chat, 0.04) || chat
  return isLightSurfaceAbove(lifted, sidebar, minDistance) ? lifted : chat
}

export function deriveSurfaceRoles(input: ThemeSurfaceRoleInput): ThemeSurfaceRoles {
  const defaultBg = input.colorScheme === 'dark' ? '#101010' : '#FFFFFF'
  const defaultText = input.colorScheme === 'dark' ? '#F9FAFB' : '#111827'
  const primaryText = firstDefinedColor(input.primaryText, defaultText) || defaultText

  const appBg = firstDefinedColor(input.app, input.chat, defaultBg) || defaultBg
  let sidebarBg = input.colorScheme === 'dark'
    ? appBg
    : ensureDistinctSurface(
      firstDefinedColor(input.sidebar, input.panel, input.elevated, appBg) || appBg,
      firstDefinedColor(input.chat, input.app, appBg) || appBg,
      [input.sidebar, input.panel, input.elevated, input.floating],
      primaryText,
      0.045,
      4
    )

  let chatBg = input.colorScheme === 'dark'
    ? firstDefinedColor(input.panel, input.sidebar, input.elevated, input.chat, appBg) || appBg
    : firstDefinedColor(input.chat, input.app, input.panel, input.sidebar, appBg) || appBg

  if (input.colorScheme === 'light') {
    sidebarBg = ensureLightSidebarBelowChat(sidebarBg, chatBg, primaryText)
    chatBg = ensureLightChatAboveSidebar(chatBg, sidebarBg)
  }

  chatBg = ensureDistinctSurface(
    chatBg,
    sidebarBg,
    input.colorScheme === 'dark'
      ? [input.panel, input.sidebar, input.elevated, input.floating]
      : [input.chat, input.app, input.panel, input.elevated],
    primaryText,
    input.colorScheme === 'dark' ? 0.08 : 0.055
  )

  let panelBg = firstDefinedColor(input.panel, chatBg, input.elevated, sidebarBg, appBg) || chatBg
  panelBg = input.colorScheme === 'dark'
    ? ensureDistinctSurface(
      panelBg,
      appBg,
      [input.panel, chatBg, input.elevated, input.floating],
      primaryText,
      0.08
    )
    : ensureSubtleSurfaceFromMany(
      panelBg,
      [chatBg],
      primaryText,
      0.018,
      4
    )

  let elevatedBg = firstDefinedColor(input.elevated, panelBg) || panelBg
  elevatedBg = input.colorScheme === 'dark'
    ? ensureDistinctSurface(
      elevatedBg,
      panelBg,
      [input.elevated],
      primaryText,
      0.075,
      6
    )
    : ensureSubtleSurfaceFromMany(
      firstDefinedColor(panelBg, input.elevated, input.floating) || panelBg,
      [chatBg, panelBg],
      primaryText,
      0.032,
      4
    )

  let floatingBg = firstDefinedColor(input.floating, elevatedBg, panelBg) || elevatedBg
  floatingBg = input.colorScheme === 'dark'
    ? ensureDistinctSurface(
      floatingBg,
      elevatedBg,
      [input.floating],
      primaryText,
      0.1,
      6
    )
    : ensureSubtleSurfaceFromMany(
      elevatedBg,
      [chatBg, panelBg, elevatedBg],
      primaryText,
      0.048,
      4
    )

  const tabBarBg = chatBg

  return {
    appBg,
    sidebarBg,
    chatBg,
    panelBg,
    tabBarBg,
    elevatedBg,
    floatingBg,
  }
}
