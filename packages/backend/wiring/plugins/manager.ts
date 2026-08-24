/**
 * Plugin Manager — main-process adapter around the headless core manager.
 */

import {
  CorePluginBootstrapper,
  CorePluginManager,
  type CorePluginInfo,
  type CorePluginInstallRequest,
  type CorePluginInstallResult,
  type CorePluginManagerHost,
  type CorePluginUninstallResult,
  type CorePluginUpdateResult, type CorePluginBootstrapperOptions,
} from '@onething/core/plugins'
import { createPluginAPI, disposePlugin, type PluginState } from './api.js'
import {
  archiveCorePluginData,
  decidePluginOrphanArchive,
  findCorePluginDataOrphans,
  findCorePluginHomeOrphans,
  readPluginLedger,
  restoreCorePluginDataArchive,
  scanPluginSourceEntries,
} from '@onething/core/plugins'
import {
  scanPlugins,
  loadPluginEntry,
  clearPluginSettingsKeys,
  ensurePluginDirs,
  getPluginDataRoot,
  getPluginsDir,
  invalidateDeclaredPanelIdsCache,
  loadPersistedPluginHealth,
  markPluginDemolished,
  persistPluginHealth,
  readPluginConfig,
  removePluginSourceDir,
  setPluginEnabled,
  writePluginConfig,
} from './loader.js'
import { configurePluginConfigHost, invalidatePluginConfigCache } from '@onething/runtime/plugins/config'
import {
  configurePluginStatusHost,
  detachPluginStatusHost,
  subscribePluginStatusSweep,
} from '@onething/runtime/plugins/status-bound'
import { configureIMConnectorHooks } from '../../channel/connector-registry.js'
import {
  fetchPluginMarketIndex,
  installPluginPackage,
  packageNameFromNodeModulesPath,
  readInstalledPluginSpec,
  uninstallPluginPackage,
} from './install.js'
import { pluginScope, assertUiAnchorRegistryConsistency } from '@onething/core/plugins'
import { configurePluginConfigBroadcast } from '@onething/runtime/plugins/config-access'
import {
  clearPluginRuntimeHealth,
  describePluginSurfaceDegradation,
  isPluginSurfaceDegraded,
  probePluginSurface,
  configurePluginHealthHost,
  getPluginRuntimeHealth,
  reportPluginRuntimeFailure,
  reportPluginRuntimeSuccess,
  restorePluginRuntimeHealth,
} from '@onething/runtime/plugins/health'
import type { PluginAPI, PluginDefinition, PluginEntry, PluginCommandDefinition } from './types.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { LegacyDuckLogger } from '@onething/core/logging'

const log = getLogger('plugins.manager')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & LegacyDuckLogger = consolePort(log)


export interface PluginManagerContext {
  eventBus: any
  streamEngine: any
}

export type PluginInfo = CorePluginInfo<PluginEntry, PluginDefinition>

function createHost(): CorePluginManagerHost<
  PluginDefinition,
  PluginEntry,
  PluginAPI,
  PluginState,
  PluginCommandDefinition,
  PluginManagerContext
> {
  return {
    ensurePluginDirs,
    scanPlugins,
    loadPluginEntry: (definition, reloadToken) => loadPluginEntry(definition, reloadToken),
    // 面板声明由 createPluginAPI 自己现查清单 —— 这里不再中转一遍。
    createPluginAPI(pluginId, context) {
      return createPluginAPI(pluginId, context.eventBus, context.streamEngine)
    },
    disposePlugin,
    setPluginEnabled,
    getPluginHealth: getPluginRuntimeHealth,
    // 请求通道的失败/成功进 R1 的熔断账(scope = `request:<action>`)。
    // 少了这条线,R3/R5 的 UI 轮询一个必败 action 会无限连败而插件永远 Active。
    onRequestFailure: reportPluginRuntimeFailure,
    onRequestSuccess: reportPluginRuntimeSuccess,
    // R7:降级闸的数据源。没有这条线,"降级"就只是一个徽章。
    isSurfaceDegraded: isPluginSurfaceDegraded,
    describeDegradedSurface: describePluginSurfaceDegradation,
    // ── R4:数据目录与卸载 ──
    archivePluginData: pluginId => {
      // §7.4:归档完成后到的写(config/KV/storage)= warn + 丢弃,不重建家目录。
      markPluginDemolished(pluginId)
      // 归档目标(P1 适配):插件的数据家在 plugins/<id>/。
      return archiveCorePluginData(getPluginsDir(), pluginId)
    },
    removePluginSource: async (definition) => {
      // 源目录没了,清单也就变了 —— 面板声明缓存必须跟着失效。
      invalidateDeclaredPanelIdsCache()
      // npm 形态(dirPath 在 node_modules 里)= `npm uninstall` 拆账;
      // 不在 node_modules 里的(directory 扫描语义下的宿主)走 rm -rf。
      const pkg = packageNameFromNodeModulesPath(getPluginsDir(), definition.dirPath)
      if (pkg) return uninstallPluginPackage(getPluginsDir(), pkg)
      return removePluginSourceDir(definition.dirPath, definition.id)
    },
    clearPluginSettings: pluginId => {
      clearPluginSettingsKeys(pluginId)
      // 配置缓存跟着盘上的事实走,否则卸载后重装会读到上一世的值。
      invalidatePluginConfigCache(pluginId)
      clearPluginRuntimeHealth(pluginId)
    },
    restorePluginDataArchive: (pluginId, archivePath) => {
      return restoreCorePluginDataArchive(getPluginsDir(), pluginId, archivePath)
    },
    // ── P1:npm 生命周期(裁决 8:v1 依赖本机 npm)──
    installPluginPackage: input => installPluginPackage(getPluginsDir(), input),
    readInstalledPluginSpec: pkg => readInstalledPluginSpec(getPluginsDir(), pkg),
    fetchPluginMarketIndex,
    getPluginSourceScan: () => scanPluginSourceEntries(getPluginsDir()),
    archiveOrphanPluginData: ({ knownPluginIds, scanTrusted, userPluginCount }) => {
      const dataRoot = getPluginDataRoot()
      const orphans = findCorePluginDataOrphans(dataRoot, knownPluginIds)

      // 家目录孤儿(P1):plugins/<id>/ 无 plugin.json = 纯数据家目录,它的
      // "主"是账 + 包。账不可信 = 整轮弃权 —— 拿空账当真会把全部 npm 插件
      // 的家目录判成孤儿(与扫描不可信同一条安全闸)。
      const ledger = readPluginLedger(getPluginsDir())
      let homeOrphans: ReturnType<typeof findCorePluginHomeOrphans> = []
      if (ledger.trusted) {
        homeOrphans = findCorePluginHomeOrphans(
          getPluginsDir(),
          scanPlugins().map(definition => definition.id),
        )
      } else {
        log.warn('skipping plugin-home orphan scan this round', { reason: ledger.reason })
      }

      // 自动归档的安全闸:扫描不可信 / 一个用户插件都没有 / 候选超阈值,
      // 一律不动手,改为请人来看。误归档一次就是把用户的数据从插件脚下搬走。
      const decision = decidePluginOrphanArchive({
        orphans: [...orphans, ...homeOrphans],
        scanTrusted: scanTrusted && ledger.trusted,
        userPluginCount,
      })
      if (!decision.proceed) {
        log.warn('refusing to auto-archive orphan plugin data; nothing was moved', {
          candidates: [...orphans, ...homeOrphans].map(orphan => orphan.pluginId),
          reason: decision.reason,
        })
        return []
      }

      const archived: string[] = []
      const archiveOne = (root: string, pluginId: string, kind: string): void => {
        const result = archiveCorePluginData(root, pluginId)
        if (result.archived) {
          archived.push(pluginId)
          // 孤儿的 plugin-settings 三键也是它的足迹 —— 数据搬走了键还留着,
          // 下一个同名插件装上来会继承一具前世的启停位与配置。
          markPluginDemolished(pluginId)
          clearPluginSettingsKeys(pluginId)
          invalidatePluginConfigCache(pluginId)
          clearPluginRuntimeHealth(pluginId)
          log.warn('archived plugin data for an uninstalled plugin', {
            pluginId,
            kind,
            archivePath: result.archivePath,
          })
        } else if (result.error) {
          log.error('archive orphaned plugin data failed', { pluginId, reason: result.error })
        }
      }
      for (const orphan of orphans) archiveOne(dataRoot, orphan.pluginId, orphan.kind)
      for (const orphan of homeOrphans) archiveOne(getPluginsDir(), orphan.pluginId, `home ${orphan.kind}`)
      return archived
    },
  }
}

export class PluginManager extends CorePluginManager<
  PluginAPI,
  PluginEntry,
  PluginCommandDefinition,
  PluginState,
  PluginDefinition,
  PluginManagerContext
> {
  /** 目录变了要广播,而 core 不认识 EventBus —— initialize 时接上。 */
  private eventBus: { emitGlobal?(event: unknown): void } | null = null

  /** 流结束清扫的订阅句柄(R6)。重复 initialize 不能叠加订阅。 */
  private unsubscribeStatusSweep: (() => void) | undefined

  constructor() {
    super(createHost())
  }

  /**
   * 目录变更的机械信号。
   *
   * 插件系统是 post-window 非阻塞装配的,renderer 在 boot 时拉的那一次很可能拉了个
   * 空清单;而设置窗启停插件之后,主窗那份 nav 也不会自己更新(两个独立
   * BrowserWindow)。两个症状同一个成因:**目录变了没人说一声**。
   * 一条信号盖住两处 —— bootstrap 完成、启用、停用、刷新,统一发它。
   */
  private emitCatalogChanged(pluginId: string): void {
    this.eventBus?.emitGlobal?.({
      type: 'plugin:notification',
      pluginId,
      message: `plugin-catalog-changed:${pluginId}`,
      level: 'info',
      kind: 'catalog-changed',
    })
  }

  async enablePlugin(pluginId: string): Promise<void> {
    await super.enablePlugin(pluginId)
    this.emitCatalogChanged(pluginId)
  }

  async disablePlugin(pluginId: string): Promise<void> {
    await super.disablePlugin(pluginId)
    this.emitCatalogChanged(pluginId)
  }

  /**
   * 拆掉本管理器接到宿主上的线。
   *
   * 不解绑的话,重启插件系统会叠加一个拦截器,而旧那个还指着上一次的 EventBus ——
   * 每次重启多一份空转,dev 热重载下可观察。
   *
   * 由 `shutdown()` 调用。**不留没有调用者的契约**:上一版的 docstring 写着
   * "shutdown 必须调用它"却没人调,真正防重入的是 initialize 里那次
   * `unsubscribeStatusSweep?.()` —— 一句自己不兑现的承诺比没有承诺更坏。
   */
  detachHostSubscriptions(): void {
    this.unsubscribeStatusSweep?.()
    this.unsubscribeStatusSweep = undefined
    this.eventBus = null
    /*
     * 全部 late-bound 端口一起拆。
     *
     * 漏掉的两个持的引用比拆掉的更重:`configurePluginHealthHost` 的闭包持
     * `this.disablePlugin`(**即这个实例本身**),`configurePluginConfigHost` 的
     * 闭包持 `this.getPlugins()` —— 不拆的话每次重启都多留一个活的旧 manager。
     */
    detachPluginStatusHost()
    configurePluginConfigBroadcast(null)
    configureIMConnectorHooks({})
    configurePluginHealthHost(null)
    configurePluginConfigHost(null)
  }

  override shutdown(): void {
    super.shutdown()
    this.detachHostSubscriptions()
  }

  async uninstallPlugin(pluginId: string): Promise<CorePluginUninstallResult> {
    // 卸载同样改目录 —— 少了这条广播,主窗会留着一个已卸载插件的面板入口,
    // 而 R5 加 catalog-changed 正是为了治这个(当时漏了卸载这条路径)。
    invalidateDeclaredPanelIdsCache()
    const result = await super.uninstallPlugin(pluginId)
    this.emitCatalogChanged(pluginId)
    return result
  }

  /**
   * install/update 同样要广播。
   *
   * core 的 installPlugin/updatePlugin 内部走 `doRefreshPlugins()`(单飞互斥
   * 的要求,见 runLifecycleExclusive 的注释)—— 它**不经过**本类的
   * `refreshPlugins()` 覆盖,广播因此不会自动发生。新装的插件不带广播,
   * 主窗的面板入口与锚点块清单就停在装前那一世。
   */
  async installPlugin(input: CorePluginInstallRequest): Promise<CorePluginInstallResult> {
    invalidateDeclaredPanelIdsCache()
    const result = await super.installPlugin(input)
    this.emitCatalogChanged(result.pluginId ?? input.pkg)
    return result
  }

  async updatePlugin(pluginId: string): Promise<CorePluginUpdateResult> {
    invalidateDeclaredPanelIdsCache()
    const result = await super.updatePlugin(pluginId)
    this.emitCatalogChanged(pluginId)
    return result
  }

  async refreshPlugins(): Promise<void> {
    // 刷新就是"重新看盘上有什么" —— 缓存的清单先作废。
    invalidateDeclaredPanelIdsCache()
    await super.refreshPlugins()
    this.emitCatalogChanged('*')
  }

  /** Call after EventBus and StreamEngine are initialized */
  async initialize(context: PluginManagerContext): Promise<void>
  async initialize(eventBus: any, streamEngine: any): Promise<void>
  async initialize(eventBusOrContext: any, streamEngine?: any): Promise<void> {
    const context = streamEngine === undefined
      ? eventBusOrContext as PluginManagerContext
      : { eventBus: eventBusOrContext, streamEngine }
    this.eventBus = context.eventBus ?? null

    // 熔断器要能真的禁用插件并通知用户 —— core 不认识 EventBus,这条线只能在
    // 这里接上(late-bound host port,与 configure*Host 同构)。
    configurePluginHealthHost({
      disablePlugin: pluginId => this.disablePlugin(pluginId),
      notify: (pluginId, message) => {
        context.eventBus?.emitGlobal?.({
          type: 'plugin:notification',
          pluginId,
          message,
          level: 'error',
        })
      },
      persistHealth: persistPluginHealth,
      loadPersistedHealth: loadPersistedPluginHealth,
    })
    // 配置的 schema 单源是 manifest —— 这里把"去哪儿读 manifest / 去哪儿读写盘"
    // 两件宿主事实接给 config 层,它才不必认识 loader 或 manager。
    configurePluginConfigHost({
      getSettingsContribution: pluginId => this.getPlugins()
        .find(info => info.definition.id === pluginId)
        ?.definition.manifest.contributes?.settings,
      readConfig: readPluginConfig,
      writeConfig: writePluginConfig,
    })
    // R6:插件流状态的投递口 + 流结束强制清扫。
    //
    // 清扫挂在 EventBus 的 **interceptor** 相位(commit 与 fan-out 之前),
    // 不是事后观察者:终止事件一旦过线,renderer 会自己把 transient 扫干净,
    // 后到的 cleared 就落在一条已经收尾的消息上,宿主清扫成了空转。
    // 与引擎内部实现仍然解耦 —— 判据是总线上的事件名,不是引擎的结束路径。
    // R7:IM 渠道的**运行期**失败进熔断账(scope `connector:<id>`)。
    // 没有这条线,connector 家族就只有注册期生产者 —— 而"降级而非禁用"这条
    // 拍板最需要的恰恰是一个运行期证据。
    configureIMConnectorHooks({
      onSendFailure: (pluginId, connectorId, error) =>
        reportPluginRuntimeFailure(pluginId, pluginScope.connector(connectorId), error),
      onSendSuccess: (pluginId, connectorId) =>
        reportPluginRuntimeSuccess(pluginId, pluginScope.connector(connectorId)),
      // 降级闸的数据源 —— 与请求通道那道闸同源,connector 家族才真有牙齿。
      isSurfaceDegraded: isPluginSurfaceDegraded,
      describeDegradedSurface: describePluginSurfaceDegradation,
      probeSurface: probePluginSurface,
    })
    configurePluginStatusHost({
      emitSessionEvent: (sessionId, event) => context.eventBus?.emit?.(sessionId, event),
      // 状态只在流内有意义:没有正在跑的流,那条 content:part 在 renderer 侧
      // 解析不出 messageId,会落进待发队列并贴到**下一条**毫不相干的消息上。
      isStreaming: (sessionId: string) => Boolean(context.streamEngine?.getController?.(sessionId)),
    })
    this.unsubscribeStatusSweep?.()
    this.unsubscribeStatusSweep = context.eventBus
      ? subscribePluginStatusSweep(context.eventBus)
      : undefined

    configurePluginConfigBroadcast(pluginId => {
      context.eventBus?.emitGlobal?.({
        type: 'plugin:notification',
        pluginId,
        message: `plugin-config-changed:${pluginId}`,
        level: 'info',
        kind: 'config-changed',
      })
    })
    // 回灌必须在扫描/加载之前:上一轮被熔断禁用的插件,这次启动要带着原因出现。
    restorePluginRuntimeHealth()

    // 锚点清单的键集合一致性(R5.x):类型层面 Record 索引兑住"漏配",
    // 这条运行时断言兑住"多配/旧键残留"—— 装配期炸,比某个挂点静默少画一块强。
    assertUiAnchorRegistryConsistency()

    await super.initialize(context)
    // 装配完成才是 renderer 能看到真实清单的时刻 —— boot 时那一次拉的多半是空的。
    this.emitCatalogChanged('*')
  }
}

const pluginBootstrapperOptions: CorePluginBootstrapperOptions<PluginManager, PluginManagerContext> = {
  ensurePluginDirs,
  createManager: () => new PluginManager(),
  initializeManager: (manager, context) => manager.initialize(context),
  logger: consoleLog,
};
const pluginBootstrapper = new CorePluginBootstrapper<PluginManager, PluginManagerContext>(pluginBootstrapperOptions)

/**
 * Bootstrap the plugin system.
 * Must be called after EventBus and StreamEngine are initialized.
 * Idempotent — subsequent calls are no-ops.
 */
export async function bootstrapPluginSystem(
  eventBus: any,
  streamEngine: any,
): Promise<PluginManager> {
  return pluginBootstrapper.bootstrap({ eventBus, streamEngine })
}

/** Get the singleton manager (null before bootstrap) */
export function getPluginManager(): PluginManager | null {
  return pluginBootstrapper.getManager()
}
