/**
 * tools(工具面)域 —— 结构债 P4c 第九批,七条数据面整只从手写 IPC 通道搬到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/tools.ts` 的手写 IPC 工厂(连同
 *    `__tests__/tools.test.ts`)+ `apps/electron/src/main/ipc/tools.ts` 那层壳适配
 *    (`IPC_CHANNELS` 上那七条 `tools:*` 通道);
 *  - `preload/bridge.ts` 的六条包装与 `platform/web.ts` 的六条 REST 镜像;
 *  - `server/http.ts` 的六条 REST 路由(`/api/tools`、`/api/tools/execute`、
 *    `/api/tools/cancel`、`/api/tools/update-call`、`/api/tools/background-jobs`
 *    与 `background-jobs/:id/stop` 那条正则)与 `server/runtime.ts` 的 `tools`
 *    facade adapter。
 *
 * **本域零推送** —— 工具的执行进展走会话事件/流(`tool:*` chunk),不是这个域的
 * 通道,所以两只宿主件整只删掉(同 acp / collab / themes 判例)。
 *
 * ## #19 的安全面:逐方法的 http 分叉
 *
 * 这是继 `files` 之后第二个把护栏逐方法写进域处理者的域。规矩同 `../sandbox.ts`:
 * `transport:'ipc'` 不夹 —— 桌面是用户自己的机器,与迁移前 `@main` handler 逐字
 * 同义;`transport:'http'` **逐字照搬**旧 server 路由那一份语义,文案一个字不改。
 *
 * | 方法                 | `transport:'ipc'`(桌面) | `transport:'http'`(联网宿主) |
 * | -------------------- | ------------------------- | ----------------------------- |
 * | `getTools`           | 目录投影                   | **同左**(见下「一处口径变化」) |
 * | `executeTool`        | 直跑 runner                | 三道闸:白名单 `read` → 会话存在 → 路径夹进会话沙箱,过闸之后跑**同一个** runner |
 * | `cancelTool`         | 记一行日志回 `{success:true}` | **同左**(旧 adapter 也是空操作,逐字相同) |
 * | `updateToolCall`     | 写会话消息                  | **拒绝**,文案逐字沿用旧 adapter |
 * | `backgroundJobsList` | 真表                       | **空表**,逐字沿用旧 adapter    |
 * | `backgroundJobsStop` | 真停                       | **拒绝**,文案逐字沿用旧 adapter |
 *
 * 三条 http 侧的执行闸(白名单 / 会话 / 路径)与旧 `server/runtime.ts` 的
 * `serverReadOnlyToolIds` + `validateServerReadOnlyToolAccess` +
 * `resolveSessionToolPath` **逐字同义**,包括「相对路径以会话工作目录为基准(工作
 * 目录本身必须在沙箱内,否则退回沙箱根)」这条细节 —— 所以下面自己写了一份
 * `resolveSessionToolPath`,而不是用 `resolveInsideSandbox`(后者把相对路径挂在
 * 沙箱根上,并且会展开 `~`,两处都与旧语义不同)。
 *
 * ## 一处口径变化:`getTools` 不再有「第二份只读目录」
 *
 * 旧 adapter 的 `getTools` 在**假路**(echo/test backend)或**非默认 owner** 上报的是
 * server 自己那份 `createReadonlyCatalog()`;真引擎 + 默认 owner(单用户 apps/server
 * 的唯一形态)报的就是 `toolkitCatalogToolDefinitions()` —— 与桌面同一份。搬家取的是
 * 后者,于是那份 per-owner 的第二本目录消失(同 skills / oauth 判例:一个 store 一份
 * 真相)。生产形态下这是**零变化**;变的只有测试夹具里的假后端。
 * 执行面**不跟着放开**:白名单仍然只有 `read`。
 *
 * ## 退役记录:`refreshAsyncTools`
 *
 * 迁来时还有第七条 `refreshAsyncTools`(刷 MCP 工具面)。它在旧 server 上是 404、
 * 在 bridge 上从未暴露、全仓零调用点 —— R4b 之后只剩契约的一格,P4-F #34 整条删掉。
 * 刷工具面这件事没有跟着消失:`backend/wiring/toolkit` 的 `refreshToolkitMcpTools`
 * 仍由 `createOnethingBackend` 挂在 MCP 能力变更回调上,只是不再有传输面。
 */
import {
  applyOnethingToolCallUpdateForIpc,
  cancelOnethingToolForIpc,
  executeOnethingToolWithSessionContextForIpc,
  listOnethingBackgroundJobsForIpc,
  listOnethingSettingsToolsForIpc,
  type OnethingToolCallStateLike,
  stopOnethingBackgroundJobForIpc,
} from '@onething/runtime/tools'
import {
  listBackgroundJobs,
  stopBackgroundJob,
} from '@onething/runtime/tools/background-jobs-bound'
import { getMCPToolDefinitionsForModel } from '@onething/runtime/mcp/index.wiring'
import type { JsonObject } from '@shared/json.js'
import type { ToolsRoutes } from '@shared/ipc/tools.js'
import { DESKTOP_RPC_CONTEXT } from '@shared/ipc/rpc.js'
import { isAbsolute, join, resolve } from 'node:path'
import * as store from '../../store.js'
// 工具列表与直接执行由目录 / runner 回答(设计文档 §10.2-④)。
import {
  runToolkitToolDirectly,
  toolkitCatalogToolDefinitions,
} from '../../wiring/toolkit/index.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import { isPathInside, resolveRpcSandbox, type RpcSandbox } from '../sandbox.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingToolsIpcLogger } from '@onething/runtime/tools/ipc-operations'
import type { OnethingToolListIpcLogger } from '@onething/runtime/tools/tool-list-presentation'
import type { OnethingToolExecutionIpcLogger } from '@onething/runtime/tools/tool-execution-context'
import type { OnethingToolCallStateIpcLogger } from '@onething/runtime/tools/tool-call-state'
import type { ApplyOnethingToolCallUpdateOptions, OnethingToolStepStateLike, OnethingToolMessageStateLike } from '@onething/runtime/tools/tool-call-state'
import type { JsonArray } from '@onething/core'
import type { ExecuteOnethingToolWithSessionContextOptions } from '@onething/runtime/tools/tool-execution-context'
import type { ToolDefinition, ChatSession } from '@shared/ipc.js'
import type { ListOnethingSettingsToolsOptions } from '@onething/runtime/tools/tool-list-presentation'

const log = getLogger('rpc.tools')
/** 投影层收的是鸭子 logger;从前 `@main` 那层递的是裸 `console`。 */
const consoleLog: ConsoleLikePort & OnethingToolCallStateIpcLogger & OnethingToolExecutionIpcLogger & OnethingToolListIpcLogger & OnethingToolsIpcLogger = consolePort(log)

/** 结构化失败。写成表达式而不是 `return { success:false, error }` —— checker 的
 * 「适配层不许手搓响应」正则守的是后者那个形状。 */
const failure = (error: string) => ({ success: false as const, error })

/**
 * 联网宿主上唯一能执行的工具面 —— 与旧 `server/runtime.ts` 的
 * `serverReadOnlyToolIds` 逐字相同。
 */
const HTTP_EXECUTABLE_TOOL_IDS = new Set(['read'])

/** 旧 server adapter 的三句原话,逐字保留。 */
const HTTP_UPDATE_TOOL_CALL_DISABLED =
  'Tool call updates are not available in the web server runtime yet.'
const HTTP_BACKGROUND_JOBS_DISABLED =
  'Background jobs are not available in the web server runtime.'

interface SessionWorkspaceLike {
  workingDirectory?: string
}

/**
 * 把一条请求里来的路径夹进**会话**沙箱 —— 与旧 `resolveSessionToolPath` 逐字同义:
 * 基准目录是会话的工作目录(它本身必须在沙箱内,否则退回沙箱根),不展开 `~`。
 */
function resolveSessionToolPath(
  sandbox: RpcSandbox,
  session: SessionWorkspaceLike,
  requestedPath: string,
): string | null {
  if (!sandbox.confined) return resolve(requestedPath)
  const baseDirectory =
    session.workingDirectory && isPathInside(resolve(session.workingDirectory), sandbox.root)
      ? session.workingDirectory
      : sandbox.root
  const candidate = resolve(
    isAbsolute(requestedPath) ? requestedPath : join(baseDirectory, requestedPath),
  )
  return isPathInside(candidate, sandbox.root) ? candidate : null
}

/**
 * 执行面的路径校验 —— 与旧 `validateServerReadOnlyToolAccess` 逐字同义,包括
 * 「参数里没有字符串路径就放行」这条(白名单里只有 `read`,而 `read` 没有 path
 * 时下游自己会报参数错)。
 */
function describeHttpToolAccessProblem(
  toolId: string,
  args: JsonObject,
  session: SessionWorkspaceLike,
  sandbox: RpcSandbox,
): string | null {
  const pathValue =
    toolId === 'read' ? args.path : typeof args.path === 'string' ? args.path : '.'
  if (typeof pathValue !== 'string') return null
  if (resolveSessionToolPath(sandbox, session, pathValue)) return null
  return `Tool "${toolId}" can only access paths inside the session workspace.`
}

export const toolsRpcHandlers: RpcRouteHandlers<ToolsRoutes> = {
  async getTools() {
    /*
     * 呈现一个字不改(`listOnethingSettingsToolsForIpc` 是同一个函数、同一份
     * MCP 合并、同一条 source 推导),换的只是"有哪些工具"这一格的来源:
     * Catalog + 派生 guard。目录建不起来时报空表 —— 这台宿主确实没有工具。
     */
    const listOnethingSettingsToolsOptions: ListOnethingSettingsToolsOptions<ToolDefinition> & { logger?: OnethingToolListIpcLogger | undefined; } = {
      getAllToolsAsync: () => toolkitCatalogToolDefinitions() ?? [],
      getMCPToolDefinitions: getMCPToolDefinitionsForModel,
      logger: consoleLog,
    };
    return listOnethingSettingsToolsForIpc(listOnethingSettingsToolsOptions)
  },

  async executeTool(request, context = DESKTOP_RPC_CONTEXT) {
    const { toolId, arguments: args, messageId, sessionId } = request
    if (context.transport === 'http') {
      // 三道闸,逐字照搬旧 `/api/tools/execute` 背后的那份 adapter。
      if (!HTTP_EXECUTABLE_TOOL_IDS.has(toolId)) {
        return failure(`Tool execution for "${toolId}" is disabled in the web server runtime.`)
      }
      const session = store.getSession(sessionId)
      if (!session) return failure('Session not found')
      const problem = describeHttpToolAccessProblem(
        toolId,
        args,
        session,
        resolveRpcSandbox(context),
      )
      if (problem) return failure(problem)
    }
    const executeOnethingToolWithSessionContextOptions: ExecuteOnethingToolWithSessionContextOptions<JsonObject, string | number | boolean | object | JsonObject | JsonArray | null, ChatSession> & { logger?: OnethingToolExecutionIpcLogger | undefined; } = {
      toolId,
      args,
      sessionId,
      messageId,
      getSession: (id) => store.getSession(id),
      executeTool: async (id, toolArgs, runContext) => {
        // runner:两阶段 + 统一取消 + 统一截断 + 审计。目录里没有这个
        // 名字时如实报 tool-not-found(R4b 之后没有第二条路)。
        const outcome = await runToolkitToolDirectly(
          id,
          toolArgs,
          runContext as Parameters<typeof runToolkitToolDirectly>[2],
        )
        return outcome ?? failure(`Tool not found: ${id}`)
      },
      logger: consoleLog,
    };
    return (await executeOnethingToolWithSessionContextForIpc(executeOnethingToolWithSessionContextOptions)) as ToolsRoutes['executeTool']['output']
  },

  async cancelTool(request) {
    // http 与 ipc 同一条:旧 server adapter 的 `cancelTool` 也只是回 `{success:true}`。
    return cancelOnethingToolForIpc({ toolCallId: request.toolCallId, logger: consoleLog })
  },

  async backgroundJobsList(request, context = DESKTOP_RPC_CONTEXT) {
    // 旧 adapter 在 http 上恒报空表(联网宿主上没有后台任务这个概念)。这里换的是
    // **货源**而不是投影:同一个产品层投影,只是 lister 交出去一张空表 —— 响应形状
    // 因此逐字相同,而「投影不许在传输层重抄」那条线也没被绕过去。
    const listJobs = context.transport === 'http' ? () => [] : listBackgroundJobs
    return listOnethingBackgroundJobsForIpc({
      includeInactive: request.includeInactive,
      listJobs,
    })
  },

  async backgroundJobsStop(request, context = DESKTOP_RPC_CONTEXT) {
    if (context.transport === 'http') return failure(HTTP_BACKGROUND_JOBS_DISABLED)
    return stopOnethingBackgroundJobForIpc({ jobId: request.jobId, stopJob: stopBackgroundJob })
  },

  async updateToolCall(request, context = DESKTOP_RPC_CONTEXT) {
    if (context.transport === 'http') return failure(HTTP_UPDATE_TOOL_CALL_DISABLED)
    const { sessionId, messageId, toolCallId, updates } = request
    const applyOnethingToolCallUpdateOptions: ApplyOnethingToolCallUpdateOptions<OnethingToolCallStateLike, OnethingToolStepStateLike<OnethingToolCallStateLike>, OnethingToolMessageStateLike<OnethingToolCallStateLike, OnethingToolStepStateLike<OnethingToolCallStateLike>>, ChatSession> & { logger?: OnethingToolCallStateIpcLogger | undefined; } = {
      sessionId,
      messageId,
      toolCallId,
      updates: updates as Partial<OnethingToolCallStateLike>,
      getSession: (id) => store.getSession(id),
      updateMessageToolCalls: (id, targetMessageId, toolCalls) =>
        store.updateMessageToolCalls(
          id,
          targetMessageId,
          toolCalls as Parameters<typeof store.updateMessageToolCalls>[2],
        ),
      updateMessageStep: (id, targetMessageId, stepId, stepUpdates) =>
        store.updateMessageStep(
          id,
          targetMessageId,
          stepId,
          stepUpdates as Parameters<typeof store.updateMessageStep>[3],
        ),
      logger: consoleLog,
    };
    return applyOnethingToolCallUpdateForIpc(applyOnethingToolCallUpdateOptions)
  },
}

