/**
 * plugins 域 —— 结构债 P4 终态批 C2,十九条 invoke 数据面整只从手写 IPC 通道搬到
 * 通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/plugins.ts` 那只 portable 工厂(十九条 `ipcMain.handle`)
 *    + `apps/electron/src/main/ipc/plugins.ts` 的适配层 —— 前者**整只删掉**,后者
 *    只剩两件要宿主本体的事(原生对话框 / 命令执行的 execa)与一条推送的注入;
 *  - `preload/bridge.ts` 的十九条包装;
 *  - `platform/web.ts` 的六条 REST 直打 + 十三条硬桩,连同 `server/http.ts` 的
 *    `/api/plugins*` 六条路由与那条 501 的 `/api/plugins/:id/:action`。
 *
 * ## 两条推送留在原地
 *
 * `PLUGINS_NOTIFICATION` 是总线上的全局事件,由 IPCBridge 扇给所有窗,从头到尾
 * 不经过请求面;`PLUGINS_REQUEST_PROGRESS` 改成注入端口
 * (`wiring/plugins/events.ts`),域把 `context.callerId` 原样递过去,桌面据它
 * **定向回发起窗** —— 设置窗是独立 BrowserWindow,广播出去等于每扇窗都收一份
 * 别人的进度。
 *
 * ## 闸:这个进程装没装 PluginManager(B1,不再问 transport)
 *
 * 方案 A(设计文档 §6)下**插件只在装了管理器的宿主上执行**,没装的进程手里最多
 * 有一本只读镜像目录(`owners/<uid>/<wid>/plugin-store/plugins`,由
 * `server/plugin-catalog.ts` 那个单槽端口提供)。全域 18 条因此只问一个问题:
 *
 *  - 7 条读面(list / enable / disable / refresh / commands / executeCommand /
 *    configGet):管理器在场 → 走管理器,与 IPC 逐字同;不在场 → 退到镜像端口
 *    (端口里装的就是从前 `/api/plugins*` 六条路由背后的**同一批闭包**,一行没搬;
 *    `configGet` 从那份清单投影里就地派生只读值,逐字搬自迁移前 `platform/web.ts`);
 *  - 11 条写面:管理器不在场 → 回迁移前 `platform/web.ts` 那句**逐字相同**的文案。
 *
 * B1 之前这两组判据都还挂着 `transport === 'http' &&`,于是**桌面内嵌 HTTP 面
 * 同时装着真管理器与镜像端口**:IPC 读桌面真树、自己的 HTTP 面读一棵它根本不写的
 * 镜像树(审计 2026-09-02 §2.5 的脑裂)。去掉那半个判据后,读面与写面的判据合成
 * 同一个,脑裂消失;React 壳(无管理器、无端口)与独立 `server:start`(无管理器、
 * 有端口)的答案逐字不变。
 *
 * 渲染侧另有一层:能力位 `pluginsManage`(web 默认 false)让写面**根本不发请求**,
 * 就地返回同一批文案(`platform/plugins-client.ts`)。这里是第二道,不是唯一一道。
 */
import type {
  AbortPluginRequestResult,
  CheckPluginUpdatesResponse,
  GetPluginMarketResponse,
  InstallPluginResponse,
  ListPluginsResponse,
  PluginConfigResponse,
  PluginFootprintResponse,
  PluginLifecycleInfoResponse,
  PluginRequestResult,
  ReadPluginTarballResponse,
  SetPluginConfigResponse,
  UninstallPluginResponse,
  UpdatePluginResponse,
} from '@shared/ipc/plugins.js'
import type { PluginsRoutes } from '@shared/ipc/plugins.js'
import { DESKTOP_RPC_CONTEXT, type RpcDispatchContext } from '@shared/ipc/rpc.js'
import { createPluginConfigAccess } from '@onething/runtime/plugins/config-access'
import {
  abortOnethingPluginRequestForIpc,
  checkOnethingPluginUpdatesForIpc,
  disableOnethingPluginForIpc,
  enableOnethingPluginForIpc,
  getOnethingPluginConfigForIpc,
  getOnethingPluginFootprintForIpc,
  getOnethingPluginLifecycleInfoForIpc,
  getOnethingPluginMarketForIpc,
  handleOnethingPluginRequestForIpc,
  installOnethingPluginForIpc,
  listOnethingPluginCommandsForIpc,
  listOnethingPluginsForIpc,
  refreshOnethingPluginsForIpc,
  setOnethingPluginConfigForIpc,
  uninstallOnethingPluginForIpc,
  updateOnethingPluginForIpc,
} from '@onething/runtime/plugins'
import { getPluginAppVersion } from '@onething/runtime/plugins/app-version'
import { clearPluginRuntimeHealth } from '@onething/runtime/plugins/health'
import { readPluginTarballSummary } from '@onething/runtime/plugins/tarball.wiring'
import { getServerPluginCatalogPort } from '../../server/plugin-catalog.js'
import { getPluginBackgroundParams } from '../../wiring/plugins/background.js'
import { executePluginCommandOnHost } from '../../wiring/plugins/commands.js'
import { broadcastPluginRequestProgress } from '../../wiring/plugins/events.js'
import { pickPluginFileOnHost } from '../../wiring/plugins/host-ports.js'
import { getPluginManager } from '../../wiring/plugins/index.js'
import {
  getPluginMarketIndexSnapshot,
  probePluginNpmAvailability,
} from '../../wiring/plugins/install.js'
import { getPluginFootprint } from '../../wiring/plugins/loader.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import { requestSessionOwner, sessionAccess } from '../../session/access.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingPluginIpcLogger } from '@onething/runtime/plugins/ipc-operations'

const log = getLogger('rpc.plugins')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog: ConsoleLikePort & OnethingPluginIpcLogger = consolePort(log)

/**
 * 迁移前 `platform/web.ts` 那批硬桩里的原话,一个字都不改 —— 迁的是通道,
 * 不是可感知行为。
 */
const WEB_PLUGINS_READ_ONLY
  = 'Plugins are installed and uninstalled on the desktop host only; this server mirrors the plugin catalog read-only.'
const WEB_PLUGINS_INSTALL_DESKTOP_ONLY = 'Plugins are installed on the desktop host only.'
const WEB_PLUGINS_UPDATE_DESKTOP_ONLY = 'Plugins are updated on the desktop host only.'
const WEB_PLUGINS_TARBALL_DESKTOP_ONLY = 'Plugin tarballs are inspected on the desktop host only.'
const WEB_PLUGINS_MARKET_UNAVAILABLE = 'Plugin market is unavailable in the web host'
const WEB_PLUGINS_CONFIG_READ_ONLY
  = 'Plugin configuration is editable on the desktop host only; this server mirrors the plugin catalog read-only.'
const WEB_PLUGINS_CONFIG_READ_ONLY_REASON
  = 'Plugin configuration is editable on the desktop host only.'
const WEB_PLUGINS_FOOTPRINT_DESKTOP_ONLY = 'Plugin data lives on the desktop host only.'
const WEB_PLUGINS_EXECUTE_DESKTOP_ONLY = 'Plugins execute on the desktop host only'
/** 那条 501 路由的正文,逐字保留(结构化形状,不再是 HTTP 状态码)。 */
const WEB_PLUGIN_REQUEST_DESKTOP_ONLY
  = 'Plugins execute on the desktop host only; this server mirrors the plugin catalog read-only.'

const pluginConfigAccess = createPluginConfigAccess()

/**
 * 这条读请求要不要退到 server 那本只读镜像。
 *
 * B1(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2)之前的判据是
 * 「是不是 http」,再看端口在不在。那是**两个进程混成一个问题**:桌面内嵌 HTTP 面
 * 同时装着真管理器与 server 镜像端口,于是同一台机器,IPC 读桌面真树、自己的
 * HTTP 面读一棵它根本不写的镜像树 —— 审计 2026-09-02 §2.5 记的那个脑裂。
 *
 * 现在只问一件事:**这个进程装没装 PluginManager**。装了 → `null`(走管理器那条路,
 * 与 IPC 逐字同);没装 → 退到镜像端口(可能也没有 → 调用点回今天那句结构化拒绝)。
 * 于是 React 壳(无管理器、无端口)与独立 `server:start`(无管理器、有端口)的答案
 * 逐字不变,变的只有 Vue 桌面内嵌面那 7 条读面 —— 它们从此读自己真的那棵树。
 */
function pluginCatalogFallback() {
  if (getPluginManager() !== null) return null
  return getServerPluginCatalogPort()
}

/** server adapter 认识的请求上下文 —— 由宿主铸的 dispatch context 转成。 */
function runtimeContext(context: RpcDispatchContext) {
  if (context.ownerUid === undefined || context.workspaceId === undefined) return undefined
  return { userId: context.ownerUid, workspaceId: context.workspaceId }
}

/**
 * 写面的判据:插件管理器在不在场(同 B 批 `collabRooms` 判例)。
 *
 * B1 去掉了从前那半个 `context.transport === 'http' &&`:管理器不在场时,
 * 这些写面在 IPC 上本来也做不成事(`manager: null` 会一路走到投影层的空手降级),
 * 只是从前答的是投影层的话、现在答的是这里这句 —— 而**唯一挂 IPC 面的宿主是
 * Vue 桌面,它一定装了管理器**,所以现役宿主上一条都不变。
 */
function pluginsUnmanaged(): boolean {
  return getPluginManager() === null
}

export const pluginsRpcHandlers: RpcRouteHandlers<PluginsRoutes> = {
  async list(_request, context = DESKTOP_RPC_CONTEXT): Promise<ListPluginsResponse> {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.list(runtimeContext(context))) as ListPluginsResponse
    }
    return (await listOnethingPluginsForIpc({
      manager: getPluginManager(),
      logger: consoleLog,
      // 设置页从列表一次拿全配置材料(字段表 + 当前值),不必逐插件再问一轮。
      getPluginConfig: pluginConfigAccess.read,
      // G 期(L2.5):背景层的运行期调参是内存态,只有桌面宿主有它 ——
      // 方案 A 下只有这一个宿主执行插件代码,也就只有这里存在 updateBackground。
      getPluginBackgroundParams,
    })) as ListPluginsResponse
  },

  async enable(request, context = DESKTOP_RPC_CONTEXT) {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.enable(request?.pluginId ?? '', runtimeContext(context))) as {
        success: boolean
        error?: string
      }
    }
    return enableOnethingPluginForIpc({
      manager: getPluginManager(),
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
    })
  },

  async disable(request, context = DESKTOP_RPC_CONTEXT) {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.disable(request?.pluginId ?? '', runtimeContext(context))) as {
        success: boolean
        error?: string
      }
    }
    return disableOnethingPluginForIpc({
      manager: getPluginManager(),
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
      // 用户亲手关的 = 清账。熔断的自动禁用不经过这条命令,所以两者天然分得开。
      onManualDisable: clearPluginRuntimeHealth,
    })
  },

  async refresh(_request, context = DESKTOP_RPC_CONTEXT) {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.refresh(runtimeContext(context))) as {
        success: boolean
        error?: string
      }
    }
    return refreshOnethingPluginsForIpc({
      manager: getPluginManager(),
      logger: consoleLog,
    })
  },

  async commands(_request, context = DESKTOP_RPC_CONTEXT) {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.commands(runtimeContext(context))) as {
        success: boolean
        commands?: Array<{ id: string; name: string; description: string; usage: string }>
        error?: string
      }
    }
    return listOnethingPluginCommandsForIpc({
      manager: getPluginManager(),
      logger: consoleLog,
    })
  },

  async executeCommand(request, context = DESKTOP_RPC_CONTEXT) {
    if (request?.sessionId) sessionAccess.resolve(context, request.sessionId, 'write')
    const catalog = pluginCatalogFallback()
    if (catalog) {
      return (await catalog.executeCommand(request, runtimeContext(context))) as {
        success: boolean
        message?: string
        error?: string
      }
    }
    return executePluginCommandOnHost({
      commandName: request?.commandName ?? '',
      args: request?.args,
      sessionId: request?.sessionId ?? '',
    }, { executionContext: requestSessionOwner(context) })
  },

  /**
   * 统一请求通道(R2)。分发与序列化判断全在 core 的 `manager.handleRequest`,
   * 这里只把 progress 接到推送端口上,并把「谁在问」原样递过去。
   */
  async request(payload, context = DESKTOP_RPC_CONTEXT): Promise<PluginRequestResult> {
    if (pluginsUnmanaged()) {
      return {
        success: false,
        requestId: payload?.requestId ?? '',
        error: WEB_PLUGIN_REQUEST_DESKTOP_ONLY,
      }
    }
    return handleOnethingPluginRequestForIpc({
      manager: getPluginManager(),
      pluginId: payload?.pluginId ?? '',
      action: payload?.action ?? '',
      payload: payload?.payload,
      requestId: payload?.requestId,
      bypassDegraded: payload?.bypassDegraded,
      onProgress: progress => broadcastPluginRequestProgress(progress, context.callerId),
      logger: consoleLog,
    })
  },

  async requestAbort(request): Promise<AbortPluginRequestResult> {
    if (pluginsUnmanaged()) {
      return { success: false, aborted: false, error: WEB_PLUGINS_EXECUTE_DESKTOP_ONLY }
    }
    return abortOnethingPluginRequestForIpc({
      manager: getPluginManager(),
      requestId: request?.requestId ?? '',
      logger: consoleLog,
    })
  },

  /**
   * 配置读取。
   *
   * http 上是**只读**的(方案 A):值与字段表都从那份目录清单投影里派生 ——
   * 不新开路由,也不假装 server 上有一份可写的配置(server 写 plugin-settings
   * 会与桌面那份文件分叉,那比"不能编辑"糟糕得多)。整段逐字搬自迁移前
   * `platform/web.ts` 的 `getPluginConfig`。
   */
  async configGet(request, context = DESKTOP_RPC_CONTEXT): Promise<PluginConfigResponse> {
    const catalog = pluginCatalogFallback()
    if (catalog) {
      const pluginId = request?.pluginId ?? ''
      try {
        const listed = (await catalog.list(runtimeContext(context))) as {
          success?: boolean
          plugins?: Array<Record<string, unknown>>
        }
        const plugin = listed?.plugins?.find(item => item.id === pluginId)
        if (!plugin) return { success: false, error: `Unknown plugin "${pluginId}"` }
        const fields = (plugin.configFields ?? []) as PluginConfigResponse['fields']
        return {
          success: true,
          declared: Boolean(fields?.length)
            || Boolean((plugin.configUnsupportedReasons as string[])?.length),
          fields,
          title: (plugin.configTitle as string) || undefined,
          config: (plugin.configValues as Record<string, unknown>) ?? {},
          unsupportedReasons: (plugin.configUnsupportedReasons as string[]) ?? [],
          editable: false,
          readOnlyReason: WEB_PLUGINS_CONFIG_READ_ONLY_REASON,
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return getOnethingPluginConfigForIpc({
      access: pluginConfigAccess,
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
    })
  },

  async configSet(request): Promise<SetPluginConfigResponse> {
    if (pluginsUnmanaged()) {
      return { success: false, error: WEB_PLUGINS_CONFIG_READ_ONLY }
    }
    return setOnethingPluginConfigForIpc({
      access: pluginConfigAccess,
      pluginId: request?.pluginId ?? '',
      config: request?.config,
      logger: consoleLog,
    })
  },

  async uninstall(request): Promise<UninstallPluginResponse> {
    if (pluginsUnmanaged()) {
      return { success: false, error: WEB_PLUGINS_READ_ONLY }
    }
    return uninstallOnethingPluginForIpc({
      manager: getPluginManager(),
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
    })
  },

  async footprint(request): Promise<PluginFootprintResponse> {
    if (pluginsUnmanaged()) {
      return { success: false, error: WEB_PLUGINS_FOOTPRINT_DESKTOP_ONLY }
    }
    return getOnethingPluginFootprintForIpc({
      readFootprint: pluginId => {
        const footprint = getPluginFootprint(pluginId)
        return {
          pluginId: footprint.pluginId,
          dataDir: footprint.dataDir,
          dataDirExists: footprint.dataDirExists,
          entries: footprint.entries,
          legacyKvExists: footprint.legacyKvExists,
          settingsKeys: footprint.settingsKeys,
        }
      },
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
    })
  },

  // ── P1:npm 生命周期 —— 命令链在 core manager,这里只做转调。──
  async install(request): Promise<InstallPluginResponse> {
    if (pluginsUnmanaged()) {
      return { success: false, error: WEB_PLUGINS_INSTALL_DESKTOP_ONLY }
    }
    return installOnethingPluginForIpc({
      manager: getPluginManager(),
      pkg: request?.pkg ?? '',
      tarballUrl: request?.tarballUrl,
      path: request?.path,
      integrity: request?.integrity,
      logger: consoleLog,
    })
  },

  async update(request): Promise<UpdatePluginResponse> {
    if (pluginsUnmanaged()) {
      return { success: false, pluginId: '', error: WEB_PLUGINS_UPDATE_DESKTOP_ONLY }
    }
    return updateOnethingPluginForIpc({
      manager: getPluginManager(),
      pluginId: request?.pluginId ?? '',
      logger: consoleLog,
    })
  },

  async checkUpdates(): Promise<CheckPluginUpdatesResponse> {
    if (pluginsUnmanaged()) return { success: true, offers: [] }
    return checkOnethingPluginUpdatesForIpc({
      manager: getPluginManager(),
      logger: consoleLog,
    })
  },

  // 裁决 8:v1 依赖本机 npm —— 能力面先行,设置页据此置灰并说明。
  async lifecycleInfo(): Promise<PluginLifecycleInfoResponse> {
    if (pluginsUnmanaged()) return { success: true, npmAvailable: false }
    return getOnethingPluginLifecycleInfoForIpc({
      probeNpmAvailability: probePluginNpmAvailability,
    })
  },

  // 装前清单预读:包名与声明都在 tarball 里,宿主自己读出来。
  // 纯读取,不落任何盘 —— 安装闸一条不松(预读不是信任来源)。
  async readTarball(request): Promise<ReadPluginTarballResponse> {
    if (pluginsUnmanaged()) {
      return {
        success: false,
        errorCode: 'not-supported',
        error: WEB_PLUGINS_TARBALL_DESKTOP_ONLY,
      }
    }
    return readPluginTarballSummary(request?.path ?? '')
  },

  // P3:市场 —— 索引视图在装配层 join 好(安装态 + 版本兼容 + 缓存龄),
  // renderer 只渲染;拉取失败回上次缓存并 stale 置位(断网容忍)。
  async market(request): Promise<GetPluginMarketResponse> {
    if (pluginsUnmanaged()) {
      return {
        success: false,
        entries: [],
        fetchedAt: null,
        stale: false,
        error: WEB_PLUGINS_MARKET_UNAVAILABLE,
      }
    }
    return getOnethingPluginMarketForIpc({
      manager: getPluginManager(),
      logger: consoleLog,
      refresh: request?.refresh === true,
      getMarketSnapshot: getPluginMarketIndexSnapshot,
      appVersion: getPluginAppVersion(),
    })
  },

  /**
   * `file-pick` 的一次导入(B 期,用户壁纸)。
   *
   * 全程在宿主进程:对话框 → 闸 → 拷贝 → 返回一个 `storage:` 地址。
   * renderer 收到的是地址,插件收到的也是地址 —— **字节两边都不过手**。
   * 未注入宿主 = 那句逐字相同的降级(浏览器里既没有原生对话框也没有插件数据目录)。
   *
   * 手势锚定是天然的:原生对话框只能由用户那一次点击拉起来。这里不需要
   * (也无法伪造)一个 `userGesture` 布尔。
   */
  async pickFile(request, context = DESKTOP_RPC_CONTEXT) {
    return pickPluginFileOnHost(request, context.callerId)
  },
}
