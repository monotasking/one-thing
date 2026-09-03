/**
 * `@onething/client` —— core 的客户端底座(`docs/design/client-sdk-2026-09.md`)。
 *
 * 三段自下而上:**transport**(唯一的可换点)→ **rpc**(泛型域客户端)→
 * **events / model**(事件枢纽与纯判据)。零 React / 零 Vue / 零 Electron,
 * 浏览器与 Node 同一份代码 —— 由 `bun run gate:client` 在系统 Node 与 Electron
 * 两个运行时各跑一遍真 SSE 证明,不靠这段注释。
 *
 * **不在本包的**(§4.3 判据:凡是不经 core 就能答的,不进来):系统主题
 * (`matchMedia`)、剪贴板、打开外链、文件对话框 —— 那些是宿主能力,住在各壳
 * 自己的 `platform/host.ts`。
 *
 * Node 专用面(读 `<store>/run/http.json`)在子路径 `@onething/client/node`,
 * 浏览器构建永远不引它。
 */
export { createOnethingClient } from './client.js'
export type { CreateOnethingClientOptions, OnethingClient } from './client.js'

export { createHttpTransport } from './transport/http.js'
export type { FetchLike, HttpTransportOptions } from './transport/http.js'
export { createMemoryTransport } from './transport/memory.js'
export type {
  MemoryHandler,
  MemoryTransport,
  MemoryTransportOptions,
} from './transport/memory.js'
export { parseSseStream } from './transport/sse.js'
export type { ParseSseStreamOptions, SseMessage } from './transport/sse.js'
export type {
  ClientLogger,
  HostCapabilities,
  Transport,
  TransportConnectionState,
  TransportEvent,
  TransportEventName,
  TransportEvents,
  TransportEventsOptions,
} from './transport/types.js'

export { RpcError, createRouterClient } from './rpc/router-client.js'
export type { RpcInvoke } from './rpc/router-client.js'

export { createEventHub } from './events/subscriptions.js'
export type {
  CreateEventHubOptions,
  EventHub,
  EventHubStatus,
  Unsubscribe,
} from './events/subscriptions.js'
export {
  foldSessionLifecycleEvent,
  onSessionLifecycle,
} from './events/session-lifecycle.js'
export type {
  SessionCreatedLifecycleEvent,
  SessionDeletedLifecycleEvent,
  SessionLifecycleEvent,
} from './events/session-lifecycle.js'

export {
  isProviderConfigEnabled,
  isProviderEnabledIn,
  resolveProviderModelSelection,
} from './model/provider-model.js'
export type {
  AgentModelBindingLike,
  ProviderEnabledOverride,
  SessionModelLike,
  SpaceDefaultSelectionLike,
} from './model/provider-model.js'
