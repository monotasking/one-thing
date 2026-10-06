/**
 * **设置里的代理落到 Electron 这个进程的网络面上**(从 `host-ports.ts` 拆出来的那一半,第④步批 2b)。
 *
 * 第④步批 2b 起后端是 Electron 拉起的子进程,`host-ports.ts` 那张「交给进程内装配的宿主表」整只退役;
 * 剩下真属于 Electron 这个进程的只有这一件:把设置里的 `network.proxy` 套到 `session.defaultSession` 与内置
 * 浏览器的每一格 `persist:browser-<id>` 分区上。后端自己的出网(provider 请求、模型下载)走它自己的受管
 * fetch,读的是同一份设置,与这里无关 —— 所以从前那一口 `clearDispatcherCache`(清后端进程里的 undici 缓存)
 * 在这个进程里没有对象了,不再递。
 *
 * 判词一句话(整段在 `network-proxy.ts` 的文件头):**谁要出网谁来登记,配置变了策略挨个重套**。设置从哪来:
 * 主进程那台客户端的设置订阅源(`core-client.ts` 的 `createSettingsFeed`,订 `GET /api/events` 上的
 * `settings:changed` 再取整份),连上后先套一次,之后每次保存设置再套。
 */
import { session } from 'electron'
import { getLogger } from '@onething/backend/logging'
import type { ProxySettings } from '@shared/ipc.js'
import { ShellProxyPolicy } from './network-proxy.js'
import type { SettingsFeed } from './core-client.js'

const log = getLogger('shell.proxy')

/**
 * 这个进程的**代理策略**。一个对象,不是散在各处的 `if`。它是这只文件的模块级单例,因为它代表的正是
 * **这个进程**的网络面:`electron/browser/index.ts` 拿同一个实例给自己建出来的每一格分区登记。
 */
export const shellProxyPolicy = new ShellProxyPolicy({
  defaultSession: () => session.defaultSession,
  onError: (where, error) => {
    log.warn('apply proxy to a network face failed', { where }, error)
  },
})

/** 一份代理设置套到 defaultSession 加上每一个已登记的浏览器分区。 */
export async function applyShellNetworkProxySettings(proxy: ProxySettings | undefined): Promise<void> {
  await shellProxyPolicy.apply(
    ShellProxyPolicy.fromSettings(proxy ?? { enabled: false, url: '' }, error => {
      log.warn('proxy settings invalid, Electron proxy not applied', { error })
    }),
  )
}

/**
 * 订设置:连上后那一份、以及之后每一次保存,都取 `network.proxy` 重套一遍。返回摘掉它的那一手(幂等)。
 * 处理函数与第④步批 1 那一版(订进程内单槽广播器)逐字同一件事,只是订阅源换成了 SSE。
 */
export function installProxySettingsWatcher(feed: SettingsFeed): () => void {
  return feed.subscribe(settings => {
    void applyShellNetworkProxySettings(settings.network?.proxy).catch(error => {
      log.warn('re-applying proxy after a settings change failed', undefined, error)
    })
  })
}
