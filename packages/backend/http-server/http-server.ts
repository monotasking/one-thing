/**
 * http-server —— 界面连进来的那台 HTTP 服务器(决策 D21 / D26,`docs/design/backend-structure-decisions-2026-10.md`)。
 *
 * 它做的事:收请求、开 SSE 事件流、写发现文件(`<store>/run/http.json`)、认来访者(Bearer token 与本机信任)、
 * 按名册把 `POST /api/rpc` 分发给各功能开给界面的操作(`runtime/<功能>/<功能>-client-api*.ts`)。
 * 它不认识任何具体功能:哪些功能有界面操作,只写在 `http-server-client-api-roster.ts` 那一张名册里。
 *
 * 这里是**唯一**一份 core 服务传输面代码:`server:start` 的进程入口(`packages/backend/backend-standalone-main.ts`)挂它,
 * Electron 桌面主进程在 backend 就绪后也挂它(`startEmbeddedOnethingHttpServer`)—— 两者是同一份代码的两种启动方式。
 *
 * 对外交出四类东西,只给宿主(`packages/backend/backend-standalone-main.ts`、`apps/desktop-react/electron`、冒烟脚本)用:
 *   1. HTTP 面本身:建服务器 / 请求处理函数;
 *   2. server runtime:不带界面单独跑时那台 backend 与它的设置仓;
 *   3. 发现文件:谁在服务这个 store、端口与 token 在哪;
 *   4. 桌面内嵌:在桌面自己的 backend 上挂起 / 摘下同一份 HTTP 面,以及宿主声明本机信任。
 *
 * 功能代码不经这个入口:它会把整台服务器(连同 server runtime 与装配配方)拖进来。功能要的几只小件
 * (本机信任、沙箱、发现文件、门面类型)走各自的深层键 `@onething/backend/http-server/http-server-<x>.js`。
 */

// 1. HTTP 面
export {
  createOnethingHttpServer,
  createOnethingServerRequestHandler,
  type OnethingHttpServerOptions,
  type OnethingServerRequestHandler,
} from './http-server-routes.js'

// 2. server runtime
export {
  createDevelopmentOnethingServerRuntime,
  createOnethingServerRuntimeOverBackend,
  toOnethingServerBackend,
  type OnethingServerRuntime,
  type OnethingServerRuntimeOptions,
  type OnethingServerRuntimeOverBackendOptions,
} from './http-server-runtime.js'
export {
  createFileServerSettingsStore,
  createSingleFileServerSettingsStore,
  type ServerSettingsStore,
} from '../settings/settings-client-api-server-store.js'

// 3. 发现文件
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
} from './http-server-discovery.js'

// 4. 桌面内嵌与本机信任
export {
  getEmbeddedOnethingHttpServer,
  startEmbeddedOnethingHttpServer,
  stopEmbeddedOnethingHttpServer,
  type EmbeddedOnethingHttpServer,
  type EmbeddedOnethingHttpServerOptions,
} from './http-server-embed.js'
export { configureHostLocalTrust } from './http-server-host-trust.js'
