import {
  registerElectronACPIpcHandlers,
  type ElectronACPAgentConfigRequest,
  type ElectronACPAgentIdRequest,
  type ElectronACPCancelSessionRequest,
} from '@onething/electron-host/ipc/acp'
import {
  addOnethingACPAgentForIpc,
  cancelOnethingACPSessionForIpc,
  connectOnethingACPAgentForIpc,
  disconnectOnethingACPAgentForIpc,
  getOnethingACPAgentsForIpc,
  refreshOnethingACPAgentForIpc,
  removeOnethingACPAgentForIpc,
  updateOnethingACPAgentForIpc,
} from '@onething/runtime/acp'
import {
  IPC_CHANNELS,
  type ACPAddAgentRequest,
  type ACPAddAgentResponse,
  type ACPCancelSessionRequest,
  type ACPCancelSessionResponse,
  type ACPConnectAgentRequest,
  type ACPConnectAgentResponse,
  type ACPDisconnectAgentRequest,
  type ACPDisconnectAgentResponse,
  type ACPGetAgentsResponse,
  type ACPRefreshAgentRequest,
  type ACPRefreshAgentResponse,
  type ACPRemoveAgentRequest,
  type ACPRemoveAgentResponse,
  type ACPUpdateAgentRequest,
  type ACPUpdateAgentResponse,
} from '@shared/ipc.js'
import { ACPManager } from '@onething/runtime/acp'
import { registerACPPermissionBridge } from '@onething/backend/wiring/acp/permission-bridge.js'
import { disposeExternalAgentConnectors } from '@onething/backend/wiring/external-agents/index.js'
import { getSettings, saveSettings } from '@onething/backend/stores/settings.js'

function getACPSettings() {
  return getSettings().acp || { enabled: true, agents: [] }
}

async function saveACPSettings(acpSettings: ReturnType<typeof getACPSettings>): Promise<void> {
  const settings = getSettings()
  settings.acp = acpSettings
  saveSettings(settings)
  ACPManager.updateSettings(acpSettings)
}

function acpAdapters() {
  return {
    getSettings: getACPSettings,
    saveSettings: saveACPSettings,
    manager: ACPManager,
    logger: console,
  }
}

export function registerACPHandlers(): void {
  registerElectronACPIpcHandlers({
    channels: {
      getAgents: IPC_CHANNELS.ACP_GET_AGENTS,
      addAgent: IPC_CHANNELS.ACP_ADD_AGENT,
      updateAgent: IPC_CHANNELS.ACP_UPDATE_AGENT,
      removeAgent: IPC_CHANNELS.ACP_REMOVE_AGENT,
      connectAgent: IPC_CHANNELS.ACP_CONNECT_AGENT,
      disconnectAgent: IPC_CHANNELS.ACP_DISCONNECT_AGENT,
      refreshAgent: IPC_CHANNELS.ACP_REFRESH_AGENT,
      cancelSession: IPC_CHANNELS.ACP_CANCEL_SESSION,
    },
    getAgents: async (): Promise<ACPGetAgentsResponse> =>
      getOnethingACPAgentsForIpc({
        getSettings: getACPSettings,
        manager: ACPManager,
        logger: console,
      }),
    addAgent: async (request: ElectronACPAgentConfigRequest): Promise<ACPAddAgentResponse> => {
      const typedRequest = request as ACPAddAgentRequest
      return addOnethingACPAgentForIpc({
        ...acpAdapters(),
        config: typedRequest.config,
      }) as Promise<ACPAddAgentResponse>
    },
    updateAgent: async (request: ElectronACPAgentConfigRequest): Promise<ACPUpdateAgentResponse> => {
      const typedRequest = request as ACPUpdateAgentRequest
      return updateOnethingACPAgentForIpc({
        ...acpAdapters(),
        config: typedRequest.config,
      }) as Promise<ACPUpdateAgentResponse>
    },
    removeAgent: async (request: ElectronACPAgentIdRequest): Promise<ACPRemoveAgentResponse> => {
      const typedRequest = request as ACPRemoveAgentRequest
      return removeOnethingACPAgentForIpc({
        ...acpAdapters(),
        agentId: typedRequest.agentId,
      })
    },
    connectAgent: async (request: ElectronACPAgentIdRequest): Promise<ACPConnectAgentResponse> => {
      const typedRequest = request as ACPConnectAgentRequest
      return connectOnethingACPAgentForIpc({
        getSettings: getACPSettings,
        manager: ACPManager,
        agentId: typedRequest.agentId,
        logger: console,
      }) as Promise<ACPConnectAgentResponse>
    },
    disconnectAgent: async (request: ElectronACPAgentIdRequest): Promise<ACPDisconnectAgentResponse> => {
      const typedRequest = request as ACPDisconnectAgentRequest
      return disconnectOnethingACPAgentForIpc({
        agentId: typedRequest.agentId,
        disconnectAgent: agentId => ACPManager.disconnectAgent(agentId),
        logger: console,
      })
    },
    refreshAgent: async (request: ElectronACPAgentIdRequest): Promise<ACPRefreshAgentResponse> => {
      const typedRequest = request as ACPRefreshAgentRequest
      return refreshOnethingACPAgentForIpc({
        getSettings: getACPSettings,
        manager: ACPManager,
        agentId: typedRequest.agentId,
        logger: console,
      }) as Promise<ACPRefreshAgentResponse>
    },
    cancelSession: async (request: ElectronACPCancelSessionRequest): Promise<ACPCancelSessionResponse> => {
      const typedRequest = request as ACPCancelSessionRequest
      return cancelOnethingACPSessionForIpc({
        sessionId: typedRequest.sessionId,
        agentId: typedRequest.agentId,
        cancelSession: (sessionId, agentId) => ACPManager.cancelSession(sessionId, agentId),
        logger: console,
      })
    },
  })
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
