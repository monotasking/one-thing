import type { ElectronAPI } from '@/types'
import { createElectronPlatformApi } from './electron'
import { createWebPlatformApi } from './web'
import { currentClient } from './client'
import type { OnethingClient } from '@onething/client'
import type { PlatformApi } from './types'

type WindowWithElectronApi = Window & {
  electronAPI?: ElectronAPI
}

let webApi: PlatformApi | undefined
const electronApiCache = new WeakMap<ElectronAPI, PlatformApi>()

function currentPlatformApi(): PlatformApi {
  // Resolved per access, not at module load: node-environment tests import
  // modules that reach this file without a window, and happy-dom tests stub
  // window.electronAPI after import.
  const electronAPI = typeof window === 'undefined'
    ? undefined
    : (window as WindowWithElectronApi).electronAPI
  if (electronAPI) {
    let api = electronApiCache.get(electronAPI)
    if (!api) {
      api = createElectronPlatformApi(electronAPI)
      electronApiCache.set(electronAPI, api)
    }
    return api
  }

  webApi ??= createWebPlatformApi()
  return webApi
}

export const platformApi: PlatformApi = new Proxy({} as PlatformApi, {
  get: (_target, prop) => Reflect.get(currentPlatformApi(), prop),
  has: (_target, prop) => Reflect.has(currentPlatformApi(), prop),
})

/**
 * 这个宿主的 `@onething/client`(C2,`docs/design/client-sdk-2026-09.md` §5.2)。
 *
 * 与 `platformApi` **同一条判据、同一套缓存**(实现都在 `platform/client.ts`):
 * 有 `window.electronAPI` 走 IPC 传输(`platform/electron-transport.ts`),
 * 否则走包里的 HTTP 传输。一样是按访问解析的代理 —— 宿主是运行时才知道的事。
 *
 * 用它做什么:`client.api(router)` 取一个域客户端(壳里几十个 `*-client.ts` 走的
 * 是 `clientApi(router)`,它多包了一层惰性)、`client.events.on(name, cb)` 订
 * core 主推送流上的三条、`client.events.status()` 读连接状态那一格。
 */
export const client: OnethingClient = new Proxy({} as OnethingClient, {
  get: (_target, prop) => Reflect.get(currentClient(), prop),
  has: (_target, prop) => Reflect.has(currentClient(), prop),
})

export { clientApi, clientFor, currentClient } from './client'
export type { PlatformApi, PlatformCapabilities, PlatformEnvironment } from './types'
