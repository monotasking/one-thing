/**
 * 用户提示词片段（主线 T1 第一批）。
 *
 * 一份实现服务三个宿主：desktop 的 `apps/electron/src/main/ipc/prompts.ts`
 * （已删）、server 的 `/api/prompts*` 五条路由（已删）、以及 web 侧那五个
 * 手写 fetch（已删）。
 *
 * **口径变化（明写在这里，不藏）**：server 原先按 owner 分库
 * （`<dataRoot>/owners/<uid>/<wid>/prompts.json`，`getPromptStoreForContext`），
 * 通用 RPC 信封不带 request context，所以迁移后 server 读的是与 desktop 同一份
 * `<store>/prompts.json`。这正是「一份实现、两个宿主」的意思——单用户前提下
 * （apps/server 本就单用户，见 CLAUDE.md）这是收敛而不是退化，但**旧的
 * owners 目录里已有的片段不会自动搬家**。同类口径变化 T0 在 usage ledger 上
 * 已有先例。
 *
 * 若将来 server 真要多 owner，正确的修法是给 RPC 信封加 context，而不是让这个
 * 文件重新长出第二套 per-owner 分支。
 */
import type { RouteHandlers } from '@shared/ipc/router'
import { promptsRouter, type PromptsRoutes } from '@shared/ipc/prompts.js'
import {
  createOnethingPromptForIpc,
  deleteOnethingPromptForIpc,
  getOnethingPromptForIpc,
  listOnethingPromptsForIpc,
  updateOnethingPromptForIpc,
} from '@onething/backend/prompt'
import {
  createPrompt,
  deletePrompt,
  getPrompt,
  listPrompts,
  updatePrompt,
} from '@onething/backend/prompt/prompt-store-bound'
import { consolePort, getLogger } from '@onething/backend/logging/configure-logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import type { OnethingPromptIpcLogger } from '@onething/backend/prompt/prompt-ipc-operations'
import { defineClientApi } from '@onething/backend/http-server/http-server-dispatch-table.js'

const log = getLogger('ipc.prompts')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingPromptIpcLogger = consolePort(log)


export const promptsRpcHandlers: RouteHandlers<PromptsRoutes> = {
  async list() {
    return listOnethingPromptsForIpc({ listPrompts, logger: consoleLog })
  },
  async get(request) {
    return getOnethingPromptForIpc({ request, getPrompt, logger: consoleLog })
  },
  async create(request) {
    return createOnethingPromptForIpc({ request, createPrompt, logger: consoleLog })
  },
  async update(request) {
    return updateOnethingPromptForIpc({ request, updatePrompt, logger: consoleLog })
  },
  async delete(request) {
    return deleteOnethingPromptForIpc({ request, deletePrompt, logger: consoleLog })
  },
}


/** 名册 `http-server/http-server-client-api-roster.ts` 里的一行:域 `prompts` 的契约与处理者。 */
export const PROMPTS_CLIENT_API = defineClientApi({ id: 'rpc:prompts', router: promptsRouter, handlers: promptsRpcHandlers })
