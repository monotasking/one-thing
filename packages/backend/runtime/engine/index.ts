export {
  ProductStreamEngine,
  type BindableStreamSender,
  type ProductEditAndResendCommand,
  type ProductSendMessageCommand,
  type StreamSender,
  type StreamSenderPayload,
} from './stream-engine.js'
export type {
  EngineAgentModelBinding,
  EngineMessageOrigin,
  EngineOriginTransport,
  EngineRoutedSession,
  ProductStreamEnginePorts,
  StreamEngineAgentBindingPort,
  StreamEnginePluginInterceptPort,
  StreamEngineRoomIngressPort,
  StreamEngineSessionRouterPort,
  StreamEngineSteeringDeliveryPort,
} from './ports.js'
export { mintTurnPrincipal } from './turn-principal.js'
export {
  isSystemInternalSource,
  pluginMessageSource,
  taskMessageSource,
  PLUGIN_MESSAGE_SOURCE_PREFIX,
  SYSTEM_INTERNAL_MESSAGE_SOURCES,
  TASK_MESSAGE_SOURCE_PREFIX,
} from './message-sources.js'

// ── providers 归位(D24,2026-10-04)从 `providers/` 搬来的「用服务商干活」那几只:发一轮对话 / 起标题的门面、
// 按本进程宿主能力造这一轮要用的 AgentProvider、后台杂活回合用哪个模型跑。外面真在用的名字逐个列出。
export {
  configureAppProviderRegistry,
  generateChatResponse,
  generateChatTitle,
  getAvailableProviders,
  isProviderSupported,
} from './engine-chat-facade.js'
export {
  createAgentProviderFromRuntime,
} from './engine-provider-factory.js'
export {
  createUtilityProvider,
} from './engine-utility-provider.js'
export type {
  UtilityProviderRef,
} from './engine-utility-provider.js'
