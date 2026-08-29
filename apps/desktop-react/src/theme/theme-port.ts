import type { AppSettings, GetSettingsResponse } from '@shared/ipc/settings'
import type { ApplyThemeResponse } from '@shared/ipc/themes'

/**
 * 主题取数与 `@renderer/platform` 之间的那一层**端口** —— 与
 * `data/sessions-port.ts` 同一形状、同一理由:theme-source 的全部判据
 * (当前主题怎么判、变量怎么贴、没连上时不打标记)都是纯逻辑,
 * 不该为了测它去起一台 core。真实现是下面那一个,测试用
 * `configureThemePort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:四个方法逐条对应
 * `settingsApi.getSettings / getSystemTheme`、`themesApi.apply` 与
 * `platformApi.onSystemThemeChanged`,一个字段都没有多。
 */
export interface ThemePort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  getSettings(): Promise<GetSettingsResponse>
  getSystemTheme(): Promise<{ success: boolean; theme?: 'light' | 'dark'; error?: string }>
  applyTheme(themeId: string, mode: 'dark' | 'light'): Promise<ApplyThemeResponse>
  /** 系统明暗变化的推送面。返回退订函数。 */
  onSystemThemeChanged(callback: (theme: 'light' | 'dark') => void): () => void
}

let port: ThemePort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureThemePort(next: ThemePort | undefined): void {
  port = next
}

/**
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:`@renderer/platform`
 * 在模块顶层就会去摸 `window`,而端口被换掉的测试根本不该把它拖进来。
 *
 * ## 推送面的实情(勘察结论,D2)
 *
 * 新壳跑的是 `@renderer/platform` 的 **web** 实现(它的判据是
 * `window.electronAPI` 在不在场,而新壳的 preload 只暴露 `onethingHost`)。于是:
 *
 *  - `onSystemThemeChanged` —— web 实现就是一条 `prefers-color-scheme` 的
 *    matchMedia 监听,**在新壳里真的工作**。系统换明暗即时重 apply。
 *  - `onSettingsChanged` —— web 实现是一条 `() => () => {}` 的空桩(那是 Electron
 *    独有的推送)。**所以「有人在旧壳里改了主题」这件事,新壳今天听不见**;
 *    补法是给 HTTP 面开一条设置变更推送,那要动共享层,不在本批。留了
 *    `refreshThemeFromSettings()` 作为手动重判口,将来新壳自己的设置页直接调它。
 */
async function realPort(): Promise<ThemePort> {
  const [{ platformApi }, { themesApi }, { settingsApi }, { whenConnected }] = await Promise.all([
    import('@renderer/platform'),
    import('@renderer/platform/themes-client'),
    import('@renderer/platform/settings-client'),
    import('../platform/connection'),
  ])
  return {
    ready: () => whenConnected(),
    getSettings: () => settingsApi.getSettings(),
    getSystemTheme: () => settingsApi.getSystemTheme(),
    applyTheme: (themeId, mode) => themesApi.apply({ themeId, mode }),
    onSystemThemeChanged: (callback) => platformApi.onSystemThemeChanged(callback),
  }
}

let pending: Promise<ThemePort> | undefined

export function themePort(): Promise<ThemePort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}

/** 只为让判据函数的入参有名字 —— 不是新契约。 */
export type ThemePreference = Pick<AppSettings, 'theme'> & {
  general?: AppSettings['general']
}
