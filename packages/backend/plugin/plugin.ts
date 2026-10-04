export {
  ONETHING_LOG_MONITOR_DEFAULT_CONFIG,
  ONETHING_LOG_MONITOR_MANIFEST,
  createOnethingLogMonitorSearchToolParameters,
  registerOnethingLogMonitorPanel,
  registerOnethingLogMonitorPlugin,
  registerOnethingLogMonitorStatusDemo,
  resolveOnethingLogMonitorConfig,
} from './plugin-log-monitor.js'
/*
 * memory-wiki 曾经在这里导出一整屏。2026-08-12 它退出内置搬进市场仓
 * (`monotasking/plugin` 的 `packages/memory-wiki`,包名
 * `@onething-plugins/memory-wiki`)—— 判据是"离了宿主活不了"才留在内置,而它
 * 只用注入 api 上的四样东西。同 id、同家目录,用户数据零迁移。
 *
 * 这里不留转发桩:一个没有实现的导出面只会让下一个人以为宿主还认识它。
 *
 * `note-skills` 于 2026-09-18 走了同一条路的另一头 —— 它不是搬去市场,是**退役**:
 * 「笔记库里的技能」今天由技能加载器直接吃(`listCustomSkillRoots` 那条 `custom:`
 * 链路),不再需要一个插件来当中间人(正本 `docs/design/notes-obsidian-cli-2026-09.md`
 * §4.4)。同样不留转发桩。
 */
// IM 连接器登记表(`api.registerIMConnector` 那一张,渠道网关的出站回复也读它)。包根归位 B(2026-10-04)
// 从包根 `channel/connector-registry.ts` 搬来:它零依赖,写它的是插件、读它的是网关(L3),放在插件这一层两边都顺。
export {
  configureIMConnectorHooks,
  getIMConnector,
  getIMConnectorOwner,
  listIMConnectorIds,
  registerIMConnector,
  sendIMReply,
  type RegisterIMConnectorOptions,
} from './plugin-im-connector-registry.js'
export * from './plugin-command-execution.js'
export * from './plugin-ipc-operations.js'
export * from './plugin-list.js'
export * from './plugin-theme-overrides.js'
export * from './plugin-config-schema.js'
export type {
  OnethingLogMonitorConfig,
  OnethingLogMonitorPanelApi,
  OnethingLogMonitorPluginApi,
  OnethingLogMonitorStatusApi,
  OnethingLogMonitorSearchToolParameters,
  RegisterOnethingLogMonitorPluginOptions,
} from './plugin-log-monitor.js'
// 插件的提示词源(越层清零 C1,2026-10-04 从 prompt/ 搬来)。同名的 `registerPromptContextProvider`
// 交出的是带断路器的那一半(`plugin-prompt-context-breaker.ts`);不带健康回调的泛型那一半
// (`plugin-prompt-context.ts`)只交出它的源类,给要自己拼 composer 的调用方。
export {
  pluginPromptSource,
  registerPromptContextProvider,
  type PromptProviderConfig,
} from './plugin-prompt-context-breaker.js'
export { PluginPromptContextSource } from './plugin-prompt-context.js'
