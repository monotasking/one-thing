/**
 * 深链(H4)的装配层出口。
 *
 * 这里没有 Electron:协议注册、窗口聚焦、确认卡的 IPC 投递全在
 * `apps/electron/src/deeplink/`。装配层只回答两件事 —— "这条链要给用户看什么"
 * (confirm-card)与"确认之后交给谁跑"(registry)。
 *
 * 另交出深链的词汇与插件深链动作的登记契约(`deeplink-contract.ts`,D202 从插件功能搬回)。确认卡上的插件显示名
 * 随登记携带、从登记表读(D203),所以本功能**不引插件**:插件写表(经 `registerPluginDeepLinkAction`),深链读表。
 * 依赖(入口值闭包实测,511 只文件):agent(确认卡点名 agent)、plugin-contract(作用域与健康账)、logging 等。
 */
export {
  DEEPLINK_CARD_SOURCE_LABEL,
  buildDeepLinkCard,
  resolvePluginDisplayName,
} from './deeplink-confirm-card.js'
export type {
  DeepLinkAskCard,
  DeepLinkCard,
  DeepLinkPluginCard,
  DeepLinkRejectionCard,
} from './deeplink-confirm-card.js'
export {
  describePluginDeepLinkAction,
  invokePluginDeepLinkAction,
  listPluginDeepLinkActions,
  registerPluginDeepLinkAction,
  resetPluginDeepLinkActionsForTests,
} from './deeplink-registry.js'
export type {
  InvokePluginDeepLinkOptions,
  InvokePluginDeepLinkOutcome,
  PluginDeepLinkActionInfo,
} from './deeplink-registry.js'

// 深链的词汇与插件深链动作的登记契约(D202 从插件功能搬回来成 `deeplink-contract.ts`:URL 语法、声明门、
// 动作名形状、超时预算、返回值整形;全仓读者只有插件与深链自己)。
export {
  DEEPLINK_TEXT_MAX_BYTES,
  normalizePluginDeepLinkResult,
  PLUGIN_DEEPLINK_ACTION_NAME_PATTERN,
  PLUGIN_DEEPLINK_HANDLE_PERMISSION_NOTE,
  PLUGIN_DEEPLINK_HANDLER_TIMEOUT_MS,
  PLUGIN_PERMISSION_DEEPLINK_HANDLE,
  pluginDeepLinkAddress,
  pluginDeepLinkSurface,
} from './deeplink-contract.js'
export type {
  CorePluginDeepLinkActionRegistration,
  CorePluginDeepLinkResult,
  DeepLinkIntent,
  DeepLinkParseResult,
} from './deeplink-contract.js'
