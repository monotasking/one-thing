/**
 * Theme Manager
 * Central management for themes: loading, caching, resolving, and applying
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { Theme, ThemeMeta, Base46Theme } from './types.js'
import {
  extractPreviewColors,
  resolveTheme,
  resolveThemeColorScaleDiagnostics,
  resolveThemeHighlights,
  resolveThemeUI,
} from './resolver.js'
import {
  generateCSSVariables,
  isThemeTokenOverridable,
  pickHighlightTokenOverrides,
} from './css-mapper.js'
import { generateSkinVariables } from './skin.js'
import { parseBase46Lua, convertBase46ToTheme } from './base46-parser.js'
import type { ThemeDebugData } from './theme-debug.js'
import { getOnethingStorePath } from '../storage/paths.js'

import { getLogger } from '../logging/index.js'

const log = getLogger('themes')

export type {
  ApplyThemeResponse,
  Base46Theme,
  GetThemeResponse,
  GetThemesResponse,
  OpenThemesFolderResponse,
  RefreshThemesResponse,
  Theme,
  ThemeFolderOpener,
  ThemeMeta,
} from './types.js'
export * from './window-theme.js'

// Import built-in themes (using 'with' for Node.js 25+ compatibility)
import flexokiTheme from './builtin/flexoki.json' with { type: 'json' }
import draculaTheme from './builtin/dracula.json' with { type: 'json' }
import nordTheme from './builtin/nord.json' with { type: 'json' }
import tokyoNightTheme from './builtin/tokyo-night.json' with { type: 'json' }
import catppuccinTheme from './builtin/catppuccin.json' with { type: 'json' }
// New themes
import catppuccinLatteTheme from './builtin/catppuccin-latte.json' with { type: 'json' }
import solarizedLightTheme from './builtin/solarized-light.json' with { type: 'json' }
import solarizedDarkTheme from './builtin/solarized-dark.json' with { type: 'json' }
import gruvboxLightTheme from './builtin/gruvbox-light.json' with { type: 'json' }
import gruvboxDarkTheme from './builtin/gruvbox-dark.json' with { type: 'json' }
import oneLightTheme from './builtin/one-light.json' with { type: 'json' }
import oneDarkTheme from './builtin/one-dark.json' with { type: 'json' }
import githubLightTheme from './builtin/github-light.json' with { type: 'json' }
import githubDarkTheme from './builtin/github-dark.json' with { type: 'json' }
import rosePineTheme from './builtin/rose-pine.json' with { type: 'json' }
import paperInkTheme from './builtin/paper-ink.json' with { type: 'json' }
import afterRainRainbowTheme from './builtin/after-rain-rainbow.json' with { type: 'json' }
import afterRainNightTheme from './builtin/after-rain-night.json' with { type: 'json' }

// Theme caches
const builtinThemeMap = new Map<string, Theme>()
const customThemeMap = new Map<string, Theme>()

// Default theme ID
export const DEFAULT_THEME_ID = 'flexoki'

/**
 * Get the themes directory paths
 */
function getThemeDirs(): string[] {
  const homePath = os.homedir()

  return [
    // App data themes directory
    path.join(homePath, '.onething', 'themes'),
  ]
}

/**
 * Get project-specific themes directory
 */
function getProjectThemeDir(projectPath?: string): string | null {
  if (!projectPath) return null
  return path.join(projectPath, '.start-electron', 'themes')
}

/**
 * Initialize built-in themes
 */
export function initializeThemes(): void {
  const builtinThemes: Theme[] = [
    flexokiTheme as Theme,
    draculaTheme as Theme,
    nordTheme as Theme,
    tokyoNightTheme as Theme,
    catppuccinTheme as Theme,
    // New themes
    catppuccinLatteTheme as Theme,
    solarizedLightTheme as Theme,
    solarizedDarkTheme as Theme,
    gruvboxLightTheme as Theme,
    gruvboxDarkTheme as Theme,
    oneLightTheme as Theme,
    oneDarkTheme as Theme,
    githubLightTheme as Theme,
    githubDarkTheme as Theme,
    rosePineTheme as Theme,
    paperInkTheme as Theme,
    afterRainRainbowTheme as Theme,
    afterRainNightTheme as Theme,
  ]

  for (const theme of builtinThemes) {
    theme.source = 'builtin'
    builtinThemeMap.set(theme.id, theme)
  }

  log.info('builtin themes initialized', { count: builtinThemeMap.size, ids: builtinThemes.map(t => t.id) })
}

/**
 * Load a single theme file (JSON or Lua)
 */
function loadThemeFile(filePath: string, source: 'user' | 'project'): Theme | null {
  try {
    const ext = path.extname(filePath).toLowerCase()
    const fileName = path.basename(filePath, ext)

    if (ext === '.json') {
      // JSON theme file
      const content = fs.readFileSync(filePath, 'utf-8')
      const theme = JSON.parse(content) as Theme

      // Validate required fields
      if (!theme.id || !theme.name || !theme.theme) {
        log.warn('invalid json theme file', { filePath })
        return null
      }

      theme.source = source
      theme.filePath = filePath
      return theme

    } else if (ext === '.lua') {
      // Base46 Lua theme file
      const content = fs.readFileSync(filePath, 'utf-8')
      const base46Theme = parseBase46Lua(content)

      if (!base46Theme) {
        log.warn('base46 theme parse failed', { filePath })
        return null
      }

      // Convert Base46 to our theme format
      const theme = convertBase46ToTheme(base46Theme, fileName)
      theme.source = source
      theme.filePath = filePath
      return theme
    }

    return null
  } catch (err) {
    log.error('theme file load failed', { filePath }, err)
    return null
  }
}

/**
 * Load custom themes from filesystem
 */
export function loadCustomThemes(projectPath?: string): void {
  customThemeMap.clear()

  const dirs = [
    ...getThemeDirs(),
    getProjectThemeDir(projectPath),
  ].filter((dir): dir is string => dir !== null)

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      // Create directory if it doesn't exist (for user convenience)
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        continue
      }
    }

    const source = dir.includes('.start-electron') ? 'project' : 'user'

    try {
      const files = fs.readdirSync(dir).filter(
        f => f.endsWith('.json') || f.endsWith('.lua')
      )

      for (const file of files) {
        const filePath = path.join(dir, file)
        const theme = loadThemeFile(filePath, source)

        if (theme) {
          customThemeMap.set(theme.id, theme)
        }
      }
    } catch (err) {
      log.error('themes directory read failed', { dir }, err)
    }
  }

  if (customThemeMap.size > 0) {
    log.info('custom themes loaded', { count: customThemeMap.size, ids: Array.from(customThemeMap.keys()) })
  }
}

/**
 * Detect the color scheme support of a theme
 * Priority: explicit colorScheme > auto-detect from variants > default 'dark'
 */
function detectColorScheme(theme: Theme): 'dark' | 'light' | 'both' {
  // 1. Use explicit colorScheme if declared
  if (theme.colorScheme) {
    return theme.colorScheme
  }

  // 2. Check if bg.app has dark/light variants (most reliable indicator)
  const bgApp = theme.theme.bg?.app
  if (typeof bgApp === 'object' && bgApp !== null && 'dark' in bgApp && 'light' in bgApp) {
    return 'both'
  }

  // 3. Check if the first def value has dark/light variants
  // This catches themes like Flexoki where defs define base colors with variants
  if (theme.defs) {
    const firstDefValue = Object.values(theme.defs)[0]
    if (typeof firstDefValue === 'object' && firstDefValue !== null &&
        'dark' in firstDefValue && 'light' in firstDefValue) {
      return 'both'
    }
  }

  // Default to 'dark' - most themes are dark-first
  return 'dark'
}

/**
 * Get list of all available themes
 */
export function getThemeList(): ThemeMeta[] {
  const themes: ThemeMeta[] = []

  // Built-in themes first
  for (const theme of builtinThemeMap.values()) {
    themes.push({
      id: theme.id,
      name: theme.name,
      author: theme.author,
      type: theme.type,
      source: 'builtin',
      colorScheme: detectColorScheme(theme),
      previewColors: extractPreviewColors(theme),
    })
  }

  // Custom themes (may override built-in)
  for (const theme of customThemeMap.values()) {
    const existingIdx = themes.findIndex(t => t.id === theme.id)
    const meta: ThemeMeta = {
      id: theme.id,
      name: theme.name,
      author: theme.author,
      type: theme.type,
      source: theme.source || 'user',
      colorScheme: detectColorScheme(theme),
      previewColors: extractPreviewColors(theme),
    }

    if (existingIdx >= 0) {
      themes[existingIdx] = meta // Override built-in
    } else {
      themes.push(meta)
    }
  }

  return themes
}

/**
 * Get a specific theme by ID
 */
export function getTheme(id: string): Theme | null {
  // Check custom first (allows overriding built-in)
  if (customThemeMap.has(id)) {
    return customThemeMap.get(id)!
  }
  if (builtinThemeMap.has(id)) {
    return builtinThemeMap.get(id)!
  }
  return null
}

/**
 * Get the background color for a theme (for BrowserWindow backgroundColor)
 * This resolves the theme's bg.app color for the given mode
 */
export function getThemeBackgroundColor(
  themeId: string,
  mode: 'dark' | 'light'
): string {
  const theme = getTheme(themeId) || getTheme(DEFAULT_THEME_ID)
  if (!theme) {
    // Ultimate fallback - Flexoki colors
    return mode === 'light' ? '#FFFCF0' : '#282726'
  }

  // Resolve the background color
  const resolvedColors = resolveTheme(theme, mode)
  const bgColor = resolvedColors['bg.app'] || resolvedColors['bg.sidebar']

  // If still no color, use Flexoki defaults
  if (!bgColor) {
    return mode === 'light' ? '#FFFCF0' : '#282726'
  }

  return bgColor
}

/**
 * token 覆盖的键白名单 = 主题系统认得的 token 全集(`CSS_VAR_MAP` ∪ 代码色权威族,
 * 见 `isThemeTokenOverridable`)。
 *
 * 这是**主题系统自己的门**:谁调 `applyTheme` 都塞不进一个主题不认识的键,
 * 也塞不进空值。不另抄一份白名单 —— 抄一份就一定会漂移。
 */
export function sanitizeThemeTokenOverrides(
  tokenOverrides?: Record<string, string>
): Record<string, string> | undefined {
  if (!tokenOverrides) return undefined
  const sanitized: Record<string, string> = {}
  for (const [token, value] of Object.entries(tokenOverrides)) {
    if (!isThemeTokenOverridable(token)) continue
    if (typeof value !== 'string' || !value.trim()) continue
    sanitized[token] = value
  }
  return Object.keys(sanitized).length ? sanitized : undefined
}

/**
 * Apply a theme and get CSS variables
 *
 * `tokenOverrides` 是**参数**,不是事后叠加:它在 `resolveThemeUI` /
 * `generateCSSVariables` 之前落位,ui 语义层、-rgb 变体、primary 色阶都按
 * 覆盖色重新派生。主题系统不知道覆盖是谁给的(插件在装配层,产品层不认识它)。
 */
export function applyTheme(
  themeId: string,
  mode: 'dark' | 'light',
  onDebug?: (data: ThemeDebugData) => void,
  tokenOverrides?: Record<string, string>,
  skinTiers?: Record<string, string>
): Record<string, string> {
  const theme = getTheme(themeId)
  if (!theme) {
    log.warn('theme not found, using default', { themeId, defaultThemeId: DEFAULT_THEME_ID })
    const defaultTheme = getTheme(DEFAULT_THEME_ID)
    if (!defaultTheme) {
      throw new Error(`Default theme ${DEFAULT_THEME_ID} not found`)
    }
    return applyThemeInternal(defaultTheme, mode, DEFAULT_THEME_ID, onDebug, tokenOverrides, skinTiers)
  }

  return applyThemeInternal(theme, mode, themeId, onDebug, tokenOverrides, skinTiers)
}

/**
 * Internal theme application logic
 */
function applyThemeInternal(
  theme: Theme,
  mode: 'dark' | 'light',
  themeId: string,
  onDebug?: (data: ThemeDebugData) => void,
  tokenOverrides?: Record<string, string>,
  skinTiers?: Record<string, string>
): Record<string, string> {
  // Resolve all color references（token 覆盖在语义派生之前落位，见 resolveTheme）
  const sanitizedOverrides = sanitizeThemeTokenOverrides(tokenOverrides)
  const resolvedColors = resolveTheme(theme, mode, sanitizedOverrides)
  const resolvedUI = resolveThemeUI(theme, mode, resolvedColors)
  // 代码色(`syntax.*` / `text.code.*`)必须**再走一遍高亮层**：这批变量由
  // `resolveThemeHighlights` 发出，只写 resolvedColors 会被高亮层原样盖回去
  // （L2 曾经的死键就是这么来的）。递进去的是输入层，护栏在它之后照常重跑。
  const resolvedHighlights = resolveThemeHighlights(
    theme,
    mode,
    resolvedColors,
    resolvedUI['ui.surface.codeBlock'].bg,
    pickHighlightTokenOverrides(sanitizedOverrides)
  )
  const colorScaleDiagnostics = resolveThemeColorScaleDiagnostics(resolvedColors, mode)

  log.debug('neutral text semantics resolved', {
    themeId: theme.id,
    themeName: theme.name,
    mode,
    primaryText: resolvedColors['neutral.primaryText'],
    regularText: resolvedColors['neutral.regularText'],
    secondaryText: resolvedColors['neutral.secondaryText'],
    placeholderText: resolvedColors['neutral.placeholderText'],
    disabledText: resolvedColors['neutral.disabledText'],
  })
  log.debug('primary/status semantics and scales resolved', {
    themeId: theme.id,
    themeName: theme.name,
    mode,
    primary: colorScaleDiagnostics.primary,
    status: colorScaleDiagnostics.status,
  })

  onDebug?.({ themeId, mode, resolvedUI })

  // Map to CSS variables
  const cssVariables = generateCSSVariables(resolvedColors, resolvedHighlights, resolvedUI)

  // 皮肤档位(H3)：和主题变量走同一张出口表，但**来源是 skin 声明，不是 theme
  // token** —— 主题 JSON 里没有、也不会有 radius 字段（“主题不能定义形”那条裁决
  // 没被推翻）；这里是宿主开的枚举档位口，值查 `SKIN_TIER_VALUES` 得到。
  //
  // 合并放在最后是安全的，且**只对皮肤成立**：`--skin-*` 与主题变量名不相交，
  // 没有任何东西从皮肤变量派生。颜色覆盖必须前移到 resolveThemeUI 之前，正是
  // 因为反过来 —— 派生层整片挂在颜色上（见 §6.1.1 的差异记录）。
  return { ...cssVariables, ...generateSkinVariables(skinTiers) }
}

/**
 * Get the themes folder path (for "Open Themes Folder" button)
 */
export function getThemesFolderPath(): string {
  // §16.22:与 theme-runtime 的调试落点同一条纪律 —— app 层路径一律经 store 口。
  // 这一句还会 mkdir,直拼就意味着任何指了别处 store 的进程照样在用户真机库里
  // 建目录。
  const themesPath = path.join(getOnethingStorePath(), 'themes')

  // Ensure directory exists
  if (!fs.existsSync(themesPath)) {
    fs.mkdirSync(themesPath, { recursive: true })
  }

  return themesPath
}

/**
 * Refresh themes (reload from filesystem)
 */
export function refreshThemes(projectPath?: string): ThemeMeta[] {
  loadCustomThemes(projectPath)
  return getThemeList()
}
