// 主题的语义词表(从 `theme-resolver.ts` 拆出,拆分批 1,D226):高亮与界面的语义 token 名单、默认的高亮别名、
// 状态色与中性色 token、它们缺席时去哪里找(fallback 路径表)和最后的默认值,以及解析结果的几个形状(`Resolved*`)。
// 只有数据与形状,没有逻辑。依赖方向(谁引谁):色彩语义 → 词表;解析核(`theme-resolver.ts`)→ 色彩语义;界面样式 → 解析核;
// 高亮 → 界面样式与解析核;预览色 → 界面样式与解析核。
import type { HighlightFontStyle, SemanticHighlightToken, SemanticUIToken } from './theme-types.js'

export type ResolvedColorValue = string | { dark: string; light: string }

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

export const SEMANTIC_HIGHLIGHT_TOKEN_SET = new Set<string>(SEMANTIC_HIGHLIGHT_TOKENS)

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

export const VALID_HIGHLIGHT_FONT_STYLES = new Set<HighlightFontStyle>([
  'normal',
  'italic',
  'bold',
  'underline',
  'bold italic',
  'bold underline',
  'italic underline',
  'bold italic underline',
])

export const DEFAULT_HIGHLIGHT_ALIASES: Record<string, SemanticHighlightToken> = {
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

export const DEFAULT_PRIMARY_COLOR = '#4385BE'

export const STATUS_COLOR_DEFAULTS: Record<ThemeStatusColorToken, string> = {
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
  info: '#3B82F6',
}

export const STATUS_COLOR_FALLBACK_PATHS: Record<ThemeStatusColorToken, string[]> = {
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

export const NEUTRAL_COLOR_FALLBACK_PATHS: Record<ThemeNeutralColorToken, string[]> = {
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

export const NEUTRAL_TEXT_COLOR_TOKENS = [
  'primaryText',
  'regularText',
  'secondaryText',
  'placeholderText',
  'disabledText',
] as const satisfies readonly ThemeNeutralColorToken[]

export type NeutralTextColorToken = typeof NEUTRAL_TEXT_COLOR_TOKENS[number]

export const NEUTRAL_COLOR_DEFAULTS: Record<ThemeNeutralColorToken, string> = {
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
