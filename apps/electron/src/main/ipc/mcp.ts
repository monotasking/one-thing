/**
 * MCP IPC Handlers
 *
 * Electron owns IPC registration and host adapters. Runtime-owned MCP
 * operations shape responses, errors, settings mutations, and capability
 * projections.
 */

import { registerElectronMCPIpcHandlers } from '@onething/electron-host/ipc/mcp'
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import * as fs from 'fs'
import {
  addOnethingMCPServerForIpc,
  callOnethingMCPToolForIpc,
  connectOnethingMCPServerForIpc,
  disconnectOnethingMCPServerForIpc,
  getOnethingMCPPromptForIpc,
  getOnethingMCPServersForIpc,
  listOnethingMCPPromptsForIpc,
  listOnethingMCPResourcesForIpc,
  listOnethingMCPToolsForIpc,
  logoutOnethingMCPServerForIpc,
  probeOnethingMCPServerForIpc,
  readOnethingMCPConfigFileForIpc,
  readOnethingMCPResourceForIpc,
  refreshOnethingMCPServerForIpc,
  removeOnethingMCPServerForIpc,
  updateOnethingMCPServerForIpc,
} from '@onething/runtime/mcp'
import {
  IPC_CHANNELS,
  type MCPAddServerRequest,
  type MCPAddServerResponse,
  type MCPCallToolRequest,
  type MCPCallToolResponse,
  type MCPConnectServerRequest,
  type MCPConnectServerResponse,
  type MCPDisconnectServerRequest,
  type MCPDisconnectServerResponse,
  type MCPLogoutServerRequest,
  type MCPLogoutServerResponse,
  type MCPProbeServerRequest,
  type MCPProbeServerResponse,
  type MCPGetPromptRequest,
  type MCPGetPromptResponse,
  type MCPGetPromptsResponse,
  type MCPGetResourcesResponse,
  type MCPGetServersResponse,
  type MCPGetToolsResponse,
  type MCPReadConfigFileRequest,
  type MCPReadConfigFileResponse,
  type MCPReadResourceRequest,
  type MCPReadResourceResponse,
  type MCPRefreshServerRequest,
  type MCPRefreshServerResponse,
  type MCPRemoveServerRequest,
  type MCPRemoveServerResponse,
  type MCPServerConfig,
  type MCPUpdateServerRequest,
  type MCPUpdateServerResponse,
} from '@shared/ipc.js'
import { MCPManager, probeMCPServerConfig, registerMCPTools } from '@onething/backend/mcp/index.js'
import { configureMCPCapabilitiesChangedHandler } from '@onething/backend/mcp/capabilities-changed.js'
import { getMCPOAuthFlowManager } from '@onething/backend/mcp/oauth/index.js'
import { getSettings, saveSettings } from '@onething/backend/stores/settings.js'
import { getLogger } from '@onething/backend/logging/index.js'

const log = getLogger('ipc.mcp')

function getMCPSettings() {
  const settings = getSettings()
  return settings.mcp || DEFAULT_MCP_SETTINGS
}

async function saveMCPSettings(mcpSettings: { enabled: boolean; servers: MCPServerConfig[] }) {
  const settings = getSettings()
  settings.mcp = mcpSettings
  await saveSettings(settings)
}

function mcpServerAdapters() {
  return {
    getSettings: getMCPSettings,
    saveSettings: saveMCPSettings,
    manager: MCPManager,
    registerTools: registerMCPTools,
    logoutOAuth: (serverId: string) => getMCPOAuthFlowManager().logout(serverId),
    logger: console,
  }
}

export function registerMCPHandlers(): void {
  // P2-1: server-pushed list changes re-read into state by the client; the
  // model-facing catalog regenerates through the same path connect uses.
  configureMCPCapabilitiesChangedHandler(() => {
    void registerMCPTools()
  })

  registerElectronMCPIpcHandlers({
    channels: {
      getServers: IPC_CHANNELS.MCP_GET_SERVERS,
      addServer: IPC_CHANNELS.MCP_ADD_SERVER,
      updateServer: IPC_CHANNELS.MCP_UPDATE_SERVER,
      removeServer: IPC_CHANNELS.MCP_REMOVE_SERVER,
      connectServer: IPC_CHANNELS.MCP_CONNECT_SERVER,
      disconnectServer: IPC_CHANNELS.MCP_DISCONNECT_SERVER,
      logoutServer: IPC_CHANNELS.MCP_LOGOUT_SERVER,
      probeServer: IPC_CHANNELS.MCP_PROBE_SERVER,
      refreshServer: IPC_CHANNELS.MCP_REFRESH_SERVER,
      getTools: IPC_CHANNELS.MCP_GET_TOOLS,
      callTool: IPC_CHANNELS.MCP_CALL_TOOL,
      getResources: IPC_CHANNELS.MCP_GET_RESOURCES,
      readResource: IPC_CHANNELS.MCP_READ_RESOURCE,
      getPrompts: IPC_CHANNELS.MCP_GET_PROMPTS,
      getPrompt: IPC_CHANNELS.MCP_GET_PROMPT,
      readConfigFile: IPC_CHANNELS.MCP_READ_CONFIG_FILE,
    },
    getServers: async (): Promise<MCPGetServersResponse> => {
      return getOnethingMCPServersForIpc({
        getServerStates: () => MCPManager.getServerStates(),
        logger: console,
      })
    },
    addServer: async (request: unknown): Promise<MCPAddServerResponse> => {
      const typedRequest = request as MCPAddServerRequest
      return addOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        config: typedRequest.config,
      }) as Promise<MCPAddServerResponse>
    },
    updateServer: async (request: unknown): Promise<MCPUpdateServerResponse> => {
      const typedRequest = request as MCPUpdateServerRequest
      return updateOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        config: typedRequest.config,
      }) as Promise<MCPUpdateServerResponse>
    },
    removeServer: async (request: unknown): Promise<MCPRemoveServerResponse> => {
      const typedRequest = request as MCPRemoveServerRequest
      return removeOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        serverId: typedRequest.serverId,
      })
    },
    connectServer: async (request: unknown): Promise<MCPConnectServerResponse> => {
      const typedRequest = request as MCPConnectServerRequest
      return connectOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        serverId: typedRequest.serverId,
      }) as Promise<MCPConnectServerResponse>
    },
    disconnectServer: async (request: unknown): Promise<MCPDisconnectServerResponse> => {
      const typedRequest = request as MCPDisconnectServerRequest
      return disconnectOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        serverId: typedRequest.serverId,
      })
    },
    logoutServer: async (request: unknown): Promise<MCPLogoutServerResponse> => {
      const typedRequest = request as MCPLogoutServerRequest
      return logoutOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        serverId: typedRequest.serverId,
      })
    },
    probeServer: async (request: unknown): Promise<MCPProbeServerResponse> => {
      const typedRequest = request as MCPProbeServerRequest
      return probeOnethingMCPServerForIpc({
        config: typedRequest.config,
        probe: config => probeMCPServerConfig(config),
        logger: console,
      }) as Promise<MCPProbeServerResponse>
    },
    refreshServer: async (request: unknown): Promise<MCPRefreshServerResponse> => {
      const typedRequest = request as MCPRefreshServerRequest
      return refreshOnethingMCPServerForIpc({
        ...mcpServerAdapters(),
        serverId: typedRequest.serverId,
      }) as Promise<MCPRefreshServerResponse>
    },
    getTools: async (): Promise<MCPGetToolsResponse> => {
      return listOnethingMCPToolsForIpc({
        getAllTools: () => MCPManager.getAllTools(),
        logger: console,
      })
    },
    callTool: async (request: unknown): Promise<MCPCallToolResponse> => {
      const typedRequest = request as MCPCallToolRequest
      return callOnethingMCPToolForIpc({
        serverId: typedRequest.serverId,
        toolName: typedRequest.toolName,
        args: typedRequest.arguments,
        callTool: (serverId, toolName, args) => MCPManager.callTool(serverId, toolName, args),
        logger: console,
      }) as Promise<MCPCallToolResponse>
    },
    getResources: async (): Promise<MCPGetResourcesResponse> => {
      return listOnethingMCPResourcesForIpc({
        getAllResources: () => MCPManager.getAllResources(),
        logger: console,
      })
    },
    readResource: async (request: unknown): Promise<MCPReadResourceResponse> => {
      const typedRequest = request as MCPReadResourceRequest
      return readOnethingMCPResourceForIpc({
        serverId: typedRequest.serverId,
        uri: typedRequest.uri,
        readResource: (serverId, uri) => MCPManager.readResource(serverId, uri),
        logger: console,
      }) as Promise<MCPReadResourceResponse>
    },
    getPrompts: async (): Promise<MCPGetPromptsResponse> => {
      return listOnethingMCPPromptsForIpc({
        getAllPrompts: () => MCPManager.getAllPrompts(),
        logger: console,
      })
    },
    getPrompt: async (request: unknown): Promise<MCPGetPromptResponse> => {
      const typedRequest = request as MCPGetPromptRequest
      return getOnethingMCPPromptForIpc({
        serverId: typedRequest.serverId,
        name: typedRequest.name,
        args: typedRequest.arguments,
        getPrompt: (serverId, name, args) => MCPManager.getPrompt(serverId, name, args),
        logger: console,
      }) as Promise<MCPGetPromptResponse>
    },
    readConfigFile: async (request: unknown): Promise<MCPReadConfigFileResponse> => {
      const typedRequest = request as MCPReadConfigFileRequest
      return readOnethingMCPConfigFileForIpc({
        filePath: typedRequest.filePath,
        fileExists: filePath => fs.existsSync(filePath),
        readTextFile: filePath => fs.readFileSync(filePath, 'utf-8'),
        logger: console,
      }) as Promise<MCPReadConfigFileResponse>
    },
  })
}

export async function initializeMCP(): Promise<void> {
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
