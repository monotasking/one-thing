/**
 * 深链(H4)的装配层出口。
 *
 * 这里没有 Electron:协议注册、窗口聚焦、确认卡的 IPC 投递全在
 * `apps/electron/src/deeplink/`。装配层只回答两件事 —— "这条链要给用户看什么"
 * (confirm-card)与"确认之后交给谁跑"(registry)。
 */
export {
  DEEPLINK_CARD_SOURCE_LABEL,
  buildDeepLinkCard,
  resolvePluginDisplayName,
} from './confirm-card.js'
export type {
  DeepLinkAskCard,
  DeepLinkCard,
  DeepLinkPluginCard,
  DeepLinkRejectionCard,
} from './confirm-card.js'
export {
  describePluginDeepLinkAction,
  invokePluginDeepLinkAction,
  listPluginDeepLinkActions,
  registerPluginDeepLinkAction,
  resetPluginDeepLinkActionsForTests,
} from './registry.js'
export type {
  InvokePluginDeepLinkOptions,
  InvokePluginDeepLinkOutcome,
  PluginDeepLinkActionInfo,
} from './registry.js'
