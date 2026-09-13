import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'
import { themesRouter, type GetThemesResponse } from '@shared/ipc/themes'
import { IPC_CHANNELS } from '@shared/ipc/channels'

/**
 * 设置页「外观 · 主题」那一节与 core 之间的那一层**端口**(2026-09-13)。
 *
 * 判例与 `browser-settings-port` / `permission-grants-port` 逐条相同:形状是
 * **平台调用面的子集**,不是新契约(五口各自对应 `settingsApi.getSettings` /
 * `settingsApi.saveSettings` / `themesApi.getAll` / 推送面上的 `settings:changed`,
 * 一个字段都没多),存在的唯一理由是**可测** —— 这一节的全部判据(按明暗过滤
 * 主题表、当前 id 不在表里怎么办、三格各自怎么合进整份设置)都是纯逻辑,不该
 * 为了测它去起一台 core。
 *
 * ── 为什么不挂到 `theme/theme-port.ts` 上 ────────────────────────────────
 * 那条端口是**颜色来源**那条链的口:读设置 + 读系统明暗 + `themes.apply` 贴表。
 * 这一节要的是**设置页那一格**:读设置、写设置、列出可选主题。两条端口各有一口
 * 读设置,是**同一个平台调用面被两个数据源各用了一次**,不是两份契约(与
 * `browser-settings-port` 文件头那一段逐字同一条判据)。
 *
 * ── 整份写回是这条路唯一的形状 ────────────────────────────────────────────
 * `settings.saveSettings` 收的是整份 `AppSettings`,所以三条写路一律
 * 「**当场读一份新的** → 合并一格 → 整份写回」——不拿缓存里那份当底本(它可能
 * 已经旧了,写回去等于把别人刚改的那一格抹掉)。
 */
export interface ThemeSettingsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 整份应用设置。这一节要 `theme` 与 `general.{light,dark}ThemeId` 三格。 */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见文件头。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  /** 可选主题名册(`themesRouter.getAll`,无参按本仓惯例递 `{}`)。 */
  listThemes(): Promise<GetThemesResponse>
  /**
   * 设置变更的推送面(与 `theme/theme-port.ts` **同一条** `settings:changed`)。
   *
   * 别的客户端 / 别的面改了主题,这一节要跟着变 —— 收到就 `invalidate()`,
   * 让 query 自己回后台对一次账。不直接拿载荷当新值:那一份是脱敏过的整份设置,
   * 而这一节的屏幕形状还要配上主题名册,两半合成只该有一个产地(投影函数)。
   *
   * 返回退订函数。
   */
  onSettingsChanged(callback: () => void): () => void
}

let port: ThemeSettingsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureThemeSettingsPort(next: ThemeSettingsPort | undefined): void {
  port = next
  pending = undefined
}

/**
 * 真实现是**惰性**建的,理由与 `browser-settings-port` 逐字相同:它要的是那个
 * 连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<ThemeSettingsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const settingsApi = client.api(settingsRouter)
  const themesApi = client.api(themesRouter)
  return {
    ready: () => whenConnected(),
    readSettings: () => settingsApi.getSettings({}),
    saveSettings: (settings) => settingsApi.saveSettings(settings),
    listThemes: () => themesApi.getAll({}),
    onSettingsChanged: (callback) =>
      client.events.on(IPC_CHANNELS.SETTINGS_CHANGED, () => callback()),
  }
}

let pending: Promise<ThemeSettingsPort> | undefined

export function themeSettingsPort(): Promise<ThemeSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
