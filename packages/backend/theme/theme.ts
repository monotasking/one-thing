/**
 * Theme Manager
 * Central management for themes: loading, caching, resolving, and applying
 *
 * theme —— 主题:内置与用户自带主题的加载、缓存、解析成 CSS 变量,以及应用一套主题。
 * 主题管理器(加载、列表、应用)住在 `theme-catalog.ts`,这只入口只转交;另外从兄弟文件交出三类东西:
 * - 主题的形状(`Theme` / `ThemeMeta` 与开给界面的几个响应形状);
 * - 插件主题覆盖要用的令牌判据(哪些令牌可覆盖、高亮别名、令牌对应的 CSS 变量)与调节旋钮;
 * - 插件皮肤的档位与变量表。
 * 依赖 storage、logging。
 */

export type {
  ApplyThemeResponse,
  Base46Theme,
  GetThemeResponse,
  GetThemesResponse,
  RefreshThemesResponse,
  Theme,
  ThemeMeta,
  ThemesFolderPathResponse,
} from './theme-types.js'

// 插件主题覆盖与皮肤用到的令牌判据、调节旋钮、皮肤档位。
export {
  canonicalHighlightToken,
  isHighlightAliasToken,
  isThemeTokenOverridable,
  themeTokenCssVariables,
} from './theme-css-mapper.js'
export { isThemeKnobVar, resolveThemeKnobValue, themeKnobType } from './theme-knobs.js'
export { generateSkinVariables, isSkinKnob, isSkinTier, SKIN_TIER_VALUES, SKIN_VAR_MAP } from './theme-skin.js'
export type { SkinKnob } from './theme-skin.js'

// 主题目录:加载、缓存、列表与应用(2026-10-04 起住在 `theme-catalog.ts`,入口只转交)。
export {
  DEFAULT_THEME_ID,
  applyTheme,
  getTheme,
  getThemeBackgroundColor,
  getThemeList,
  getThemesFolderPath,
  initializeThemes,
  loadCustomThemes,
  refreshThemes,
  sanitizeThemeTokenOverrides,
} from './theme-catalog.js'
