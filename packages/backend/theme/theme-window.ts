export type OnethingThemeMode = 'dark' | 'light'
export type OnethingThemePreference = OnethingThemeMode | 'system'

export interface OnethingWindowThemeGeneralSettings {
  themeId?: string
  darkThemeId?: string
  lightThemeId?: string
  colorTheme?: string
}

export interface OnethingWindowThemeDefaults {
  themeId?: string
  darkThemeId?: string
  lightThemeId?: string
  colorTheme?: string
}

export interface ResolveOnethingWindowThemeSelectionInput {
  theme: OnethingThemePreference
  general?: OnethingWindowThemeGeneralSettings
  defaults: OnethingWindowThemeDefaults
  systemShouldUseDarkColors: boolean
}

export interface OnethingWindowThemeSelection {
  mode: OnethingThemeMode
  themeId: string
  colorTheme: string
}

const FALLBACK_THEME_ID = 'flexoki'
const FALLBACK_COLOR_THEME = 'blue'

export function resolveOnethingThemeMode(
  theme: OnethingThemePreference,
  systemShouldUseDarkColors: boolean,
): OnethingThemeMode {
  if (theme === 'system') return systemShouldUseDarkColors ? 'dark' : 'light'
  return theme === 'light' ? 'light' : 'dark'
}

export function resolveOnethingWindowThemeSelection(
  input: ResolveOnethingWindowThemeSelectionInput,
): OnethingWindowThemeSelection {
  const mode = resolveOnethingThemeMode(input.theme, input.systemShouldUseDarkColors)
  const generalModeThemeId = mode === 'dark'
    ? input.general?.darkThemeId
    : input.general?.lightThemeId
  const defaultModeThemeId = mode === 'dark'
    ? input.defaults.darkThemeId
    : input.defaults.lightThemeId

  return {
    mode,
    themeId: generalModeThemeId || input.general?.themeId || defaultModeThemeId || input.defaults.themeId || FALLBACK_THEME_ID,
    colorTheme: input.general?.colorTheme || input.defaults.colorTheme || FALLBACK_COLOR_THEME,
  }
}
