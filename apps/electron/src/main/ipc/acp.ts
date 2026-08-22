/**
 * ACP 生命周期(不是传输面)。
 *
 * 结构债 P4c 第六批:八条 `ACP_*` 通道整只搬去 `acpRouter` /
 * `@onething/backend/rpc/domains/acp`,`registerACPHandlers` 与
 * `apps/electron/src/ipc/acp.ts` 那个手写工厂一起删除。这里只剩两件**要进程内
 * 单例**的事:起 `ACPManager` 并挂上权限桥、收尾时把它和外部 agent 连接器一起停掉。
 */
import { ACPManager } from '@onething/runtime/acp'
import { registerACPPermissionBridge } from '@onething/backend/wiring/acp/permission-bridge.js'
import { disposeExternalAgentConnectors } from '@onething/backend/wiring/external-agents/index.js'
import { getSettings } from '@onething/backend/stores/settings.js'

function getACPSettings() {
  return getSettings().acp || { enabled: true, agents: [] }
}

export function initializeACP(): void {
  ACPManager.initialize(getACPSettings())
  registerACPPermissionBridge()
}

export async function shutdownACP(): Promise<void> {
  await ACPManager.shutdown()
  // External agent connectors (Claude Code, …) share the same teardown moment.
  await disposeExternalAgentConnectors()
}
