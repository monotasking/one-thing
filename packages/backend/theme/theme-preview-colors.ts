// 主题的预览色(从 `theme-resolver.ts` 拆出,拆分批 1,D226):主题列表里那几块小色样从解析结果里怎么挑。
import type { ColorValue, Theme } from './theme-types.js'
import { resolveTheme } from './theme-resolver.js'
import { resolveThemeUI } from './theme-ui-styles.js'

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
