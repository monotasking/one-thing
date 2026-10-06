import {
  settingsRouter,
  type AppSettings,
  type GetSettingsResponse,
  type SaveSettingsResponse,
} from '@shared/ipc/settings'
import type { BackendHostState, ClientActionDone } from '@shared/contracts/client-action'

/**
 * 设置 → 通用「后端」那几行与两处之间的**端口**(第④步批 2b)。
 *
 * 两处:后端自己(读 / 写整份设置里 `general.backendKeepRunningAfterQuit` 那一格,`settings` 域)与
 * **拉起后端的那个宿主**(后端此刻的样子、重启它、定位它的日志 —— 只有桌面的主进程答得出,走
 * `src/platform/host.ts` 那几只函数)。形状是两边调用面的子集,存在的唯一理由是可测(判例与
 * `network-settings-port` 逐字相同)。整份写回一律「当场读一份新的 → 合一格 → 整份写回」。
 */
export interface BackendHostPort {
  /** 这台客户端看不看得见后端进程(浏览器壳答假:三行不画、横幅不弹)。 */
  available(): boolean
  readState(): Promise<BackendHostState | undefined>
  onState(listener: (state: BackendHostState) => void): () => void
  restart(): Promise<ClientActionDone>
  revealLog(): Promise<ClientActionDone>
  readSettings(): Promise<GetSettingsResponse>
  saveSettings(settings: AppSettings): Promise<SaveSettingsResponse>
}

let port: BackendHostPort | undefined
let pending: Promise<BackendHostPort> | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureBackendHostPort(next: BackendHostPort | undefined): void {
  port = next
  pending = undefined
}

export function backendHostPort(): Promise<BackendHostPort> {
  if (port) return Promise.resolve(port)
  pending ??= Promise.all([import('../platform/host'), import('../platform/connection')]).then(([host, connection]) => {
    const settingsApi = async () => (await connection.onethingClient()).api(settingsRouter)
    return {
      available: () => host.canSeeBackendProcess(),
      readState: () => host.readBackendHostState(),
      onState: listener => host.onBackendHostStateChange(listener),
      restart: () => host.restartBackendViaHost(),
      revealLog: () => host.revealBackendLogViaHost(),
      readSettings: async () => (await settingsApi()).getSettings({}),
      saveSettings: async settings => (await settingsApi()).saveSettings(settings),
    } satisfies BackendHostPort
  }).catch(error => {
    pending = undefined
    throw error
  })
  return pending
}
