import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'

/**
 * 设置页「内置浏览器」那一节与 core 之间的那一层**端口**(B2′)。
 *
 * 判例与 `permission-grants-port` / `provider-settings-port` 逐条相同:形状是
 * **平台调用面的子集**,不是新契约(两条各自对应 `settingsApi.getSettings` /
 * `settingsApi.saveSettings`,一个字段都没多),存在的唯一理由是**可测** ——
 * 这一节的全部判据(CDP 那一格怎么折、MCP 那条装过没有、装的时候写什么)
 * 都是纯逻辑,不该为了测它去起一台 core。
 *
 * ── 为什么不挂到 `provider-settings-port` 上 ──────────────────────────────
 * 那条端口自己的文件头写着同一条理由:它的十七口全是「模型服务」那块面的事,
 * 而这一节要的两口与 provider 毫无关系。两条端口各有一口读设置,是**同一个平台
 * 调用面被两个数据源各用了一次**,不是两份契约。
 *
 * ── 整份写回是这条路唯一的形状(而且它是安全的)────────────────────────────
 * `settings.saveSettings` 收的是整份 `AppSettings`,所以调用方一律
 * 「**当场读一份新的** → 合并一格 → 整份写回」——不拿缓存里那份当底本(它可能
 * 已经旧了,写回去等于把别人刚改的那一格抹掉)。
 *
 * 密钥不会在这条路上丢:壳走 HTTP 面,`getSettings` 交出来的敏感键是哨兵
 * (`sanitizeSettingsForClient`),而 `saveSettings` 那一侧的
 * `mergeServerSettingsUpdate` 会拿当前真值把哨兵补回去。**但这只对哨兵成立** ——
 * 真要写一把密钥仍然走凭证域(`provider-settings-port` 的 ② 那条判例)。
 */
export interface BrowserSettingsPort {
  /** 传输面就绪(D0 的 whenConnected);浏览器直开时它也会 resolve。 */
  ready(): Promise<unknown>
  /** 整份应用设置。这一节要 `browser.cdp` 与 `mcp.servers` 两格。 */
  readSettings(): Promise<GetSettingsResponse>
  /** 整份写回。见文件头。 */
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
}

let port: BrowserSettingsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureBrowserSettingsPort(next: BrowserSettingsPort | undefined): void {
  port = next
  pending = undefined
}

/**
 * 真实现是**惰性**建的,理由与 `permission-grants-port` 逐字相同:它要的是那个
 * 连通之后才存在的客户端,而端口被换掉的测试根本不该把连通面拖进来。
 */
async function realPort(): Promise<BrowserSettingsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const api = client.api(settingsRouter)
  return {
    ready: () => whenConnected(),
    readSettings: () => api.getSettings({}),
    saveSettings: (settings) => api.saveSettings(settings),
  }
}

let pending: Promise<BrowserSettingsPort> | undefined

export function browserSettingsPort(): Promise<BrowserSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
