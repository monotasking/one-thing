/**
 * Theme Color Resolver
 * Recursively resolves color references from defs and theme properties
 */
// 主题解析核(拆分批 1,D226 之后只剩这一层):把主题定义里的颜色引用递归解开、拍平成一张路径 → 值的表,
// 按明暗模式取值,叠上根级 token 覆盖。词表在 `theme-semantic-tokens.ts`;在这张表上推导出来的三条线
// —— 色彩语义(`theme-color-semantics.ts`)、界面样式(`theme-ui-styles.ts`)、高亮(`theme-highlight-styles.ts`)——
// 与预览色(`theme-preview-colors.ts`)各住各的文件。
import type { ColorValue, SemanticHighlightToken, Theme, ThemeDefs, ThemeHighlightGroup } from './theme-types.js'
import { getLogger } from '../logging/logging.js'
import { type ResolvedColorValue, SEMANTIC_HIGHLIGHT_TOKEN_SET } from './theme-semantic-tokens.js'
import { applyThemeColorSemantics } from './theme-color-semantics.js'

export const log = getLogger('themes')

/**
 * Check if a value is a direct color value (not a reference)
 */
function isDirectColorValue(value: string): boolean {
  return (
    value.startsWith('#') ||
    value.startsWith('rgb') ||
    value.startsWith('hsl') ||
    value.startsWith('var(') ||
    value.startsWith('linear-gradient') ||
    value.startsWith('radial-gradient') ||
    value.startsWith('color-mix') ||
    value === 'transparent' ||
    value === 'inherit' ||
    value === 'currentColor' ||
    value === 'none' ||
    /^\d/.test(value) ||
    value.startsWith('inset ')
  )
}

/**
 * Recursively resolve a color value
 * @param value - The color value to resolve
 * @param defs - Theme color definitions (aliases)
 * @param resolvedMap - Already resolved colors (for reference lookups)
 * @param visited - Visited references (to detect cycles)
 */
export function resolveColorValue(
  value: ColorValue,
  defs: ThemeDefs,
  resolvedMap: Map<string, ResolvedColorValue>,
  visited: Set<string> = new Set()
): ResolvedColorValue {
  // Handle mode variants { dark: "...", light: "..." }
  if (typeof value === 'object' && value !== null && 'dark' in value && 'light' in value) {
    return {
      dark: resolveColorValue(value.dark, defs, resolvedMap, new Set(visited)) as string,
      light: resolveColorValue(value.light, defs, resolvedMap, new Set(visited)) as string,
    }
  }

  // Handle string values
  if (typeof value === 'string') {
    // Check if it's a direct color value
    if (isDirectColorValue(value)) {
      return value
    }

    // Check for Flexoki palette reference (fx-*)
    if (value.startsWith('fx-')) {
      return `var(--${value})`
    }

    // It's a reference - resolve it
    const refName = value

    // Prevent infinite recursion (circular references)
    if (visited.has(refName)) {
      log.warn('circular color reference detected', { refName })
      return '#ff00ff' // Magenta as error indicator
    }
    visited.add(refName)

    // Check defs first
    if (defs[refName] !== undefined) {
      return resolveColorValue(defs[refName], defs, resolvedMap, visited)
    }

    // Check already resolved theme colors
    if (resolvedMap.has(refName)) {
      return resolvedMap.get(refName)!
    }

    // Unknown reference - return as-is (might be CSS keyword or variable)
    log.warn('unknown color reference', { refName })
    return value
  }

  return String(value)
}

/**
 * Flatten a nested object to dot-notation keys
 * { bg: { app: "#fff" } } -> { "bg.app": "#fff" }
 */
function flattenObject(
  obj: Record<string, any>,
  prefix: string = '',
  result: Record<string, ColorValue> = {}
): Record<string, ColorValue> {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key

    if (value !== null && typeof value === 'object' && !('dark' in value && 'light' in value)) {
      // Nested object (not a mode variant)
      flattenObject(value, fullKey, result)
    } else if (value !== undefined) {
      result[fullKey] = value as ColorValue
    }
  }
  return result
}

/**
 * Resolve all colors in a theme for a specific mode
 * @param theme - The theme to resolve
 * @param mode - "dark" or "light"
 * @param tokenOverrides - 已过白名单的 token → 颜色字面量覆盖(见
 *   `applyThemeTokenOverrides`)。主题系统对"谁给的覆盖"无知,只知道它比主题
 *   自身的取值更靠后。
 * @returns Flat map of theme property path -> resolved color string
 */
export function resolveTheme(
  theme: Theme,
  mode: 'dark' | 'light',
  tokenOverrides?: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {}
  const resolvedMap = new Map<string, ResolvedColorValue>()
  const defs = { ...(theme.defs || {}) }

  // Flatten the theme colors to dot-notation
  const flatColors = flattenObject(theme.theme as unknown as Record<string, any>)

  // 顶层 token(primary / accent / accentMain / …)同时是主题里的**引用名**:
  // `bg.btn.primary: "accent"` 这类取值靠名字查表。所以顶层覆盖要先进 defs 与
  // flat 表,引用才跟着覆盖走 —— 只写解析结果的话,主按钮之类"按名字引用"的
  // 表面会整片留在旧色上。带点的 token 不是引用名,留到语义派生前再落位。
  const rootOverrides = pickRootThemeTokenOverrides(tokenOverrides)
  seedThemeTokenOverrides(defs, flatColors, rootOverrides)

  const explicitPrimary = flatColors.primary
  if (
    explicitPrimary !== undefined &&
    !(typeof explicitPrimary === 'string' && (explicitPrimary === 'accent' || explicitPrimary === 'accentMain'))
  ) {
    defs.primary = explicitPrimary
    defs.accent = explicitPrimary
    defs.accentMain = explicitPrimary
    flatColors.accent = explicitPrimary
    flatColors.accentMain = explicitPrimary
  }

  // primary 的传播(上一段)会把 accent / accentMain 一起带走 —— 那是主题作者
  // 写 primary 时的既有语义,但不能把**显式声明过**的覆盖顶掉:声明是终局。
  seedThemeTokenOverrides(defs, flatColors, rootOverrides)

  // Resolve each color
  for (const [path, value] of Object.entries(flatColors)) {
    const resolvedValue = resolveColorValue(value, defs, resolvedMap, new Set())

    let finalValue: string
    if (typeof resolvedValue === 'object' && 'dark' in resolvedValue) {
      finalValue = resolvedValue[mode]
    } else {
      finalValue = resolvedValue
    }

    resolved[path] = finalValue
    resolvedMap.set(path, resolvedValue)

    // Also store by last segment for reference lookups (e.g., "accent" from "theme.accent")
    const lastSegment = path.split('.').pop()
    if (lastSegment && !resolvedMap.has(lastSegment)) {
      resolvedMap.set(lastSegment, resolvedValue)
    }
  }

  // Ensure accentLight is defined (used by buttons and gradients)
  // Falls back to accentSub if not explicitly defined in the theme
  if (!resolved['accentLight']) {
    resolved['accentLight'] = resolved['accentSub'] || resolved['accent'] || '#4385BE'
  }

  // token 覆盖必须落在**语义派生之前**:primary 色阶、状态色、neutral 语义
  // 全部由 `applyThemeColorSemantics` 从这张表现算,ui 语义层(`resolveThemeUI`)
  // 与 -rgb 变体(`generateCSSVariables`)又从算完的表里派生。覆盖若落在这条链
  // **之后**,只有原始变量会变色,派生层整片留在旧色上 —— 那正是真机走查里
  // "装了品牌色插件却几乎看不出变化"的病根。
  applyThemeTokenOverrides(resolved, tokenOverrides)

  applyThemeColorSemantics(resolved, mode)

  // 语义层会把声明值再加工(如 danger 向红偏移、primary 回填 accent)。
  // **派生用加工值,出口用声明值** —— "声明什么、:root 上就是什么"是对外承诺,
  // 不能被内部加工改写。
  applyThemeTokenOverrides(resolved, tokenOverrides)

  return resolved
}

/** 顶层(无点)token —— 它们同时是主题里可被引用的名字。 */
function pickRootThemeTokenOverrides(
  tokenOverrides: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!tokenOverrides) return undefined
  const root: Record<string, string> = {}
  for (const [token, value] of Object.entries(tokenOverrides)) {
    if (!token.includes('.')) root[token] = value
  }
  return Object.keys(root).length ? root : undefined
}

/** 顶层覆盖同时写进 defs(引用名)与 flat 表(自身取值)。 */
function seedThemeTokenOverrides(
  defs: ThemeDefs,
  flatColors: Record<string, any>,
  rootOverrides: Record<string, string> | undefined
): void {
  if (!rootOverrides) return
  for (const [token, value] of Object.entries(rootOverrides)) {
    defs[token] = value
    flatColors[token] = value
  }
}

/**
 * 把 token 覆盖写进解析表。
 *
 * 值按**颜色字面量**直写,不过 `resolveColorValue` —— 覆盖不是主题作者写的引用,
 * `red` 就该是红色,不能被当成 defs 里的一个名字去查表。键白名单不在这里判:
 * 调用方(`applyTheme`)已用 `CSS_VAR_MAP` 筛过,这里再抄一份表就一定会漂移。
 */
function applyThemeTokenOverrides(
  resolved: Record<string, string>,
  tokenOverrides: Record<string, string> | undefined
): void {
  if (!tokenOverrides) return

  for (const [token, value] of Object.entries(tokenOverrides)) {
    resolved[token] = value
  }

  // `accentRgb` 是主题**手写**的三元组,不会跟着 accent 变。accent 被覆盖成一个
  // 六位 hex、而 accentRgb 自己没被覆盖时,让出手写值,交给 css-mapper 从新的
  // accent 现算 —— 否则 `rgba(var(--accent-rgb), …)` 一族会整片留在旧色上。
  if (
    typeof tokenOverrides.accent === 'string' &&
    tokenOverrides.accentRgb === undefined &&
    /^#[0-9a-f]{6}$/i.test(tokenOverrides.accent)
  ) {
    delete resolved.accentRgb
  }
}

export function isSemanticHighlightToken(value: string): value is SemanticHighlightToken {
  return SEMANTIC_HIGHLIGHT_TOKEN_SET.has(value)
}

export function isHighlightLink(value: ThemeHighlightGroup): value is { link: string } {
  return typeof value === 'object' && value !== null && 'link' in value
}

export function buildResolvedMap(resolvedTheme: Record<string, string>): Map<string, ResolvedColorValue> {
  const resolvedMap = new Map<string, ResolvedColorValue>()
  for (const [path, value] of Object.entries(resolvedTheme)) {
    resolvedMap.set(path, value)
    const lastSegment = path.split('.').pop()
    if (lastSegment && !resolvedMap.has(lastSegment)) {
      resolvedMap.set(lastSegment, value)
    }
  }
  return resolvedMap
}

export function selectModeValue(value: ResolvedColorValue, mode: 'dark' | 'light'): string {
  return typeof value === 'object' && 'dark' in value ? value[mode] : value
}

export function resolveThemeDefinitionColors(
  theme: Theme,
  mode: 'dark' | 'light',
  resolvedTheme: Record<string, string>
): Record<string, string> {
  const defs = theme.defs || {}
  const resolvedMap = buildResolvedMap(resolvedTheme)
  const resolvedDefs: Record<string, string> = {}

  for (const [key, value] of Object.entries(defs)) {
    try {
      resolvedDefs[key] = selectModeValue(resolveColorValue(value, defs, resolvedMap, new Set()), mode)
    } catch {
      // Invalid optional palette entries should not block semantic UI fallback.
    }
  }

  for (const key of ['purple', 'cyan', 'green', 'orange', 'yellow', 'brown', 'blue', 'nord_blue'] as const) {
    if (resolvedDefs[key] && !resolvedDefs[`b30.${key}`]) {
      resolvedDefs[`b30.${key}`] = resolvedDefs[key]
    }
  }

  return resolvedDefs
}

export function getResolvedThemeValue(
  resolvedTheme: Record<string, string>,
  ...paths: string[]
): string | undefined {
  for (const path of paths) {
    const value = resolvedTheme[path]
    if (value !== undefined) return value
  }
  return undefined
}
