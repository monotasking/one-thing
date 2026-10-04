/**
 * 进程壳的公共出口。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后,HTTP/SSE 面与 server runtime
 * 的**实现**住在装配层 `@onething/backend/http-server` —— 桌面主进程和这个进程壳挂的
 * 是同一份代码。这里只保留转出,免得旧的包入口引用一次性断掉(包名 2026-10-04 由 `@onething/server-host` 改为 `@onething/backend-server`,决策 D120)。
 */
export {
  createOnethingHttpServer,
  createOnethingServerRequestHandler,
} from '@onething/backend/http-server'
export {
  createFileServerSettingsStore,
  createDevelopmentOnethingServerRuntime,
  createOnethingServerRuntimeOverBackend,
  createSingleFileServerSettingsStore,
} from '@onething/backend/http-server'
export {
  readHttpDiscovery,
  writeHttpDiscovery,
  removeHttpDiscovery,
  isHttpDiscoveryAlive,
  getHttpDiscoveryPath,
} from '@onething/backend/http-server'
export type {
  OnethingHttpServerOptions,
  OnethingServerRequestHandler,
} from '@onething/backend/http-server'
export type {
  OnethingServerRuntime,
  ServerSettingsStore,
} from '@onething/backend/http-server'
export type { HttpDiscoveryRecord } from '@onething/backend/http-server'
