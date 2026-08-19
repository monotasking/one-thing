/**
 * Base46 Theme Parser
 * Parses NvChad Base46 Lua theme files and converts them to our JSON format
 */

import type {
  Base46Base16,
  Base46Base30,
  Base46Theme,
  SemanticHighlightToken,
  Theme,
  ThemeDefs,
  ThemeHighlights,
} from './types.js'
import type { ThemeColorScheme } from './role-mapping.js'
import {
  deriveStateOverlays,
  deriveSurfaceRoles,
  firstDefinedColor,
  mixCssColors,
  parseCssColor,
  readableColor,
  relativeLuminance,
} from './role-mapping.js'
import { selectPrimaryColorSemantics, selectStatusColorSemantics } from './resolver.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('themes')

const BASE46_HIGHLIGHT_ALIASES: Record<string, SemanticHighlightToken> = {
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
  String: 'syntax.string',
  Character: 'syntax.string',
  Number: 'syntax.number',
  Float: 'syntax.number',
  Function: 'syntax.function',
  Identifier: 'syntax.variable',
  '@function': 'syntax.function',
  '@method': 'syntax.function',
  '@variable': 'syntax.variable',
  '@property': 'syntax.property',
  '@field': 'syntax.property',
  Type: 'syntax.type',
  Typedef: 'syntax.type',
  '@type': 'syntax.type',
  '@class': 'syntax.type',
  Tag: 'syntax.tag',
  '@tag': 'syntax.tag',
  Operator: 'syntax.operator',
  Delimiter: 'syntax.punctuation',
  '@operator': 'syntax.operator',
  '@punctuation': 'syntax.punctuation',
  Error: 'syntax.invalid',
  DiffAdd: 'syntax.inserted',
  DiffDelete: 'syntax.deleted',
  Title: 'syntax.heading',
  Underlined: 'syntax.link',
}

/**
 * Extract a Lua table from theme content
 * Handles patterns like: M.base_30 = { key = "value", ... }
 */
function extractLuaTable(content: string, tableName: string): Record<string, string> {
  const result: Record<string, string> = {}

  // Match patterns like: M.base_30 = { ... }
  const tableRegex = new RegExp(`M\\.${tableName}\\s*=\\s*\\{([^}]+)\\}`, 's')
  const match = content.match(tableRegex)

  if (!match) return result

  const tableContent = match[1]

  // Match key-value pairs: key = "value" or key = "#hex"
  const kvRegex = /(\w+)\s*=\s*["']([^"']+)["']/g
  let kvMatch

  while ((kvMatch = kvRegex.exec(tableContent)) !== null) {
    const [, key, value] = kvMatch
    result[key] = value
  }

  return result
}

/**
 * Extract a single Lua value
 * Handles patterns like: M.type = "dark"
 */
function extractLuaValue(content: string, key: string): string | null {
  const regex = new RegExp(`M\\.${key}\\s*=\\s*["']([^"']+)["']`)
  const match = content.match(regex)
  return match ? match[1] : null
}

/**
 * Parse a Base46 Lua theme file
 */
export function parseBase46Lua(content: string): Base46Theme | null {
  try {
    const base30 = extractLuaTable(content, 'base_30')
    const base16 = extractLuaTable(content, 'base_16')
    const type = extractLuaValue(content, 'type') as 'dark' | 'light' | null

    // Validate we got at least some colors
    if (Object.keys(base30).length === 0 && Object.keys(base16).length === 0) {
      log.warn('no colors found in base46 theme file')
      return null
    }

    return {
      type: type || 'dark',
      base_30: base30 as Partial<Base46Base30>,
      base_16: base16 as Partial<Base46Base16>,
    }
  } catch (err) {
    log.error('base46 lua parse failed', undefined, err)
    return null
  }
}

/**
 * Convert kebab-case or snake_case to camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
}

/**
 * Convert string to kebab-case (for theme ID)
 */
function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function buildBase46Highlights(
  b30: Partial<Base46Base30>,
  b16: Partial<Base46Base16>
): ThemeHighlights {
  const plain = b30.light_grey || b16.base06 || b30.white || b16.base05 || '#E6E4D9'
  const keyword = b30.purple || b16.base0E || '#BD93F9'
  const string = b30.green || b16.base0B || '#50FA7B'
  const number = b30.orange || b16.base09 || '#FFB86C'
  const fn = b30.blue || b16.base0D || '#8BE9FD'
  const variable = b30.cyan || b16.base08 || plain
  const operator = b30.grey_fg || b16.base04 || '#878580'
  const type = b30.teal || b16.base0C || '#4ec9b0'
  const property = b30.nord_blue || b16.base0C || '#9cdcfe'
  const punctuation = b30.grey_fg || b16.base05 || '#d4d4d4'
  const comment = b30.grey || b16.base03 || '#6272A4'
  const danger = b30.red || b16.base08 || '#FF5555'

  return {
    semanticTokens: {
      'syntax.plain': { fg: plain },
      'syntax.comment': { fg: comment, fontStyle: 'italic' },
      'syntax.keyword': { fg: keyword },
      'syntax.atom': { fg: number },
      'syntax.string': { fg: string },
      'syntax.number': { fg: number },
      'syntax.function': { fg: fn },
      'syntax.definition': { fg: fn },
      'syntax.variable': { fg: variable },
      'syntax.property': { fg: property },
      'syntax.type': { fg: type },
      'syntax.tag': { fg: keyword },
      'syntax.operator': { fg: operator },
      'syntax.punctuation': { fg: punctuation },
      'syntax.invalid': { fg: danger },
      'syntax.inserted': { fg: b30.vibrant_green || b30.green || b16.base0B || '#50FA7B' },
      'syntax.deleted': { fg: danger },
      'syntax.heading': { fg: fn, fontStyle: 'bold' },
      'syntax.link': { fg: b30.cyan || b16.base0C || '#8BE9FD', fontStyle: 'underline' },
      'syntax.emphasis': { fg: plain, fontStyle: 'italic' },
      'syntax.strong': { fg: plain, fontStyle: 'bold' },
    },
    aliases: BASE46_HIGHLIGHT_ALIASES,
  }
}

interface Base46AppRoles {
  accent: string
  accentSub: string
  appBg: string
  sidebarBg: string
  chatBg: string
  panelBg: string
  tabBarBg: string
  elevatedBg: string
  floatingBg: string
  primaryText: string
  secondaryText: string
  mutedText: string
  faintText: string
  sidebarTitleText: string
  sidebarItemText: string
  sidebarMutedText: string
  placeholderText: string
  borderDefault: string
  borderSubtle: string
  borderStrong: string
}

function deriveBase46AppRoles(
  b30: Partial<Base46Base30>,
  b16: Partial<Base46Base16>,
  colorScheme: ThemeColorScheme
): Base46AppRoles {
  const defaultBg = colorScheme === 'dark' ? '#282726' : '#FFFCF0'
  const defaultText = colorScheme === 'dark' ? '#F2F0E5' : '#1F2328'
  const defaultSubtleText = colorScheme === 'dark' ? '#B7B5AC' : '#6B7280'
  const defaultAccent = colorScheme === 'dark' ? '#4385BE' : '#2563EB'

  const baseBg = firstDefinedColor(b30.black, b16.base00, defaultBg) || defaultBg
  const rawAppBg = firstDefinedColor(b30.darker_black, b16.base00, baseBg) || baseBg
  const rawChatBg = firstDefinedColor(b30.darker_black, b30.black, b16.base00, rawAppBg) || rawAppBg
  const rawSidebarBg = firstDefinedColor(b30.black, b16.base00, rawAppBg) || rawAppBg
  const rawPanelBg = firstDefinedColor(b30.one_bg, b16.base01, rawSidebarBg) || rawSidebarBg
  const rawElevatedBg = firstDefinedColor(b30.one_bg2, b16.base02, rawPanelBg) || rawPanelBg
  const rawFloatingBg = firstDefinedColor(b30.one_bg3, b16.base03, rawElevatedBg) || rawElevatedBg
  const accent = firstDefinedColor(b30.blue, b16.base0D, defaultAccent) || defaultAccent
  const accentSub = firstDefinedColor(b30.nord_blue, b30.cyan, b16.base0C, accent) || accent

  const surfaces = deriveSurfaceRoles({
    colorScheme,
    app: rawAppBg,
    sidebar: rawSidebarBg,
    chat: rawChatBg,
    panel: rawPanelBg,
    elevated: rawElevatedBg,
    floating: rawFloatingBg,
    primaryText: firstDefinedColor(b30.white, b16.base05, b30.light_grey, b16.base06, defaultText),
  })
  const {
    appBg,
    sidebarBg,
    chatBg,
    panelBg,
    tabBarBg,
    elevatedBg,
    floatingBg,
  } = surfaces

  const primaryText = readableColor(
    chatBg,
    [b30.white, b16.base05, b30.light_grey, b16.base06],
    defaultText,
    4.5,
    0.88
  )
  const secondaryText = readableColor(
    chatBg,
    [b30.light_grey, b16.base06, b30.grey_fg2, b16.base05, primaryText],
    primaryText,
    4.5,
    0.8
  )
  const mutedText = readableColor(
    chatBg,
    [b30.grey_fg, b30.grey_fg2, b16.base04, b30.light_grey, secondaryText],
    defaultSubtleText,
    4.5,
    0.68
  )
  const faintText = readableColor(
    chatBg,
    [b30.grey, b16.base03, b30.grey_fg, mutedText],
    mutedText,
    3.8,
    0.58
  )
  const sidebarItemText = readableColor(
    sidebarBg,
    [b30.grey_fg, b30.light_grey, b16.base04, b16.base06, secondaryText, primaryText],
    secondaryText,
    4.5,
    0.72
  )
  const sidebarMutedText = readableColor(
    sidebarBg,
    [b30.grey_fg2, b30.grey_fg, b16.base04, b30.light_grey, sidebarItemText],
    sidebarItemText,
    4.5,
    0.62
  )
  const placeholderText = readableColor(
    panelBg,
    [b30.grey, b16.base03, b30.grey_fg, mutedText],
    mutedText,
    4.5,
    0.62
  )

  return {
    accent,
    accentSub,
    appBg,
    sidebarBg,
    chatBg,
    panelBg,
    tabBarBg,
    elevatedBg,
    floatingBg,
    primaryText,
    secondaryText,
    mutedText,
    faintText,
    sidebarTitleText: readableColor(sidebarBg, [b30.white, b16.base05, primaryText], primaryText),
    sidebarItemText,
    sidebarMutedText,
    placeholderText,
    borderDefault: firstDefinedColor(b30.line, b30.grey, b16.base02, mixCssColors(primaryText, panelBg, 0.18)) || '#44475A',
    borderSubtle: firstDefinedColor(b30.one_bg2, b16.base01, mixCssColors(primaryText, panelBg, 0.12)) || '#343331',
    borderStrong: firstDefinedColor(b30.grey_fg, b16.base03, mixCssColors(primaryText, panelBg, 0.28)) || '#575653',
  }
}

/**
 * Convert Base46 theme to our JSON theme format
 */
export function convertBase46ToTheme(base46: Base46Theme, fileName: string): Theme {
  const b30 = base46.base_30
  const b16 = base46.base_16

  // Create a display name from filename
  const displayName = fileName
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

  // Detect color scheme: use explicit type from Lua, or detect from background color
  const bgColor = b30.black || b30.darker_black || b16.base00 || '#1E1E2E'
  const colorScheme = base46.type || detectColorSchemeFromBg(bgColor)
  const roles = deriveBase46AppRoles(b30, b16, colorScheme)
  const dangerBase = b30.red || b16.base08 || '#FF5555'
  const warningBase = b30.orange || b30.yellow || b16.base09 || '#FFB86C'
  const successBase = b30.green || b16.base0B || '#50FA7B'
  const infoBase = b30.cyan || b16.base0C || '#8BE9FD'
  const danger = selectStatusColorSemantics(dangerBase, colorScheme, roles.appBg)
  const warning = selectStatusColorSemantics(warningBase, colorScheme, roles.appBg)
  const success = selectStatusColorSemantics(successBase, colorScheme, roles.appBg)
  const info = selectStatusColorSemantics(infoBase, colorScheme, roles.appBg)
  const primary = selectPrimaryColorSemantics(roles.accent, colorScheme, roles.appBg)
  const selectedBorder = colorScheme === 'dark'
    ? primary.hover || primary.base || roles.accent
    : primary.border || primary.base || roles.accent
  const panelStates = deriveStateOverlays(roles.panelBg, selectedBorder, colorScheme) || {
    hover: roles.elevatedBg,
    active: roles.floatingBg,
    selected: {
      bg: roles.elevatedBg,
      border: selectedBorder,
    },
    selectedHover: roles.floatingBg,
  }
  const chatStates = deriveStateOverlays(roles.chatBg, selectedBorder, colorScheme) || panelStates

  // Build defs from all Base46 colors
  const defs: ThemeDefs = {}

  // Add base_30 colors to defs
  for (const [key, value] of Object.entries(b30)) {
    defs[key] = value
  }

  // Add base_16 colors to defs
  for (const [key, value] of Object.entries(b16)) {
    defs[key] = value
  }

  // Map Base46 colors to our theme structure
  const theme: Theme = {
    id: toKebabCase(fileName),
    name: displayName,
    author: 'NvChad',
    version: '1.0.0',
    type: 'full',
    colorScheme, // Auto-detected from Lua M.type or background luminance

    defs,

    theme: {
      // Accent - use blue or base0D (functions/links)
      accent: roles.accent,
      accentMain: roles.accent,
      accentSub: roles.accentSub,
      accentRgb: hexToRgb(roles.accent),

      bg: {
        app: roles.appBg,
        sidebar: roles.sidebarBg,
        chat: roles.chatBg,
        panel: roles.panelBg,
        elevated: roles.elevatedBg,
        floating: roles.floatingBg,
        selected: panelStates.selected.bg,
        selectedHover: panelStates.selectedHover,
        hover: panelStates.hover,
        active: panelStates.active,
        message: {
          user: roles.elevatedBg,
          userSolid: roles.elevatedBg,
          ai: 'transparent',
          system: roles.panelBg,
          error: danger.bg,
          hover: chatStates.hover,
        },
        toolCall: roles.panelBg,
        toolCallHover: roles.elevatedBg,
        toolResult: roles.panelBg,
        input: roles.panelBg,
        inputFocus: roles.elevatedBg,
        btn: {
          primary: roles.accent,
          primaryHover: roles.accentSub,
          secondary: roles.floatingBg,
          secondaryHover: roles.borderStrong,
          ghost: 'transparent',
          ghostHover: roles.elevatedBg,
          danger: danger.base,
          dangerHover: b30.baby_pink || danger.text,
        },
        code: {
          inline: roles.elevatedBg,
          block: roles.appBg,
          header: roles.elevatedBg,
        },
        menu: roles.elevatedBg,
        menuItemHover: roles.floatingBg,
        tooltip: b30.light_grey || b16.base07 || '#F2F0E5',
        modal: roles.panelBg,
        highlight: warning.bg,
      },

      text: {
        primary: roles.primaryText,
        secondary: roles.secondaryText,
        muted: roles.mutedText,
        faint: roles.faintText,
        error: danger.text,
        warning: warning.text,
        success: success.text,
        info: info.text,
        link: info.text,
        linkHover: b30.teal || b16.base0C || '#8BE9FD',
        user: {
          primary: roles.primaryText,
          secondary: roles.secondaryText,
        },
        ai: {
          primary: roles.primaryText,
          secondary: roles.secondaryText,
          thinking: roles.faintText,
        },
        tool: {
          name: b30.purple || b16.base0E || '#BD93F9',
          args: roles.faintText,
          result: roles.mutedText,
          error: danger.text,
        },
        sidebar: {
          title: roles.sidebarTitleText,
          item: roles.sidebarItemText,
          itemActive: roles.primaryText,
          itemHover: roles.primaryText,
          muted: roles.sidebarMutedText,
        },
        input: roles.primaryText,
        inputPlaceholder: roles.placeholderText,
        btn: {
          primary: roles.appBg,
          secondary: roles.secondaryText,
          ghost: roles.mutedText,
          danger: roles.appBg,
        },
        code: {
          inline: b30.pink || b16.base0E || '#FF79C6',
          block: b30.light_grey || b16.base06 || '#E6E4D9',
          comment: b30.grey || b16.base03 || '#6272A4',
          keyword: b30.purple || b16.base0E || '#BD93F9',
          string: b30.green || b16.base0B || '#50FA7B',
          number: b30.orange || b16.base09 || '#FFB86C',
          function: b30.blue || b16.base0D || '#8BE9FD',
          variable: b30.cyan || b16.base08 || '#F8F8F2',
          operator: b30.grey_fg || b16.base04 || '#878580',
          type: b30.teal || b16.base0C || '#4ec9b0',
          property: b30.nord_blue || b16.base0C || '#9cdcfe',
          punctuation: b30.grey_fg || b16.base05 || '#d4d4d4',
        },
        menu: {
          item: roles.mutedText,
          itemHover: roles.primaryText,
          itemActive: roles.accent,
          header: roles.faintText,
        },
        label: roles.mutedText,
        helper: roles.faintText,
      },

      border: {
        default: roles.borderDefault,
        subtle: roles.borderSubtle,
        strong: roles.borderStrong,
        accent: roles.accent,
        error: danger.border,
        success: success.border,
        warning: warning.border,
        input: roles.borderDefault,
        inputFocus: roles.accent,
        inputError: danger.border,
        message: roles.borderSubtle,
        messageUser: roles.borderDefault,
        code: roles.borderDefault,
        divider: roles.borderSubtle,
      },

      shadow: {
        xs: '0 1px 2px rgba(0, 0, 0, 0.2)',
        sm: '0 2px 4px rgba(0, 0, 0, 0.25)',
        md: '0 4px 12px rgba(0, 0, 0, 0.3)',
        lg: '0 8px 24px rgba(0, 0, 0, 0.35)',
        xl: '0 16px 48px rgba(0, 0, 0, 0.4)',
        inner: 'inset 0 2px 4px rgba(0, 0, 0, 0.15)',
        glow: {
          accent: `0 0 20px rgba(${hexToRgb(b30.blue || b16.base0D || '#4385BE')}, 0.2)`,
          error: `0 0 20px rgba(${hexToRgb(danger.base)}, 0.2)`,
        },
        elevated: '0 8px 32px rgba(0, 0, 0, 0.4)',
        floating: '0 12px 48px rgba(0, 0, 0, 0.5)',
      },

      effects: {
        gradientUserBubble: `linear-gradient(135deg, ${roles.elevatedBg} 0%, ${roles.panelBg} 100%)`,
        gradientAiBubble: 'linear-gradient(135deg, transparent 0%, transparent 100%)',
        gradientAccent: `linear-gradient(135deg, ${roles.accent} 0%, ${roles.accentSub} 100%)`,
        overlayDisabled: 'rgba(0, 0, 0, 0.5)',
        blurBackdrop: '24px',
      },

      // Diff colors for code diff views
      diff: {
        addBg: success.bg,
        addText: b30.vibrant_green || success.text,
        delBg: danger.bg,
        delText: b30.baby_pink || danger.text,
        hunkBg: `rgba(${hexToRgb(b30.grey || b16.base03 || '#6F6E69')}, 0.1)`,
        hunkText: b30.grey || b16.base03 || '#6F6E69',
      },

      // Semantic colors (aligned with Base46 color scheme)
      color: {
        danger: danger.base,
        dangerBg: danger.bg,
        dangerBgHover: danger.bgHover,
        dangerBorder: danger.border,
        dangerText: danger.text,
        dangerLight: danger.bg,
        warning: warning.base,
        warningBg: warning.bg,
        warningBgHover: warning.bgHover,
        warningBorder: warning.border,
        warningText: warning.text,
        warningLight: warning.bg,
        success: success.base,
        successBg: success.bg,
        successBgHover: success.bgHover,
        successBorder: success.border,
        successText: success.text,
        successLight: success.bg,
        info: info.base,
        infoBg: info.bg,
        infoBgHover: info.bgHover,
        infoBorder: info.border,
        infoText: info.text,
        infoLight: info.bg,
      },
    },

    highlights: buildBase46Highlights(b30, b16),
  }

  return theme
}

/**
 * Convert hex color to RGB values string
 */
function hexToRgb(hex: string): string {
  const color = parseCssColor(hex)
  if (!color) return '67, 133, 190'
  return `${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}`
}

/**
 * Calculate relative luminance of a hex color (WCAG standard)
 * Returns value 0-1, where 0 is black and 1 is white
 */
function getLuminance(hex: string): number {
  const color = parseCssColor(hex)
  return color ? relativeLuminance(color) : 0
}

/**
 * Detect if a theme is light or dark based on background color luminance
 */
function detectColorSchemeFromBg(bgColor: string): 'dark' | 'light' {
  const luminance = getLuminance(bgColor)
  // Threshold: > 0.5 is considered light
  return luminance > 0.5 ? 'light' : 'dark'
}
