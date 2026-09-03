/**
 * settings(应用设置)域的渲染侧客户端 —— 结构债 P4c 第十一批。
 *
 * 四条数据面走通用 `rpc:invoke` / `POST /api/rpc`。**两件要 Electron 本体的事
 * 不在这里** —— `openSettingsWindow`(BrowserWindow)与 `showOpenDialog`
 * (原生对话框)仍是 `platformApi` 上的方法;**三条推送也不在这里** ——
 * `onSettingsChanged` / `onSettingsNavigate` / `onSystemThemeChanged` 仍是
 * `platformApi` 上的订阅(router 今天没有推送面)。
 *
 * ## `getSystemTheme` 在 web 上就地作答
 *
 * 唯一一条不走线的:浏览器里「系统」指的是**看的人那台机器**,问服务器等于问错了
 * 机器。所以 web 上就地读 `prefers-color-scheme` —— 与迁移前 `platform/web.ts`
 * 那条桩**逐字相同**(含 `typeof window === 'undefined'` 时的 `'dark'` 兜底,
 * 以及「匹配 light 才算 light,否则 dark」的判法)。Electron 上走 RPC,答案来自
 * 主进程的 `nativeTheme.shouldUseDarkColors`,与迁移前同一个源。
 *
 * `testProxy` 保留旧的位置参数签名(`testProxy(proxy)`),调用点零改动;
 * 结构化克隆那一下也留着 —— 从前是 preload 包装在做(`JSON.parse(JSON.stringify)`),
 * 现在由这里做,免得 Pinia 的响应式 Proxy 过不了线。
 */
import type { AppSettings, ProxySettings } from '@shared/ipc/settings.js'
import { settingsRouter } from '@shared/ipc/settings.js'
import { platformApi } from './index'
import { clientApi } from './client'

const settings = clientApi(settingsRouter)

/** 迁移前 `platform/web.ts` 的 `getPreferredColorScheme`,逐字。 */
function preferredColorScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export const settingsApi = {
  getSettings: () => settings.getSettings({}),
  saveSettings: (next: AppSettings) => settings.saveSettings(next),
  getSystemTheme: () =>
    platformApi.environment === 'web'
      ? Promise.resolve({ success: true, theme: preferredColorScheme() })
      : settings.getSystemTheme({}),
  testProxy: (proxy: ProxySettings) =>
    settings.testProxy({ proxy: JSON.parse(JSON.stringify(proxy)) as ProxySettings }),
}
