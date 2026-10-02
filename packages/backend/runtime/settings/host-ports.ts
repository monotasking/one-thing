/**
 * 设置面的**宿主注入端口** —— 结构债 P4c 第十一批。
 *
 * settings 的四条数据面已经迁到通用 RPC 通道(`settingsRouter` +
 * `backend/rpc/domains/settings.ts`)。四条里有三件事只有 Electron 桌面做得到,
 * 它们从此走这个端口:
 *
 *  - `shouldUseDarkColors()` —— `nativeTheme.shouldUseDarkColors`。未注入时
 *    答 `false`(= 浅色),与迁移前 headless 宿主根本没有这条通道等价。
 *    **注意**:web 端不走这条 —— 浏览器的「系统」是**看的人那台机器**,
 *    所以 `platform/settings-client.ts` 在 web 上就地读 `prefers-color-scheme`,
 *    与迁移前 `platform/web.ts` 的答案逐字相同。
 *  - `applyNetworkProxySettings(proxy)` —— Electron `session` 与内嵌浏览器
 *    分区的代理。未注入 = 无代理面可套用,静默跳过。
 *  - `registerGlobalWindowShortcuts()` —— 全局快捷键重注册。同上。
 *
 * 判例照 `wiring/gateway/host-ports.ts`:**late-bound**(每次调用现读)、
 * **未注入即安静降级**而不是抛错 —— 没有宿主的进程里「给窗口套代理」不是 bug,
 * 是一件做不到的事。
 *
 * 放 `backend/wiring` 而不是 runtime:端口的形状就是 `@shared/ipc/settings.js`
 * 上的 `ProxySettings`,而产品层禁 `@shared/ipc`(只有 `*.wiring.ts` 例外)。
 */
import type { ProxySettings } from '@shared/ipc/settings.js'

type MaybePromise<T> = T | Promise<T>

export interface SettingsHostPorts {
  /** `nativeTheme.shouldUseDarkColors`。未注入 = `false`。 */
  shouldUseDarkColors?(): boolean
  /** 把代理设置套到宿主的网络面(Electron session + 内嵌浏览器分区)。 */
  applyNetworkProxySettings?(proxy: ProxySettings | undefined): MaybePromise<unknown>
  /** 快捷键设置变了之后重注册全局快捷键。 */
  registerGlobalWindowShortcuts?(): MaybePromise<unknown>
}

let hostPorts: SettingsHostPorts = {}

export function configureSettingsHost(ports: SettingsHostPorts): void {
  hostPorts = ports
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetSettingsHost(): void {
  hostPorts = {}
}

/** 当前注入的端口。串联/诊断用。 */
export function getSettingsHostPorts(): SettingsHostPorts {
  return hostPorts
}

/** 宿主说了算的深浅色;没有宿主 = 浅色。 */
export function hostShouldUseDarkColors(): boolean {
  return hostPorts.shouldUseDarkColors?.() === true
}

export async function applyHostNetworkProxySettings(
  proxy: ProxySettings | undefined,
): Promise<void> {
  await hostPorts.applyNetworkProxySettings?.(proxy)
}

export async function registerHostGlobalWindowShortcuts(): Promise<void> {
  await hostPorts.registerGlobalWindowShortcuts?.()
}
