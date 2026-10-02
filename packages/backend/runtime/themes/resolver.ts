/**
 * Theme Color Resolver
 * Recursively resolves color references from defs and theme properties
 */

import { generate as generateAntColorPalette } from '@ant-design/colors'
import type {
  ColorValue,
  HighlightFontStyle,
  HighlightStyle,
  SemanticHighlightToken,
  SemanticUIToken,
  Theme,
  ThemeDefs,
  ThemeHighlightGroup,
} from './types.js'
import type { ThemeSurfaceRoles } from './role-mapping.js'
import {
  type CategoryColor,
  colorMeetsContrast,
  colorToHex,
  colorToRgbString,
  contrastRatio,
  deriveCategoryColors,
  deriveNeutralTextRamp,
  deriveStateOverlays,
  deriveStatusSurfaceRamp,
  deriveSurfaceRoles,
  guaranteeMinAbsDeltaL,
  guaranteeMinDeltaL,
  mixCssColors,
  nudgeDangerColorTowardRed,
  parseCssColor,
  readableAgainst,
  resolveColorOverBackground,
  rgbaFromCssColor,
} from './role-mapping.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('themes')

type ResolvedColorValue = string | { dark: string; light: string }

export interface ResolvedHighlightStyle {
  fg?: string
  bg?: string
  fontStyle?: HighlightFontStyle
}

export interface ResolvedUIStyle {
  fg?: string
  bg?: string
  border?: string
  ring?: string
  shadow?: string
}

export const SEMANTIC_HIGHLIGHT_TOKENS: SemanticHighlightToken[] = [
  'syntax.plain',
  'syntax.comment',
  'syntax.keyword',
  'syntax.atom',
  'syntax.string',
  'syntax.number',
  'syntax.function',
  'syntax.definition',
  'syntax.variable',
  'syntax.property',
  'syntax.type',
  'syntax.tag',
  'syntax.operator',
  'syntax.punctuation',
  'syntax.invalid',
  'syntax.inserted',
  'syntax.deleted',
  'syntax.heading',
  'syntax.link',
  'syntax.emphasis',
  'syntax.strong',
]

const SEMANTIC_HIGHLIGHT_TOKEN_SET = new Set<string>(SEMANTIC_HIGHLIGHT_TOKENS)

export const SEMANTIC_UI_TOKENS: SemanticUIToken[] = [
  'ui.accent.primary',
  'ui.accent.subtle',
  'ui.surface.app',
  'ui.surface.sidebar',
  'ui.surface.chat',
  'ui.surface.panel',
  'ui.surface.elevated',
  'ui.surface.floating',
  'ui.surface.overlay',
  'ui.surface.menu',
  'ui.surface.menuHover',
  'ui.surface.input',
  'ui.surface.inputFocus',
  'ui.surface.codeInline',
  'ui.surface.codeBlock',
  'ui.surface.codeHeader',
  'ui.surface.tooltip',
  'ui.surface.modal',
  'ui.surface.note',
  'ui.surface.previewLight',
  'ui.surface.previewDark',
  'ui.text.primary',
  'ui.text.secondary',
  'ui.text.muted',
  'ui.text.faint',
  'ui.text.inverse',
  'ui.text.placeholder',
  'ui.text.disabled',
  'ui.text.link',
  'ui.text.linkHover',
  'ui.border.default',
  'ui.border.subtle',
  'ui.border.strong',
  'ui.border.divider',
  'ui.border.focus',
  'ui.border.selected',
  'ui.table.headerBg',
  'ui.table.rowBg',
  'ui.table.border',
  'ui.action.primary',
  'ui.action.primaryHover',
  'ui.action.secondary',
  'ui.action.secondaryHover',
  'ui.action.ghost',
  'ui.action.ghostHover',
  'ui.action.danger',
  'ui.action.dangerHover',
  'ui.action.disabled',
  'ui.state.hover',
  'ui.state.active',
  'ui.state.selected',
  'ui.state.selectedHover',
  'ui.state.highlight',
  'ui.state.focus',
  'ui.state.disabled',
  'ui.sidebar.surface',
  'ui.sidebar.item',
  'ui.sidebar.itemHover',
  'ui.sidebar.itemActive',
  'ui.sidebar.itemMuted',
  'ui.sidebar.header',
  'ui.sidebar.action',
  'ui.sidebar.actionHover',
  'ui.sidebar.border',
  'ui.category.1.icon',
  'ui.category.1.badgeBg',
  'ui.category.1.badgeText',
  'ui.category.2.icon',
  'ui.category.2.badgeBg',
  'ui.category.2.badgeText',
  'ui.category.3.icon',
  'ui.category.3.badgeBg',
  'ui.category.3.badgeText',
  'ui.category.4.icon',
  'ui.category.4.badgeBg',
  'ui.category.4.badgeText',
  'ui.category.5.icon',
  'ui.category.5.badgeBg',
  'ui.category.5.badgeText',
  'ui.category.6.icon',
  'ui.category.6.badgeBg',
  'ui.category.6.badgeText',
  'ui.category.7.icon',
  'ui.category.7.badgeBg',
  'ui.category.7.badgeText',
  'ui.tabBar.surface',
  'ui.tabBar.divider',
  'ui.tabBar.item',
  'ui.tabBar.itemHover',
  'ui.tabBar.itemActive',
  'ui.tabBar.action',
  'ui.tabBar.actionHover',
  'ui.tabBar.danger',
  'ui.status.danger',
  'ui.status.warning',
  'ui.status.success',
  'ui.status.info',
  'ui.message.user',
  'ui.message.userSolid',
  'ui.message.assistant',
  'ui.message.system',
  'ui.message.error',
  'ui.message.hover',
  'ui.message.thinking',
  'ui.tool.surface',
  'ui.tool.surfaceHover',
  'ui.tool.surfaceSubtle',
  'ui.tool.result',
  'ui.tool.error',
  'ui.tool.success',
  'ui.tool.text',
  'ui.tool.textMuted',
  'ui.tool.textFaint',
  'ui.tool.accent',
  'ui.tool.accentOn',
  'ui.tool.successText',
  'ui.tool.dangerText',
  'ui.tool.border',
  'ui.editor.text',
  'ui.editor.placeholder',
  'ui.editor.caret',
  'ui.editor.selection',
]

const VALID_HIGHLIGHT_FONT_STYLES = new Set<HighlightFontStyle>([
  'normal',
  'italic',
  'bold',
  'underline',
  'bold italic',
  'bold underline',
  'italic underline',
  'bold italic underline',
])

const DEFAULT_HIGHLIGHT_ALIASES: Record<string, SemanticHighlightToken> = {
  Normal: 'syntax.plain',
  Comment: 'syntax.comment',
  '@comment': 'syntax.comment',
  Keyword: 'syntax.keyword',
  Statement: 'syntax.keyword',
  Conditional: 'syntax.keyword',
  Repeat: 'syntax.keyword',
  Include: 'syntax.keyword',
  Exception: 'syntax.keyword',
  '@keyword': 'syntax.keyword',
  '@keyword.function': 'syntax.keyword',
  '@keyword.operator': 'syntax.keyword',
  Boolean: 'syntax.atom',
  Constant: 'syntax.atom',
  '@boolean': 'syntax.atom',
  String: 'syntax.string',
  Character: 'syntax.string',
  '@string': 'syntax.string',
  Number: 'syntax.number',
  Float: 'syntax.number',
  '@number': 'syntax.number',
  Function: 'syntax.function',
  '@function': 'syntax.function',
  '@method': 'syntax.function',
  '@constructor': 'syntax.function',
  Identifier: 'syntax.variable',
  Variable: 'syntax.variable',
  '@variable': 'syntax.variable',
  Property: 'syntax.property',
  '@property': 'syntax.property',
  '@field': 'syntax.property',
  Type: 'syntax.type',
  Typedef: 'syntax.type',
  '@type': 'syntax.type',
  '@class': 'syntax.type',
  Tag: 'syntax.tag',
  '@tag': 'syntax.tag',
  '@tag.attribute': 'syntax.property',
  Operator: 'syntax.operator',
  Delimiter: 'syntax.punctuation',
  '@operator': 'syntax.operator',
  '@punctuation': 'syntax.punctuation',
  Error: 'syntax.invalid',
  DiagnosticError: 'syntax.invalid',
  DiffAdd: 'syntax.inserted',
  DiffDelete: 'syntax.deleted',
  Title: 'syntax.heading',
  Underlined: 'syntax.link',
}

export type ThemeStatusColorToken = 'success' | 'warning' | 'danger' | 'info'

export const THEME_STATUS_COLOR_TOKENS: ThemeStatusColorToken[] = [
  'success',
  'warning',
  'danger',
  'info',
]

export const THEME_NEUTRAL_COLOR_TOKENS = [
  'primaryText',
  'regularText',
  'secondaryText',
  'placeholderText',
  'disabledText',
  'darkerBorder',
  'darkBorder',
  'baseBorder',
  'lightBorder',
  'lighterBorder',
  'extraLightBorder',
  'darkerFill',
  'darkFill',
  'baseFill',
  'lightFill',
  'lighterFill',
  'extraLightFill',
  'blankFill',
  'basicBlack',
  'basicWhite',
  'transparent',
  'pageBackground',
  'baseBackground',
  'overlayBackground',
] as const

export type ThemeNeutralColorToken = typeof THEME_NEUTRAL_COLOR_TOKENS[number]

export interface ResolvedStatusColorSemantics {
  base: string
  hover?: string
  bg: string
  bgHover: string
  border: string
  text: string
  light: string
}

export interface ResolvedPrimaryColorSemantics extends ResolvedStatusColorSemantics {
  hover: string
}

export interface ResolvedThemeColorSemantics {
  primary: ResolvedPrimaryColorSemantics
  status: Record<ThemeStatusColorToken, ResolvedStatusColorSemantics>
  neutral: Record<ThemeNeutralColorToken, string>
}

export interface ResolvedColorScaleDiagnostics {
  primary: {
    semantics: ResolvedPrimaryColorSemantics
    scale: string[]
  }
  status: Record<ThemeStatusColorToken, {
    semantics: ResolvedStatusColorSemantics
    scale: string[]
  }>
}

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

const DEFAULT_PRIMARY_COLOR = '#4385BE'

const STATUS_COLOR_DEFAULTS: Record<ThemeStatusColorToken, string> = {
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
  info: '#3B82F6',
}

const STATUS_COLOR_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
  success: ['color.success', 'text.success', 'border.success', 'diff.addText'],
  warning: ['color.warning', 'text.warning', 'border.warning'],
  danger: ['color.danger', 'text.error', 'border.error', 'bg.btn.danger', 'diff.delText'],
  info: ['color.info', 'text.info', 'text.link', 'accent'],
}

const STATUS_LIGHT_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
  success: ['color.successBg', 'color.successLight', 'bg.toolSuccess', 'diff.addBg'],
  warning: ['color.warningBg', 'color.warningLight', 'bg.highlight'],
  danger: ['color.dangerBg', 'color.dangerLight', 'bg.message.error', 'bg.toolError', 'diff.delBg'],
  info: ['color.infoBg', 'color.infoLight'],
}

const STATUS_BG_HOVER_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
  success: ['color.successBgHover', 'color.successBg', 'color.successLight', 'bg.toolSuccess'],
  warning: ['color.warningBgHover', 'color.warningBg', 'color.warningLight', 'bg.highlight'],
  danger: ['color.dangerBgHover', 'color.dangerBg', 'color.dangerLight', 'bg.toolError', 'bg.message.error'],
  info: ['color.infoBgHover', 'color.infoBg', 'color.infoLight'],
}

const STATUS_BORDER_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
  success: ['color.successBorder', 'border.success', 'color.success'],
  warning: ['color.warningBorder', 'border.warning', 'color.warning'],
  danger: ['color.dangerBorder', 'border.error', 'color.danger'],
  info: ['color.infoBorder', 'border.accent', 'color.info', 'accent'],
}

const STATUS_TEXT_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
  success: ['color.successText', 'text.success', 'color.success'],
  warning: ['color.warningText', 'text.warning', 'color.warning'],
  danger: ['color.dangerText', 'text.error', 'color.danger'],
  info: ['color.infoText', 'text.info', 'text.link', 'color.info'],
}

const NEUTRAL_COLOR_FALLBACK_PATHS: Record<ThemeNeutralColorToken, string[]> = {
  primaryText: ['neutral.primaryText', 'text.primary'],
  regularText: ['neutral.regularText', 'text.secondary', 'text.primary'],
  secondaryText: ['neutral.secondaryText', 'text.muted', 'text.secondary', 'text.primary'],
  placeholderText: ['neutral.placeholderText', 'text.inputPlaceholder', 'text.faint', 'text.muted'],
  disabledText: ['neutral.disabledText', 'text.inputDisabled', 'text.btn.disabled', 'text.faint', 'text.muted'],
  darkerBorder: ['neutral.darkerBorder', 'border.strong', 'border.default'],
  darkBorder: ['neutral.darkBorder', 'border.strong', 'border.default'],
  baseBorder: ['neutral.baseBorder', 'border.default'],
  lightBorder: ['neutral.lightBorder', 'border.subtle', 'border.default'],
  lighterBorder: ['neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default'],
  extraLightBorder: ['neutral.extraLightBorder', 'border.divider', 'border.subtle', 'border.default'],
  darkerFill: ['neutral.darkerFill', 'bg.floating', 'bg.elevated', 'bg.panel', 'bg.chat'],
  darkFill: ['neutral.darkFill', 'bg.elevated', 'bg.panel', 'bg.chat'],
  baseFill: ['neutral.baseFill', 'bg.panel', 'bg.chat'],
  lightFill: ['neutral.lightFill', 'bg.chat', 'bg.panel', 'bg.app'],
  lighterFill: ['neutral.lighterFill', 'bg.input', 'bg.chat', 'bg.app'],
  extraLightFill: ['neutral.extraLightFill', 'bg.app', 'bg.chat'],
  blankFill: ['neutral.blankFill'],
  basicBlack: ['neutral.basicBlack'],
  basicWhite: ['neutral.basicWhite'],
  transparent: ['neutral.transparent'],
  pageBackground: ['neutral.pageBackground', 'bg.app'],
  baseBackground: ['neutral.baseBackground', 'bg.chat', 'bg.panel', 'bg.app'],
  overlayBackground: ['neutral.overlayBackground', 'bg.modal', 'bg.floating', 'bg.panel'],
}

const NEUTRAL_TEXT_COLOR_TOKENS = [
  'primaryText',
  'regularText',
  'secondaryText',
  'placeholderText',
  'disabledText',
] as const satisfies readonly ThemeNeutralColorToken[]

type NeutralTextColorToken = typeof NEUTRAL_TEXT_COLOR_TOKENS[number]

const NEUTRAL_COLOR_DEFAULTS: Record<ThemeNeutralColorToken, string> = {
  primaryText: '#F9FAFB',
  regularText: '#E5E7EB',
  secondaryText: '#9CA3AF',
  placeholderText: '#6B7280',
  disabledText: '#4B5563',
  darkerBorder: '#4B5563',
  darkBorder: '#374151',
  baseBorder: '#2F3746',
  lightBorder: '#253041',
  lighterBorder: '#202A39',
  extraLightBorder: '#1B2433',
  darkerFill: '#374151',
  darkFill: '#2F3746',
  baseFill: '#253041',
  lightFill: '#202A39',
  lighterFill: '#1B2433',
  extraLightFill: '#111827',
  blankFill: 'transparent',
  basicBlack: '#000000',
  basicWhite: '#FFFFFF',
  transparent: 'transparent',
  pageBackground: '#111827',
  baseBackground: '#1F2937',
  overlayBackground: '#374151',
}

function firstResolvedThemeValue(
  resolvedTheme: Record<string, string>,
  ...paths: string[]
): string | undefined {
  for (const path of paths) {
    const value = resolvedTheme[path]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function deriveTranslucentColor(color: string, alpha: number): string {
  if (parseCssColor(color)) {
    return rgbaFromCssColor(color, alpha)
  }
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}

function solidColorForRamp(color: string, background: string | undefined): string | undefined {
  const colorOverBackground = resolveColorOverBackground(color, background)
  if (colorOverBackground) return colorToHex(colorOverBackground)

  const parsed = parseCssColor(color)
  if (!parsed) return undefined

  return colorToHex(parsed)
}

function fallbackStatusColorScale(baseColor: string, mode: 'dark' | 'light'): string[] {
  const surface = mode === 'dark' ? '#141414' : '#FFFFFF'
  const contrast = mode === 'dark' ? '#FFFFFF' : '#000000'

  return [
    `color-mix(in srgb, ${baseColor} 8%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 14%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 22%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 34%, ${surface})`,
    `color-mix(in srgb, ${baseColor} 52%, ${surface})`,
    baseColor,
    `color-mix(in srgb, ${baseColor} 86%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 72%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 58%, ${contrast})`,
    `color-mix(in srgb, ${baseColor} 44%, ${contrast})`,
  ]
}

function generateSemanticColorScale(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): string[] {
  const solidBase = solidColorForRamp(baseColor, background)
  if (!solidBase) return fallbackStatusColorScale(baseColor, mode)

  const solidBackground = background ? solidColorForRamp(background, undefined) : undefined
  return generateAntColorPalette(solidBase, {
    theme: mode === 'dark' ? 'dark' : 'default',
    ...(mode === 'dark' && solidBackground ? { backgroundColor: solidBackground } : {}),
  })
}

export function selectPrimaryColorSemantics(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): ResolvedPrimaryColorSemantics {
  const scale = generateSemanticColorScale(baseColor, mode, background)

  return {
    base: scale[5] || baseColor,
    hover: (mode === 'dark' ? scale[6] : scale[4]) || baseColor,
    bg: scale[0] || deriveTranslucentColor(baseColor, 0.1),
    bgHover: scale[1] || deriveTranslucentColor(baseColor, 0.14),
    border: scale[2] || deriveTranslucentColor(baseColor, 0.28),
    text: (mode === 'dark' ? scale[7] : scale[6]) || baseColor,
    light: scale[0] || deriveTranslucentColor(baseColor, 0.1),
  }
}

export function selectStatusColorSemantics(
  baseColor: string,
  mode: 'dark' | 'light',
  background: string | undefined,
): ResolvedStatusColorSemantics {
  const scale = generateSemanticColorScale(baseColor, mode, background)
  const surfaceRamp = deriveStatusSurfaceRamp(baseColor, background, mode)

  return {
    base: scale[5] || baseColor,
    bg: surfaceRamp?.bg || scale[0] || deriveTranslucentColor(baseColor, 0.12),
    bgHover: surfaceRamp?.bgHover || scale[1] || deriveTranslucentColor(baseColor, 0.18),
    border: surfaceRamp?.border || scale[2] || deriveTranslucentColor(baseColor, 0.32),
    text: (mode === 'dark' ? scale[7] : scale[6]) || baseColor,
    light: surfaceRamp?.bg || scale[0] || deriveTranslucentColor(baseColor, 0.12),
  }
}

function applyThemeColorSemantics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): void {
  const primary = firstResolvedThemeValue(
    resolvedTheme,
    'primary',
    'accentMain',
    'accent'
  ) || DEFAULT_PRIMARY_COLOR

  resolvedTheme.primary = primary
  if (!resolvedTheme.accent) resolvedTheme.accent = primary
  if (!resolvedTheme.accentMain) resolvedTheme.accentMain = primary
  if (!resolvedTheme.accentLight) {
    resolvedTheme.accentLight = resolvedTheme.accentSub || primary
  }

  const rampBackground = firstResolvedThemeValue(
    resolvedTheme,
    'neutral.pageBackground',
    'bg.app',
  )
  const generatedPrimary = selectPrimaryColorSemantics(primary, mode, rampBackground)

  resolvedTheme.primaryHover = firstResolvedThemeValue(
    resolvedTheme,
    'primaryHover',
  ) || generatedPrimary.hover || firstResolvedThemeValue(
    resolvedTheme,
    'bg.btn.primaryHover',
    'accentLight',
    'accentSub',
  ) || primary
  resolvedTheme.primaryBg = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBg',
  ) || generatedPrimary.bg
  resolvedTheme.primaryBgHover = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBgHover',
  ) || generatedPrimary.bgHover
  resolvedTheme.primaryBorder = firstResolvedThemeValue(
    resolvedTheme,
    'primaryBorder',
  ) || generatedPrimary.border || firstResolvedThemeValue(
    resolvedTheme,
    'border.accent',
    'border.inputFocus',
  ) || primary
  resolvedTheme.primaryText = firstResolvedThemeValue(
    resolvedTheme,
    'primaryText',
  ) || generatedPrimary.text
  resolvedTheme.primaryLight = resolvedTheme.primaryBg || firstResolvedThemeValue(resolvedTheme, 'primaryLight') || generatedPrimary.light

  for (const token of THEME_STATUS_COLOR_TOKENS) {
    const colorPath = `color.${token}`
    const bgPath = `color.${token}Bg`
    const bgHoverPath = `color.${token}BgHover`
    const borderPath = `color.${token}Border`
    const textPath = `color.${token}Text`
    const lightPath = `color.${token}Light`
    const requestedBaseColor = firstResolvedThemeValue(
      resolvedTheme,
      ...STATUS_COLOR_FALLBACK_PATHS[token]
    ) || STATUS_COLOR_DEFAULTS[token]
    const requestedColor = token === 'danger'
      ? nudgeDangerColorTowardRed(requestedBaseColor)
      : requestedBaseColor
    const generated = selectStatusColorSemantics(requestedColor, mode, rampBackground)
    const explicitBorder = firstResolvedThemeValue(resolvedTheme, borderPath)
    const explicitText = firstResolvedThemeValue(resolvedTheme, textPath)

    resolvedTheme[colorPath] = requestedColor
    resolvedTheme[bgPath] = firstResolvedThemeValue(resolvedTheme, bgPath, lightPath) || generated.bg
    resolvedTheme[bgHoverPath] = firstResolvedThemeValue(resolvedTheme, bgHoverPath) || generated.bgHover
    resolvedTheme[borderPath] = explicitBorder
      ? (explicitBorder === requestedBaseColor ? requestedColor : explicitBorder)
      : generated.border
    resolvedTheme[textPath] = explicitText
      ? (explicitText === requestedBaseColor ? requestedColor : explicitText)
      : generated.text
    resolvedTheme[lightPath] = resolvedTheme[bgPath] || firstResolvedThemeValue(resolvedTheme, lightPath) || generated.bg
  }

  const generatedNeutralText = deriveNeutralTextRamp(
    firstResolvedThemeValue(resolvedTheme, 'text.primary', 'neutral.primaryText') || NEUTRAL_COLOR_DEFAULTS.primaryText,
    firstResolvedThemeValue(resolvedTheme, 'neutral.pageBackground', 'bg.app') || NEUTRAL_COLOR_DEFAULTS.pageBackground,
    mode,
  )
  const generatedNeutralTextByToken = generatedNeutralText as Record<NeutralTextColorToken, string> | undefined

  for (const token of THEME_NEUTRAL_COLOR_TOKENS) {
    const path = `neutral.${token}`
    if (NEUTRAL_TEXT_COLOR_TOKENS.includes(token as NeutralTextColorToken)) {
      resolvedTheme[path] = generatedNeutralTextByToken?.[token as NeutralTextColorToken]
        || firstResolvedThemeValue(
          resolvedTheme,
          ...NEUTRAL_COLOR_FALLBACK_PATHS[token]
        )
        || NEUTRAL_COLOR_DEFAULTS[token]
      continue
    }

    resolvedTheme[path] = firstResolvedThemeValue(
      resolvedTheme,
      ...NEUTRAL_COLOR_FALLBACK_PATHS[token]
    ) || NEUTRAL_COLOR_DEFAULTS[token]
  }
}

export function resolveThemeColorSemantics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): ResolvedThemeColorSemantics {
  const normalizedTheme = { ...resolvedTheme }
  applyThemeColorSemantics(normalizedTheme, mode)

  return {
    primary: {
      base: normalizedTheme.primary,
      hover: normalizedTheme.primaryHover,
      bg: normalizedTheme.primaryBg,
      bgHover: normalizedTheme.primaryBgHover,
      border: normalizedTheme.primaryBorder,
      text: normalizedTheme.primaryText,
      light: normalizedTheme.primaryLight,
    },
    status: Object.fromEntries(
      THEME_STATUS_COLOR_TOKENS.map(token => [
        token,
        {
          base: normalizedTheme[`color.${token}`],
          bg: normalizedTheme[`color.${token}Bg`],
          bgHover: normalizedTheme[`color.${token}BgHover`],
          border: normalizedTheme[`color.${token}Border`],
          text: normalizedTheme[`color.${token}Text`],
          light: normalizedTheme[`color.${token}Light`],
        },
      ])
    ) as Record<ThemeStatusColorToken, ResolvedStatusColorSemantics>,
    neutral: Object.fromEntries(
      THEME_NEUTRAL_COLOR_TOKENS.map(token => [token, normalizedTheme[`neutral.${token}`]])
    ) as Record<ThemeNeutralColorToken, string>,
  }
}

export function resolveThemeColorScaleDiagnostics(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light' = 'light',
): ResolvedColorScaleDiagnostics {
  const normalizedTheme = { ...resolvedTheme }
  applyThemeColorSemantics(normalizedTheme, mode)

  const rampBackground = firstResolvedThemeValue(
    normalizedTheme,
    'neutral.pageBackground',
    'bg.app',
  )

  return {
    primary: {
      semantics: {
        base: normalizedTheme.primary,
        hover: normalizedTheme.primaryHover,
        bg: normalizedTheme.primaryBg,
        bgHover: normalizedTheme.primaryBgHover,
        border: normalizedTheme.primaryBorder,
        text: normalizedTheme.primaryText,
        light: normalizedTheme.primaryLight,
      },
      scale: generateSemanticColorScale(
        normalizedTheme.primary || DEFAULT_PRIMARY_COLOR,
        mode,
        rampBackground,
      ),
    },
    status: Object.fromEntries(
      THEME_STATUS_COLOR_TOKENS.map(token => {
        const base = normalizedTheme[`color.${token}`] || STATUS_COLOR_DEFAULTS[token]
        return [
          token,
          {
            semantics: {
              base,
              bg: normalizedTheme[`color.${token}Bg`],
              bgHover: normalizedTheme[`color.${token}BgHover`],
              border: normalizedTheme[`color.${token}Border`],
              text: normalizedTheme[`color.${token}Text`],
              light: normalizedTheme[`color.${token}Light`],
            },
            scale: generateSemanticColorScale(base, mode, rampBackground),
          },
        ]
      })
    ) as ResolvedColorScaleDiagnostics['status'],
  }
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

function isSemanticHighlightToken(value: string): value is SemanticHighlightToken {
  return SEMANTIC_HIGHLIGHT_TOKEN_SET.has(value)
}

function isHighlightLink(value: ThemeHighlightGroup): value is { link: string } {
  return typeof value === 'object' && value !== null && 'link' in value
}

function buildResolvedMap(resolvedTheme: Record<string, string>): Map<string, ResolvedColorValue> {
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

function selectModeValue(value: ResolvedColorValue, mode: 'dark' | 'light'): string {
  return typeof value === 'object' && 'dark' in value ? value[mode] : value
}

function resolveThemeDefinitionColors(
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

function getResolvedThemeValue(
  resolvedTheme: Record<string, string>,
  ...paths: string[]
): string | undefined {
  for (const path of paths) {
    const value = resolvedTheme[path]
    if (value !== undefined) return value
  }
  return undefined
}

function deriveLightSurface(base: string, primaryText: string | undefined, strength: number): string {
  return mixCssColors(primaryText, base, strength) || base
}

function contrastForColor(
  foreground: string | undefined,
  background: string | undefined
): number {
  const foregroundColor = resolveColorOverBackground(foreground, background)
  const backgroundColor = parseCssColor(background)
  if (!foregroundColor || !backgroundColor) return -1
  return contrastRatio(foregroundColor, backgroundColor)
}

function onSolidColor(
  resolvedTheme: Record<string, string>,
  background: string | undefined,
  ...fallbackPaths: string[]
): string | undefined {
  const fallback = getResolvedThemeValue(resolvedTheme, ...fallbackPaths)
  const candidates = [
    getResolvedThemeValue(resolvedTheme, 'neutral.basicWhite') || NEUTRAL_COLOR_DEFAULTS.basicWhite,
    getResolvedThemeValue(resolvedTheme, 'neutral.basicBlack') || NEUTRAL_COLOR_DEFAULTS.basicBlack,
  ]
    .map(color => ({ color, contrast: contrastForColor(color, background) }))
    .sort((a, b) => b.contrast - a.contrast)

  const readable = candidates.find(candidate => candidate.contrast >= 4.5)
  return readable?.color || fallback
}

/**
 * Minimum OKLCH lightness separation between a surface and the chat canvas it
 * sits on. Shared with the guardrail tests so resolver policy and test
 * expectations cannot drift apart.
 */
export const SURFACE_GUARD_MIN_DELTA_L = {
  input: 0.03,
  inputFocus: 0.05,
  userBubble: 0.03,
  systemMessage: 0.03,
} as const

const SURFACE_ROLE_STASH_KEYS: Record<keyof ThemeSurfaceRoles, string> = {
  appBg: 'role.surface.appBg',
  sidebarBg: 'role.surface.sidebarBg',
  chatBg: 'role.surface.chatBg',
  panelBg: 'role.surface.panelBg',
  tabBarBg: 'role.surface.tabBarBg',
  elevatedBg: 'role.surface.elevatedBg',
  floatingBg: 'role.surface.floatingBg',
}

function readStashedSurfaceRoles(
  resolvedTheme: Record<string, string>
): ThemeSurfaceRoles | null {
  const roles: Partial<Record<keyof ThemeSurfaceRoles, string>> = {}
  for (const [role, stashKey] of Object.entries(SURFACE_ROLE_STASH_KEYS) as Array<[keyof ThemeSurfaceRoles, string]>) {
    const value = resolvedTheme[stashKey]
    if (!value) return null
    roles[role] = value
  }
  return roles as ThemeSurfaceRoles
}

function deriveSemanticSurfaceRoles(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light'
): ThemeSurfaceRoles {
  // Once the neutral ramp has been anchored onto the derived roles, re-deriving
  // from those anchored values would feed the promoted surfaces back through
  // the promotion logic and shift the whole ladder up a step. Return the
  // stashed roles instead so derivation is idempotent.
  const stashed = readStashedSurfaceRoles(resolvedTheme)
  if (stashed) return stashed

  const get = (...paths: string[]) => getResolvedThemeValue(resolvedTheme, ...paths)

  return deriveSurfaceRoles({
    colorScheme: mode,
    app: get('neutral.pageBackground', 'bg.app'),
    // Sidebar has its own visual role, so keep explicit sidebar before neutral fallbacks.
    sidebar: get('bg.sidebar', 'neutral.baseFill', 'neutral.pageBackground'),
    chat: get('neutral.baseBackground', 'bg.chat'),
    panel: get('neutral.baseFill', 'bg.panel'),
    elevated: get('neutral.darkFill', 'bg.elevated'),
    floating: get('neutral.darkerFill', 'bg.floating'),
    primaryText: get('neutral.primaryText', 'text.primary'),
  })
}

function selectedStateBorderColor(
  resolvedTheme: Record<string, string>,
  mode: 'dark' | 'light'
): string | undefined {
  return mode === 'dark'
    ? getResolvedThemeValue(
      resolvedTheme,
      'primaryHover',
      'primary',
      'accentMain',
      'accent',
      'primaryBorder',
      'border.accent',
    )
    : getResolvedThemeValue(
      resolvedTheme,
      'primaryBorder',
      'primary',
      'accentMain',
      'accent',
      'border.accent',
    )
}

function deriveStateOverlaysForSurface(
  resolvedTheme: Record<string, string>,
  surface: string | undefined,
  mode: 'dark' | 'light'
) {
  return deriveStateOverlays(surface, selectedStateBorderColor(resolvedTheme, mode), mode)
}

function categoryUIStyle(token: SemanticUIToken, categoryColors: CategoryColor[]): ResolvedUIStyle | undefined {
  const match = /^ui\.category\.(\d+)\.(icon|badgeBg|badgeText)$/.exec(token)
  if (!match) return undefined

  const category = categoryColors[Number(match[1]) - 1]
  if (!category) return {}

  switch (match[2]) {
    case 'icon':
      return { fg: category.icon }
    case 'badgeBg':
      return { bg: category.badgeBg }
    case 'badgeText':
      return { fg: category.badgeText }
    default:
      return undefined
  }
}

function firstSolidColor(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find(candidate => candidate !== undefined && parseCssColor(candidate) !== null)
}

/**
 * Composer/input surface visibly raised from the chat surface. Raw theme fills
 * can land exactly on the derived chat surface (the surface roles may promote
 * chat above bg.chat), so every token that paints the input must share this
 * guarded value or --bg-input consumers drift apart.
 */
function resolveComposerInputBg(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): string {
  // Always raised in the mode's direction (lighter in dark, darker in light):
  // the composer paints as a card on the chat canvas next to a darker sidebar,
  // so honoring a theme's recessed bg.input reads as a hole, not an input.
  const isDark = mode === 'dark'
  const rawInputBg = getResolvedThemeValue(resolvedTheme, 'neutral.lighterFill', 'bg.input')
    || surfaceRoles.panelBg
  const guardedRaw = guaranteeMinDeltaL(surfaceRoles.chatBg, rawInputBg, SURFACE_GUARD_MIN_DELTA_L.input, isDark)
  if (guardedRaw === rawInputBg) return rawInputBg

  // The raw input color is unusable (recessed or colliding). Don't lightness-
  // shift it — that keeps its stale chroma and reads as an off-family grey
  // slab on tinted canvases. Reuse the derived panel surface instead: it is
  // already in the canvas's tonal family and guaranteed distinct from chat.
  const panelBg = surfaceRoles.panelBg
  return guaranteeMinDeltaL(surfaceRoles.chatBg, panelBg, SURFACE_GUARD_MIN_DELTA_L.input, isDark)
    ?? guardedRaw
    ?? panelBg
}

/**
 * Rewrites the neutral fill ramp onto the derived surface roles so every
 * consumer — UI tokens reading `neutral.*`, the emitted `--color-neutral-*`
 * CSS variables, highlight fallbacks — sees one consistent surface system.
 *
 * Why: `deriveSurfaceRoles` may promote surfaces away from the raw theme
 * values (dark mode prefers the panel color for the chat canvas). Tokens that
 * keep reading raw `neutral.*`/`bg.*` values then collide with the promoted
 * surfaces — the class of bug where the composer sat exactly on the chat
 * background. Anchoring once here removes the need for per-token collision
 * guards on every neutral consumer.
 *
 * Also stashes the roles onto the record so later derivations return the same
 * values (see deriveSemanticSurfaceRoles).
 */
function anchorNeutralFillsToSurfaceRoles(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): void {
  // Compute before overwriting neutral.lighterFill, which it reads.
  const inputBg = resolveComposerInputBg(resolvedTheme, surfaceRoles, mode)

  for (const [role, stashKey] of Object.entries(SURFACE_ROLE_STASH_KEYS) as Array<[keyof ThemeSurfaceRoles, string]>) {
    resolvedTheme[stashKey] = surfaceRoles[role]
  }

  resolvedTheme['neutral.pageBackground'] = surfaceRoles.appBg
  resolvedTheme['neutral.baseBackground'] = surfaceRoles.chatBg
  resolvedTheme['neutral.extraLightFill'] = surfaceRoles.appBg
  resolvedTheme['neutral.lightFill'] = surfaceRoles.chatBg
  resolvedTheme['neutral.baseFill'] = surfaceRoles.panelBg
  resolvedTheme['neutral.darkFill'] = surfaceRoles.elevatedBg
  resolvedTheme['neutral.darkerFill'] = surfaceRoles.floatingBg
  resolvedTheme['neutral.lighterFill'] = inputBg
}

/**
 * User-bubble surface that is always a solid, parseable color visibly raised
 * from the chat surface. `bg.message.user` may be a gradient, which components
 * cannot feed into color-mix(), so the solid variant must never inherit it.
 */
function resolveUserBubbleSolidBg(
  resolvedTheme: Record<string, string>,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light'
): string {
  const rawSolid = firstSolidColor(
    getResolvedThemeValue(resolvedTheme, 'bg.message.userSolid'),
    getResolvedThemeValue(resolvedTheme, 'bg.message.user'),
  ) || surfaceRoles.elevatedBg

  return guaranteeMinAbsDeltaL(surfaceRoles.chatBg, rawSolid, SURFACE_GUARD_MIN_DELTA_L.userBubble, mode === 'dark')
    ?? rawSolid
}

function fallbackUIStyle(
  resolvedTheme: Record<string, string>,
  token: SemanticUIToken,
  surfaceRoles: ThemeSurfaceRoles,
  mode: 'dark' | 'light',
  categoryColors: CategoryColor[] = []
): ResolvedUIStyle {
  const categoryStyle = categoryUIStyle(token, categoryColors)
  if (categoryStyle) return categoryStyle

  const get = (...paths: string[]) => getResolvedThemeValue(resolvedTheme, ...paths)

  switch (token) {
    case 'ui.accent.primary':
      return { fg: get('primary', 'accentMain', 'accent') }
    case 'ui.accent.subtle':
      return { fg: get('primaryHover', 'accentSub', 'accentLight', 'primaryText', 'primary', 'accent') }
    case 'ui.surface.app':
      return { bg: surfaceRoles.appBg }
    case 'ui.surface.sidebar':
      return { bg: surfaceRoles.sidebarBg }
    case 'ui.surface.chat':
      return { bg: surfaceRoles.chatBg }
    case 'ui.surface.panel':
      return { bg: surfaceRoles.panelBg }
    case 'ui.surface.elevated':
      return {
        bg: surfaceRoles.elevatedBg,
        shadow: get('shadow.elevated', 'shadow.md', 'shadow.sm'),
      }
    case 'ui.surface.floating':
      return {
        bg: surfaceRoles.floatingBg,
        shadow: get('shadow.floating', 'shadow.lg', 'shadow.md'),
      }
    case 'ui.surface.overlay':
      return { bg: get('neutral.overlayBackground', 'bg.modalOverlay', 'effects.overlayActive') }
    case 'ui.surface.menu':
      return { bg: get('bg.menu', 'neutral.darkerFill') || surfaceRoles.floatingBg }
    case 'ui.surface.menuHover':
      return {
        bg: mode === 'light'
          ? rgbaFromCssColor(get('primary', 'accentMain', 'accent'), 0.12)
          : get('neutral.darkFill', 'bg.menuItemHover', 'bg.hover'),
      }
    case 'ui.surface.input':
      return {
        bg: resolveComposerInputBg(resolvedTheme, surfaceRoles, mode),
        border: get('neutral.baseBorder', 'border.input', 'border.default'),
      }
    case 'ui.surface.inputFocus': {
      const rawFocusBg = get('neutral.darkFill', 'bg.inputFocus', 'bg.input') || surfaceRoles.elevatedBg
      return {
        bg: guaranteeMinDeltaL(surfaceRoles.chatBg, rawFocusBg, SURFACE_GUARD_MIN_DELTA_L.inputFocus, mode === 'dark') ?? rawFocusBg,
        border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
        ring: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
      }
    }
    case 'ui.surface.codeInline':
      return {
        bg: get('neutral.darkFill', 'bg.code.inline') || (surfaceRoles.elevatedBg),
        fg: get('neutral.primaryText', 'text.code.inline', 'text.primary'),
        border: get('neutral.baseBorder', 'border.code', 'border.subtle'),
      }
    case 'ui.surface.codeBlock': {
      const rawBlockBg = get('neutral.baseFill', 'bg.code.block') || surfaceRoles.panelBg
      return {
        bg: mode === 'light'
          ? deriveLightSurface(surfaceRoles.chatBg, get('neutral.primaryText', 'text.primary'), 0.035)
          : (guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, true) ?? rawBlockBg),
        fg: get('neutral.primaryText', 'text.code.block', 'text.primary'),
        border: get('neutral.baseBorder', 'border.code', 'border.subtle'),
      }
    }
    case 'ui.surface.codeHeader': {
      const rawBlockBg = get('neutral.baseFill', 'bg.code.block') || surfaceRoles.panelBg
      const guardedBlockBg = guaranteeMinDeltaL(surfaceRoles.chatBg, rawBlockBg, 0.04, true) ?? rawBlockBg
      const rawHeaderBg = get('neutral.darkFill', 'bg.code.header') || surfaceRoles.elevatedBg
      return {
        bg: mode === 'light'
          ? deriveLightSurface(surfaceRoles.chatBg, get('neutral.primaryText', 'text.primary'), 0.055)
          : (guaranteeMinDeltaL(guardedBlockBg, rawHeaderBg, 0.05, true) ?? rawHeaderBg),
      }
    }
    case 'ui.surface.tooltip':
      {
        const bg = get('bg.tooltip') || surfaceRoles.floatingBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('text.tooltip'),
            get('text.btn.primary'),
            surfaceRoles.appBg,
            surfaceRoles.panelBg,
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.darkBorder', 'border.strong', 'border.default'),
          shadow: get('shadow.floating', 'shadow.lg', 'shadow.md'),
        }
      }
    case 'ui.surface.modal':
      return {
        bg: get('neutral.darkerFill', 'bg.modal') || surfaceRoles.floatingBg,
        fg: get('neutral.regularText', 'text.modalBody', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default'),
        shadow: get('shadow.floating', 'shadow.xl', 'shadow.lg'),
      }
    case 'ui.surface.note':
      return {
        bg: get('color.warningBg', 'color.warningLight') || surfaceRoles.elevatedBg,
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('color.warningBorder', 'color.warning', 'border.warning', 'border.subtle', 'border.default'),
      }
    case 'ui.surface.previewLight':
      return { bg: '#ffffff', fg: '#111827', border: '#e5e7eb' }
    case 'ui.surface.previewDark':
      return { bg: '#0f1117', fg: '#f9fafb', border: '#1f2937' }
    case 'ui.text.primary':
      return { fg: get('neutral.primaryText', 'text.primary') }
    case 'ui.text.secondary':
      return { fg: get('neutral.regularText', 'text.secondary', 'text.primary') }
    case 'ui.text.muted':
      return { fg: get('neutral.secondaryText', 'text.muted', 'text.secondary', 'text.primary') }
    case 'ui.text.faint':
      return { fg: get('neutral.disabledText', 'text.faint', 'text.muted', 'text.secondary') }
    case 'ui.text.inverse':
      return { fg: get('neutral.pageBackground', 'bg.app', 'text.btn.primary', 'neutral.primaryText', 'text.primary') }
    case 'ui.text.placeholder':
      return { fg: get('neutral.placeholderText', 'text.inputPlaceholder', 'text.muted') }
    case 'ui.text.disabled':
      return { fg: get('neutral.disabledText', 'text.inputDisabled', 'text.btn.disabled', 'text.faint', 'text.muted') }
    case 'ui.text.link':
      return { fg: get('color.info', 'text.link', 'primary', 'accent') }
    case 'ui.text.linkHover':
      return { fg: get('color.infoText', 'text.linkHover', 'text.link', 'color.info', 'primary', 'accent') }
    case 'ui.border.default':
      return { border: get('neutral.baseBorder', 'border.default') }
    case 'ui.border.subtle':
      return { border: get('neutral.lightBorder', 'border.subtle', 'border.default') }
    case 'ui.border.strong':
      return { border: get('neutral.darkBorder', 'border.strong', 'border.default') }
    case 'ui.border.divider':
      return { border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default') }
    case 'ui.border.focus':
      return { border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'), ring: get('primaryBorder', 'primary', 'border.inputFocus', 'accent') }
    case 'ui.border.selected':
      return { border: get('primaryBorder', 'primary', 'border.accent', 'border.inputFocus', 'accent') }
    case 'ui.table.headerBg':
      {
        const rawBg = get('bg.tableHeader', 'bg.table.header', 'neutral.darkFill') || surfaceRoles.elevatedBg
        return {
          bg: guaranteeMinDeltaL(surfaceRoles.panelBg, rawBg, 0.04, mode === 'dark') ?? rawBg,
        }
      }
    case 'ui.table.rowBg':
      return { bg: 'transparent' }
    case 'ui.table.border':
      {
        const rawHeaderBg = get('bg.tableHeader', 'bg.table.header', 'neutral.darkFill') || surfaceRoles.elevatedBg
        const headerBg = guaranteeMinDeltaL(surfaceRoles.panelBg, rawHeaderBg, 0.04, mode === 'dark') ?? rawHeaderBg
        const rawBorder = get('border.table', 'neutral.baseBorder', 'border.default') || headerBg
        return {
          border: guaranteeMinDeltaL(headerBg, rawBorder, 0.06, mode === 'dark') ?? rawBorder,
        }
      }
    case 'ui.action.primary':
      {
        const bg = get('primary', 'bg.btn.primary', 'accent')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.primary', 'neutral.pageBackground', 'bg.app'),
          border: get('primary', 'primaryBorder', 'border.accent', 'accent'),
        }
      }
    case 'ui.action.primaryHover':
      {
        const bg = get('primaryHover', 'bg.btn.primaryHover', 'accentLight', 'accentSub', 'bg.btn.primary', 'primary', 'accent')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.primary', 'neutral.pageBackground', 'bg.app'),
          border: get('primary', 'primaryBorder', 'border.accent', 'accent'),
        }
      }
    case 'ui.action.secondary':
      return {
        bg: get('neutral.darkFill', 'bg.btn.secondary') || surfaceRoles.elevatedBg,
        fg: get('neutral.primaryText', 'text.btn.secondary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.action.secondaryHover':
      return {
        bg: get('neutral.darkerFill', 'bg.btn.secondaryHover', 'bg.btn.secondary', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.btn.secondary', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default', 'border.subtle'),
      }
    case 'ui.action.ghost':
      return {
        bg: get('bg.btn.ghost') || 'transparent',
        fg: get('neutral.regularText', 'text.btn.ghost', 'text.primary'),
        border: 'transparent',
      }
    case 'ui.action.ghostHover':
      return {
        bg: get('neutral.darkFill', 'bg.btn.ghostHover', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.btn.ghost', 'text.primary'),
        border: 'transparent',
      }
    case 'ui.action.danger':
      {
        const bg = get('color.danger', 'bg.btn.danger')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.danger', 'neutral.pageBackground', 'bg.app'),
          border: get('color.dangerBorder', 'color.danger', 'border.error'),
        }
      }
    case 'ui.action.dangerHover':
      {
        const bg = get('color.dangerBgHover', 'bg.btn.dangerHover', 'bg.btn.danger', 'color.danger')
        return {
          bg,
          fg: onSolidColor(resolvedTheme, bg, 'text.btn.danger', 'neutral.pageBackground', 'bg.app'),
          border: get('color.dangerBorder', 'color.danger', 'border.error'),
        }
      }
    case 'ui.action.disabled':
      return {
        bg: get('neutral.lighterFill', 'bg.inputDisabled', 'effects.overlayDisabled', 'bg.hover'),
        fg: get('neutral.disabledText', 'text.btn.disabled', 'text.inputDisabled', 'text.faint'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.state.hover':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return { bg: state?.hover || get('bg.hover', 'effects.overlayHover', 'neutral.darkFill') || surfaceRoles.elevatedBg }
      }
    case 'ui.state.active':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return { bg: state?.active || get('bg.active', 'effects.overlayActive', 'neutral.darkerFill') || surfaceRoles.floatingBg }
      }
    case 'ui.state.selected':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return {
          bg: state?.selected.bg || get('bg.selected', 'primaryBg'),
          fg: get('neutral.primaryText', 'text.primary'),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.state.selectedHover':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.panelBg, mode)
        return {
          bg: state?.selectedHover || get('bg.selectedHover', 'primaryBgHover', 'bg.selected', 'primaryBg'),
          fg: get('neutral.primaryText', 'text.primary'),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.state.highlight':
      return { bg: get('color.warningBg', 'color.warningLight', 'bg.highlight', 'accentSub') }
    case 'ui.state.focus':
      return {
        border: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
        ring: get('primaryBorder', 'primary', 'border.inputFocus', 'border.accent', 'accent'),
      }
    case 'ui.state.disabled':
      return {
        bg: get('bg.inputDisabled', 'neutral.lighterFill', 'effects.overlayDisabled'),
        fg: get('neutral.disabledText', 'text.inputDisabled', 'text.btn.disabled', 'text.faint'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.sidebar.surface':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default'),
        }
      }
    case 'ui.sidebar.item':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.itemHover':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('text.sidebar.itemHover'),
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.itemActive':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const activeBg = state?.selected.bg || get('bg.selected', 'primaryBg')
        const activeSurface = colorToRgbString(resolveColorOverBackground(activeBg, bg)) || activeBg || bg
        return {
          bg: activeBg,
          fg: readableAgainst(activeSurface, [
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.itemActive'),
            get('text.sidebar.itemHover'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: state?.selected.border || get('primaryBorder', 'primary', 'border.accent', 'accent'),
        }
      }
    case 'ui.sidebar.itemMuted':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.muted'),
            get('text.sidebar.count'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.sidebar.header':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.title'),
            get('neutral.disabledText', 'text.faint'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.sidebar.action':
      {
        const bg = surfaceRoles.sidebarBg
        return {
          fg: readableAgainst(bg, [
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
          bg: 'transparent',
        }
      }
    case 'ui.sidebar.actionHover':
      {
        const bg = surfaceRoles.sidebarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('text.sidebar.itemHover'),
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.item'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.sidebar.border':
      return { border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default') }
    case 'ui.tabBar.surface':
      return {
        bg: surfaceRoles.tabBarBg,
        border: get('neutral.lighterBorder', 'border.divider', 'border.subtle', 'border.default'),
        shadow: 'none',
      }
    case 'ui.tabBar.divider':
      return { border: 'color-mix(in srgb, var(--ui-border-subtle-border, var(--border-subtle, var(--border))) 70%, var(--ui-text-muted-fg, var(--muted)))' }
    case 'ui.tabBar.item':
      {
        const bg = surfaceRoles.tabBarBg
        return {
          fg: readableAgainst(bg, [
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tabBar.itemHover':
      {
        const bg = surfaceRoles.tabBarBg
        const state = deriveStateOverlaysForSurface(resolvedTheme, bg, mode)
        const hoverBg = state?.hover || get('bg.hover', 'effects.overlayHover')
        const hoverSurface = colorToRgbString(resolveColorOverBackground(hoverBg, bg)) || hoverBg || bg
        return {
          bg: hoverBg,
          fg: readableAgainst(hoverSurface, [
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.tabBar.itemActive':
      {
        const state = deriveStateOverlaysForSurface(resolvedTheme, surfaceRoles.tabBarBg, mode)
        const activeBg = state?.selected.bg || get('bg.selected', 'primaryBg') || surfaceRoles.elevatedBg
        return {
          bg: activeBg,
          fg: readableAgainst(colorToRgbString(resolveColorOverBackground(activeBg, surfaceRoles.tabBarBg)) || activeBg, [
            get('neutral.primaryText', 'text.primary'),
            get('text.sidebar.itemActive'),
            get('neutral.regularText', 'text.secondary'),
            get('text.btn.secondary'),
            '#F9FAFB',
            '#111827',
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: 'transparent',
        }
      }
    case 'ui.tabBar.action':
      {
        const bg = surfaceRoles.tabBarBg
        return {
          fg: readableAgainst(bg, [
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tabBar.actionHover':
      {
        const bg = surfaceRoles.elevatedBg
        return {
          bg,
          fg: readableAgainst(bg, [
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
        }
      }
    case 'ui.tabBar.danger':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.error'),
      }
    case 'ui.status.danger':
      return {
        fg: get('color.dangerText', 'color.danger', 'text.error'),
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.status.warning':
      return {
        fg: get('color.warningText', 'color.warning', 'text.warning'),
        bg: get('color.warningBg', 'color.warningLight'),
        border: get('color.warningBorder', 'color.warning', 'border.warning'),
      }
    case 'ui.status.success':
      return {
        fg: get('color.successText', 'color.success', 'text.success'),
        bg: get('color.successBg', 'color.successLight'),
        border: get('color.successBorder', 'color.success', 'border.success'),
      }
    case 'ui.status.info':
      return {
        fg: get('color.infoText', 'color.info', 'text.info'),
        bg: get('color.infoBg', 'color.infoLight'),
        border: get('color.infoBorder', 'color.info', 'border.accent', 'primary', 'accent'),
      }
    case 'ui.message.user':
      return {
        // May be a gradient; components must only use it as a direct background.
        bg: get('bg.message.user') || resolveUserBubbleSolidBg(resolvedTheme, surfaceRoles, mode),
        fg: get('neutral.primaryText', 'text.user.primary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.messageUser', 'border.message', 'border.subtle'),
      }
    case 'ui.message.userSolid':
      return {
        bg: resolveUserBubbleSolidBg(resolvedTheme, surfaceRoles, mode),
        fg: get('neutral.primaryText', 'text.user.primary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.messageUser', 'border.message', 'border.subtle'),
      }
    case 'ui.message.assistant':
      {
        const bg = get('bg.message.ai') || 'transparent'
        const surface = bg === 'transparent'
          ? surfaceRoles.chatBg
          : (colorToRgbString(resolveColorOverBackground(bg, surfaceRoles.chatBg)) || surfaceRoles.chatBg)
        return {
          bg,
          fg: readableAgainst(surface, [
            get('text.ai.primary'),
            get('neutral.primaryText', 'text.primary'),
            get('neutral.regularText', 'text.secondary'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
          border: get('neutral.lightBorder', 'border.message', 'border.subtle'),
        }
      }
    case 'ui.message.system': {
      // Reads raw bg.* first, so it can collide with the promoted chat surface
      // the same way the composer did. Non-opaque values pass through untouched.
      const rawSystemBg = get('bg.message.system', 'bg.panel') || surfaceRoles.panelBg
      return {
        bg: guaranteeMinAbsDeltaL(surfaceRoles.chatBg, rawSystemBg, SURFACE_GUARD_MIN_DELTA_L.systemMessage, mode === 'dark') ?? rawSystemBg,
        fg: get('neutral.regularText', 'text.system', 'text.secondary', 'text.primary'),
        border: get('neutral.lightBorder', 'border.message', 'border.subtle'),
      }
    }
    case 'ui.message.error':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.message.hover':
      return { bg: get('bg.message.hover', 'bg.hover') }
    case 'ui.message.thinking':
      return { fg: get('neutral.secondaryText', 'text.ai.thinking', 'text.muted') }
    case 'ui.tool.surface':
      return {
        bg: get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel'),
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('neutral.lightBorder', 'border.subtle', 'border.default'),
      }
    case 'ui.tool.surfaceHover':
      return {
        bg: get('neutral.darkerFill', 'bg.toolCallHover', 'bg.toolCall', 'neutral.darkFill', 'bg.hover'),
        fg: get('neutral.primaryText', 'text.primary'),
        border: get('neutral.baseBorder', 'border.default', 'border.subtle'),
      }
    case 'ui.tool.surfaceSubtle':
      return {
        bg: 'color-mix(in srgb, var(--ui-tool-text-fg, var(--tool-ink)) 6%, var(--ui-tool-surface-bg, var(--bg-tool-call)))',
      }
    case 'ui.tool.result':
      return {
        bg: get('neutral.baseFill', 'bg.toolResult', 'bg.toolCall', 'bg.panel'),
        fg: get('neutral.regularText', 'text.tool.result', 'text.primary'),
      }
    case 'ui.tool.error':
      return {
        bg: get('color.dangerBg', 'color.dangerLight', 'bg.toolError', 'bg.message.error'),
        fg: get('color.dangerText', 'color.danger', 'text.tool.error', 'text.error'),
        border: get('color.dangerBorder', 'color.danger', 'border.error'),
      }
    case 'ui.tool.success':
      return {
        bg: get('color.successBg', 'color.successLight', 'bg.toolSuccess'),
        fg: get('color.successText', 'color.success', 'text.success'),
        border: get('color.successBorder', 'color.success', 'border.success'),
      }
    case 'ui.tool.text':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('neutral.primaryText', 'text.primary'),
            get('text.tool.name'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.basicWhite'),
            get('neutral.basicBlack'),
          ], get('neutral.primaryText', 'text.primary'), 4.5),
        }
      }
    case 'ui.tool.textMuted':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('text.tool.args'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.tool.textFaint':
      {
        const bg = get('neutral.darkFill', 'bg.toolCall', 'neutral.baseFill', 'bg.panel')
        return {
          fg: readableAgainst(bg, [
            get('text.tool.label'),
            get('neutral.disabledText', 'text.faint'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3),
        }
      }
    case 'ui.tool.accent':
      return { fg: get('primary', 'accent') }
    case 'ui.tool.accentOn':
      return { fg: get('neutral.pageBackground', 'bg.app', 'text.btn.primary') }
    case 'ui.tool.successText':
      return { fg: get('color.success', 'text.success') }
    case 'ui.tool.dangerText':
      return { fg: get('color.danger', 'text.error') }
    case 'ui.tool.border':
      return { border: get('neutral.lightBorder', 'border.subtle', 'border.default') }
    case 'ui.editor.text':
      return {
        fg: get('neutral.primaryText', 'text.input', 'text.primary'),
        bg: resolveComposerInputBg(resolvedTheme, surfaceRoles, mode),
        border: get('neutral.baseBorder', 'border.input', 'border.default'),
      }
    case 'ui.editor.placeholder':
      {
        const bg = resolveComposerInputBg(resolvedTheme, surfaceRoles, mode)
        return {
          fg: readableAgainst(bg, [
            get('neutral.placeholderText', 'text.inputPlaceholder'),
            get('neutral.secondaryText', 'text.muted'),
            get('neutral.regularText', 'text.secondary'),
            get('neutral.primaryText', 'text.primary'),
          ], get('neutral.regularText', 'text.secondary', 'text.primary'), 3.5),
        }
      }
    case 'ui.editor.caret':
      return { fg: get('neutral.primaryText', 'text.input', 'text.primary') }
    case 'ui.editor.selection':
      return {
        bg: get('primaryBg', 'bg.selected'),
        fg: get('neutral.primaryText', 'text.primary'),
      }
  }

  return {}
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

/**
 * Resolve app UI semantic tokens from the shared role mapping. `theme.ui` is
 * intentionally not applied here: product chrome should be derived from the
 * same role contract for every theme instead of per-theme semantic overrides.
 */
export function resolveThemeUI(
  theme: Theme,
  mode: 'dark' | 'light',
  resolvedTheme: Record<string, string> = resolveTheme(theme, mode)
): Record<SemanticUIToken, ResolvedUIStyle> {
  const styles = new Map<SemanticUIToken, ResolvedUIStyle>()
  const surfaceRoles = deriveSemanticSurfaceRoles(resolvedTheme, mode)
  anchorNeutralFillsToSurfaceRoles(resolvedTheme, surfaceRoles, mode)
  const categoryColors = deriveCategoryColors(
    {
      ...resolvedTheme,
      ...resolveThemeDefinitionColors(theme, mode, resolvedTheme),
    },
    [
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.sidebarBg,
      surfaceRoles.panelBg,
      surfaceRoles.panelBg,
      surfaceRoles.panelBg,
    ],
    mode,
    7
  )

  for (const token of SEMANTIC_UI_TOKENS) {
    styles.set(token, fallbackUIStyle(resolvedTheme, token, surfaceRoles, mode, categoryColors))
  }

  // Post-process: guarantee surface elevation chain using chained anchoring.
  // Each surface is anchored to the already-guarded surface below it in the hierarchy.
  {
    const isDark = mode === 'dark'
    const chatBg = styles.get('ui.surface.chat')?.bg

    // codeBlock distinct from chat (ΔL≥0.04 both modes)
    const rawCodeBlock = styles.get('ui.surface.codeBlock')
    const guardedCodeBlockBg = rawCodeBlock?.bg
      ? (guaranteeMinDeltaL(chatBg, rawCodeBlock.bg, 0.04, isDark) ?? rawCodeBlock.bg)
      : rawCodeBlock?.bg
    if (rawCodeBlock && guardedCodeBlockBg !== rawCodeBlock.bg) {
      styles.set('ui.surface.codeBlock', { ...rawCodeBlock, bg: guardedCodeBlockBg })
    }

    // codeHeader distinct from guarded codeBlock (dark ΔL≥0.05; light ΔL≥0.025 —
    // light headers should read as part of the block, not a separate panel)
    const rawCodeHeader = styles.get('ui.surface.codeHeader')
    const guardedCodeHeaderBg = rawCodeHeader?.bg
      ? (guaranteeMinDeltaL(guardedCodeBlockBg, rawCodeHeader.bg, isDark ? 0.05 : 0.025, isDark) ?? rawCodeHeader.bg)
      : rawCodeHeader?.bg
    if (rawCodeHeader && guardedCodeHeaderBg !== rawCodeHeader.bg) {
      styles.set('ui.surface.codeHeader', { ...rawCodeHeader, bg: guardedCodeHeaderBg })
    }

    // panel distinct from chat (ΔL≥0.04 both modes)
    const rawPanel = styles.get('ui.surface.panel')
    const guardedPanelBg = rawPanel?.bg
      ? (guaranteeMinDeltaL(chatBg, rawPanel.bg, 0.04, isDark) ?? rawPanel.bg)
      : rawPanel?.bg
    if (rawPanel && guardedPanelBg !== rawPanel.bg) {
      styles.set('ui.surface.panel', { ...rawPanel, bg: guardedPanelBg })
    }

    // elevated distinct from guarded panel (dark ΔL≥0.04, light ΔL≥0.03 — shadows compensate)
    const rawElevated = styles.get('ui.surface.elevated')
    const guardedElevatedBg = rawElevated?.bg
      ? (guaranteeMinDeltaL(guardedPanelBg, rawElevated.bg, isDark ? 0.04 : 0.03, isDark) ?? rawElevated.bg)
      : rawElevated?.bg
    if (rawElevated && guardedElevatedBg !== rawElevated.bg) {
      styles.set('ui.surface.elevated', { ...rawElevated, bg: guardedElevatedBg })
    }

    // floating distinct from guarded elevated (dark ΔL≥0.04, light ΔL≥0.03)
    const rawFloating = styles.get('ui.surface.floating')
    const guardedFloatingBg = rawFloating?.bg
      ? (guaranteeMinDeltaL(guardedElevatedBg, rawFloating.bg, isDark ? 0.04 : 0.03, isDark) ?? rawFloating.bg)
      : rawFloating?.bg
    if (rawFloating && guardedFloatingBg !== rawFloating.bg) {
      styles.set('ui.surface.floating', { ...rawFloating, bg: guardedFloatingBg })
    }

    if (isDark) {
      // menu distinct from chat (ΔL≥0.04, dark mode only — light mode menus are white/light)
      const rawMenu = styles.get('ui.surface.menu')
      if (rawMenu?.bg) {
        const guardedMenuBg = guaranteeMinDeltaL(chatBg, rawMenu.bg, 0.04, true) ?? rawMenu.bg
        if (guardedMenuBg !== rawMenu.bg) {
          styles.set('ui.surface.menu', { ...rawMenu, bg: guardedMenuBg })
        }
      }
    }

    // The elevation chain above may have moved panel/elevated/floating past the
    // anchored values; sync the neutral ramp (and role stash) to the final
    // surfaces so emitted --color-neutral-* variables match what is painted.
    const surfaceSync: Array<[SemanticUIToken, keyof ThemeSurfaceRoles, string]> = [
      ['ui.surface.panel', 'panelBg', 'neutral.baseFill'],
      ['ui.surface.elevated', 'elevatedBg', 'neutral.darkFill'],
      ['ui.surface.floating', 'floatingBg', 'neutral.darkerFill'],
    ]
    for (const [token, role, neutralPath] of surfaceSync) {
      const finalBg = styles.get(token)?.bg
      if (finalBg) {
        resolvedTheme[neutralPath] = finalBg
        resolvedTheme[SURFACE_ROLE_STASH_KEYS[role]] = finalBg
      }
    }

    const finalPanelBg = styles.get('ui.surface.panel')?.bg
    const panelState = deriveStateOverlaysForSurface(resolvedTheme, finalPanelBg, mode)
    if (panelState) {
      styles.set('ui.state.hover', {
        ...(styles.get('ui.state.hover') || {}),
        bg: panelState.hover,
      })
      styles.set('ui.state.active', {
        ...(styles.get('ui.state.active') || {}),
        bg: panelState.active,
      })
      styles.set('ui.state.selected', {
        ...(styles.get('ui.state.selected') || {}),
        bg: panelState.selected.bg,
        border: panelState.selected.border,
      })
      styles.set('ui.state.selectedHover', {
        ...(styles.get('ui.state.selectedHover') || {}),
        bg: panelState.selectedHover,
        border: panelState.selected.border,
      })
    }
  }

  return Object.fromEntries(
    SEMANTIC_UI_TOKENS.map(token => [token, styles.get(token) || {}])
  ) as Record<SemanticUIToken, ResolvedUIStyle>
}

/**
 * Extract preview colors from a theme (for theme list thumbnails)
 * Returns colors for the preview card in theme selector
 */
export function extractPreviewColors(theme: Theme): {
  bg: string
  sidebar: string
  accent: string
  text: string
  palette: string[]
} {
  const defs = theme.defs || {}
  const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
  const resolvedTheme = resolveTheme(theme, mode)
  const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)

  function resolveOptional(value: ColorValue | undefined): string | undefined {
    if (!value) return undefined

    if (typeof value === 'string') {
      if (value.startsWith('#')) return value
      if (value.startsWith('rgb')) return value
      // Try to resolve from defs
      if (defs[value]) return resolveOptional(defs[value])
      return undefined
    }

    if (typeof value === 'object' && 'dark' in value) {
      return resolveOptional(value.dark)
    }

    return undefined
  }

  function resolveSimple(value: ColorValue | undefined): string {
    return resolveOptional(value) || '#888888'
  }

  const palette: string[] = []
  const seen = new Set<string>()
  const pushSwatch = (value: ColorValue | undefined) => {
    const color = resolveOptional(value)
    if (!color || (!color.startsWith('#') && !color.startsWith('rgb'))) return
    const key = color.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    palette.push(color)
  }

  const preferredDefKeys = [
    'nord1',
    'nord2',
    'nord3',
    'nord4',
    'nord8',
    'nord9',
    'nord7',
    'nord14',
    'nord10',
    'nord15',
    'one_bg',
    'one_bg2',
    'one_bg3',
    'grey_fg',
    'white',
    'cyan',
    'blue',
    'nord_blue',
    'green',
    'yellow',
    'purple',
    'red',
    'base01',
    'base02',
    'base03',
    'base05',
    'base0C',
    'base0D',
    'base0B',
    'base0A',
    'base0E',
    'base08',
  ]

  for (const key of preferredDefKeys) {
    pushSwatch(defs[key])
    if (palette.length >= 10) break
  }

  if (palette.length < 6) {
    pushSwatch(theme.theme.bg?.sidebar)
    pushSwatch(theme.theme.bg?.panel)
    pushSwatch(theme.theme.bg?.elevated)
    pushSwatch(theme.theme.text?.primary)
    pushSwatch(theme.theme.accent)
    pushSwatch(theme.theme.text?.info)
    pushSwatch(theme.theme.text?.success)
    pushSwatch(theme.theme.text?.warning)
    pushSwatch(theme.theme.text?.error)
  }

  return {
    bg: resolvedUI['ui.surface.chat'].bg || resolveSimple(theme.theme.bg?.chat),
    sidebar: resolvedUI['ui.sidebar.surface'].bg || resolveSimple(theme.theme.bg?.sidebar),
    accent: resolvedUI['ui.accent.primary'].fg || resolveSimple(theme.theme.accent),
    text: resolvedUI['ui.text.primary'].fg || resolveSimple(theme.theme.text?.primary),
    palette: palette.slice(0, 10),
  }
}
