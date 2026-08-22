/**
 * MCP 生命周期(不是传输面)。
 *
 * 结构债 P4c 第六批:十六条 `MCP_*` 通道整只搬去 `mcpRouter` /
 * `@onething/backend/rpc/domains/mcp`,`registerMCPHandlers` 与
 * `apps/electron/src/ipc/mcp.ts` 那个手写工厂一起删除。这里只剩两件**要进程内
 * 单例**的事:起 `MCPManager`(含 capabilities-changed 回灌与模型面目录重建)、
 * 收尾时把它停掉。
 *
 * `configureMCPCapabilitiesChangedHandler` 从 `registerMCPHandlers` 挪到
 * `initializeMCP`:它配的是**客户端回灌路径**而不是 IPC 通道,而这两个函数在
 * `handlers.ts` 里本来就前后脚跑(注册在前、初始化在后),挪过来不改先后。
 */
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { MCPManager, registerMCPTools } from '@onething/runtime/mcp/index.wiring'
import { configureMCPCapabilitiesChangedHandler } from '@onething/runtime/mcp/capabilities-changed'
import { getSettings } from '@onething/backend/stores/settings.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.mcp')

function getMCPSettings() {
  const settings = getSettings()
  return settings.mcp || DEFAULT_MCP_SETTINGS
}

export async function initializeMCP(): Promise<void> {
  // P2-1: server-pushed list changes re-read into state by the client; the
  // model-facing catalog regenerates through the same path connect uses.
  configureMCPCapabilitiesChangedHandler(() => {
    void registerMCPTools()
  })

  const mcpSettings = getMCPSettings()
  await MCPManager.initialize(mcpSettings)
  await registerMCPTools()

  const serverCount = mcpSettings?.servers?.length || 0
  if (serverCount > 0) {
    log.info('MCP initialized', { serverCount })
  }
}

export async function shutdownMCP(): Promise<void> {
  await MCPManager.shutdown()
}
