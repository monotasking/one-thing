import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'
import type { Theme } from '../types.js'
import { generateCSSVariables } from '../css-mapper.js'
import { resolveTheme, resolveThemeHighlights, resolveThemeUI } from '../resolver.js'
import {
  colorDistance,
  contrastRatio,
  parseCssColor,
  relativeLuminance,
  resolveColorOverBackground,
} from '../role-mapping.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const builtinThemeDir = path.resolve(dirname, '../builtin')
const builtinThemeFiles = fs
  .readdirSync(builtinThemeDir)
  .filter(fileName => fileName.endsWith('.json'))
  .sort()

interface GalleryTheme {
  theme: string
  scheme: 'dark' | 'light'
  surfaces: {
    app: string
    sidebar: string
    chat: string
    tabbar: string
    composer: string
    tool: string
  }
  states: {
    sidebarActive: string
    tabActive: string
    composerFocus: string
  }
  accent: string
}

interface GalleryComponent {
  name: string
  surface: string
  text: Array<{ label: string; variable: string; minimum: number }>
  active?: { bg: string; fg: string; minimum: number }
}

const galleryComponents: GalleryComponent[] = [
  {
    name: 'sidebar',
    surface: '--ui-sidebar-surface-bg',
    text: [
      { label: 'item', variable: '--ui-sidebar-item-fg', minimum: 4.5 },
      { label: 'muted metadata', variable: '--ui-sidebar-item-muted-fg', minimum: 3.5 },
      { label: 'section header', variable: '--ui-sidebar-header-fg', minimum: 3.5 },
    ],
    active: {
      bg: '--ui-sidebar-item-active-bg',
      fg: '--ui-sidebar-item-active-fg',
      minimum: 4.5,
    },
  },
  {
    name: 'tabbar',
    surface: '--ui-tab-bar-surface-bg',
    text: [
      { label: 'item', variable: '--ui-tab-bar-item-fg', minimum: 3.5 },
      { label: 'action', variable: '--ui-tab-bar-action-fg', minimum: 3.5 },
    ],
    active: {
      bg: '--ui-tab-bar-item-active-bg',
      fg: '--ui-tab-bar-item-active-fg',
      minimum: 4.5,
    },
  },
  {
    name: 'chat window',
    surface: '--ui-surface-chat-bg',
    text: [
      { label: 'primary text', variable: '--ui-text-primary-fg', minimum: 4.5 },
      { label: 'secondary text', variable: '--ui-text-secondary-fg', minimum: 3.5 },
    ],
  },
  {
    name: 'composer',
    surface: '--ui-surface-input-bg',
    text: [
      { label: 'editor text', variable: '--ui-editor-text-fg', minimum: 4.5 },
      { label: 'placeholder', variable: '--ui-editor-placeholder-fg', minimum: 3.5 },
    ],
  },
  {
    name: 'tool card',
    surface: '--ui-tool-surface-bg',
    text: [
      { label: 'tool text', variable: '--ui-tool-text-fg', minimum: 4.5 },
      { label: 'tool muted metadata', variable: '--ui-tool-text-muted-fg', minimum: 3.5 },
    ],
  },
]

function loadBuiltinTheme(fileName: string): Theme {
  return JSON.parse(fs.readFileSync(path.resolve(builtinThemeDir, fileName), 'utf8')) as Theme
}

function requiredVar(cssVariables: Record<string, string>, name: string, themeName: string): string {
  const value = cssVariables[name]
  expect(value, `${themeName} should define ${name}`).toBeTruthy()
  return value
}

function resolveRequiredColor(
  value: string,
  background: string,
  label: string
): NonNullable<ReturnType<typeof resolveColorOverBackground>> {
  const color = resolveColorOverBackground(value, background)
  expect(color, `${label} should parse as a color`).toBeTruthy()
  return color!
}

function solidColorKey(value: string | undefined): string | null {
  const color = parseCssColor(value)
  if (!color || color.alpha < 0.999) return null
  return `${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)}`
}

function resolveBuiltinTheme(theme: Theme): {
  mode: 'dark' | 'light'
  cssVariables: Record<string, string>
  gallery: GalleryTheme
} {
  const mode = theme.colorScheme === 'light' ? 'light' : 'dark'
  const resolvedTheme = resolveTheme(theme, mode)
  const resolvedHighlights = resolveThemeHighlights(theme, mode, resolvedTheme)
  const resolvedUI = resolveThemeUI(theme, mode, resolvedTheme)
  const cssVariables = generateCSSVariables(resolvedTheme, resolvedHighlights, resolvedUI)

  return {
    mode,
    cssVariables,
    gallery: {
      theme: theme.name,
      scheme: mode,
      surfaces: {
        app: requiredVar(cssVariables, '--ui-surface-app-bg', theme.name),
        sidebar: requiredVar(cssVariables, '--ui-sidebar-surface-bg', theme.name),
        chat: requiredVar(cssVariables, '--ui-surface-chat-bg', theme.name),
        tabbar: requiredVar(cssVariables, '--ui-tab-bar-surface-bg', theme.name),
        composer: requiredVar(cssVariables, '--ui-surface-input-bg', theme.name),
        tool: requiredVar(cssVariables, '--ui-tool-surface-bg', theme.name),
      },
      states: {
        sidebarActive: requiredVar(cssVariables, '--ui-sidebar-item-active-bg', theme.name),
        tabActive: requiredVar(cssVariables, '--ui-tab-bar-item-active-bg', theme.name),
        composerFocus: requiredVar(cssVariables, '--ui-surface-input-focus-bg', theme.name),
      },
      accent: requiredVar(cssVariables, '--ui-accent-primary-fg', theme.name),
    },
  }
}

describe('built-in theme gallery regression', () => {
  it('keeps a stable semantic surface matrix for every built-in theme', () => {
    const gallery = builtinThemeFiles.map(fileName => resolveBuiltinTheme(loadBuiltinTheme(fileName)).gallery)

    expect(gallery).toMatchInlineSnapshot(`
      [
        {
          "accent": "#7cc4dc",
          "scheme": "dark",
          "states": {
            "composerFocus": "#2F5061",
            "sidebarActive": "#384F5D",
            "tabActive": "#2E4C5D",
          },
          "surfaces": {
            "app": "#1b3443",
            "chat": "#234152",
            "composer": "#2b4a5b",
            "sidebar": "#1b3443",
            "tabbar": "#234152",
            "tool": "#2c4d5e",
          },
          "theme": "雨后夜晚 Night After Rain",
        },
        {
          "accent": "#2f6e88",
          "scheme": "light",
          "states": {
            "composerFocus": "#E5EBEB",
            "sidebarActive": "#D0D8DA",
            "tabActive": "#E9EBEB",
          },
          "surfaces": {
            "app": "#f2f7f7",
            "chat": "#fafcfc",
            "composer": "#e8f0f1",
            "sidebar": "#ecf3f4",
            "tabbar": "#fafcfc",
            "tool": "#EBF1F1",
          },
          "theme": "雨后彩虹 Rainbow After Rain",
        },
        {
          "accent": "#8839EF",
          "scheme": "light",
          "states": {
            "composerFocus": "#DDDFE5",
            "sidebarActive": "#CACDD5",
            "tabActive": "#DFE0E4",
          },
          "surfaces": {
            "app": "#DCE0E8",
            "chat": "#EFF1F5",
            "composer": "#E4E6EB",
            "sidebar": "#E6E9EF",
            "tabbar": "#EFF1F5",
            "tool": "#E4E6EC",
          },
          "theme": "Catppuccin Latte",
        },
        {
          "accent": "#CBA6F7",
          "scheme": "dark",
          "states": {
            "composerFocus": "#313244",
            "sidebarActive": "#2A2B38",
            "tabActive": "#282838",
          },
          "surfaces": {
            "app": "#11111B",
            "chat": "#1E1E2E",
            "composer": "#262636",
            "sidebar": "#11111B",
            "tabbar": "#1E1E2E",
            "tool": "#313244",
          },
          "theme": "Catppuccin Mocha",
        },
        {
          "accent": "#BD93F9",
          "scheme": "dark",
          "states": {
            "composerFocus": "#44475A",
            "sidebarActive": "#3C3D45",
            "tabActive": "#3E4151",
          },
          "surfaces": {
            "app": "#21222C",
            "chat": "#343746",
            "composer": "#3C404F",
            "sidebar": "#21222C",
            "tabbar": "#343746",
            "tool": "#44475A",
          },
          "theme": "Dracula",
        },
        {
          "accent": "#4385BE",
          "scheme": "dark",
          "states": {
            "composerFocus": "#42403E",
            "sidebarActive": "#43423F",
            "tabActive": "#3E3D3B",
          },
          "surfaces": {
            "app": "#282726",
            "chat": "#343331",
            "composer": "#3C3B39",
            "sidebar": "#282726",
            "tabbar": "#343331",
            "tool": "#403E3C",
          },
          "theme": "Flexoki",
        },
        {
          "accent": "#58A6FF",
          "scheme": "dark",
          "states": {
            "composerFocus": "#23282F",
            "sidebarActive": "#1C1F25",
            "tabActive": "#1F242C",
          },
          "surfaces": {
            "app": "#010409",
            "chat": "#161B22",
            "composer": "#1E232A",
            "sidebar": "#010409",
            "tabbar": "#161B22",
            "tool": "#23282F",
          },
          "theme": "GitHub Dark",
        },
        {
          "accent": "#0969DA",
          "scheme": "light",
          "states": {
            "composerFocus": "#EDEDEE",
            "sidebarActive": "#DBDDE0",
            "tabActive": "#EEEEEE",
          },
          "surfaces": {
            "app": "#FFFFFF",
            "chat": "#FFFFFF",
            "composer": "#F4F4F5",
            "sidebar": "#F6F8FA",
            "tabbar": "#FFFFFF",
            "tool": "#F5F5F6",
          },
          "theme": "GitHub Light",
        },
        {
          "accent": "#83A598",
          "scheme": "dark",
          "states": {
            "composerFocus": "#4B4641",
            "sidebarActive": "#45433D",
            "tabActive": "#474240",
          },
          "surfaces": {
            "app": "#282828",
            "chat": "#3C3836",
            "composer": "#45413F",
            "sidebar": "#282828",
            "tabbar": "#3C3836",
            "tool": "#4A4540",
          },
          "theme": "Gruvbox Dark",
        },
        {
          "accent": "#076678",
          "scheme": "light",
          "states": {
            "composerFocus": "#E9DFB8",
            "sidebarActive": "#D1C39F",
            "tabActive": "#EAE0B7",
          },
          "surfaces": {
            "app": "#FBF1C7",
            "chat": "#FBF1C7",
            "composer": "#F0E6BD",
            "sidebar": "#EBDBB2",
            "tabbar": "#FBF1C7",
            "tool": "#F1E7BF",
          },
          "theme": "Gruvbox Light",
        },
        {
          "accent": "#88C0D0",
          "scheme": "dark",
          "states": {
            "composerFocus": "#475063",
            "sidebarActive": "#4A505B",
            "tabActive": "#464D5D",
          },
          "surfaces": {
            "app": "#2E3440",
            "chat": "#3B4252",
            "composer": "#434C5E",
            "sidebar": "#2E3440",
            "tabbar": "#3B4252",
            "tool": "#434C5E",
          },
          "theme": "Nord",
        },
        {
          "accent": "#61AFEF",
          "scheme": "dark",
          "states": {
            "composerFocus": "#3A3F49",
            "sidebarActive": "#3C4046",
            "tabActive": "#363C47",
          },
          "surfaces": {
            "app": "#21252B",
            "chat": "#2C323C",
            "composer": "#343A45",
            "sidebar": "#21252B",
            "tabbar": "#2C323C",
            "tool": "#3A3F49",
          },
          "theme": "One Dark",
        },
        {
          "accent": "#4078F2",
          "scheme": "light",
          "states": {
            "composerFocus": "#E8E8E9",
            "sidebarActive": "#D5D6D7",
            "tabActive": "#E9E9E9",
          },
          "surfaces": {
            "app": "#FAFAFA",
            "chat": "#FAFAFA",
            "composer": "#EFEFF0",
            "sidebar": "#F0F0F0",
            "tabbar": "#FAFAFA",
            "tool": "#F0F0F1",
          },
          "theme": "One Light",
        },
        {
          "accent": "#a63c26",
          "scheme": "light",
          "states": {
            "composerFocus": "#E8E4D8",
            "sidebarActive": "#D2CAB8",
            "tabActive": "#E9E5DA",
          },
          "surfaces": {
            "app": "#f4eedd",
            "chat": "#faf6ea",
            "composer": "#EFEBDF",
            "sidebar": "#ece4d0",
            "tabbar": "#faf6ea",
            "tool": "#F0ECE0",
          },
          "theme": "纸墨 Paper Ink",
        },
        {
          "accent": "#C4A7E7",
          "scheme": "dark",
          "states": {
            "composerFocus": "#2D2B3C",
            "sidebarActive": "#33313F",
            "tabActive": "#292738",
          },
          "surfaces": {
            "app": "#191724",
            "chat": "#1F1D2E",
            "composer": "#272536",
            "sidebar": "#191724",
            "tabbar": "#1F1D2E",
            "tool": "#2D2B3C",
          },
          "theme": "Rosé Pine",
        },
        {
          "accent": "#268BD2",
          "scheme": "dark",
          "states": {
            "composerFocus": "#18444F",
            "sidebarActive": "#1F464F",
            "tabActive": "#15414D",
          },
          "surfaces": {
            "app": "#002B36",
            "chat": "#073642",
            "composer": "#123F4B",
            "sidebar": "#002B36",
            "tabbar": "#073642",
            "tool": "#17434E",
          },
          "theme": "Solarized Dark",
        },
        {
          "accent": "#268BD2",
          "scheme": "light",
          "states": {
            "composerFocus": "#E9E5D3",
            "sidebarActive": "#CECFC1",
            "tabActive": "#ECE5D3",
          },
          "surfaces": {
            "app": "#FDF6E3",
            "chat": "#FDF6E3",
            "composer": "#F1EBD8",
            "sidebar": "#EEE8D5",
            "tabbar": "#FDF6E3",
            "tool": "#F1EDDB",
          },
          "theme": "Solarized Light",
        },
        {
          "accent": "#7AA2F7",
          "scheme": "dark",
          "states": {
            "composerFocus": "#414868",
            "sidebarActive": "#2F303D",
            "tabActive": "#33384D",
          },
          "surfaces": {
            "app": "#16161E",
            "chat": "#292E42",
            "composer": "#31364B",
            "sidebar": "#16161E",
            "tabbar": "#292E42",
            "tool": "#414868",
          },
          "theme": "Tokyo Night",
        },
      ]
    `)
  })

  it('keeps gallery surfaces readable, layered, and free of solid accent leaks', () => {
    for (const fileName of builtinThemeFiles) {
      const theme = loadBuiltinTheme(fileName)
      const { cssVariables, gallery } = resolveBuiltinTheme(theme)
      const accentKey = solidColorKey(gallery.accent)

      for (const component of galleryComponents) {
        const surface = requiredVar(cssVariables, component.surface, gallery.theme)

        for (const text of component.text) {
          const foreground = requiredVar(cssVariables, text.variable, gallery.theme)
          const foregroundColor = resolveRequiredColor(foreground, surface, `${gallery.theme} ${component.name} ${text.label}`)
          const backgroundColor = resolveRequiredColor(surface, '#ffffff', `${gallery.theme} ${component.name} surface`)

          expect(
            contrastRatio(foregroundColor, backgroundColor),
            `${gallery.theme} ${component.name} ${text.label} contrast`
          ).toBeGreaterThanOrEqual(text.minimum)
        }

        expect(
          solidColorKey(surface),
          `${gallery.theme} ${component.name} surface should not be solid accent`
        ).not.toBe(accentKey)

        if (component.active) {
          const activeBg = requiredVar(cssVariables, component.active.bg, gallery.theme)
          const activeFg = requiredVar(cssVariables, component.active.fg, gallery.theme)
          const activeBgColor = resolveRequiredColor(activeBg, surface, `${gallery.theme} ${component.name} active bg`)
          const activeFgColor = resolveRequiredColor(activeFg, surface, `${gallery.theme} ${component.name} active fg`)
          const surfaceColor = resolveRequiredColor(surface, '#ffffff', `${gallery.theme} ${component.name} surface`)

          expect(
            contrastRatio(activeFgColor, activeBgColor),
            `${gallery.theme} ${component.name} active contrast`
          ).toBeGreaterThanOrEqual(component.active.minimum)
          expect(
            colorDistance(activeBgColor, surfaceColor),
            `${gallery.theme} ${component.name} active surface should be visible`
          ).toBeGreaterThanOrEqual(6)
          expect(
            solidColorKey(activeFg),
            `${gallery.theme} ${component.name} active text should not be solid accent`
          ).not.toBe(accentKey)
        }
      }

      const appColor = resolveRequiredColor(gallery.surfaces.app, '#ffffff', `${gallery.theme} app surface`)
      const sidebarColor = resolveRequiredColor(gallery.surfaces.sidebar, '#ffffff', `${gallery.theme} sidebar surface`)
      const chatColor = resolveRequiredColor(gallery.surfaces.chat, '#ffffff', `${gallery.theme} chat surface`)
      const tabBarColor = resolveRequiredColor(gallery.surfaces.tabbar, '#ffffff', `${gallery.theme} tabbar surface`)

      if (gallery.scheme === 'dark') {
        expect(colorDistance(appColor, chatColor), `${gallery.theme} dark app and chat surfaces`).toBeGreaterThanOrEqual(6)
        expect(colorDistance(sidebarColor, appColor), `${gallery.theme} dark sidebar sits on app canvas`).toBeLessThanOrEqual(1)
      } else {
        expect(relativeLuminance(chatColor), `${gallery.theme} light chat surface should be lighter than sidebar`).toBeGreaterThan(relativeLuminance(sidebarColor))
      }
      expect(colorDistance(tabBarColor, chatColor), `${gallery.theme} tabbar belongs to chat panel`).toBeLessThanOrEqual(1)
      expect(colorDistance(tabBarColor, sidebarColor), `${gallery.theme} tabbar differs from sidebar`).toBeGreaterThanOrEqual(6)
    }
  })
})
