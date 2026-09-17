import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
  type ProxySettings,
  type TestProxyResponse,
} from '@shared/ipc/settings'

export interface NetworkSettingsPort {
  readSettings(): Promise<GetSettingsResponse>
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
  testProxy(proxy: ProxySettings): Promise<TestProxyResponse>
}

let port: NetworkSettingsPort | undefined
let pending: Promise<NetworkSettingsPort> | undefined

export function configureNetworkSettingsPort(next: NetworkSettingsPort | undefined): void {
  port = next
  pending = undefined
}

export function networkSettingsPort(): Promise<NetworkSettingsPort> {
  if (port) return Promise.resolve(port)
  pending ??= import('../platform/connection').then(async ({ onethingClient }) => {
    const api = (await onethingClient()).api(settingsRouter)
    return {
      readSettings: () => api.getSettings({}),
      saveSettings: (settings: AppSettings) => api.saveSettings(settings),
      testProxy: (proxy: ProxySettings) => api.testProxy({ proxy }),
    }
  }).catch((error) => {
    pending = undefined
    throw error
  })
  return pending
}
