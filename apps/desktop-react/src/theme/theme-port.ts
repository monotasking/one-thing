import type { AppSettings, GetSettingsResponse } from '@shared/ipc/settings'
import type { ApplyThemeResponse } from '@shared/ipc/themes'

/**
 * 主题取数与 `@renderer/platform` 之间的那一层**端口** —— 与
 * `data/sessions-port.ts` 同一形状、同一理由:theme-source 的全部判据
 * (当前主题怎么判、变量怎么贴、没连上时不打标记)都是纯逻辑,
 * 不该为了测它去起一台 core。真实现是下面那一个,测试用
 * `configureThemePort` 换成假的。
 *
 * 形状是**平台调用面的子集**,不是新契约:五个方法逐条对应
 * `settingsApi.getSettings / getSystemTheme`、`themesApi.apply` 与
 * `platformApi.onSystemThemeChanged / onSettingsChanged`,一个字段都没有多。
 */
export interface ThemePort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  getSettings(): Promise<GetSettingsResponse>
  getSystemTheme(): Promise<{ success: boolean; theme?: 'light' | 'dark'; error?: string }>
  applyTheme(themeId: string, mode: 'dark' | 'light'): Promise<ApplyThemeResponse>
  /** 系统明暗变化的推送面。返回退订函数。 */
  onSystemThemeChanged(callback: (theme: 'light' | 'dark') => void): () => void
  /**
   * 设置变更的推送面(共享层读侧补齐 E 批开的)。返回退订函数。
   *
   * 载荷是**脱敏过的整份设置** —— 与 `getSettings` 在同一道 Bearer 闸后交出去的
   * 逐字同形,所以拿到它就够重判,不必再回问一趟。
   */
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void
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
 *  - `onSettingsChanged` —— D2 勘察时它还是一条 `() => () => {}` 的空桩,于是
 *    「有人在旧壳里改了主题」这件事新壳听不见。**共享层读侧补齐 E 批把它补成了
 *    真订阅**:server 把设置变更作为一条具名 SSE 事件下发(骑既有的
 *    `GET /api/events`,不新开路由、不新开通道),载荷是脱敏过的整份设置。
 *    H 批把它接上 —— theme-source 订这条流、重判 `decideTheme`、变了才重贴。
 *    `refreshThemeFromSettings()` 留任:它现在是**手动**重判口(新壳自己的设置页
 *    改完设置后可以直接调,不必等一趟推送回来)。
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
    onSettingsChanged: (callback) => platformApi.onSettingsChanged(callback),
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
