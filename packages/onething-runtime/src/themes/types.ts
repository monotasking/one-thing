/**
 * Theme System Type Definitions
 * Supports JSON themes, color references, dark/light variants, and Base46 import
 */

import type { ThemeShellRoles } from './shell-roles.js'

// ============================================
// Color Value Types
// ============================================

/**
 * Color value can be:
 * - Hex color: "#282A36"
 * - RGB/RGBA: "rgb(255, 255, 255)" or "rgba(255, 255, 255, 0.5)"
 * - Reference to defs: "purple" (resolves from defs section)
 * - Reference to theme colors: "accent" (resolves from other theme properties)
 * - Mode variants: { dark: "#000", light: "#fff" }
 * - CSS values: "transparent", "inherit", gradients, shadows
 * - Flexoki palette reference: "fx-blue-300" (maps to var(--fx-blue-300))
 */
export type ColorValue = string | { dark: string; light: string }

/**
 * Theme color definitions - reusable color aliases
 */
export interface ThemeDefs {
  [key: string]: ColorValue
}

// ============================================
// Theme Color Structure
// ============================================

export interface ThemeBgColors {
  app: ColorValue
  sidebar: ColorValue
  chat: ColorValue
  panel: ColorValue
  elevated: ColorValue
  floating: ColorValue
  message?: {
    user?: ColorValue
    userSolid?: ColorValue
    ai?: ColorValue
    system?: ColorValue
    error?: ColorValue
    hover?: ColorValue
  }
  toolCall?: ColorValue
  toolCallHover?: ColorValue
  toolResult?: ColorValue
  input?: ColorValue
  inputFocus?: ColorValue
  btn?: {
    primary?: ColorValue
    primaryHover?: ColorValue
    secondary?: ColorValue
    secondaryHover?: ColorValue
    ghost?: ColorValue
    ghostHover?: ColorValue
    danger?: ColorValue
    dangerHover?: ColorValue
  }
  code?: {
    inline?: ColorValue
    block?: ColorValue
    header?: ColorValue
  }
  menu?: ColorValue
  menuItemHover?: ColorValue
  tooltip?: ColorValue
  modal?: ColorValue
  selected?: ColorValue
  selectedHover?: ColorValue
  highlight?: ColorValue
  hover?: ColorValue
  active?: ColorValue
}

export interface ThemeTextColors {
  primary: ColorValue
  secondary?: ColorValue
  muted?: ColorValue
  faint?: ColorValue
  error?: ColorValue
  warning?: ColorValue
  success?: ColorValue
  info?: ColorValue
  link?: ColorValue
  linkHover?: ColorValue
  user?: {
    primary?: ColorValue
    secondary?: ColorValue
  }
  ai?: {
    primary?: ColorValue
    secondary?: ColorValue
    thinking?: ColorValue
  }
  tool?: {
    name?: ColorValue
    args?: ColorValue
    result?: ColorValue
    error?: ColorValue
    label?: ColorValue
  }
  sidebar?: {
    title?: ColorValue
    item?: ColorValue
    itemActive?: ColorValue
    itemHover?: ColorValue
    muted?: ColorValue
  }
  input?: ColorValue
  inputPlaceholder?: ColorValue
  btn?: {
    primary?: ColorValue
    secondary?: ColorValue
    ghost?: ColorValue
    danger?: ColorValue
  }
  code?: {
    inline?: ColorValue
    block?: ColorValue
    comment?: ColorValue
    keyword?: ColorValue
    string?: ColorValue
    number?: ColorValue
    function?: ColorValue
    variable?: ColorValue
    operator?: ColorValue
    type?: ColorValue         // Type names (class, interface)
    property?: ColorValue     // Object properties, attributes
    punctuation?: ColorValue  // Brackets, semicolons
  }
  menu?: {
    item?: ColorValue
    itemHover?: ColorValue
    itemActive?: ColorValue
    header?: ColorValue
  }
  label?: ColorValue
  helper?: ColorValue
}

export interface ThemeBorderColors {
  default: ColorValue
  subtle?: ColorValue
  strong?: ColorValue
  accent?: ColorValue
  error?: ColorValue
  success?: ColorValue
  warning?: ColorValue
  input?: ColorValue
  inputFocus?: ColorValue
  inputError?: ColorValue
  message?: ColorValue
  messageUser?: ColorValue
  code?: ColorValue
  divider?: ColorValue
}

export interface ThemeShadows {
  xs?: ColorValue
  sm?: ColorValue
  md?: ColorValue
  lg?: ColorValue
  xl?: ColorValue
  inner?: ColorValue
  glow?: {
    accent?: ColorValue
    error?: ColorValue
  }
  elevated?: ColorValue
  floating?: ColorValue
}

export interface ThemeEffects {
  gradientUserBubble?: ColorValue
  gradientAiBubble?: ColorValue
  gradientAccent?: ColorValue
  overlayHover?: ColorValue
  overlayActive?: ColorValue
  overlayDisabled?: ColorValue
  blurBackdrop?: ColorValue
}

/**
 * Complete theme color structure
 */
/**
 * Diff colors for code diff views (StepsPanel, etc.)
 */
export interface ThemeDiffColors {
  addBg?: ColorValue      // Background for added lines
  addText?: ColorValue    // Text color for added lines
  delBg?: ColorValue      // Background for deleted lines
  delText?: ColorValue    // Text color for deleted lines
  hunkBg?: ColorValue     // Background for hunk headers
  hunkText?: ColorValue   // Text color for hunk headers
}

/**
 * Semantic status colors (aligned with Base46)
 * Maps to: red=danger, orange/yellow=warning, green=success, cyan=info
 */
export interface ThemeSemanticColors {
  danger?: ColorValue      // Base46: red / base08 - errors, deletions
  dangerBg?: ColorValue
  dangerBgHover?: ColorValue
  dangerBorder?: ColorValue
  dangerText?: ColorValue
  dangerLight?: ColorValue // Deprecated compatibility alias for dangerBg
  warning?: ColorValue     // Base46: orange|yellow / base09 - warnings
  warningBg?: ColorValue
  warningBgHover?: ColorValue
  warningBorder?: ColorValue
  warningText?: ColorValue
  warningLight?: ColorValue
  success?: ColorValue     // Base46: green / base0B - success, additions
  successBg?: ColorValue
  successBgHover?: ColorValue
  successBorder?: ColorValue
  successText?: ColorValue
  successLight?: ColorValue
  info?: ColorValue        // Base46: cyan / base0C - info, links
  infoBg?: ColorValue
  infoBgHover?: ColorValue
  infoBorder?: ColorValue
  infoText?: ColorValue
  infoLight?: ColorValue
}

/**
 * Neutral colors for text, border, fill, and background hierarchy.
 * Names follow the app's shared neutral contract and are intentionally
 * close to common design-system wording so imported themes can map cleanly.
 */
export interface ThemeNeutralColors {
  primaryText?: ColorValue
  regularText?: ColorValue
  secondaryText?: ColorValue
  placeholderText?: ColorValue
  disabledText?: ColorValue
  darkerBorder?: ColorValue
  darkBorder?: ColorValue
  baseBorder?: ColorValue
  lightBorder?: ColorValue
  lighterBorder?: ColorValue
  extraLightBorder?: ColorValue
  darkerFill?: ColorValue
  darkFill?: ColorValue
  baseFill?: ColorValue
  lightFill?: ColorValue
  lighterFill?: ColorValue
  extraLightFill?: ColorValue
  blankFill?: ColorValue
  basicBlack?: ColorValue
  basicWhite?: ColorValue
  transparent?: ColorValue
  pageBackground?: ColorValue
  baseBackground?: ColorValue
  overlayBackground?: ColorValue
}

export interface ThemeColors {
  /**
   * Primary/default theme color. If present, it takes precedence over legacy
   * accent fields for the default theme color semantics.
   */
  primary?: ColorValue
  primaryHover?: ColorValue
  primaryBg?: ColorValue
  primaryBgHover?: ColorValue
  primaryBorder?: ColorValue
  primaryText?: ColorValue
  primaryLight?: ColorValue // Deprecated compatibility alias for primaryBg
  accent: ColorValue
  accentMain?: ColorValue
  accentSub?: ColorValue
  accentRgb?: ColorValue  // RGB triplet (e.g., "67, 133, 190")

  bg: ThemeBgColors
  text: ThemeTextColors
  border: ThemeBorderColors
  shadow?: ThemeShadows
  effects?: ThemeEffects
  diff?: ThemeDiffColors  // Diff view colors
  color?: ThemeSemanticColors  // Semantic status colors
  neutral?: ThemeNeutralColors // Neutral text, border, fill, and background colors
}

// ============================================
// Highlight Group Types
// ============================================

export type SemanticHighlightToken =
  | 'syntax.plain'
  | 'syntax.comment'
  | 'syntax.keyword'
  | 'syntax.atom'
  | 'syntax.string'
  | 'syntax.number'
  | 'syntax.function'
  | 'syntax.definition'
  | 'syntax.variable'
  | 'syntax.property'
  | 'syntax.type'
  | 'syntax.tag'
  | 'syntax.operator'
  | 'syntax.punctuation'
  | 'syntax.invalid'
  | 'syntax.inserted'
  | 'syntax.deleted'
  | 'syntax.heading'
  | 'syntax.link'
  | 'syntax.emphasis'
  | 'syntax.strong'

export type HighlightFontStyle =
  | 'normal'
  | 'italic'
  | 'bold'
  | 'underline'
  | 'bold italic'
  | 'bold underline'
  | 'italic underline'
  | 'bold italic underline'

export interface HighlightStyle {
  fg?: ColorValue
  bg?: ColorValue
  fontStyle?: HighlightFontStyle
}

export interface HighlightLink {
  link: SemanticHighlightToken | string
}

export type ThemeHighlightGroup = HighlightStyle | HighlightLink

export interface ThemeHighlights {
  semanticTokens?: Partial<Record<SemanticHighlightToken, HighlightStyle>>
  groups?: Record<string, ThemeHighlightGroup>
  aliases?: Record<string, SemanticHighlightToken | string>
}

// ============================================
// UI Semantic Token Types
// ============================================

export type SemanticUIToken =
  | 'ui.accent.primary'
  | 'ui.accent.subtle'
  | 'ui.surface.app'
  | 'ui.surface.sidebar'
  | 'ui.surface.chat'
  | 'ui.surface.panel'
  | 'ui.surface.elevated'
  | 'ui.surface.floating'
  | 'ui.surface.overlay'
  | 'ui.surface.menu'
  | 'ui.surface.menuHover'
  | 'ui.surface.input'
  | 'ui.surface.inputFocus'
  | 'ui.surface.codeInline'
  | 'ui.surface.codeBlock'
  | 'ui.surface.codeHeader'
  | 'ui.surface.tooltip'
  | 'ui.surface.modal'
  | 'ui.surface.note'
  | 'ui.surface.previewLight'
  | 'ui.surface.previewDark'
  | 'ui.text.primary'
  | 'ui.text.secondary'
  | 'ui.text.muted'
  | 'ui.text.faint'
  | 'ui.text.inverse'
  | 'ui.text.placeholder'
  | 'ui.text.disabled'
  | 'ui.text.link'
  | 'ui.text.linkHover'
  | 'ui.border.default'
  | 'ui.border.subtle'
  | 'ui.border.strong'
  | 'ui.border.divider'
  | 'ui.border.focus'
  | 'ui.border.selected'
  | 'ui.table.headerBg'
  | 'ui.table.rowBg'
  | 'ui.table.border'
  | 'ui.action.primary'
  | 'ui.action.primaryHover'
  | 'ui.action.secondary'
  | 'ui.action.secondaryHover'
  | 'ui.action.ghost'
  | 'ui.action.ghostHover'
  | 'ui.action.danger'
  | 'ui.action.dangerHover'
  | 'ui.action.disabled'
  | 'ui.state.hover'
  | 'ui.state.active'
  | 'ui.state.selected'
  | 'ui.state.selectedHover'
  | 'ui.state.highlight'
  | 'ui.state.focus'
  | 'ui.state.disabled'
  | 'ui.sidebar.surface'
  | 'ui.sidebar.item'
  | 'ui.sidebar.itemHover'
  | 'ui.sidebar.itemActive'
  | 'ui.sidebar.itemMuted'
  | 'ui.sidebar.header'
  | 'ui.sidebar.action'
  | 'ui.sidebar.actionHover'
  | 'ui.sidebar.border'
  | 'ui.category.1.icon'
  | 'ui.category.1.badgeBg'
  | 'ui.category.1.badgeText'
  | 'ui.category.2.icon'
  | 'ui.category.2.badgeBg'
  | 'ui.category.2.badgeText'
  | 'ui.category.3.icon'
  | 'ui.category.3.badgeBg'
  | 'ui.category.3.badgeText'
  | 'ui.category.4.icon'
  | 'ui.category.4.badgeBg'
  | 'ui.category.4.badgeText'
  | 'ui.category.5.icon'
  | 'ui.category.5.badgeBg'
  | 'ui.category.5.badgeText'
  | 'ui.category.6.icon'
  | 'ui.category.6.badgeBg'
  | 'ui.category.6.badgeText'
  | 'ui.category.7.icon'
  | 'ui.category.7.badgeBg'
  | 'ui.category.7.badgeText'
  | 'ui.tabBar.surface'
  | 'ui.tabBar.divider'
  | 'ui.tabBar.item'
  | 'ui.tabBar.itemHover'
  | 'ui.tabBar.itemActive'
  | 'ui.tabBar.action'
  | 'ui.tabBar.actionHover'
  | 'ui.tabBar.danger'
  | 'ui.status.danger'
  | 'ui.status.warning'
  | 'ui.status.success'
  | 'ui.status.info'
  | 'ui.message.user'
  | 'ui.message.userSolid'
  | 'ui.message.assistant'
  | 'ui.message.system'
  | 'ui.message.error'
  | 'ui.message.hover'
  | 'ui.message.thinking'
  | 'ui.tool.surface'
  | 'ui.tool.surfaceHover'
  | 'ui.tool.surfaceSubtle'
  | 'ui.tool.result'
  | 'ui.tool.error'
  | 'ui.tool.success'
  | 'ui.tool.text'
  | 'ui.tool.textMuted'
  | 'ui.tool.textFaint'
  | 'ui.tool.accent'
  | 'ui.tool.accentOn'
  | 'ui.tool.successText'
  | 'ui.tool.dangerText'
  | 'ui.tool.border'
  | 'ui.editor.text'
  | 'ui.editor.placeholder'
  | 'ui.editor.caret'
  | 'ui.editor.selection'

export interface UIStyle {
  fg?: ColorValue
  bg?: ColorValue
  border?: ColorValue
  ring?: ColorValue
  shadow?: ColorValue
}

export interface UILink {
  link: SemanticUIToken | string
}

export type ThemeUIGroup = UIStyle | UILink

export interface ThemeUITokens {
  /**
   * @deprecated Runtime UI colors are derived by the shared role mapping in
   * resolveThemeUI(). Theme-level UI overrides are kept only for legacy theme
   * file compatibility and should not be used for product chrome.
   */
  semanticTokens?: Partial<Record<SemanticUIToken, UIStyle>>
  /**
   * @deprecated Runtime UI colors are derived by the shared role mapping.
   */
  groups?: Record<string, ThemeUIGroup>
  /**
   * @deprecated Runtime UI colors are derived by the shared role mapping.
   */
  aliases?: Record<string, SemanticUIToken | string>
}

// ============================================
// Theme Definition
// ============================================

/**
 * Complete theme structure
 */
export interface Theme {
  $schema?: string
  id: string                              // Unique identifier (kebab-case)
  name: string                            // Display name
  author?: string
  version?: string
  type: 'full' | 'accent'                 // full = complete theme, accent = only accent colors
  source?: 'builtin' | 'user' | 'project' // Where the theme comes from
  filePath?: string                       // Path for custom themes
  colorScheme?: 'dark' | 'light' | 'both' // Explicit color scheme declaration

  defs: ThemeDefs
  theme: ThemeColors
  highlights?: ThemeHighlights
  ui?: ThemeUITokens
  /** 壳的角色表:主题直说各面用哪个色,不经派生(`shell-roles.ts`)。 */
  shellRoles?: ThemeShellRoles
}

/**
 * Theme metadata for listing (without full theme data)
 */
export interface ThemeMeta {
  id: string
  name: string
  author?: string
  type: 'full' | 'accent'
  source: 'builtin' | 'user' | 'project'
  /** Color scheme support: 'dark' = dark only, 'light' = light only, 'both' = has dark/light variants */
  colorScheme: 'dark' | 'light' | 'both'
  previewColors?: {
    bg: string        // Background color for preview card
    sidebar: string   // Sidebar color
    accent: string    // Accent color
    text: string      // Text color
    palette?: string[] // Representative swatches from the theme palette
  }
}

// ============================================
// Base46 Types (NvChad theme format)
// ============================================

/**
 * Base46 base_30 UI colors
 */
export interface Base46Base30 {
  black: string
  darker_black: string
  black2: string
  one_bg: string
  one_bg2: string
  one_bg3: string
  grey: string
  grey_fg: string
  grey_fg2: string
  light_grey: string
  white: string
  red: string
  baby_pink: string
  pink: string
  line: string
  green: string
  vibrant_green: string
  nord_blue: string
  blue: string
  yellow: string
  sun: string
  purple: string
  dark_purple: string
  teal: string
  orange: string
  cyan: string
  statusline_bg: string
  lightbg: string
  pmenu_bg: string
  folder_bg: string
}

/**
 * Base46 base_16 syntax colors (base16 scheme)
 */
export interface Base46Base16 {
  base00: string  // Background
  base01: string  // Lighter Background (status bars)
  base02: string  // Selection Background
  base03: string  // Comments, Invisibles
  base04: string  // Dark Foreground (status bars)
  base05: string  // Default Foreground
  base06: string  // Light Foreground
  base07: string  // Light Background
  base08: string  // Variables, Errors
  base09: string  // Integers, Booleans, Constants
  base0A: string  // Classes, Markup Bold
  base0B: string  // Strings, Inherited Class
  base0C: string  // Support, Regular Expressions
  base0D: string  // Functions, Methods
  base0E: string  // Keywords, Storage
  base0F: string  // Deprecated, Embedded Language
}

/**
 * Base46 theme structure
 */
export interface Base46Theme {
  type: 'dark' | 'light'
  base_30: Partial<Base46Base30>
  base_16: Partial<Base46Base16>
}

// ============================================
// IPC Response Types
// ============================================

export interface GetThemesResponse {
  success: boolean
  themes?: ThemeMeta[]
  error?: string
}

export interface GetThemeResponse {
  success: boolean
  theme?: Theme
  error?: string
}

export interface ApplyThemeResponse {
  success: boolean
  cssVariables?: Record<string, string>
  error?: string
}

export interface RefreshThemesResponse {
  success: boolean
  themes?: ThemeMeta[]
  error?: string
}

export interface OpenThemesFolderResponse {
  success: boolean
  error?: string
}

export type ThemeFolderOpener = (
  themesPath: string
) => Promise<string | void | null | undefined> | string | void | null | undefined
