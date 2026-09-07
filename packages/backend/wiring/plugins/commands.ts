/**
 * 插件命令的**执行接线** —— 结构债 P4 终态批 C2。
 *
 * 从前这一段住在 `apps/electron/src/main/ipc/plugins.ts`(`executePluginCommand`),
 * 有两个调用方:那只 IPC 工厂,和网关的命令提供者。IPC 那一半随 C2 迁进
 * `rpc/domains/plugins.ts`;为了不让同一段接线在域文件和宿主文件里各留一份,
 * 整段搬到这里,两边都调它。
 *
 * 编排本体在产品层(`@onething/runtime/plugins` 的
 * `executeOnethingPluginCommandForIpc` → `executeOnethingPluginCommand`);
 * 这里只把脊柱上的四样东西接上去:插件管理器、会话仓、事件总线,和**宿主注入的**
 * 子进程执行器(`configurePluginsHost({ execCommand })` —— execa 是桌面的依赖,
 * 装配层不该把它拖进 server 的单文件包)。
 */
import {
  executeOnethingPluginCommandForIpc,
  listOnethingPluginCommandsForIpcAllowingUninitialized,
  type ExecuteOnethingPluginCommandResult,
  type ListOnethingPluginCommandsForIpcResult,
} from '@onething/runtime/plugins'
import { getEventBus } from '../../events/index.js'
import * as store from '../../store.js'
import { consolePort, getLogger } from '../logging/index.js'
import { execPluginCommandOnHost } from './host-ports.js'
import { getPluginManager } from './manager.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingPluginIpcLogger } from '@onething/runtime/plugins/ipc-operations'
import type { RuntimeRequestContext } from '@onething/core'
import { DEFAULT_SESSION_OWNER, sessionAccess } from '../../session/access.js'

const log = getLogger('plugins.commands')
const consoleLog: ConsoleLikePort & OnethingPluginIpcLogger = consolePort(log)

export interface ExecutePluginCommandOnHostRequest {
  commandName: string
  args?: string
  sessionId: string
}

/** 一次插件命令执行(桌面 IPC 与网关共用的同一条路)。 */
export function executePluginCommandOnHost(
  request: ExecutePluginCommandOnHostRequest,
  options: { executionContext?: RuntimeRequestContext } = {},
): Promise<ExecuteOnethingPluginCommandResult> {
  const executionContext = Object.freeze({ ...(options.executionContext ?? DEFAULT_SESSION_OWNER) })
  if (request.sessionId) sessionAccess.resolve(executionContext, request.sessionId, 'write')
  const eventBus = getEventBus()
  return executeOnethingPluginCommandForIpc({
    manager: getPluginManager(),
    commandName: request.commandName,
    args: request.args,
    sessionId: request.sessionId,
    getSession: sessionId => {
      if (!sessionId) return undefined
      sessionAccess.resolve(executionContext, sessionId, 'read')
      return store.getSession(sessionId)
    },
    emitSessionCommand: (sessionId, event) => {
      sessionAccess.resolve(executionContext, sessionId, 'write')
      return eventBus.emit(sessionId, event, { executionContext })
    },
    emitGlobalEvent: event => eventBus.emitGlobal(event),
    exec: (commandToRun, args = [], options) =>
      execPluginCommandOnHost(commandToRun, args, { cwd: options.cwd }),
    onEmitError(label, error) {
      log.error('plugin event emit failed', { label }, error)
    },
    logger: consoleLog,
  })
}

/**
 * 网关侧的「列命令」:插件系统还没装配起来时,答案是「这台机器没有插件命令」,
 * 不是一条错误 —— 那条降级判定在产品层的
 * `listOnethingPluginCommandsForIpcAllowingUninitialized` 里。
 */
export function listPluginCommandsForGateway(): Promise<ListOnethingPluginCommandsForIpcResult> {
  return listOnethingPluginCommandsForIpcAllowingUninitialized({
    manager: getPluginManager(),
    logger: consoleLog,
  })
}
