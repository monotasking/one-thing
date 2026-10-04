/**
 * plugin —— 插件系统:从 npm 账本装载插件、注入的 `api` 对象、各种登记(提示词源、深链接、检索供给方、
 * 凭证策略、IM 连接器……)、健康与断路器、插件主题覆盖与皮肤,以及插件市场的安装 / 卸载。
 * 插件与宿主约定的词汇(作用域、表面、策略、健康账、三张登记契约)住 `plugin-contract`(D202),本入口不转交。
 *
 * 对外交出八类东西(按段分组):
 * - 装配:插件管理器的取用口、宿主注入口、插件自带的小模型服务、内置插件(log-monitor);
 * - 插件 API 与定义的形状、插件信息;
 * - 磁盘与账本:插件目录、设置文件的读写、启用开关、扫描与内置定义、市场索引与 npm 安装;
 * - 回合里的钩子:输入拦截、工具调用 / 结果拦截、回复后与压缩前的生命周期钩子、会话间投递;
 * - 提示词源:带断路器的登记与源、不带健康回调的源类;
 * - 主题覆盖与皮肤;
 * - IM 连接器的出站回复;
 * - 开给设置页的列 / 开 / 关 / 刷新 / 执行命令与调试日志口。
 * 依赖 provider-call、provider、credentials、resource、toolkit、session、theme、scheduler、search、storage、logging 等。
 */

// 装配。
export { getPluginManager } from './plugin-system.js'
export { configurePluginsHost, resetPluginsHost } from './plugin-host-ports.js'
export type { PluginsHostPorts } from './plugin-host-ports.js'
export { PluginLlmService } from './plugin-llm-service.js'
export {
  ONETHING_LOG_MONITOR_MANIFEST,
  registerOnethingLogMonitorPanel,
  registerOnethingLogMonitorStatusDemo,
} from './plugin-log-monitor.js'

// 插件 API 与定义的形状。
export type { CorePluginCommandDefinition, CorePluginDefinition, PluginSettings } from './plugin-api-types.js'
export type { CorePluginInfo } from './plugin-manager-base.js'
export type { CorePluginSchedulerHost } from './plugin-scheduler.js'

// 磁盘与账本、市场。
export {
  createBuiltinPluginDefinitions,
  ensureCorePluginsDir,
  getCorePluginSettingsPath,
  getCorePluginsDir,
  getPluginEnabledWithAdapters,
  readPluginLedger,
  readPluginSettingsFile,
  scanCorePlugins,
  setPluginEnabledWithAdapters,
  unscopedPluginIdFromPackageName,
  writePluginSettingsFile,
} from './plugin-loader.js'
export type { CorePluginSettingsStorageAdapters } from './plugin-loader.js'
export { getPluginsDir } from './plugin-disk-loader.js'
export { CorePluginStore } from './plugin-store.js'
export { PLUGIN_PACKAGE_SCOPE, readPluginTarballSummary } from './plugin-tarball.js'
export { findMarketIndexEntry } from './plugin-install.js'
export type { CorePluginMarketIndex } from './plugin-install.js'
export {
  configurePluginMarketIndex,
  getPluginMarketIndexSnapshot,
  installPluginPackage,
  probePluginNpmAvailability,
  uninstallPluginPackage,
} from './plugin-npm-process.js'

// 健康与作用域、深链 / 检索供给方 / 凭证策略三张登记的契约:D202 起住插件词汇 `@onething/backend/plugin-contract`
// (深链那一份住 `@onething/backend/deeplink`),本入口不再转交别的功能的名字。

// 回合里的钩子。
export { runPluginInputIntercept } from './plugin-input-intercept-bound.js'
export { runPluginToolCallIntercept } from './plugin-tool-call-intercept-bound.js'
export { runPluginToolResultIntercept } from './plugin-tool-result-intercept-bound.js'
// 工具目录的拦截端口(D191):装配在造目录时把它递进 `buildToolkitCatalog`,工具目录不再直接认识上面两条链。
export { pluginToolInterceptor } from './plugin-tool-interceptor.js'
export { runAfterAssistantResponseHooks, runBeforeContextCompactHooks } from './plugin-lifecycle-hooks.js'
export type { BeforeContextCompactContext } from './plugin-lifecycle-hooks.js'
export { deliverInternalMessage, pluginPostInterceptReply } from './plugin-session-messenger.js'
export type { PluginInterceptSteerPort } from './plugin-session-messenger.js'

// 插件的提示词源(越层清零 C1,2026-10-04 从 prompt/ 搬来)。同名的 `registerPromptContextProvider`
// 交出的是带断路器的那一半(`plugin-prompt-context-breaker.ts`);不带健康回调的泛型那一半
// (`plugin-prompt-context.ts`)只交出它的源类,给要自己拼 composer 的调用方。
export {
  pluginPromptSource,
  registerPromptContextProvider,
  type PromptProviderConfig,
} from './plugin-prompt-context-breaker.js'
export { PluginPromptContextSource } from './plugin-prompt-context.js'

// 主题覆盖与皮肤。
export { getPluginThemeKnobVariables, getPluginThemeOverrideTokenValues } from './plugin-theme-override-table.js'
export { getPluginSkinTiers } from './plugin-skin-table.js'

// IM 连接器(`api.registerIMConnector` 那一张)的出站回复,渠道网关读它。包根归位 B(2026-10-04)
// 从包根 `channel/connector-registry.ts` 搬来。
export { sendIMReply } from './plugin-im-connector-registry.js'

// 开给设置页的操作与调试日志口。
export {
  disableOnethingPluginForIpc,
  enableOnethingPluginForIpc,
  executeOnethingPluginCommandForIpc,
  listOnethingPluginCommandsForIpc,
  listOnethingPluginsForIpc,
  refreshOnethingPluginsForIpc,
} from './plugin-ipc-operations.js'
export type { OnethingPluginIpcLogger } from './plugin-ipc-operations.js'
