/**
 * 装配层的 HTTP/SSE 面(A 期,docs/design/one-core-2026-08.md §3)。
 *
 * 这里是**唯一**一份 core 服务传输面代码:`server:start` 的进程壳挂它,
 * Electron 桌面主进程在 backend 就绪后也挂它 —— 两者是同一份代码的两种启动
 * 方式,不是两套。
 */
export {
  createOnethingHttpServer,
  createOnethingServerRequestHandler,
  type OnethingHttpServerOptions,
  type OnethingServerRequestHandler,
} from './http.js'
export {
  createDevelopmentOnethingServerRuntime,
  createOnethingServerRuntimeOverBackend,
  createFileServerSettingsStore,
  createSingleFileServerSettingsStore,
  toOnethingServerBackend,
  type OnethingServerRuntime,
  type OnethingServerRuntimeOptions,
  type OnethingServerRuntimeOverBackendOptions,
  type ServerSettingsStore,
} from './runtime.js'
export {
  getHttpDiscoveryPath,
  httpDiscoveryUrl,
  isHttpDiscoveryAlive,
  readHttpDiscovery,
  removeHttpDiscovery,
  writeHttpDiscovery,
  HTTP_DISCOVERY_FILENAME,
  type HttpDiscoveryOwner,
  type HttpDiscoveryRecord,
} from './discovery.js'
