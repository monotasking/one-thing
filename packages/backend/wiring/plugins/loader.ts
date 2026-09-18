/**
 * Plugin Loader — scans and loads plugins from disk.
 *
 * 用户插件走 npm 账本:代码在 `~/.onething/plugins/node_modules/`,数据在家目录
 * `~/.onething/plugins/<id>/`。内置插件与 app 同一份构建。
 * **没有运行时 npm install**:包在安装期就 bundle 好全部依赖(2026-08-09
 * legacy 目录插件清零时,首载安装机器随之退役)。
 */

import fs from 'fs'
import path from 'path'
import {
  describePluginBackgroundProblem,
  describePluginWebviewPanelProblem,
  isPluginWebviewPanel,
  type PluginContributionUiSlot, type CorePluginSettingsStorageAdapters, type LoadCorePluginEntryAdapters,
} from '@onething/core/plugins'
import { getOnethingPluginDataDir, getOnethingStorePath } from '@onething/runtime/storage'
import { writeJsonFile } from '@onething/core/storage'
import {
  createBuiltinPluginDefinitions,
  ensureCorePluginsDir,
  getCorePluginSettingsPath,
  getCorePluginDataFootprint,
  getCorePluginsDir,
  getCoreLocalPluginsDir,
  getPluginConfigFromSettings,
  PLUGIN_SETTINGS_KEYS,
  getPluginEnabledWithAdapters,
  buildPluginEntryImportSpecifier,
  listPluginHealthFromSettings,
  loadCorePluginEntry,
  readPluginSettingsFile,
  scanCorePlugins,
  scanLocalPluginFiles,
  getCorePluginConfigPath,
  assertNotInNodeModules,
  setPluginConfigInSettings,
  setPluginEnabledWithAdapters,
  setPluginHealthInSettings,
  writePluginSettingsFile,
} from '@onething/core/plugins'
import type { CorePluginDataFootprint, PersistedPluginHealth } from '@onething/core/plugins'
import { getPluginAppVersion } from '@onething/runtime/plugins/app-version'
import { clearPluginRuntimeHealth } from '@onething/runtime/plugins/health'
import type { PluginDefinition, PluginEntry, PluginSettings } from './types.js'
import logMonitorPlugin, { logMonitorManifest } from './builtin/log-monitor.js'
import { consolePort, getLogger } from '../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { LegacyDuckLogger } from '@onething/core/logging'

const log = getLogger('plugins.loader')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & LegacyDuckLogger = consolePort(log)


export function getPluginsDir(): string {
  return getCorePluginsDir({ storePath: getOnethingStorePath() })
}

/**
 * 轻通道的专用目录:`<store>/plugins-dev/`。与 `getPluginsDir()`(npm 账本唯一)
 * 物理分离 —— 只有它扫单文件脚本,账本扫描不受影响。
 */
export function getLocalPluginsDir(): string {
  return getCoreLocalPluginsDir({ storePath: getOnethingStorePath() })
}

/**
 * 本轮扫描发现的轻通道脚本 id 集合。
 *
 * 由 `scanPlugins()` 每轮重建。装配层据它判定"这个插件是不是本地脚本",从而把
 * 它的 api 面**物理收窄**成 `LocalPluginAPI`(见 api.ts 的 narrowApiForLocalPlugin)。
 * 用集合而不是每次现扫盘:createPluginAPI 是 per-plugin 调用,而 scanPlugins 在它
 * 之前已经跑过(bootstrap:先 scan 再逐个 load),集合总是最新的。
 */
const localPluginIds = new Set<string>()

/** 这个插件是不是轻通道单文件脚本(装配层收窄能力面用)。 */
export function isLocalPlugin(pluginId: string): boolean {
  return localPluginIds.has(pluginId)
}

/**
 * 上一轮记录过的本地脚本 id —— 只为"集合变了才吼一声"的启动可见性日志服务。
 * null = 还没扫过(首扫必吼);之后只在增删时吼,避免 O(n²) 扫描下的刷屏。
 */
let loggedLocalPluginIds: string | null = null

function getPluginSettingsPath(): string {
  return getCorePluginSettingsPath({ storePath: getOnethingStorePath() })
}

function readPluginSettings(): PluginSettings {
  return readPluginSettingsFile(getPluginSettingsPath())
}

function writePluginSettings(settings: PluginSettings): void {
  writePluginSettingsFile(getPluginSettingsPath(), settings)
}

export function getPluginEnabled(pluginId: string, fallback = true): boolean {
  return getPluginEnabledWithAdapters(pluginId, fallback, {
    readSettings: readPluginSettings,
  })
}

/** 把"为什么被禁"写进 plugin-settings(与 enabled 位同一个文件,同生共死)。 */
export function persistPluginHealth(pluginId: string, health: PersistedPluginHealth | null): void {
  writePluginSettings(setPluginHealthInSettings(readPluginSettings(), pluginId, health))
}

export function loadPersistedPluginHealth(): Array<{ pluginId: string; health: PersistedPluginHealth }> {
  return listPluginHealthFromSettings(readPluginSettings())
}

/**
 * `plugin-data/` 的根目录。
 *
 * **只剩归档用途**:P1 之后插件数据住家目录 `plugins/<id>/`,2026-08-09 撤掉
 * 惰性迁移之后再没有任何读路径指向这里。留着它是为了孤儿收尸 —— 旧根里若还
 * 躺着无主数据,照样归档进 `plugin-data/legacy-backup/`。
 */
export function getPluginDataRoot(): string {
  return getOnethingPluginDataDir({ storePath: getOnethingStorePath() })
}

/**
 * 删除用户插件的源目录。
 *
 * 只删 `<store>/plugins/<id>/` 下的东西,且要求 dirPath 真的落在插件根里 ——
 * 一个手写坏了的 definition 不该把 rm -rf 指到别处。
 */
export function removePluginSourceDir(dirPath: string, pluginId: string): { removed: boolean; error?: string } {
  const pluginsDir = getPluginsDir()
  const expected = path.join(pluginsDir, pluginId)
  const resolved = path.resolve(dirPath)
  if (resolved !== path.resolve(expected)) {
    return { removed: false, error: `Refusing to remove "${resolved}": it is not ${expected}` }
  }
  if (!fs.existsSync(resolved)) return { removed: true }
  try {
    fs.rmSync(resolved, { recursive: true, force: true })
    return { removed: true }
  } catch (error) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 清掉 plugin-settings 里该插件的三键(PLUGIN_SETTINGS_KEYS)。
 * 名单与足迹共用一份常量 —— 加第四个键时不会只改一边。
 */
export function clearPluginSettingsKeys(pluginId: string): void {
  const settings = readPluginSettings()
  const enabled = { ...settings.enabled }
  delete enabled[pluginId]
  let next: PluginSettings = Object.keys(enabled).length > 0
    ? { ...settings, enabled }
    : (({ enabled: _dropped, ...rest }) => rest)(settings)
  next = setPluginConfigInSettings(next, pluginId, null)
  next = setPluginHealthInSettings(next, pluginId, null)
  writePluginSettings(next)
}

/** 这个插件在 plugin-settings 里实际占着哪几个键。 */
export function listPluginSettingsKeys(pluginId: string): string[] {
  const settings = readPluginSettings() as unknown as Record<string, Record<string, unknown> | undefined>
  return PLUGIN_SETTINGS_KEYS.filter(key => settings[key]?.[pluginId] !== undefined)
}

/**
 * 一个插件的全部落盘足迹(宪法第 6 条数据侧)。
 *
 * 足迹枚举与归档同一把尺(P1):家在 `plugins/<id>/`。卸载确认框据此展示
 * "将被归档的东西" —— 尺若分叉,对话框就会说"没什么可归档的"而家目录
 * 其实会被搬走。
 */
export function getPluginFootprint(pluginId: string): CorePluginDataFootprint {
  return getCorePluginDataFootprint(getPluginsDir(), pluginId, {
    settingsKeys: listPluginSettingsKeys(pluginId),
  })
}

// ── §7.4 拆除闩 ──
//
// 卸载(归档)完成后到的写 = warn + 静默丢弃:config.ts 的 pendingConfigs
// 合流定时器会晚到,而一次写就会 ensureDir 把刚归档的家目录复活成鬼目录。
// 扫描里再现 = 已重装,闩自动解除(scanPlugins 里抬闩)。
const demolishedPluginIds = new Set<string>()

export function markPluginDemolished(pluginId: string): void {
  demolishedPluginIds.add(pluginId)
}

export function isPluginDemolished(pluginId: string): boolean {
  return demolishedPluginIds.has(pluginId)
}

/** 插件自有配置的原始值(未校验);校验与默认值填充在 config.ts。 */
export function readPluginConfig(pluginId: string): Record<string, unknown> {
  const configPath = getCorePluginConfigPath(getPluginsDir(), pluginId)
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      log.error('plugin config.json is not a JSON object, treating it as empty', { pluginId, configPath })
    } catch (error) {
      log.error('read plugin config from home dir failed', { pluginId, configPath }, error)
    }
    return {}
  }
  // 惰性搬家(§7.2):新文件不在且中央有行 → 写新文件,从中央抹掉该行
  // (中央文件只在有实际搬移时重写)。已拆的插件不重建家目录(§7.4)。
  const central = getPluginConfigFromSettings(readPluginSettings(), pluginId)
  if (Object.keys(central).length === 0) return {}
  if (isPluginDemolished(pluginId)) return central
  try {
    assertNotInNodeModules(getPluginsDir(), configPath)
    writeJsonFile(configPath, central)
    writePluginSettings(setPluginConfigInSettings(readPluginSettings(), pluginId, null))
  } catch (error) {
    log.error('migrate plugin config into home dir failed', { pluginId }, error)
  }
  return central
}

export function writePluginConfig(pluginId: string, config: Record<string, unknown> | null): void {
  // §7.4 拆除闩。
  if (isPluginDemolished(pluginId)) {
    log.warn('ignoring plugin config write: plugin uninstalled and home dir archived', { pluginId })
    return
  }
  const configPath = getCorePluginConfigPath(getPluginsDir(), pluginId)
  if (config === null) {
    try {
      fs.rmSync(configPath, { force: true })
    } catch (error) {
      log.error('remove plugin config failed', { pluginId }, error)
    }
  } else {
    assertNotInNodeModules(getPluginsDir(), configPath)
    writeJsonFile(configPath, config)
  }
  // 中央残留行顺手抹掉 —— 有行才重写中央文件。
  const settings = readPluginSettings()
  if (settings.config?.[pluginId] !== undefined) {
    writePluginSettings(setPluginConfigInSettings(settings, pluginId, null))
  }
}

export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const pluginSettingsStorageAdapters: CorePluginSettingsStorageAdapters = {
    readSettings: readPluginSettings,
    writeSettings: writePluginSettings,
  };
  setPluginEnabledWithAdapters(pluginId, enabled, pluginSettingsStorageAdapters)
  // 显式启用 = 一次清账:熔断状态与失败计数不跨越它,否则重新启用的插件会带着
  // 上一次的红态复活。
  if (enabled) clearPluginRuntimeHealth(pluginId)
}

/**
 * 内置插件清单。
 *
 * **进这张表的判据是"离了宿主活不了"**,不是"我们写的"。2026-08-12 memory-wiki
 * 按这条判据退出:它只用注入 api 上的四样东西(storage.files / registerTool /
 * registerPromptContextProvider / settings.onChange),住在这里唯一换来的是
 * "不能单独发版"。它现在是市场包 `@onething-plugins/memory-wiki` —— 同 id、同
 * 家目录(`plugins/memory-wiki/`),用户的 config.json 与 wiki 数据零迁移。
 *
 * 退役之后这张表就不再占着 `memory-wiki` 这个 id,同 id 的 npm 包才装得进
 * (防撞闸见 `CorePluginManager.installPlugin`:内置先占位,装了也永远不显示)。
 */
function getBuiltinPlugins(): PluginDefinition[] {
  return createBuiltinPluginDefinitions<PluginEntry>([
    {
      id: 'log-monitor',
      manifest: logMonitorManifest,
      entry: logMonitorPlugin,
      enabled: getPluginEnabled('log-monitor'),
    },
  ]) as PluginDefinition[]
}

/** Scan built-in and user plugin directories and return plugin definitions. */
/**
 * 某个插件在 manifest 里声明过的面板 id(R5)。
 *
 * 事实源是清单,不是活状态:面板注册发生在 entry 执行期间,那时插件还没进
 * pluginStates,只能从扫描结果里取。放在 loader 是因为 `scanPlugins` 在这里 ——
 * 让每个造 api 的地方各自去查清单,迟早会有一条路忘了查,然后把合法的注册
 * 判成"未声明"。
 *
 * **短 TTL 缓存**:`scanPlugins()` 会读一遍插件目录,而 createPluginAPI 是
 * per-plugin 调用的 —— N 个插件就是 N 次全盘扫描(启动期的 O(n²))。
 * 一次装配/一次刷新都发生在同一瞬间,一个很短的窗口就足以把它压回 O(n),
 * 又短到不会让"刚装上的插件"读到过期清单。
 */
const DECLARED_PANEL_IDS_TTL_MS = 1000
interface DeclaredContributes {
  panels: string[]
  /** 其中的 webview 面板(C 期)—— render 挂 `panel:init:<id>` 而不是 render。 */
  webviewPanels: string[]
  uiSlots: PluginContributionUiSlot[]
  /**
   * 声明了合法的 `contributes.theme.background`(G 期,L2.5)。
   *
   * 它是 `api.theme.updateBackground` 的门控。判据用的是与投影层**同一个**
   * `describePluginBackgroundProblem` —— 非法声明既画不出层,也不该给出调参口。
   */
  background: boolean
  /**
   * `contributes.permissions` 原文(N1)—— `api.sendMessage` / `api.sessions.*`
   * 的声明门。原文而不是过滤后的枚举:未知权限名向前兼容地留着,只有被消费的
   * 那几个参与判定。
   */
  permissions: string[]
}
let declaredPanelIdsCache: {
  at: number
  byPlugin: Map<string, DeclaredContributes>
} | null = null

function declaredContributesByPlugin(): Map<string, DeclaredContributes> {
  const now = Date.now()
  if (!declaredPanelIdsCache || now - declaredPanelIdsCache.at >= DECLARED_PANEL_IDS_TTL_MS) {
    const byPlugin = new Map<string, DeclaredContributes>()
    for (const definition of scanPlugins()) {
      const contributes = definition.manifest.contributes
      // 非法的 webview 声明 = **丢弃该 panel**(与未知锚点同规)。丢在这里而不是
      // 只在投影层标一下:declaredPanelIds 是 registerWorkspacePanel 的匹配依据,
      // 留着它等于"清单里说没有、注册却成功",而那个面板永远画不出来。
      const declared = (contributes?.panels ?? [])
        .filter(panel => !describePluginWebviewPanelProblem(panel, contributes?.webviewRoot))
      byPlugin.set(definition.id, {
        panels: declared.map(panel => panel.id),
        webviewPanels: declared.filter(isPluginWebviewPanel).map(panel => panel.id),
        uiSlots: contributes?.uiSlots ?? [],
        background: contributes?.theme?.background !== undefined
          && !describePluginBackgroundProblem(contributes.theme?.background),
        permissions: (contributes?.permissions ?? []).filter(item => typeof item === 'string'),
      })
    }
    declaredPanelIdsCache = { at: now, byPlugin }
  }
  return declaredPanelIdsCache.byPlugin
}

export function getDeclaredPanelIds(pluginId: string): string[] {
  return declaredContributesByPlugin().get(pluginId)?.panels ?? []
}

/** manifest 声明为 webview 形态、且声明合法的面板 id(C 期)。 */
export function getDeclaredWebviewPanelIds(pluginId: string): string[] {
  return declaredContributesByPlugin().get(pluginId)?.webviewPanels ?? []
}

/**
 * manifest contributes.uiSlots 里声明过的锚点块(R5.x)。
 * 与面板同一份缓存 —— 两个声明清单出自同一次目录扫描,不该各扫一遍。
 */
export function getDeclaredUiSlots(pluginId: string): PluginContributionUiSlot[] {
  return declaredContributesByPlugin().get(pluginId)?.uiSlots ?? []
}

/**
 * manifest 声明了合法背景(G 期,L2.5)—— `api.theme.updateBackground` 的门控。
 * 与面板/锚点块同一份缓存、同一条"声明先于代码"。
 */
export function getDeclaredBackground(pluginId: string): boolean {
  return declaredContributesByPlugin().get(pluginId)?.background ?? false
}

/**
 * manifest 的 `contributes.permissions` 原文(N1)—— 跨会话投递与感知快照的
 * 声明门。与面板/锚点块/背景同一份缓存、同一条"声明先于代码"。
 */
export function getDeclaredPermissions(pluginId: string): string[] {
  return declaredContributesByPlugin().get(pluginId)?.permissions ?? []
}

/**
 * 目录内容变了之后清缓存 —— 不等 TTL 自然过期。
 *
 * 接线的是 `refreshPlugins`(重扫目录)、安装/更新(换了 node_modules 里的包)
 * 与卸载(删源目录)—— 凡是让清单可能变化的动作,都要让这份缓存失效。
 */
export function invalidateDeclaredPanelIdsCache(): void {
  declaredPanelIdsCache = null
}

export function scanPlugins(): PluginDefinition[] {
  // desktop 用 npm-ledger 扫描语义(P1 拍板):以 plugins/package.json 为账
  // 扫 npm 插件。server 等只投影的宿主不调这里。插件根下"有 plugin.json 但
  // 不在账里"的手工目录不再加载(2026-08-09 legacy 清零)。
  const definitions = scanCorePlugins<PluginEntry>({
    builtinPlugins: getBuiltinPlugins(),
    pluginsDir: getPluginsDir(),
    getEnabled: pluginId => getPluginEnabled(pluginId),
    appVersion: getPluginAppVersion(),
    scanMode: 'npm-ledger',
  }) as PluginDefinition[]
  // 轻通道(独立小期):`plugins-dev/` 的单文件脚本,**追加**在账本扫描之后。
  // seenIds 带上已扫到的 id(内置 + npm),让本地脚本让位于同名的正式插件 ——
  // `plugins/` 的账本扫描到此一字未动(A 期保证不回退)。
  const localDefinitions = scanLocalPluginFiles<PluginEntry>({
    localPluginsDir: getLocalPluginsDir(),
    seenIds: new Set(definitions.map(def => def.id)),
    getEnabled: pluginId => getPluginEnabled(pluginId),
  }) as PluginDefinition[]
  localPluginIds.clear()
  for (const def of localDefinitions) localPluginIds.add(def.id)
  definitions.push(...localDefinitions)
  // 启动可见性:用户该知道 plugins-dev 里有什么在跑。只在集合变化时吼一声 ——
  // scanPlugins 是热路径(createPluginAPI per-plugin 会触发),每轮都打会刷屏。
  const localIdsSignature = [...localPluginIds].sort().join(',')
  if (localIdsSignature !== loggedLocalPluginIds) {
    loggedLocalPluginIds = localIdsSignature
    if (localPluginIds.size > 0) {
      log.info('loaded local dev plugin scripts', {
        count: localPluginIds.size,
        pluginIds: [...localPluginIds].sort(),
      })
    }
  }
  // 拆除闩的解除(§7.4):扫描里再现 = 已重装,闩自动放开。
  if (demolishedPluginIds.size > 0) {
    const found = new Set(definitions.map(def => def.id))
    for (const id of [...demolishedPluginIds]) {
      if (found.has(id)) demolishedPluginIds.delete(id)
    }
  }
  return definitions
}

/**
 * npm 生命周期(install/update/uninstall)的单次预算。
 *
 * 名字留在 loader 是历史位置;真正的消费者在 install.ts —— 加载期已经没有
 * npm install 了(2026-08-09 随 legacy 目录插件一起退役)。
 */
export const PLUGIN_NPM_INSTALL_TIMEOUT_MS = 120_000

/**
 * Load a plugin's entry module dynamically.
 *
 * `reloadToken` 走 ESM cache-buster:裸 import 会命中模块缓存,改一行插件代码
 * 就得重启整个 app。manager 每次 enable 递增它,于是 disable→enable 拿到的是
 * **新模块**。
 */
export async function loadPluginEntry(
  def: PluginDefinition,
  reloadToken?: string | number,
): Promise<PluginEntry | null> {
  const loadCorePluginEntryAdapters: LoadCorePluginEntryAdapters<PluginEntry> = {
    importEntry: entryPath => import(buildPluginEntryImportSpecifier(entryPath, reloadToken)),
    logger: consoleLog,
  };
  return loadCorePluginEntry(def, loadCorePluginEntryAdapters)
}

/** Create the plugin directories if they don't exist */
export function ensurePluginDirs(): void {
  ensureCorePluginsDir(getPluginsDir(), console)
}
