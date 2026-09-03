import { settingsRouter, type AppSettings, type GetSettingsResponse } from '@shared/ipc/settings'
import { themesRouter, type ApplyThemeResponse } from '@shared/ipc/themes'
import { IPC_CHANNELS } from '@shared/ipc/channels'

/**
 * 主题取数与**两个**产地之间的那一层端口 —— 与 `data/sessions-port.ts`
 * 同一形状、同一理由:theme-source 的全部判据(当前主题怎么判、变量怎么贴、
 * 没连上时不打标记)都是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,
 * 测试用 `configureThemePort` 换成假的。
 *
 * 形状是**契约的子集**,不是新契约。五个方法,两个产地:
 *  - 经 core(`@onething/client`):`settingsRouter.getSettings`、
 *    `themesRouter.apply`、推送面上的 `settings:changed`;
 *  - **不经 core**(`platform/host.ts`,方案 §4.3):`systemTheme()` 与
 *    `onSystemThemeChanged()` —— 系统明暗是一条 `prefers-color-scheme` 的
 *    matchMedia,一个字节的网都不碰。从前它借道 Vue 渲染层那份 platform 的 web
 *    实现(`settingsApi.getSystemTheme` 在 `environment === 'web'` 那一支读的也是
 *    matchMedia),**行为逐字未变**,只是换了个住处。
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
 * 真实现是**惰性**建的,理由与 sessions-port 逐字相同:它要的是那个连通之后
 * 才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 *
 * ## 推送面的实情(勘察结论,D2)
 *
 * 新壳从来只走 HTTP/SSE 那一面(它的 preload 只暴露 `onethingHost`),
 * C1 起那一面就是 `@onething/client` 本身。于是:
 *
 *  - `onSystemThemeChanged` —— 一条 `prefers-color-scheme` 的 matchMedia 监听,
 *    住在壳自己的 `platform/host.ts`。系统换明暗即时重 apply。
 *  - `onSettingsChanged` —— D2 勘察时它还是一条 `() => () => {}` 的空桩,于是
 *    「有人在旧壳里改了主题」这件事新壳听不见。**共享层读侧补齐 E 批把它补成了
 *    真订阅**:server 把设置变更作为一条具名 SSE 事件下发(骑既有的
 *    `GET /api/events`,不新开路由、不新开通道),载荷是脱敏过的整份设置。
 *    H 批把它接上 —— theme-source 订这条流、重判 `decideTheme`、变了才重贴。
 *    `refreshThemeFromSettings()` 留任:它现在是**手动**重判口(新壳自己的设置页
 *    改完设置后可以直接调,不必等一趟推送回来)。
 */
async function realPort(): Promise<ThemePort> {
  const [{ onethingClient, whenConnected }, host] = await Promise.all([
    import('../platform/connection'),
    import('../platform/host'),
  ])
  const client = await onethingClient()
  const settingsApi = client.api(settingsRouter)
  const themesApi = client.api(themesRouter)
  return {
    ready: () => whenConnected(),
    getSettings: () => settingsApi.getSettings({}),
    // 不经 core:与从前 web 实现那一支逐字同一句 matchMedia(见文件头)。
    getSystemTheme: async () => ({ success: true, theme: host.systemTheme() }),
    applyTheme: (themeId, mode) => themesApi.apply({ themeId, mode }),
    onSystemThemeChanged: (callback) => host.onSystemThemeChanged(callback),
    onSettingsChanged: (callback) => client.events.on(IPC_CHANNELS.SETTINGS_CHANGED, callback),
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
