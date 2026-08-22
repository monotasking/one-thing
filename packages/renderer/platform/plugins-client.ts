/**
 * plugins 域的渲染侧客户端 —— 结构债 P4 终态批 C2。
 *
 * 形状照 `music-client.ts` / `interaction-client.ts` / `evals-client.ts` 的判例:
 * 壳外一个模块 + 通用 `platformApi.rpcInvoke`,四壳零改动。**两条推送不在这里**
 * —— `onPluginNotification` / `onPluginRequestProgress` 仍是 `platformApi` 上的
 * 两条订阅(router 没有推送面)。
 *
 * ## 能力位 `pluginsManage`(#16,web 默认关)
 *
 * 方案 A(插件设计文档 §6)下**插件只在 Electron 桌面宿主执行**:安装要本机
 * npm、配置要写 `<store>/plugins/<id>/config.json`、file-pick 要原生对话框。
 * 迁到通用通道之后这条路技术上通了,按「续做口径」由一颗能力位挡着 ——
 * `platformApi.capabilities.pluginsManage` 在 electron 上为 `true`、web 上为
 * `false`;为 false 时下面十二条**根本不发请求**,而是就地返回与迁移前
 * `platform/web.ts` 那批硬桩**逐字相同**的答案。设置页 / 市场区因此一行判断都
 * 不用加,可感知结果与今天一致。
 *
 * **读面不受这颗位管**(list / enable / disable / refresh / commands /
 * executeCommand / configGet):它们在 web 上本来就打真路由(`/api/plugins*`
 * 与从列表投影派生的只读配置),迁移后打的是同一批闭包 —— 域在
 * `transport === 'http'` 那一支上沿用 server 那本只读镜像目录。
 *
 * **放开 = 一行**:`platform/web.ts` 的 `pluginsManage: false` 改成 `true`
 * (或让它跟着 `/api/capabilities` 走)。
 */
// 叶子路径,不走桶:@onething/core/plugins 的 index 会把 loader(node:url 的
// pathToFileURL)整只拽进浏览器包,Vite externalize 之后运行即炸。
// request-channel.ts 零依赖、纯逻辑,是 renderer 可以吃的最小单元。
import { describeNonSerializable } from '@onething/core/plugins/request-channel'
import { pluginsRouter } from '@shared/ipc/plugins.js'
import type {
  AbortPluginRequestResult,
  CheckPluginUpdatesResponse,
  GetPluginCommandsResponse,
  GetPluginMarketRequest,
  GetPluginMarketResponse,
  InstallPluginRequest,
  InstallPluginResponse,
  ListPluginsResponse,
  PickPluginFileRequest,
  PickPluginFileResponse,
  PluginConfigResponse,
  PluginFootprintResponse,
  PluginLifecycleInfoResponse,
  PluginRequestPayload,
  PluginRequestResult,
  PluginToggleResponse,
  ReadPluginTarballResponse,
  SetPluginConfigResponse,
  UninstallPluginResponse,
  UpdatePluginResponse,
} from '@shared/ipc/plugins.js'
import type { ExecutePluginCommandResponse } from '@/types'
import { platformApi } from './index'
import { createRouterClient } from './router-client'

const plugins = createRouterClient(pluginsRouter, request => platformApi.rpcInvoke(request))

/** 与迁移前 `platform/web.ts` 那批硬桩逐字相同的那几句话。 */
const PLUGINS_READ_ONLY
  = 'Plugins are installed and uninstalled on the desktop host only; this server mirrors the plugin catalog read-only.'
const PLUGINS_INSTALL_DESKTOP_ONLY = 'Plugins are installed on the desktop host only.'
const PLUGINS_UPDATE_DESKTOP_ONLY = 'Plugins are updated on the desktop host only.'
const PLUGINS_TARBALL_DESKTOP_ONLY = 'Plugin tarballs are inspected on the desktop host only.'
const PLUGINS_MARKET_UNAVAILABLE = 'Plugin market is unavailable in the web host'
const PLUGINS_CONFIG_READ_ONLY
  = 'Plugin configuration is editable on the desktop host only; this server mirrors the plugin catalog read-only.'
const PLUGINS_FOOTPRINT_DESKTOP_ONLY = 'Plugin data lives on the desktop host only.'
const PLUGINS_EXECUTE_DESKTOP_ONLY = 'Plugins execute on the desktop host only'
const PLUGINS_FILE_PICK_DESKTOP_ONLY
  = 'Importing files into a plugin works on the desktop app only.'
/** 迁移前那条 501 路由的正文,逐字保留。 */
const PLUGIN_REQUEST_DESKTOP_ONLY
  = 'Plugins execute on the desktop host only; this server mirrors the plugin catalog read-only.'

function canManage(): boolean {
  return platformApi.capabilities.pluginsManage !== false
}

/**
 * 迁移前 `platform/web.ts` 自己生成 requestId 的那一行,逐字保留 ——
 * 随机分量不是装饰:纯时间戳在同毫秒并发下会撞号,而 requestId 是 abort 的
 * 唯一地址。桌面侧由 core 统一生成(带序列号),关着位的那一侧没有那个 registry。
 */
function localRequestId(request: PluginRequestPayload): string {
  return request.requestId
    || `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const pluginsApi = {
  // ── 读面:两个宿主都打真路由 ─────────────────────────────
  getPlugins: (): Promise<ListPluginsResponse> => plugins.list({}),
  enablePlugin: (pluginId: string): Promise<PluginToggleResponse> =>
    plugins.enable({ pluginId }),
  disablePlugin: (pluginId: string): Promise<PluginToggleResponse> =>
    plugins.disable({ pluginId }),
  refreshPlugins: (): Promise<PluginToggleResponse> => plugins.refresh({}),
  getPluginCommands: (): Promise<GetPluginCommandsResponse> => plugins.commands({}),
  executePluginCommand: (
    commandName: string,
    args: string,
    sessionId: string,
  ): Promise<ExecutePluginCommandResponse> =>
    plugins.executeCommand({ commandName, args, sessionId }),
  getPluginConfig: (pluginId: string): Promise<PluginConfigResponse> =>
    plugins.configGet({ pluginId }),

  // ── 写面:由能力位 `pluginsManage` 挡着 ───────────────────
  /**
   * 统一请求通道(R2)。
   *
   * 过线前先自检,失败时抛**我们自己的**错(从 `platform/electron.ts` 原样搬来):
   * R2 的 `assertPluginPayloadSerializable` 只在插件那一侧跑;渲染侧发出去之前
   * 什么也不查,于是一个不可克隆的 payload 得到的是 Electron 原生的
   * "An object could not be cloned" —— 没有 pluginId、没有 action、没有字段路径。
   * 插件作者拿着这句话无从下手(真机走查实证)。
   *
   * 这里**只查不修**:修在源头(渲染层把自己包的 Vue Proxy 拆掉,见
   * PluginPanelHost.toPlainPayload)。边界上静默修复会把"有人在往线上塞不可
   * 序列化的东西"这件事藏起来,而那正是 R2 要立的规矩。
   */
  pluginRequest: (request: PluginRequestPayload): Promise<PluginRequestResult> => {
    if (!canManage()) {
      return Promise.resolve({
        success: false,
        requestId: localRequestId(request),
        error: PLUGIN_REQUEST_DESKTOP_ONLY,
      })
    }
    const problem = describeNonSerializable(request.payload, 'payload')
    if (problem) {
      return Promise.reject(new Error(
        `Plugin request "${request.pluginId}/${request.action}" carries a payload that cannot cross `
        + `the process boundary: ${problem}. Everything that crosses the line must be JSON-serializable.`,
      ))
    }
    return plugins.request(request)
  },
  abortPluginRequest: (requestId: string): Promise<AbortPluginRequestResult> =>
    canManage()
      ? plugins.requestAbort({ requestId })
      : Promise.resolve({ success: false, aborted: false, error: PLUGINS_EXECUTE_DESKTOP_ONLY }),
  setPluginConfig: (
    pluginId: string,
    config: Record<string, unknown>,
  ): Promise<SetPluginConfigResponse> =>
    canManage()
      ? plugins.configSet({ pluginId, config })
      : Promise.resolve({ success: false, error: PLUGINS_CONFIG_READ_ONLY }),
  uninstallPlugin: (pluginId: string): Promise<UninstallPluginResponse> =>
    canManage()
      ? plugins.uninstall({ pluginId })
      : Promise.resolve({ success: false, error: PLUGINS_READ_ONLY }),
  getPluginFootprint: (pluginId: string): Promise<PluginFootprintResponse> =>
    canManage()
      ? plugins.footprint({ pluginId })
      : Promise.resolve({ success: false, error: PLUGINS_FOOTPRINT_DESKTOP_ONLY }),
  installPlugin: (request: InstallPluginRequest): Promise<InstallPluginResponse> =>
    canManage()
      ? plugins.install(request)
      : Promise.resolve({ success: false, error: PLUGINS_INSTALL_DESKTOP_ONLY }),
  updatePlugin: (pluginId: string): Promise<UpdatePluginResponse> =>
    canManage()
      ? plugins.update({ pluginId })
      : Promise.resolve({ success: false, pluginId: '', error: PLUGINS_UPDATE_DESKTOP_ONLY }),
  checkPluginUpdates: (): Promise<CheckPluginUpdatesResponse> =>
    canManage() ? plugins.checkUpdates({}) : Promise.resolve({ success: true, offers: [] }),
  getPluginLifecycleInfo: (): Promise<PluginLifecycleInfoResponse> =>
    canManage()
      ? plugins.lifecycleInfo({})
      : Promise.resolve({ success: true, npmAvailable: false }),
  readPluginTarball: (path: string): Promise<ReadPluginTarballResponse> =>
    canManage()
      ? plugins.readTarball({ path })
      : Promise.resolve({
        success: false,
        errorCode: 'not-supported' as const,
        error: PLUGINS_TARBALL_DESKTOP_ONLY,
      }),
  getPluginMarket: (request?: GetPluginMarketRequest): Promise<GetPluginMarketResponse> =>
    canManage()
      ? plugins.market(request ?? {})
      : Promise.resolve({
        success: false,
        entries: [],
        fetchedAt: null,
        stale: false,
        error: PLUGINS_MARKET_UNAVAILABLE,
      }),
  pickPluginFile: (request: PickPluginFileRequest): Promise<PickPluginFileResponse> =>
    canManage()
      ? plugins.pickFile(request)
      : Promise.resolve({ error: PLUGINS_FILE_PICK_DESKTOP_ONLY }),
}
