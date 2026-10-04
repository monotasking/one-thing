// 主题的代码高亮推导(从 `theme-resolver.ts` 拆出,拆分批 1,D226):每个高亮 token 的颜色与字形怎么取、
// 缺席时的配方、语法色与底色的对比度保底,以及整张高亮表的解析。
import type { ColorValue, HighlightFontStyle, HighlightStyle, SemanticHighlightToken, Theme, ThemeDefs } from './theme-types.js'
import { colorMeetsContrast, mixCssColors } from './theme-color-math.js'
import { guaranteeMinDeltaL } from './theme-role-mapping.js'
import { DEFAULT_HIGHLIGHT_ALIASES, type ResolvedColorValue, type ResolvedHighlightStyle, SEMANTIC_HIGHLIGHT_TOKENS, VALID_HIGHLIGHT_FONT_STYLES } from './theme-semantic-tokens.js'
import { buildResolvedMap, getResolvedThemeValue, isHighlightLink, isSemanticHighlightToken, log, resolveColorValue, resolveTheme, selectModeValue } from './theme-resolver.js'
import { deriveLightSurface, deriveSemanticSurfaceRoles } from './theme-ui-styles.js'

function resolveHighlightColor(
  value: ColorValue | undefined,
  defs: ThemeDefs,
  resolvedMap: Map<string, ResolvedColorValue>,
  mode: 'dark' | 'light'
): string | undefined {
  if (value === undefined) return undefined
  const resolvedValue = resolveColorValue(value, defs, resolvedMap, new Set())
  return selectModeValue(resolvedValue, mode)
}

function normalizeHighlightFontStyle(value: HighlightFontStyle | undefined): HighlightFontStyle | undefined {
  if (!value) return undefined
  if (VALID_HIGHLIGHT_FONT_STYLES.has(value)) return value
  log.warn('unknown highlight fontStyle', { value })
  return undefined
}

function resolveHighlightStyle(
  style: HighlightStyle,
  defs: ThemeDefs,
  resolvedMap: Map<string, ResolvedColorValue>,
  mode: 'dark' | 'light'
): ResolvedHighlightStyle {
  return {
    fg: resolveHighlightColor(style.fg, defs, resolvedMap, mode),
    bg: resolveHighlightColor(style.bg, defs, resolvedMap, mode),
    fontStyle: normalizeHighlightFontStyle(style.fontStyle),
  }
}

function mergeHighlightStyle(
  base: ResolvedHighlightStyle,
  override: ResolvedHighlightStyle
): ResolvedHighlightStyle {
  return {
    fg: override.fg ?? base.fg,
    bg: override.bg ?? base.bg,
    fontStyle: override.fontStyle ?? base.fontStyle,
  }
}

function fallbackHighlightStyle(theme: Theme, token: SemanticHighlightToken): HighlightStyle {
  const text = theme.theme.text
  const code = text.code || {}
  const semantic = theme.theme.color || {}

  switch (token) {
    case 'syntax.plain':
      return { fg: code.block || text.primary }
    case 'syntax.comment':
      return { fg: code.comment || text.muted || code.block || text.primary, fontStyle: 'italic' }
    case 'syntax.keyword':
      return { fg: code.keyword || code.block || text.primary }
    case 'syntax.atom':
      return { fg: code.keyword || code.number || code.block || text.primary }
    case 'syntax.string':
      return { fg: code.string || code.block || text.primary }
    case 'syntax.number':
      return { fg: code.number || code.block || text.primary }
    case 'syntax.function':
      return { fg: code.function || code.block || text.primary }
    case 'syntax.definition':
      return { fg: code.function || code.variable || code.block || text.primary }
    case 'syntax.variable':
      return { fg: code.variable || code.block || text.primary }
    case 'syntax.property':
      return { fg: code.property || code.variable || code.block || text.primary }
    case 'syntax.type':
      return { fg: code.type || code.variable || code.block || text.primary }
    case 'syntax.tag':
      return { fg: code.type || code.keyword || code.block || text.primary }
    case 'syntax.operator':
      return { fg: code.operator || code.block || text.primary }
    case 'syntax.punctuation':
      return { fg: code.punctuation || code.operator || code.block || text.primary }
    case 'syntax.invalid':
      return { fg: text.error || semantic.danger || code.block || text.primary }
    case 'syntax.inserted':
      return { fg: text.success || semantic.success || code.string || code.block || text.primary }
    case 'syntax.deleted':
      return { fg: text.error || semantic.danger || code.block || text.primary }
    case 'syntax.heading':
      return { fg: code.function || text.primary, fontStyle: 'bold' }
    case 'syntax.link':
      return { fg: text.link || code.function || text.primary, fontStyle: 'underline' }
    case 'syntax.emphasis':
      return { fg: code.block || text.primary, fontStyle: 'italic' }
    case 'syntax.strong':
      return { fg: code.block || text.primary, fontStyle: 'bold' }
  }
}

function readableSyntaxColor(
  color: string | undefined,
  background: string,
  primaryText: string | undefined,
  minimumContrast: number
): string | undefined {
  if (!color || colorMeetsContrast(color, background, minimumContrast)) return color
  if (!primaryText) return color

  for (let weight = 0.14; weight <= 0.58; weight += 0.04) {
    const mixed = mixCssColors(primaryText, color, weight)
    if (mixed && colorMeetsContrast(mixed, background, minimumContrast)) return mixed
  }

  return color
}

function fallbackCodeBlockHighlightBg(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light'
): string {
  // Must mirror the ui.surface.codeBlock post-process guard (ΔL≥0.04 from
  // chat): syntax colors are contrast-repaired against this value, so if it is
  // lighter than the painted block surface the repair under-delivers.
  const surfaceRoles = deriveSemanticSurfaceRoles(resolvedTheme, mode)
  if (mode === 'light') {
    const rawBlockBg = deriveLightSurface(
      surfaceRoles.chatBg,
      resolvedTheme['neutral.primaryText'] || resolvedTheme['text.primary'],
      0.035
    )
    return guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, false) ?? rawBlockBg
  }

  const rawBlockBg = getResolvedThemeValue(resolvedTheme, 'neutral.baseFill', 'bg.code.block') || surfaceRoles.panelBg
  return guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, true) ?? rawBlockBg
}

function ensureHighlightContrast(
  styles: Map<SemanticHighlightToken, ResolvedHighlightStyle>,
  resolvedTheme: Record<string, string>,
  codeBlockBg: string
): void {
  const primaryText = resolvedTheme['neutral.primaryText'] || resolvedTheme['text.primary']
  const minimumByToken: Partial<Record<SemanticHighlightToken, number>> = {
    'syntax.plain': 4.5,
    'syntax.comment': 3.5,
    'syntax.keyword': 4,
    'syntax.atom': 4,
    'syntax.string': 3.5,
    'syntax.number': 4,
    'syntax.function': 4,
    'syntax.definition': 4,
    'syntax.variable': 4,
    'syntax.property': 4,
    'syntax.type': 4,
    'syntax.tag': 4,
    'syntax.operator': 3.5,
    'syntax.punctuation': 3.5,
  }

  for (const [token, minimumContrast] of Object.entries(minimumByToken) as Array<[SemanticHighlightToken, number]>) {
    const style = styles.get(token)
    if (!style?.fg) continue
    styles.set(token, {
      ...style,
      fg: readableSyntaxColor(style.fg, codeBlockBg, primaryText, minimumContrast),
    })
  }
}

/**
 * Resolve app-level highlight groups from a theme. Themes without `highlights`
 * are upgraded from `theme.text.code.*` so old JSON files continue to work.
 *
 * `highlightOverrides` 是**输入层**,不是成品补丁:它在 `ensureHighlightContrast`
 * 之前落位,所以对比度护栏照常在覆盖色上重跑。护栏改写了给进来的颜色不是错误 ——
 * 主题自己写的代码色也走同一道护栏,覆盖没有豁免权。
 *
 * 键必须是权威族 `syntax.*`(别名族 `text.code.*` 由调用方经
 * `pickHighlightTokenOverrides` 归一后再递进来)。
 */
export function resolveThemeHighlights(
  theme: Theme,
  mode: 'dark' | 'light',
  resolvedTheme: Record<string, string> = resolveTheme(theme, mode),
  codeBlockBg: string = fallbackCodeBlockHighlightBg(resolvedTheme, mode),
  highlightOverrides?: Partial<Record<SemanticHighlightToken, string>>
): Record<SemanticHighlightToken, ResolvedHighlightStyle> {
  const defs = theme.defs || {}
  const resolvedMap = buildResolvedMap(resolvedTheme)
  const styles = new Map<SemanticHighlightToken, ResolvedHighlightStyle>()
  const highlights = theme.highlights
  const groups = highlights?.groups || {}
  const aliases = {
    ...DEFAULT_HIGHLIGHT_ALIASES,
    ...(highlights?.aliases || {}),
  }

  for (const token of SEMANTIC_HIGHLIGHT_TOKENS) {
    styles.set(token, resolveHighlightStyle(fallbackHighlightStyle(theme, token), defs, resolvedMap, mode))
  }

  for (const [token, style] of Object.entries(highlights?.semanticTokens || {})) {
    if (!isSemanticHighlightToken(token)) {
      log.warn('unknown semantic highlight token', { token })
      continue
    }
    styles.set(token, mergeHighlightStyle(
      styles.get(token) || {},
      resolveHighlightStyle(style, defs, resolvedMap, mode)
    ))
  }

  const resolveSemanticTarget = (
    name: string,
    visited: Set<string> = new Set()
  ): SemanticHighlightToken | null => {
    if (isSemanticHighlightToken(name)) return name
    if (visited.has(name)) {
      log.warn('circular highlight alias detected', { name })
      return null
    }
    visited.add(name)

    const aliasTarget = aliases[name]
    if (aliasTarget) {
      return resolveSemanticTarget(aliasTarget, visited)
    }

    const group = groups[name]
    if (group && isHighlightLink(group)) {
      return resolveSemanticTarget(group.link, visited)
    }

    return null
  }

  const resolveGroupDefinition = (
    name: string,
    visited: Set<string> = new Set()
  ): ResolvedHighlightStyle | null => {
    if (visited.has(name)) {
      log.warn('circular highlight group link detected', { name })
      return null
    }
    visited.add(name)

    const group = groups[name]
    if (!group) {
      if (isSemanticHighlightToken(name)) return styles.get(name) || null
      const aliasTarget = aliases[name]
      return aliasTarget ? resolveGroupDefinition(aliasTarget, visited) : null
    }

    if (isHighlightLink(group)) {
      return resolveGroupDefinition(group.link, visited)
    }

    return resolveHighlightStyle(group, defs, resolvedMap, mode)
  }

  for (const token of SEMANTIC_HIGHLIGHT_TOKENS) {
    if (!groups[token]) continue
    const groupStyle = resolveGroupDefinition(token)
    if (groupStyle) {
      styles.set(token, mergeHighlightStyle(styles.get(token) || {}, groupStyle))
    }
  }

  for (const [groupName, targetName] of Object.entries(aliases)) {
    if (!groups[groupName]) continue
    const token = resolveSemanticTarget(targetName)
    if (!token) {
      log.warn('unknown highlight alias target', { groupName, targetName })
      continue
    }
    const groupStyle = resolveGroupDefinition(groupName)
    if (groupStyle) {
      styles.set(token, mergeHighlightStyle(styles.get(token) || {}, groupStyle))
    }
  }

  // 覆盖是**最后一句声明**(压过主题的 semanticTokens / groups / aliases),
  // 但仍然是**声明**:它落在护栏之前,派生照常重跑。
  if (highlightOverrides) {
    for (const [token, fg] of Object.entries(highlightOverrides)) {
      if (!isSemanticHighlightToken(token)) {
        log.warn('unknown highlight override token', { token })
        continue
      }
      if (typeof fg !== 'string' || !fg.trim()) continue
      styles.set(token, { ...(styles.get(token) || {}), fg })
    }
  }

  ensureHighlightContrast(styles, resolvedTheme, codeBlockBg)

  return Object.fromEntries(
    SEMANTIC_HIGHLIGHT_TOKENS.map(token => [token, styles.get(token) || {}])
  ) as Record<SemanticHighlightToken, ResolvedHighlightStyle>
}
