import { DEFAULT_THEME_ID } from '../theme/theme-source'
import type { AppSettings } from '@shared/ipc/settings'
import type { ThemeMeta } from '@shared/ipc/themes'

/**
 * 设置页「外观 · 主题」那一节的**纯函数半边**(2026-09-13)。
 *
 * 与 `browser-settings-source` 里那四只名册纯函数同一条判据:投影与合并都是
 * 「线上形状 ⇄ 屏幕形状」的翻译,没有一件需要起一台 core 才测得了。写路住在
 * `theme-settings-source.ts`,这里一格 I/O 都没有。
 */

/** 明暗三档。值即 `AppSettings.theme`,不另起一套枚举。 */
export type ThemeMode = AppSettings['theme']

/** 屏幕上那一节要的形状。 */
export interface ThemeSettingsView {
  /** `settings.theme` —— 跟随系统 / 浅色 / 深色。 */
  mode: ThemeMode
  /** `general.lightThemeId`,缺席兜底 `DEFAULT_THEME_ID`。 */
  lightThemeId: string
  /** `general.darkThemeId`,同上。 */
  darkThemeId: string
  /** `themes.getAll` 交回来的整张名册(过滤在 `themesFor`,不在这里)。 */
  themes: ThemeMeta[]
}

/**
 * 整份设置 + 主题名册 → 这一节要的四格。
 *
 * 兜底 id 与 `theme/theme-source.ts` 的判据**同源**(那只常量就是从那儿导出的)
 * —— 屏幕上显示的「当前是哪套主题」必须与真正贴上去的那一套是同一句话,否则
 * 用户会看见一格选中的主题而屏幕上是另一套。
 */
export function projectThemeSettings(
  settings: Pick<AppSettings, 'theme' | 'general'>,
  themes: readonly ThemeMeta[],
): ThemeSettingsView {
  return {
    mode: settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system',
    lightThemeId: settings.general?.lightThemeId || DEFAULT_THEME_ID,
    darkThemeId: settings.general?.darkThemeId || DEFAULT_THEME_ID,
    themes: [...themes],
  }
}

/**
 * 这一档明暗下可选的那几套主题。
 *
 * 判据是主题自述的 `colorScheme`(`'both'` 两档都算),**不是名字**。
 *
 * ── 当前选中的 id 不在过滤结果里时,把它补进末尾 ──────────────────────────
 * 三种真会发生的情形:主题被卸载了、`darkThemeId` 指着一套只有浅色的主题、
 * 名册这一趟没拉到。三种的共同点是**那一格仍然是用户的选择**,而一个找不到
 * 当前项的 `Select` 画出来是一格空白 —— 屏幕上那一行于是说「你没选过主题」,
 * 那是假话。补进去之后它至少说得出「你选的是 xxx(这一档里它不在名册上)」。
 *
 * 补进来的那一行名字就是 id 本身:名册里没有它,我们不知道它叫什么,
 * 编一个显示名比把 id 摆出来更糟。
 */
export function themesFor(
  themes: readonly ThemeMeta[],
  mode: 'light' | 'dark',
  current?: string,
): ThemeMeta[] {
  const rows = themes.filter((row) => row.colorScheme === mode || row.colorScheme === 'both')
  if (!current || rows.some((row) => row.id === current)) return rows
  return [...rows, { id: current, name: current, type: 'full', source: 'user', colorScheme: mode }]
}

/**
 * 三只合并函数:**只动自己那一格**,整份设置的别的字段逐字不变。
 *
 * `general` 缺席时不能写成 `{ lightThemeId }` 一格 —— 契约上 `general` 是必填的
 * 一整段,那样写等于把 `colorTheme` / `animationSpeed` 等一并抹掉。所以一律
 * 「摊开原来那份再盖一格」;原来那份压根不在(老 store / 被手改过的
 * `settings.json`)时摊开 `undefined` 是空对象,剩下的字段由后端归一补回。
 */
export function patchThemeMode(settings: AppSettings, mode: ThemeMode): AppSettings {
  return { ...settings, theme: mode }
}

export function patchLightTheme(settings: AppSettings, lightThemeId: string): AppSettings {
  return { ...settings, general: { ...settings.general, lightThemeId } }
}

export function patchDarkTheme(settings: AppSettings, darkThemeId: string): AppSettings {
  return { ...settings, general: { ...settings.general, darkThemeId } }
}
