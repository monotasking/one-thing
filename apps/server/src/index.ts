/**
 * 进程壳的公共出口。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后,HTTP/SSE 面与 server runtime
 * 的**实现**住在装配层 `@onething/backend/server/*` —— 桌面主进程和这个进程壳挂的
 * 是同一份代码。这里只保留转出,免得旧的 `@onething/server-host` 引用一次性断掉。
 */
export {
  createOnethingHttpServer,
  createOnethingServerRequestHandler,
} from '@onething/backend/server/http.js'
export {
  createFileServerSettingsStore,
  createDevelopmentOnethingServerRuntime,
  createOnethingServerRuntimeOverBackend,
  createSingleFileServerSettingsStore,
} from '@onething/backend/server/runtime.js'
export {
  readHttpDiscovery,
  writeHttpDiscovery,
  removeHttpDiscovery,
  isHttpDiscoveryAlive,
  getHttpDiscoveryPath,
} from '@onething/backend/server/discovery.js'
export type {
  OnethingHttpServerOptions,
  OnethingServerRequestHandler,
} from '@onething/backend/server/http.js'
export type {
  OnethingServerRuntime,
  ServerSettingsStore,
} from '@onething/backend/server/runtime.js'
export type { HttpDiscoveryRecord } from '@onething/backend/server/discovery.js'
