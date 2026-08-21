/**
 * scratchpad(每会话草稿纸)域 —— 结构债 P4c 的第五个域。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/scratchpad.ts` 的手写 IPC 工厂与
 *    `apps/electron/src/main/ipc/scratchpad.ts` 里那四条 try/catch 壳;
 *  - `preload/bridge.ts` 的四条包装与 `platform/web.ts` 的四条
 *    `/api/scratchpad/*` 镜像;
 *  - `app/server/http.ts` 的四条 REST 路由与 `server/runtime.ts` 里
 *    `scratchpad` adapter 的四个方法。
 *
 * **广播那条留在原地**(与 spaces / practice 同一形状):`SCRATCHPAD_CHANGED` 早就是
 * 注入端口(`configureScratchpadHost`),而 router 今天只有请求/响应面、没有推送面。
 * 所以 `@main/ipc/scratchpad.ts` 迁完只剩那一个 `broadcastChanged` 注入,server 侧的
 * `GET /api/scratchpad/events` SSE 与 `scratchpad.subscribeChanged` adapter 也一并保留 ——
 * 它们是**推送面**,不是这次搬走的请求面。
 *
 * 逐条对着旧文件抄的形状:四个方法各自 try/catch,把异常压成
 * `{ success:false, error }`(渲染侧那套 `response.success` 判断照旧成立),
 * `get`/`update` 成功时带 `document`,`delete`/`adopt` 只回 `{ success:true }`。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import { scratchpadRouter, type ScratchpadRoutes } from '@shared/ipc/scratchpad.js'
import {
  adoptScratchpad,
  readScratchpad,
  removeScratchpad,
  updateScratchpad,
} from '../../scratchpad/index.js'
import { registerRouterHandlers } from '../registry.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const scratchpadRpcHandlers: RouteHandlers<ScratchpadRoutes> = {
  async get(request) {
    try {
      return { success: true, document: await readScratchpad(request.sessionId) }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async update(request) {
    try {
      return {
        success: true,
        document: await updateScratchpad(request.sessionId, request.content),
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  async delete(request) {
    try {
      await removeScratchpad(request.sessionId)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
  // 草稿会话物化成真会话时把那份纸改名认领过去 —— 一次搬家,不是复制。
  async adopt(request) {
    try {
      await adoptScratchpad(request.fromSessionId, request.toSessionId)
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
}

export function registerScratchpadRpcDomain(): () => void {
  return registerRouterHandlers(scratchpadRouter, scratchpadRpcHandlers)
}
