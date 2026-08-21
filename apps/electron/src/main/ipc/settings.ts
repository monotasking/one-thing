import {
  broadcastElectronSettingsChanged,
  getElectronShouldUseDarkColors,
  registerElectronSettingsIpcHandlers,
  registerElectronSystemThemeChangedBroadcast,
  showElectronOpenDialog,
  type ElectronSettingsIpcEvent,
} from '@onething/electron-host/settings/ipc-host'
import {
  getOnethingSettingsForIpc,
  getOnethingSystemThemeForIpc,
  saveOnethingSettingsWithRuntimeEffectsForIpc,
} from '@onething/runtime/settings'
import { IPC_CHANNELS, type SaveSettingsRequest, type TestProxyRequest } from '@shared/ipc.js'
import * as store from '@onething/backend/store.js'
import { openSettingsWindow } from '@onething/electron-host/window'
import { invalidateProviderCache } from '@onething/backend/wiring/providers/registry.js'
import { applyNetworkProxySettings, testProxy } from './network-proxy.js'
import { registerGlobalWindowShortcuts } from '@onething/electron-host/shortcuts/global-shortcuts'
import { getVoiceServiceSafe } from '@onething/backend/wiring/voice/service.js'
import { MCPManager, registerMCPTools } from '@onething/runtime/mcp/index.wiring'
import { DEFAULT_MCP_SETTINGS } from '@onething/core/mcp'
import { ACPManager } from '@onething/runtime/acp'
import { applyGatewaySettings } from '@onething/electron-host/gateway/lifecycle'
import { startTodoPlanWatcher } from '@onething/backend/wiring/todo-plan/store.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.settings')

async function saveSettingsFromIpc(settings: SaveSettingsRequest, event: ElectronSettingsIpcEvent) {
  const result = await saveOnethingSettingsWithRuntimeEffectsForIpc({
    settings,
    saveSettings: nextSettings => store.saveSettings(nextSettings),
    getSettings: () => store.getSettings(),
    invalidateProviderCache,
    applyNetworkProxySettings,
    registerGlobalWindowShortcuts,
    applyVoiceSettings: normalizedSettings =>
      getVoiceServiceSafe()?.applySettings(normalizedSettings),
    updateMCPSettings: nextSettings => MCPManager.updateSettings(nextSettings),
    registerMCPTools,
    updateACPSettings: nextSettings => ACPManager.updateSettings(nextSettings),
    defaultMCPSettings: DEFAULT_MCP_SETTINGS,
    defaultACPSettings: { enabled: true, agents: [] },
    logger: console,
  })
  if (!result.success) return result
  const normalizedSettings = result.settings
  await applyGatewaySettings(normalizedSettings).catch(error => {
    log.error('apply gateway channel settings failed', undefined, error)
  })

  // The todo directory is a setting; re-point the watcher if it moved. start()
  // is a no-op when the directory is unchanged.
  await startTodoPlanWatcher().catch(error => {
    log.error('todo-plan watcher restart failed', undefined, error)
  })

  broadcastElectronSettingsChanged({
    channel: IPC_CHANNELS.SETTINGS_CHANGED,
    settings: normalizedSettings,
    exceptWebContentsId: event.sender?.id,
  })
  return result
}

export function registerSettingsHandlers() {
  registerElectronSystemThemeChangedBroadcast({
    channel: IPC_CHANNELS.SYSTEM_THEME_CHANGED,
  })

  registerElectronSettingsIpcHandlers({
    channels: {
      openWindow: IPC_CHANNELS.OPEN_SETTINGS_WINDOW,
      getSettings: IPC_CHANNELS.GET_SETTINGS,
      getSystemTheme: IPC_CHANNELS.GET_SYSTEM_THEME,
      saveSettings: IPC_CHANNELS.SAVE_SETTINGS,
      testProxy: IPC_CHANNELS.TEST_PROXY,
      showOpenDialog: IPC_CHANNELS.SHOW_OPEN_DIALOG,
    },
    openSettingsWindow: (request?: unknown) => {
      const tab = (request as { tab?: unknown } | undefined)?.tab
      openSettingsWindow(undefined, typeof tab === 'string' ? tab : undefined)
      return { success: true }
    },
    getSettings: () =>
      getOnethingSettingsForIpc({
        getSettings: () => store.getSettings(),
        logger: console,
      }),
    getSystemTheme: () => getOnethingSystemThemeForIpc(getElectronShouldUseDarkColors()),
    saveSettings: (settings, event) => saveSettingsFromIpc(settings as SaveSettingsRequest, event),
    testProxy: request => {
      const typedRequest = request as TestProxyRequest
      return testProxy(typedRequest.proxy)
    },
    showOpenDialog: options => showElectronOpenDialog(options),
  })
}
