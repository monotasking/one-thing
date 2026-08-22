import type { ProxySettings } from '@shared/ipc.js'
import {
  applyElectronNetworkProxySettings,
  type ElectronProxyConfig,
} from '@onething/electron-host/network/proxy'
import { applyBrowserProxy } from '@onething/electron-host/browser/session'
import { clearAppDispatcherCache, validateProxyUrl } from '@onething/backend/provider-binding/bound-fetch.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.network-proxy')

function normalizeBypassRules(rules?: string): string {
  return (rules || '')
    .split(/[;,]/)
    .map(rule => rule.trim())
    .filter(Boolean)
    .join(';')
}

export function buildElectronProxyRules(proxy?: ProxySettings): string | undefined {
  if (!proxy?.enabled) return undefined
  const validated = validateProxyUrl(proxy.url)
  if (!validated.valid) {
    throw new Error(validated.error)
  }
  // Chromium's proxyRules parser wants `[<scheme>://]<host>:<port>` with NO path.
  // validateProxyUrl returns `new URL(...).toString()`, which appends a trailing
  // slash for http(s) (e.g. "http://127.0.0.1:7890/"). That trailing "/" makes
  // Chromium treat the proxy server as invalid → ERR_NO_SUPPORTED_PROXIES (the
  // failure the embedded browser and favicons hit). Rebuild scheme://host:port.
  const parsed = new URL(validated.normalizedUrl!)
  return `${parsed.protocol}//${parsed.host}`
}

export async function applyNetworkProxySettings(proxy: ProxySettings = getSettings().network?.proxy ?? {
  enabled: false,
  url: '',
}): Promise<void> {
  clearAppDispatcherCache()

  let config: ElectronProxyConfig
  if (!proxy.enabled) {
    config = { enabled: false }
  } else {
    try {
      config = {
        enabled: true,
        proxyRules: buildElectronProxyRules(proxy),
        proxyBypassRules: normalizeBypassRules(proxy.bypassRules),
      }
    } catch (error: any) {
      log.warn('proxy settings invalid, Electron proxy not applied', undefined, error)
      config = { enabled: false }
    }
  }

  // Apply to BOTH the app's defaultSession AND the embedded browser's
  // persist:browser partition — the browser tabs otherwise connect directly,
  // which breaks any site only reachable through the proxy (Google et al. show
  // TLS resets / "not secure" instead of loading). Keep them in sync on change.
  await applyElectronNetworkProxySettings(config)
  try {
    await applyBrowserProxy(config)
  } catch (error) {
    log.warn('apply proxy to embedded browser partition failed', undefined, error)
  }
}

// P4c 第十一批:`testProxy` 搬到装配层(`@onething/backend/wiring/settings/proxy.ts`)——
// 它没有一处 Electron 触点,而旧 server 里还躺着一份逐字相同的抄件。留在这里的
// `applyNetworkProxySettings` 才是真要宿主的那一半(Electron session + 内嵌浏览器
// 分区),它由 `app/main-process.ts` 的 `configureSettingsHost` 注入给域处理者。
