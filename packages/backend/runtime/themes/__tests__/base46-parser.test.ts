import { describe, expect, it } from 'vitest'
import type { Base46Theme } from '../types.js'
import { convertBase46ToTheme } from '../base46-parser.js'
import { deriveStateOverlays } from '../role-mapping.js'
import { resolveTheme, resolveThemeUI } from '../resolver.js'

function parseHexColor(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value)
  if (!match) {
    throw new Error(`Expected a 6-digit hex color, received ${value}`)
  }

  const numericValue = Number.parseInt(match[1], 16)
  return [
    (numericValue >> 16) & 255,
    (numericValue >> 8) & 255,
    numericValue & 255,
  ]
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = parseHexColor(color).map(channel => {
    const normalized = channel / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })

  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('Base46 theme conversion', () => {
  it('derives readable UI roles instead of blindly using low-contrast palette greys', () => {
    const base46: Base46Theme = {
      type: 'dark',
      base_30: {
        black: '#2E3440',
        darker_black: '#262C36',
        one_bg: '#3B4252',
        one_bg2: '#434C5E',
        one_bg3: '#4C566A',
        grey: '#303642',
        grey_fg: '#354052',
        grey_fg2: '#3A4557',
        light_grey: '#D8DEE9',
        white: '#ECEFF4',
        blue: '#88C0D0',
        nord_blue: '#81A1C1',
        cyan: '#8FBCBB',
        red: '#BF616A',
        green: '#A3BE8C',
        vibrant_green: '#A3BE8C',
        orange: '#D08770',
        yellow: '#EBCB8B',
        purple: '#B48EAD',
        teal: '#8FBCBB',
        line: '#4C566A',
      },
      base_16: {
        base00: '#2E3440',
        base01: '#3B4252',
        base02: '#434C5E',
        base03: '#4C566A',
        base04: '#4C566A',
        base05: '#D8DEE9',
        base06: '#E5E9F0',
        base07: '#ECEFF4',
        base08: '#BF616A',
        base09: '#D08770',
        base0A: '#EBCB8B',
        base0B: '#A3BE8C',
        base0C: '#8FBCBB',
        base0D: '#81A1C1',
        base0E: '#B48EAD',
        base0F: '#5E81AC',
      },
    }

    const theme = convertBase46ToTheme(base46, 'low-contrast-nordish')
    const sidebarBg = theme.theme.bg.sidebar as string
    const inputBg = theme.theme.bg.input as string
    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)

    expect(theme.theme.bg.chat).toBe('#3B4252')
    expect(theme.theme.bg.panel).toBe('#3B4252')
    expect(theme.theme.text.sidebar?.itemActive).toBe(theme.theme.text.primary)
    expect(theme.ui).toBeUndefined()
    expect(resolvedUI['ui.sidebar.surface'].bg).toBe(sidebarBg)

    expect(contrastRatio(theme.theme.text.sidebar?.item as string, sidebarBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.theme.text.sidebar?.muted as string, sidebarBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.theme.text.inputPlaceholder as string, inputBg)).toBeGreaterThanOrEqual(4.5)
  })

  it('repairs flat Base46 surface palettes without per-theme overrides', () => {
    const base46: Base46Theme = {
      type: 'dark',
      base_30: {
        black: '#202020',
        darker_black: '#202020',
        one_bg: '#202020',
        one_bg2: '#202020',
        one_bg3: '#202020',
        grey: '#343434',
        grey_fg: '#BDBDBD',
        grey_fg2: '#C8C8C8',
        light_grey: '#DADADA',
        white: '#F2F2F2',
        blue: '#7AA2F7',
        nord_blue: '#88C0D0',
        cyan: '#7DCFFF',
        red: '#F7768E',
        green: '#9ECE6A',
        vibrant_green: '#9ECE6A',
        orange: '#FF9E64',
        yellow: '#E0AF68',
        purple: '#BB9AF7',
        teal: '#7DCFFF',
        line: '#3A3A3A',
      },
      base_16: {
        base00: '#202020',
        base01: '#202020',
        base02: '#202020',
        base03: '#343434',
        base04: '#BDBDBD',
        base05: '#DADADA',
        base06: '#E7E7E7',
        base07: '#F2F2F2',
        base08: '#F7768E',
        base09: '#FF9E64',
        base0A: '#E0AF68',
        base0B: '#9ECE6A',
        base0C: '#7DCFFF',
        base0D: '#7AA2F7',
        base0E: '#BB9AF7',
        base0F: '#88C0D0',
      },
    }

    const theme = convertBase46ToTheme(base46, 'flat-surfaces')
    const resolvedTheme = resolveTheme(theme, 'dark')
    const resolvedUI = resolveThemeUI(theme, 'dark', resolvedTheme)

    expect(theme.theme.bg.sidebar).not.toBe(theme.theme.bg.chat)
    expect(theme.theme.bg.panel).toBe(theme.theme.bg.chat)
    expect(theme.theme.bg.elevated).not.toBe(theme.theme.bg.panel)
    expect(theme.ui).toBeUndefined()
    expect(resolvedUI['ui.sidebar.surface'].bg).toBe(theme.theme.bg.sidebar)
    expect(resolvedUI['ui.tabBar.surface'].bg).toBe(theme.theme.bg.chat)
    expect(resolvedUI['ui.tabBar.surface'].bg).not.toBe(theme.theme.bg.sidebar)
  })

  it('keeps light Base46 sidebars visually behind the chat workspace', () => {
    const base46: Base46Theme = {
      type: 'light',
      base_30: {
        white: '#272f35',
        darker_black: '#f5efde',
        black: '#fff9e8',
        black2: '#F0EAD9',
        one_bg: '#E0DAC9',
        one_bg2: '#D1CBBA',
        one_bg3: '#C2BCAB',
        grey: '#B3AD9C',
        grey_fg: '#A39D8C',
        grey_fg2: '#948E7D',
        light_grey: '#857F6E',
        red: '#c85552',
        green: '#5da111',
        vibrant_green: '#87a060',
        nord_blue: '#656c5f',
        blue: '#3a94c5',
        yellow: '#dfa000',
        purple: '#b67996',
        teal: '#69a59d',
        orange: '#F7954F',
        cyan: '#89bfdc',
        line: '#e8e2d1',
      },
      base_16: {
        base00: '#fff9e8',
        base01: '#f6f0df',
        base02: '#ede7d6',
        base03: '#e5dfce',
        base04: '#ddd7c6',
        base05: '#495157',
        base06: '#3b4349',
        base07: '#272f35',
        base08: '#5f9b93',
        base09: '#b67996',
        base0A: '#8da101',
        base0B: '#d59600',
        base0C: '#ef615e',
        base0D: '#87a060',
        base0E: '#c85552',
        base0F: '#c85552',
      },
    }

    const theme = convertBase46ToTheme(base46, 'everforest-light')
    const resolvedTheme = resolveTheme(theme, 'light')
    const resolvedUI = resolveThemeUI(theme, 'light', resolvedTheme)
    const sidebarBg = resolvedUI['ui.sidebar.surface'].bg as string
    const chatBg = resolvedUI['ui.surface.chat'].bg as string

    expect(theme.ui).toBeUndefined()
    expect(relativeLuminance(chatBg)).toBeGreaterThan(relativeLuminance(sidebarBg))
    expect(contrastRatio(resolvedUI['ui.sidebar.item'].fg as string, sidebarBg)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolvedUI['ui.text.primary'].fg as string, chatBg)).toBeGreaterThanOrEqual(4.5)
  })

  it('derives Base46 state colors from each surface instead of primary fills', () => {
    const base46: Base46Theme = {
      type: 'light',
      base_30: {
        white: '#172025',
        darker_black: '#f7f1df',
        black: '#fff9e8',
        one_bg: '#e8dfca',
        one_bg2: '#d7ccb5',
        one_bg3: '#c6b99f',
        grey: '#b8aa91',
        grey_fg: '#5f6f75',
        grey_fg2: '#536268',
        light_grey: '#405055',
        red: '#c85552',
        green: '#5da111',
        vibrant_green: '#87a060',
        nord_blue: '#6fa8b6',
        blue: '#3a94c5',
        yellow: '#dfa000',
        purple: '#b67996',
        teal: '#69a59d',
        orange: '#f7954f',
        cyan: '#89bfdc',
        line: '#ddd2ba',
      },
      base_16: {
        base00: '#fff9e8',
        base01: '#f6f0df',
        base02: '#ede7d6',
        base03: '#e5dfce',
        base04: '#8c958f',
        base05: '#495157',
        base06: '#3b4349',
        base07: '#272f35',
        base08: '#5f9b93',
        base09: '#b67996',
        base0A: '#8da101',
        base0B: '#d59600',
        base0C: '#ef615e',
        base0D: '#87a060',
        base0E: '#c85552',
        base0F: '#c85552',
      },
    }

    const theme = convertBase46ToTheme(base46, 'state-fallthrough-light')
    const panelStates = deriveStateOverlays(theme.theme.bg.panel as string, '#000000', 'light')!
    const chatStates = deriveStateOverlays(theme.theme.bg.chat as string, '#000000', 'light')!

    expect(theme.theme.bg.hover).toBe(panelStates.hover)
    expect(theme.theme.bg.active).toBe(panelStates.active)
    expect(theme.theme.bg.selected).toBe(panelStates.selected.bg)
    expect(theme.theme.bg.selectedHover).toBe(panelStates.selectedHover)
    expect(theme.theme.bg.message?.hover).toBe(chatStates.hover)
    expect(theme.theme.effects?.overlayHover).toBeUndefined()
    expect(theme.theme.effects?.overlayActive).toBeUndefined()

    const resolvedTheme = resolveTheme(theme, 'light')
    const resolvedUI = resolveThemeUI(theme, 'light', resolvedTheme)
    const resolvedPanelStates = deriveStateOverlays(
      resolvedUI['ui.surface.panel'].bg,
      resolvedUI['ui.state.selected'].border,
      'light'
    )!
    const resolvedSidebarStates = deriveStateOverlays(
      resolvedUI['ui.sidebar.surface'].bg,
      resolvedUI['ui.sidebar.itemActive'].border,
      'light'
    )!

    expect(resolvedUI['ui.state.hover'].bg).toBe(resolvedPanelStates.hover)
    expect(resolvedUI['ui.state.active'].bg).toBe(resolvedPanelStates.active)
    expect(resolvedUI['ui.state.selected'].bg).toBe(resolvedPanelStates.selected.bg)
    expect(resolvedUI['ui.state.selectedHover'].bg).toBe(resolvedPanelStates.selectedHover)
    expect(resolvedUI['ui.state.selected'].bg).not.toBe(resolvedTheme.primaryBg)
    expect(resolvedUI['ui.sidebar.itemHover'].bg).toBe(resolvedSidebarStates.hover)
    expect(resolvedUI['ui.sidebar.itemActive'].bg).toBe(resolvedSidebarStates.selected.bg)
    expect(resolvedUI['ui.sidebar.itemActive'].border).toBe(resolvedSidebarStates.selected.border)
  })
})
