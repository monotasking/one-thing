/**
 * settings(应用设置)域 —— 结构债 P4c 第十一批,四条数据面整只从手写 IPC 通道
 * 搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/settings/ipc-host.ts` 那只裸 `ipcMain.handle` 工厂上的四条
 *    (`settings:get` / `settings:save` / `settings:get-system-theme` /
 *    `network:test-proxy`)与 `@main/ipc/settings.ts` 的壳适配;
 *  - `preload/bridge.ts` 的四条包装与 `platform/web.ts` 的四条 REST 镜像;
 *  - `server/http.ts` 的 `GET|POST /api/settings` + `POST /api/network/test-proxy`
 *    三条路由,以及 `server/runtime.ts` 的 `settings` / `network` 两格 facade
 *    adapter。
 *
 * **两条不在这里**(C:要 Electron 本体):`OPEN_SETTINGS_WINDOW`(BrowserWindow)
 * 与 `SHOW_OPEN_DIALOG`(原生对话框)留在宿主 —— 后者渲染侧有 21 个调用点,是
 * 全仓最高的一条,签名一个字没动。
 *
 * ## 一份设置(拍板 #20,同 mcp / oauth / agents / models / skills 判例)
 *
 * 旧 server 在 `settings` adapter 背后另开一本 per-owner 的设置账
 * (`settingsByOwner` + `ServerSettingsStore`),而桌面读写的是装配层那只
 * `stores/settings.ts` 单例。同一个 store 两本设置账,等于把「我改没改过设置」
 * 分叉;更要命的是 P4c 第六批之后 mcp 域的写面已经落在**单例**上,于是「从浏览器
 * 加一台 MCP server」写的是单例、`GET /api/settings` 读的是 owner 缓存 —— 已经
 * 自相矛盾。搬家取的是单例这一边:web 与桌面从此读同一本 `<store>/settings.json`。
 *
 * ## http 上保留的两道真护栏(逐字)
 *
 * 旧 server adapter 比桌面多出来的东西里,有两件是**真的隔离**,原样保留在
 * `transport === 'http'` 这一支上(实现整块搬进 `server/settings-projection.ts`):
 *
 *  1. **出门脱敏**:`apiKey` / `oauthToken` / `accessToken` / `refreshToken` /
 *     `idToken` 与 MCP server 的私密字段换成 `SERVER_REDACTED_SECRET`。桌面不脱敏
 *     —— 它本来就在同一台机器上,脱了反而让设置页读不到自己刚填的值。
 *  2. **回来合并**:客户端交回来的设置若在敏感键上带着哨兵(或干脆没带这个键),
 *     用磁盘上那份真值补齐,于是「只改个主题」不会把凭证洗掉。
 *
 * ## 三件要宿主的事走端口
 *
 * `saveSettings` 的副作用链里有两件只有 Electron 桌面做得到(给 session 与内嵌
 * 浏览器分区套代理、重注册全局快捷键),`getSystemTheme` 要的
 * 「系统当前是不是深色」是第三件。三件都走
 * `wiring/settings/host-ports.ts` 的 `configureSettingsHost`,未注入即安静跳过 ——
 * 于是 server / CLI 上这条链自然退化成「存盘 + 刷 provider 缓存 + 更新 MCP/ACP」,
 * 与迁移前它们根本没有这条通道等价。
 *
 * 网关设置的套用(`applyGatewaySettings`)同样是宿主能力,它复用第八批已经立好的
 * `configureGatewayHost` —— 本批只在那张端口表上多一格 `applySettings`,桌面在
 * `main-process.ts` 里和另外八行一起注入。
 *
 * ## 一条推送走注入端口
 *
 * `SETTINGS_CHANGED` 留在原地(router 没有推送面),改走
 * `wiring/settings/events.ts` 的 `configureSettingsEventBroadcaster`;**排除发起窗
 * 这件事一字未丢** —— 它现在靠 `RpcDispatchContext.callerId`(宿主从
 * `event.sender.id` 铸进来的那一格)。
 * `SYSTEM_THEME_CHANGED` 连端口都不用:它的事件源是系统主题的 updated 事件,
 * 从头到尾只住在宿主里。
 */
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { ACPManager } from '@onething/runtime/acp'
import { MCPManager, registerMCPTools } from '@onething/runtime/mcp/index.wiring'
import {
  getOnethingSettingsForIpc,
  getOnethingSystemThemeForIpc,
  saveOnethingSettingsWithRuntimeEffectsForIpc,
} from '@onething/runtime/settings'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import type { AppSettings, SaveSettingsRequest } from '@shared/ipc/settings.js'
import { settingsRouter, type SettingsRoutes } from '@shared/ipc/settings.js'
import {
  mergeServerSettingsUpdate,
  sanitizeSettingsForClient,
} from '../../server/settings-projection.js'
import { invalidateProviderCache } from '../../wiring/providers/registry.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { getGatewayHost } from '../../wiring/gateway/host-ports.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { broadcastSettingsChanged } from '../../wiring/settings/events.js'
import {
  applyHostNetworkProxySettings,
  hostShouldUseDarkColors,
  registerHostGlobalWindowShortcuts,
} from '../../wiring/settings/host-ports.js'
import { testOnethingProxy } from '../../wiring/settings/proxy.js'
import { getVoiceServiceSafe } from '../../wiring/voice/service.js'
import { startTodoPlanWatcher } from '../../wiring/todo-plan/store.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.settings')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog = consolePort(log)

/** 只有网络那一侧要脱敏 —— 桌面读的是自己刚填进去的值。 */
function isRemoteCaller(context: RpcDispatchContext): boolean {
  return context.transport === 'http'
}

async function saveSettingsFromRpc(
  incoming: SaveSettingsRequest,
  context: RpcDispatchContext,
) {
  // http 上客户端交回来的是**脱敏过的**那份;先把真值补齐再进副作用链,
  // 否则「只改个主题」会把凭证洗成哨兵字符串。
  const settingsToSave = isRemoteCaller(context)
    ? (mergeServerSettingsUpdate(getSettings(), incoming) as SaveSettingsRequest)
    : incoming

  const result = await saveOnethingSettingsWithRuntimeEffectsForIpc<
    AppSettings,
    SaveSettingsRequest
  >({
    settings: settingsToSave,
    saveSettings: nextSettings => saveSettings(nextSettings),
    getSettings: () => getSettings(),
    invalidateProviderCache,
    applyNetworkProxySettings: proxy => applyHostNetworkProxySettings(proxy),
    registerGlobalWindowShortcuts: () => registerHostGlobalWindowShortcuts(),
    applyVoiceSettings: normalizedSettings =>
      getVoiceServiceSafe()?.applySettings(normalizedSettings),
    updateMCPSettings: nextSettings => MCPManager.updateSettings(nextSettings),
    registerMCPTools,
    updateACPSettings: nextSettings => ACPManager.updateSettings(nextSettings),
    defaultMCPSettings: DEFAULT_MCP_SETTINGS,
    defaultACPSettings: { enabled: true, agents: [] },
    logger: consoleLog,
  })
  if (!result.success) return result
  const normalizedSettings = result.settings

  await getGatewayHost()
    .applySettings(normalizedSettings)
    .catch(error => {
      log.error('apply gateway channel settings failed', undefined, error)
    })

  // The todo directory is a setting; re-point the watcher if it moved. start()
  // is a no-op when the directory is unchanged.
  await startTodoPlanWatcher().catch(error => {
    log.error('todo-plan watcher restart failed', undefined, error)
  })

  // 发起保存的那扇窗不收自己的回声 —— 回灌整份 settings 会冲掉它正在编辑的
  // 草稿。「谁在问」是宿主铸进 dispatch context 的事实(`callerId`),不从信封里读。
  broadcastSettingsChanged(normalizedSettings, { excludeCallerId: context.callerId })

  return isRemoteCaller(context)
    ? { success: true as const, settings: sanitizeSettingsForClient(normalizedSettings) }
    : result
}

export const settingsRpcHandlers: RpcRouteHandlers<SettingsRoutes> = {
  async getSettings(_input, context = DESKTOP_RPC_CONTEXT) {
    const result = await getOnethingSettingsForIpc<AppSettings>({
      getSettings: () => getSettings(),
      logger: consoleLog,
    })
    if (!result.success || !isRemoteCaller(context)) return result
    return { success: true, settings: sanitizeSettingsForClient(result.settings) }
  },
  async saveSettings(input, context = DESKTOP_RPC_CONTEXT) {
    return saveSettingsFromRpc(input, context)
  },
  async getSystemTheme() {
    return getOnethingSystemThemeForIpc(hostShouldUseDarkColors())
  },
  async testProxy(input) {
    return testOnethingProxy(input.proxy)
  },
}

export function registerSettingsRpcDomain(): () => void {
  return registerRouterHandlers(settingsRouter, settingsRpcHandlers)
}
