/**
 * `backend` RPC 域:后端进程自己的生命周期(第④步批 3)。今天只有 `shutdown`。
 *
 * 两道闸,都在处理者这一侧判:
 *  - **本机可信的来访者才行**(`isHostLocallyTrusted()`,与 `memory.trim` 同一档)—— 停掉后端会断开所有客户端;
 *  - **这只进程得是独立后端进程**:进程入口登记过收尾函数(`lifecycle-process-shutdown.ts`)才答应。进程内嵌的后端
 *    (冒烟探针那种)没有登记,答一句结构化的拒绝,不会把宿主进程带走。
 *
 * 收尾走的是进程入口自己那条路(与 SIGTERM 同一条:等拆除跑完、会话落盘、删发现文件),排在这次应答写出去之后。
 * 拉起者要不要停这台(「CLI 只停自己拉起的那台」)不是这里判的 —— 那是客户端读发现文件就能答的事,见
 * `apps/cli/src/backend-command.ts`。
 */
import { backendRouter, type BackendRoutes } from '@shared/ipc/backend.js'
import { isHostLocallyTrusted } from '@onething/backend/http-server/http-server-host-trust.js'
import { defineClientApi, type RpcRouteHandlers } from '@onething/backend/http-server/http-server-dispatch-table.js'
import { canRequestProcessShutdown, requestProcessShutdown } from './lifecycle-process-shutdown.js'

export const backendRpcHandlers: RpcRouteHandlers<BackendRoutes> = {
  async shutdown() {
    if (!isHostLocallyTrusted()) throw new Error('backend.shutdown is only available to locally trusted callers')
    if (!canRequestProcessShutdown()) throw new Error('This backend is not a standalone process; stop it from the app that runs it.')
    // 先把应答写出去,再开始收尾:收尾第一步就是关 HTTP 入口。
    setTimeout(() => { requestProcessShutdown('backend.shutdown') }, 50)
    return { accepted: true as const, pid: process.pid }
  },
}

/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `backend` 的契约与处理者。 */
export const BACKEND_CLIENT_API = defineClientApi({ id: 'rpc:backend', router: backendRouter, handlers: backendRpcHandlers })
