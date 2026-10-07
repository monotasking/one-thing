/**
 * gateway —— IM 渠道网关(微信 / Telegram):渠道、白名单与限流、网关桥与会话登记,
 * 以及装配把网关接进引擎要用的几样东西。
 *
 * 对外交出四类东西:
 * - 渠道与渠道配置:两种渠道、从环境变量读渠道 / 权限配置;
 * - 网关内核(hub):`Gateway`、`GatewayBridge`、白名单、限流、会话登记、日志口与它们的形状;
 * - 装配用的:从引擎 runtime 造对话 runtime、对话 runtime 的形状、渠道会话路由、出站回复派发、
 *   给模型的渠道上下文登记 / 撤销、宿主注入口(`configureGatewayHost` 一族)与后端进程自己实现的那台生命周期机器
 *   (`createBackendGatewayHost`,第④步批 4);
 * - 独立网关的启动函数 `startGateway` / `startGatewayFromEnv`(转交自 `gateway-standalone.ts`,给将来的进程壳用)。
 *
 * 本文件只交名字,不做事:从前它同时是独立网关进程的启动脚本(被当成主模块执行就起网关),
 * 打进单文件包以后装配一引它就会起一台网关(D184)。启动面现在住在 `gateway-standalone.ts`,
 * 进程入口是 `gateway-standalone-main.ts`(谁都不许 import 它,`bun run gateway:start` 跑它)。
 *
 * 依赖(入口值闭包实测,1340 只文件):对话 runtime 的工厂经引擎与协作把几乎整棵产品树带进来(session、engine、collab、
 * agent-loop、provider、toolkit……共 56 个功能)与包根的当前实例槽、共享层 —— 读者只有包根、L4 面与脚本,单测装载变重是
 * 交出装配名字的代价(D202 §4);独立网关的进程入口不经这里。
 */

export {
  TelegramChannel,
} from './channels/telegram/telegram.js'
export {
  WechatChannel,
  clearAuthState as clearWechatAuthState,
} from './channels/wechat/wechat.js'
export type {
  WechatAuthEvent,
} from './channels/wechat/wechat.js'
export {
  isGatewayEnabledFromEnv,
  readGatewayChannelIdsFromEnv,
  readGatewayPermissionConfigFromEnv,
} from './gateway-config.js'
export type {
  GatewayChannelId,
  GatewayPermissionConfig,
  GatewayPermissionMode,
} from './gateway-config.js'
export {
  Allowlist,
  configureGatewayLogging,
  Gateway,
  GatewayBridge,
  gatewayLogger,
  GatewaySessionRegistry,
  RateLimiter,
} from './hub/gateway-hub.js'
export type {
  GatewayLoggerFactory,
  Logger as GatewayLoggerInstance,
} from './hub/gateway-hub.js'
export type {
  AllowlistConfig,
  Channel,
  GatewayBridgeOptions,
  GatewayCommandExecutionRequest,
  GatewayCommandExecutionResult,
  GatewayCommandInfo,
  GatewayCommandProvider,
  GatewaySession,
  GatewaySessionRegistryOptions,
  InboundActor,
  InboundMessage,
  OutboundMessage,
  RateLimiterConfig,
} from './hub/gateway-hub.js'

// ── 装配用的(D202:从前 backend-assemble-engine 等读者直取内部文件)──────────────
export { createOnethingRuntimeFromStreamRuntime } from './gateway-onething-runtime.js'
export type { OnethingRuntime } from './gateway-onething-runtime.js'
export type {
  CoreConversationRuntime,
  CoreTextStreamChunk,
} from './gateway-conversation-runtime.js'
export { getChannelSessionRouter } from './gateway-channel-session-router.js'
export { OutboundReplyDispatcher } from './gateway-outbound-reply-dispatcher.js'
export {
  registerChannelPromptContextProvider,
  unregisterChannelPromptContextProvider,
} from './gateway-channel-prompt-context.js'
export {
  configureGatewayHost,
  getGatewayHost,
  resetGatewayHost,
} from './gateway-lifecycle-port.js'
export type { GatewayHostPorts } from './gateway-lifecycle-port.js'
// 后端进程自己那台网关生命周期机器(第④步批 4:网关跟着后端运行,`backend-launcher.ts` 接线)。
export { createBackendGatewayHost } from './gateway-host.js'
export type { BackendGatewayHost } from './gateway-host.js'

// ── 独立网关的启动函数(转交自启动面;进程入口是 gateway-standalone-main.ts)────────
export {
  startGateway,
  startGatewayFromEnv,
} from './gateway-standalone.js'
export type {
  GatewayRuntime,
  StartGatewayFromEnvOptions,
  StartGatewayOptions,
} from './gateway-standalone.js'
