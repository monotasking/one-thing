import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { Theme } from '../types.js'
import {
  extractPreviewColors,
  resolveTheme,
  resolveThemeHighlights,
  resolveThemeUI,
  SURFACE_GUARD_MIN_DELTA_L,
  THEME_STATUS_COLOR_TOKENS,
} from '../resolver.js'
import { CSS_VAR_MAP, generateCSSVariables } from '../css-mapper.js'
import { guaranteeMinAbsDeltaL, guaranteeMinDeltaL } from '../role-mapping.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const builtinThemeDir = path.resolve(dirname, '../builtin')
const builtinThemeFiles = fs
  .readdirSync(builtinThemeDir)
  .filter(fileName => fileName.endsWith('.json'))
  .sort()

interface ParsedColor {
  red: number
  green: number
  blue: number
  alpha: number
}

function loadBuiltinTheme(fileName: string): Theme {
  const themePath = path.resolve(builtinThemeDir, fileName)
  return JSON.parse(fs.readFileSync(themePath, 'utf8')) as Theme
}

function getPathValue(source: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object' && key in value) {
      return (value as Record<string, unknown>)[key]
    }
    return undefined
  }, source)
}

function parseCssColor(value: string | undefined): ParsedColor | null {
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

function compositeColor(foreground: ParsedColor, background: ParsedColor): ParsedColor {
  const alpha = foreground.alpha + background.alpha * (1 - foreground.alpha)
  if (alpha === 0) {
    return { red: 0, green: 0, blue: 0, alpha: 0 }
  }

  return {
    red: ((foreground.red * foreground.alpha) + (background.red * background.alpha * (1 - foreground.alpha))) / alpha,
    green: ((foreground.green * foreground.alpha) + (background.green * background.alpha * (1 - foreground.alpha))) / alpha,
    blue: ((foreground.blue * foreground.alpha) + (background.blue * background.alpha * (1 - foreground.alpha))) / alpha,
    alpha,
  }
}

function resolveColorOver(value: string | undefined, backgroundValue: string): ParsedColor {
  const color = parseCssColor(value)
  const background = parseCssColor(backgroundValue)

  if (!color || !background) {
    throw new Error(`Unable to parse colors: ${value} over ${backgroundValue}`)
  }

  return color.alpha < 1 ? compositeColor(color, background) : color
}

function relativeLuminance(color: ParsedColor): number {
  const [red, green, blue] = [color.red, color.green, color.blue].map(channel => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(foreground: ParsedColor, background: ParsedColor): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function expectReadable(
  themeName: string,
  label: string,
  foregroundValue: string | undefined,
  backgroundValue: string,
  minimum: number
) {
  const foreground = resolveColorOver(foregroundValue, backgroundValue)
  const background = resolveColorOver(backgroundValue, '#ffffff')

  expect.soft(
    contrastRatio(foreground, background),
    `${themeName} ${label} contrast`
  ).toBeGreaterThanOrEqual(minimum)
}

function colorDistance(first: ParsedColor, second: ParsedColor): number {
  return Math.abs(first.red - second.red)
    + Math.abs(first.green - second.green)
    + Math.abs(first.blue - second.blue)
}

function solidColorKey(value: string | undefined): string | null {
  const color = parseCssColor(value)
  if (!color || color.alpha < 0.999) return null
  return `${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)}`
}

function rgbTriplet(value: string | undefined): string | null {
  const color = parseCssColor(value)
  if (!color || color.alpha < 0.999) return null
  return `${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)}`
}

describe('theme CSS variable mapping', () => {
  it('maps text.input to the shared editor caret token', () => {
    expect(CSS_VAR_MAP['text.input']).toContain('--text-input')
    expect(CSS_VAR_MAP['text.input']).toContain('--editor-caret')
  })
})

describe('built-in theme text contrast', () => {
  it('exposes Nord palette swatches for theme previews', () => {
    const theme = loadBuiltinTheme('nord.json')
    const preview = extractPreviewColors(theme)

    expect(preview.palette).toEqual(expect.arrayContaining([
      '#3B4252',
      '#434C5E',
      '#4C566A',
      '#D8DEE9',
      '#88C0D0',
      '#81A1C1',
      '#8FBCBB',
      '#A3BE8C',
    ]))
    expect(preview.palette.length).toBeLessThanOrEqual(10)
  })

  it('keeps Nord defs on the official palette instead of custom pseudo-colors', () => {
    const theme = loadBuiltinTheme('nord.json')

    expect(Object.keys(theme.defs).sort()).toEqual([
      'nord0',
      'nord1',
      'nord10',
      'nord11',
      'nord12',
      'nord13',
      'nord14',
      'nord15',
      'nord2',
      'nord3',
      'nord4',
      'nord5',
      'nord6',
      'nord7',
      'nord8',
      'nord9',
    ])
    expect(theme.defs).not.toHaveProperty('nordSurface')
  })

  it('keeps built-in themes free of per-theme UI semantic overrides', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      expect(theme.ui, `${theme.name} should use shared role mapping instead of theme.ui overrides`).toBeUndefined()
    }
  })

  it('generates parseable status semantic colors without exposing ramps', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const modes: Array<'dark' | 'light'> = theme.colorScheme === 'dark' || theme.colorScheme === 'light'
        ? [theme.colorScheme]
        : ['dark', 'light']

      for (const mode of modes) {
        const resolvedTheme = resolveTheme(theme, mode)
        const pageBackground = resolvedTheme['neutral.pageBackground'] || resolvedTheme['bg.app']
        const parsedBackground = parseCssColor(pageBackground)
        expect(parsedBackground, `${theme.name} ${mode} page background should be parseable`).toBeTruthy()
        if (!parsedBackground) continue

        expect(resolvedTheme['primary.100'], `${theme.name} ${mode} should not expose primary ramp paths`).toBeUndefined()

        for (const token of THEME_STATUS_COLOR_TOKENS) {
          expect(resolvedTheme[`color.${token}.100`], `${theme.name} ${mode} should not expose ${token} ramp paths`).toBeUndefined()

          for (const suffix of ['', 'Bg', 'BgHover', 'Border', 'Text']) {
            const path = `color.${token}${suffix}`
            expect(
              parseCssColor(resolvedTheme[path]),
              `${theme.name} ${mode} ${path} should be a parseable semantic status color`,
            ).toBeTruthy()
          }

          const textColor = resolveColorOver(resolvedTheme[`color.${token}Text`], pageBackground)
          expect.soft(
            contrastRatio(textColor, parsedBackground),
            `${theme.name} ${mode} color.${token}Text should remain visible on page background`,
          ).toBeGreaterThanOrEqual(1.15)
        }
      }
    }
  })

  it('keeps Nord sidebar metadata readable against the sidebar surface', () => {
    const theme = loadBuiltinTheme('nord.json')
    const resolvedTheme = resolveTheme(theme, 'dark')
    const background = resolvedTheme['bg.sidebar']
    const readableSidebarTokens = [
      'text.sidebar.item',
      'text.sidebar.muted',
      'text.sidebar.title',
    ]

    for (const token of readableSidebarTokens) {
      expectReadable('Nord', token, resolvedTheme[token], background, 4.5)
    }
  })

  it('keeps GitHub Light chat metadata and thinking text readable', () => {
    const theme = loadBuiltinTheme('github-light.json')
    const resolvedTheme = resolveTheme(theme, 'light')
    const background = resolvedTheme['bg.chat']
    const readableTextTokens = [
      'text.faint',
      'text.ai.thinking',
      'text.tool.args',
      'text.sidebar.muted',
      'text.inputPlaceholder',
      'text.menu.header',
      'text.helper',
    ]

    for (const token of readableTextTokens) {
      expect(getPathValue(theme.theme, token), `${token} should not use a border color as text`).not.toBe('borderDefault')
      expectReadable('GitHub Light', token, resolvedTheme[token], background, 4.5)
    }
  })

  it('keeps core UI semantic surfaces readable for every built-in theme', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const themeName = theme.name
      const sidebarSurface = resolvedUI['ui.sidebar.surface'].bg || resolvedTheme['bg.sidebar']
      const tabBarSurface = resolvedUI['ui.tabBar.surface'].bg || resolvedTheme['bg.panel']
      const chatSurface = resolvedUI['ui.surface.chat'].bg || resolvedTheme['bg.chat']
      const panelSurface = resolvedUI['ui.surface.panel'].bg || resolvedTheme['bg.panel']
      const inputSurface = resolvedUI['ui.surface.input'].bg || resolvedTheme['bg.input']
      const tooltipSurface = resolvedUI['ui.surface.tooltip'].bg || resolvedTheme['bg.tooltip']
      const userMessageSurface = resolvedUI['ui.message.userSolid'].bg || resolvedUI['ui.message.user'].bg || panelSurface
      const toolSurface = resolvedUI['ui.tool.surface'].bg || resolvedTheme['bg.toolCall']
      const assistantSurface = resolvedUI['ui.message.assistant'].bg === 'transparent'
        ? chatSurface
        : (resolvedUI['ui.message.assistant'].bg || panelSurface)
      const sidebarActiveSurface = resolveColorOver(resolvedUI['ui.sidebar.itemActive'].bg, sidebarSurface)
      const tabActiveSurface = resolveColorOver(resolvedUI['ui.tabBar.itemActive'].bg, tabBarSurface)

      expectReadable(themeName, 'sidebar item', resolvedUI['ui.sidebar.item'].fg, sidebarSurface, 4.5)
      expectReadable(themeName, 'sidebar muted metadata', resolvedUI['ui.sidebar.itemMuted'].fg, sidebarSurface, 3.5)
      expectReadable(themeName, 'sidebar section header', resolvedUI['ui.sidebar.header'].fg, sidebarSurface, 3.5)
      expectReadable(themeName, 'tab item', resolvedUI['ui.tabBar.item'].fg, tabBarSurface, 3.5)
      expectReadable(themeName, 'chat primary text', resolvedUI['ui.text.primary'].fg, chatSurface, 4.5)
      expectReadable(themeName, 'composer text', resolvedUI['ui.editor.text'].fg, inputSurface, 4.5)
      expectReadable(themeName, 'composer placeholder', resolvedUI['ui.editor.placeholder'].fg, inputSurface, 3.5)
      expectReadable(themeName, 'tooltip text', resolvedUI['ui.surface.tooltip'].fg, tooltipSurface, 4.5)
      expectReadable(themeName, 'user message text', resolvedUI['ui.message.user'].fg, userMessageSurface, 4.5)
      expectReadable(themeName, 'assistant message text', resolvedUI['ui.message.assistant'].fg, assistantSurface, 4.5)
      expectReadable(themeName, 'tool text', resolvedUI['ui.tool.text'].fg, toolSurface, 4.5)
      expectReadable(themeName, 'tool muted metadata', resolvedUI['ui.tool.textMuted'].fg, toolSurface, 3.5)

      expect(
        contrastRatio(resolveColorOver(resolvedUI['ui.sidebar.itemActive'].fg, sidebarSurface), sidebarActiveSurface),
        `${themeName} sidebar active item contrast`
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(resolveColorOver(resolvedUI['ui.tabBar.itemActive'].fg, tabBarSurface), tabActiveSurface),
        `${themeName} tab active item contrast`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps composer and user bubble surfaces solid and visibly raised from the chat surface', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const modes: Array<'light' | 'dark'> = theme.colorScheme === 'light'
        ? ['light']
        : theme.colorScheme === 'dark'
          ? ['dark']
          : ['light', 'dark']

      for (const mode of modes) {
        const resolvedTheme = resolveTheme(theme, mode)
        const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
        const label = `${theme.name} (${mode})`
        const chatBg = resolvedUI['ui.surface.chat'].bg

        // 0.005 tolerance: the guard's bump round-trips through 8-bit hex,
        // which can shave up to ~0.003 off the requested OKLCH delta.
        // The composer must be raised in the mode's direction (directional
        // guard); the bubble may sit on either side of the chat surface.
        const raisedSurfaces = [
          ['composer input', resolvedUI['ui.surface.input'].bg, SURFACE_GUARD_MIN_DELTA_L.input - 0.005, guaranteeMinDeltaL],
          ['user bubble solid', resolvedUI['ui.message.userSolid'].bg, SURFACE_GUARD_MIN_DELTA_L.userBubble - 0.005, guaranteeMinAbsDeltaL],
        ] as const

        for (const [surfaceLabel, surface, minDelta, guard] of raisedSurfaces) {
          // Gradients here would make color-mix()/gradient stops in components
          // invalid at computed-value time, collapsing the background entirely.
          const surfaceColor = parseCssColor(surface)
          expect(
            surfaceColor,
            `${label} ${surfaceLabel} surface should be a solid color, got ${surface}`
          ).not.toBeNull()

          // Re-applying the resolver's lightness guard must be a no-op,
          // i.e. the surface already sits visibly off the chat background.
          expect(
            guard(chatBg, surface, minDelta, mode === 'dark'),
            `${label} ${surfaceLabel} surface should be visibly raised from the chat surface`
          ).toBe(surface)

          // Independent metric so a broken guard implementation can't
          // self-certify: the surfaces must also differ in plain RGB terms.
          expect(
            colorDistance(surfaceColor!, resolveColorOver(chatBg, '#ffffff')),
            `${label} ${surfaceLabel} surface should differ from the chat surface in RGB`
          ).toBeGreaterThanOrEqual(8)
        }
      }
    }
  })

  // P4b 停双写之后,`--bg-*` 这些 legacy 名不再由 UI 语义角色覆写(它们只剩
  // variables.css 的静态兜底 + CSS_VAR_MAP 的主题路径直写)。这条断言的本意是
  // "应用真正上色的那几个面来自语义角色映射",所以改断 `--ui-*` 正主。
  it('routes surface CSS variables through semantic role mapping for every built-in theme', () => {
    const roleBackedVariables = [
      ['--ui-surface-app-bg', 'ui.surface.app', 'bg'],
      ['--ui-surface-sidebar-bg', 'ui.surface.sidebar', 'bg'],
      ['--ui-surface-chat-bg', 'ui.surface.chat', 'bg'],
      ['--ui-surface-panel-bg', 'ui.surface.panel', 'bg'],
      ['--ui-surface-elevated-bg', 'ui.surface.elevated', 'bg'],
      ['--ui-surface-floating-bg', 'ui.surface.floating', 'bg'],
      ['--ui-tab-bar-surface-bg', 'ui.tabBar.surface', 'bg'],
      ['--ui-surface-input-bg', 'ui.surface.input', 'bg'],
    ] as const

    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const cssVariables = generateCSSVariables(resolvedTheme, undefined, resolvedUI)

      for (const [cssVariable, token, field] of roleBackedVariables) {
        expect(
          cssVariables[cssVariable],
          `${theme.name} ${cssVariable} should be produced by ${token}.${field}`
        ).toBe(resolvedUI[token][field])
      }

      expect(cssVariables['--bg-rgb']).toBe(rgbTriplet(cssVariables['--bg-app']))
      expect(cssVariables['--sidebar-rgb']).toBe(rgbTriplet(cssVariables['--bg-sidebar']))
    }
  })

  it('uses semantic role-mapped colors for settings theme previews', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const preview = extractPreviewColors(theme)

      expect(preview.bg, `${theme.name} preview bg should match chat role`).toBe(resolvedUI['ui.surface.chat'].bg)
      expect(preview.sidebar, `${theme.name} preview sidebar should match sidebar role`).toBe(resolvedUI['ui.sidebar.surface'].bg)
      expect(preview.accent, `${theme.name} preview accent should match accent role`).toBe(resolvedUI['ui.accent.primary'].fg)
      expect(preview.text, `${theme.name} preview text should match primary text role`).toBe(resolvedUI['ui.text.primary'].fg)
    }
  })

  it('keeps light theme code blocks subtle and syntax readable', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      if (mode !== 'light') continue

      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const resolvedHighlights = resolveThemeHighlights(theme, mode, resolvedTheme)
      const themeName = theme.name
      const chatSurface = resolvedUI['ui.surface.chat'].bg || resolvedTheme['bg.chat']
      const codeSurface = resolvedUI['ui.surface.codeBlock'].bg || resolvedTheme['bg.code.block']
      const codeHeaderSurface = resolvedUI['ui.surface.codeHeader'].bg || resolvedTheme['bg.code.header']
      const chatColor = resolveColorOver(chatSurface, '#ffffff')
      const codeColor = resolveColorOver(codeSurface, '#ffffff')
      const codeHeaderColor = resolveColorOver(codeHeaderSurface, '#ffffff')

      expect(
        colorDistance(codeColor, chatColor),
        `${themeName} light code block should differ subtly from chat surface`
      ).toBeGreaterThanOrEqual(8)
      expect(
        colorDistance(codeColor, chatColor),
        `${themeName} light code block should not become a heavy panel`
      ).toBeLessThanOrEqual(45)
      expect(
        colorDistance(codeHeaderColor, codeColor),
        `${themeName} light code header should stay close to code block surface`
      ).toBeLessThanOrEqual(30)

      expectReadable(themeName, 'light code plain', resolvedHighlights['syntax.plain'].fg, codeSurface, 4.5)
      expectReadable(themeName, 'light code comment', resolvedHighlights['syntax.comment'].fg, codeSurface, 3.5)
      expectReadable(themeName, 'light code keyword', resolvedHighlights['syntax.keyword'].fg, codeSurface, 4)
      expectReadable(themeName, 'light code string', resolvedHighlights['syntax.string'].fg, codeSurface, 3.5)
    }
  })

  it('keeps light theme menu hover states subtle and visible', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      if (mode !== 'light') continue

      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const themeName = theme.name
      const menuSurface = resolvedUI['ui.surface.menu'].bg || resolvedTheme['bg.menu']
      const menuHoverSurface = resolvedUI['ui.surface.menuHover'].bg || resolvedTheme['bg.menuItemHover']
      const menuColor = resolveColorOver(menuSurface, '#ffffff')
      const menuHoverColor = resolveColorOver(menuHoverSurface, menuSurface)
      const distance = colorDistance(menuHoverColor, menuColor)

      expect(distance, `${themeName} light menu hover should be visible`).toBeGreaterThanOrEqual(8)
      expect(distance, `${themeName} light menu hover should not become a heavy solid block`).toBeLessThanOrEqual(60)
    }
  })

  it('keeps active states visible without leaking solid accent into neutral chrome', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const themeName = theme.name
      const accentKey = solidColorKey(resolvedUI['ui.accent.primary'].fg || resolvedTheme.accent)
      const sidebarSurface = resolvedUI['ui.sidebar.surface'].bg || resolvedTheme['bg.sidebar']
      const tabBarSurface = resolvedUI['ui.tabBar.surface'].bg || resolvedTheme['bg.panel']
      const sidebarSurfaceColor = resolveColorOver(sidebarSurface, '#ffffff')
      const tabBarSurfaceColor = resolveColorOver(tabBarSurface, '#ffffff')
      const sidebarActiveSurface = resolveColorOver(resolvedUI['ui.sidebar.itemActive'].bg, sidebarSurface)
      const tabActiveSurface = resolveColorOver(resolvedUI['ui.tabBar.itemActive'].bg, tabBarSurface)
      const nonAccentChrome = [
        ['sidebar surface', resolvedUI['ui.sidebar.surface'].bg],
        ['tab bar surface', resolvedUI['ui.tabBar.surface'].bg],
        ['chat surface', resolvedUI['ui.surface.chat'].bg],
        ['panel surface', resolvedUI['ui.surface.panel'].bg],
        ['tooltip surface', resolvedUI['ui.surface.tooltip'].bg],
        ['composer input surface', resolvedUI['ui.surface.input'].bg],
        ['message user surface', resolvedUI['ui.message.userSolid'].bg || resolvedUI['ui.message.user'].bg],
        ['tool surface', resolvedUI['ui.tool.surface'].bg],
        ['sidebar active text', resolvedUI['ui.sidebar.itemActive'].fg],
        ['tab active text', resolvedUI['ui.tabBar.itemActive'].fg],
      ]

      for (const [label, value] of nonAccentChrome) {
        expect(solidColorKey(value), `${themeName} ${label} should not be solid accent`).not.toBe(accentKey)
      }

      expect(
        colorDistance(sidebarActiveSurface, sidebarSurfaceColor),
        `${themeName} sidebar active state should differ from sidebar surface`
      ).toBeGreaterThanOrEqual(6)
      expect(
        colorDistance(tabActiveSurface, tabBarSurfaceColor),
        `${themeName} tab active state should differ from tab bar surface`
      ).toBeGreaterThanOrEqual(6)
    }
  })

  it('keeps the app canvas visually behind the chat content surface', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
      const resolvedTheme = resolveTheme(theme, mode)
      const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
      const themeName = theme.name
      const appSurface = resolvedUI['ui.surface.app'].bg || resolvedTheme['bg.app']
      const chatSurface = resolvedUI['ui.surface.chat'].bg || resolvedTheme['bg.chat']
      const sidebarSurface = resolvedUI['ui.sidebar.surface'].bg || resolvedTheme['bg.sidebar']
      const tabBarSurface = resolvedUI['ui.tabBar.surface'].bg || chatSurface
      const appColor = resolveColorOver(appSurface, '#ffffff')
      const chatColor = resolveColorOver(chatSurface, '#ffffff')
      const sidebarColor = resolveColorOver(sidebarSurface, '#ffffff')
      const tabBarColor = resolveColorOver(tabBarSurface, '#ffffff')

      if (mode === 'dark') {
        expect(
          colorDistance(appColor, chatColor),
          `${themeName} dark app canvas should differ from chat panel`
        ).toBeGreaterThanOrEqual(6)
        expect(
          colorDistance(sidebarColor, appColor),
          `${themeName} dark sidebar surface should sit on the app canvas`
        ).toBeLessThanOrEqual(1)
      } else {
        expect(
          relativeLuminance(chatColor),
          `${themeName} light chat surface should be lighter than sidebar`
        ).toBeGreaterThan(relativeLuminance(sidebarColor))
      }
      expect(
        colorDistance(sidebarColor, chatColor),
        `${themeName} sidebar surface should differ from chat surface`
      ).toBeGreaterThanOrEqual(6)
      expect(
        colorDistance(tabBarColor, chatColor),
        `${themeName} tab bar surface should belong to the chat panel`
      ).toBeLessThanOrEqual(1)
      expect(
        colorDistance(tabBarColor, sidebarColor),
        `${themeName} tab bar surface should differ from sidebar surface`
      ).toBeGreaterThanOrEqual(6)
    }
  })
})
