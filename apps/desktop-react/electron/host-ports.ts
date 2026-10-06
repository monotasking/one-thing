/**
 * React 壳自己那份**宿主注入**(A1-b,2026-08-31)。
 *
 * 装配层(`@onething/backend`)从不 import electron —— 它需要的 Electron 独有能力
 * 一律由宿主经 `configure*Host` 端口递进去(CLAUDE.md 的 configure*Host 表)。
 * 这个文件就是这个壳递的那几件。
 *
 * **为什么自己写一份,不 import `@onething/electron-host/*`**:那个别名家族是
 * apps/electron 的**内部**路径,不是一个包 —— 它只在旧壳的 electron-vite /
 * vitest 配置里被 alias 出来,esbuild 这条链上根本解析不到。而且跨 app import
 * 会让两个壳的启动路径互相牵制,过渡期恰恰要它们各自独立。四件东西加起来六十行,
 * 抄形比接线便宜。
 *
 * A1(2026-09-02)之后这里不再自己调 `configure*Host`,而是**交出一张表**
 * (`OnethingHostPorts`,`packages/backend/backend-host-ports.ts`):装配层第一步
 * `applyHostPorts` 逐项接线。每一项必填,没接的显式写 `null` —— 于是"这个壳
 * 缺什么能力"是可数的,而不是靠比对两个壳的调用清单才看得出来。
 *
 * 这个壳真的交出来的:auth(OAuth 取数)、legacySafeStorageForMigration(旧密文的解密器)、
 * sandbox(下载目录)、storePath(打包资源目录)、terminal(T0:PTY 输出的出网口)、
 * localTrust(`desktop-embedded`,B3)、speechOutput(宠物 P3:主进程起子进程出声);其余是 `null`。
 *
 * 第④步批 1 起这张表里**没有客户端的事**了:`shell`(打开外链 / 打开路径 / 在访达里定位)、`dialog`
 * (原生对话框)、`settings`(深浅色 + 改设置后重套代理)三格退役。前两样渲染层经 preload 的
 * `host:client-action` 交给主进程自己做(`./client-action.ts`);深浅色渲染层自己读;代理重套由
 * 下面的 `installProxySettingsWatcher` 订 `settings:changed` 自己做。
 */
import { app, net, safeStorage, session } from 'electron'
import type { LegacySafeStorageDecryptor } from '@onething/backend/credentials'
import type { OnethingHostPorts } from '@onething/backend/backend-host-ports.js'
import {
  clearAppDispatcherCache,
  configureSettingsEventBroadcaster,
  createRequiredAppFetch,
  getSettings,
  getSettingsEventBroadcaster,
  type SettingsEventBroadcaster,
} from '@onething/backend/settings'
import { createEventBusTerminalBroadcaster } from '@onething/backend/terminal'
import { getLogger } from '@onething/backend/logging'
import type { ProxySettings } from '@shared/ipc.js'
import { ShellProxyPolicy } from './network-proxy.js'
import { createShellSpeechOutput } from './speech-output.js'

const log = getLogger('shell.host-ports')

/**
 * safeStorage 是 Keychain(macOS)/ DPAPI(Windows)的门面,**绑 app 身份**:同一台机器上不同 app
 * 加密出来的密文互相解不开。第④步批 0 起凭证的落盘加密改用后端自己的主密钥,这里的 safeStorage
 * **只当迁移用的旧解密器**:存量的 `encryption: 'safeStorage'` 凭证文件与旧单槽 `oauth-tokens.json`
 * 要靠它解开、再由后端用主密钥封成新信封。只递解密的两个方法,写侧再也用不到它。
 */
function legacySafeStorageForMigration(): LegacySafeStorageDecryptor | undefined {
  return safeStorage
    && typeof safeStorage.isEncryptionAvailable === 'function'
    && typeof safeStorage.decryptString === 'function'
    ? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      decryptString: buffer => safeStorage.decryptString(buffer),
    }
    : undefined
}

/**
 * OAuth 的取数走 Electron 的 `net.fetch`(跟随 app 的代理/证书设置),
 * 失败一次就退到 undici。形状照 `apps/electron/src/auth/auth-fetch.ts` 抄。
 */
function createShellAuthFetch(): typeof fetch {
  const fallbackFetch = createRequiredAppFetch({ policy: 'auth' })
  return async (input, init) => {
    const electronFetch = typeof net?.fetch === 'function' ? net.fetch.bind(net) : undefined
    if (!electronFetch) return fallbackFetch(input, init)
    try {
      return await electronFetch(input as never, init as never)
    } catch (error) {
      log.warn('net.fetch failed; falling back to app fetch', undefined, error)
      return fallbackFetch(input, init)
    }
  }
}

/**
 * 这个进程的**代理策略**(2026-09-12)。一个对象,不是散在各处的 `if` —— 判词整段
 * 在 `network-proxy.ts` 的文件头上,一句话的版本:**谁要出网谁来登记,配置变了策略
 * 挨个重套**。从前这里只对 `session.defaultSession` 一个人 `setProxy`,而内嵌浏览器
 * 的每一格身份跑在自己的 `persist:browser-<id>` 分区上 → 标签直连出网 → 被墙的站
 * TLS 被关(那条真机报障里成串的 `net_error -100`)。
 *
 * 它是这只文件的模块级单例,因为它代表的正是**这个进程**的网络面:
 * `electron/browser/index.ts` 拿同一个实例给自己建出来的每一格分区登记。
 */
export const shellProxyPolicy = new ShellProxyPolicy({
  defaultSession: () => session.defaultSession,
  clearDispatcherCache: clearAppDispatcherCache,
  onError: (where, error) => {
    log.warn('apply proxy to a network face failed', { where }, error)
  },
})

/**
 * 设置里的代理落到这个进程上。两处消费者:undici 的 dispatcher 缓存(provider
 * 请求走它,由策略内部的 `clearDispatcherCache` 顶掉)与 Electron 的每一张
 * session —— **defaultSession 加上每一个已登记的浏览器分区**。
 *
 * 两个调用点,一件事:①`main.ts` 的 `hooks.afterSettings`(启动那一次;那一刻
 * 浏览器宿主还没装,所以分区靠建出来时的**回放**拿到代理,不靠这一发);
 * ②`installProxySettingsWatcher`(**改设置那一次**,第④步批 1 起;从前是宿主表的
 * `settings.applyNetworkProxySettings` 那一格由后端保存链回调过来)。
 */
export async function applyShellNetworkProxySettings(
  proxy: ProxySettings | undefined = getSettings().network?.proxy ?? { enabled: false, url: '' },
): Promise<void> {
  await shellProxyPolicy.apply(
    ShellProxyPolicy.fromSettings(proxy, error => {
      log.warn('proxy settings invalid, Electron proxy not applied', { error })
    }),
  )
}

/**
 * **改设置之后重套代理**(第④步批 1,决策 D282)。
 *
 * 从前后端的保存链经宿主端口 `settings.applyNetworkProxySettings` 回调过来;后端要搬出这个进程,
 * 那一格就没了 —— 所以改成 Electron 自己听 `settings:changed`:每一次保存设置后端都会广播它,
 * 载荷里就是归一过的整份设置,这里只取 `network.proxy` 交给同一个 `applyShellNetworkProxySettings`。
 *
 * 今天后端还在这个进程里,所以订的是进程内那只单槽广播器,写法与 `browser/cdp-settings.ts` /
 * `browser/profiles.ts` 逐字同一条:**串联,不是覆盖**(先叫前一个、再干自己的;摘的时候只在还是
 * 我占着那一格时才把前一个装回去)。批 2 拆进程之后换成订 `GET /api/events` 上同名的那条全局事件,
 * 处理函数一个字不变。返回摘掉它的那一手(幂等)。
 */
export function installProxySettingsWatcher(): () => void {
  const previous = getSettingsEventBroadcaster()
  const mine: SettingsEventBroadcaster = (event) => {
    previous?.(event)
    void applyShellNetworkProxySettings(event.settings.network?.proxy ?? { enabled: false, url: '' }).catch(error => {
      log.warn('re-applying proxy after a settings change failed', undefined, error)
    })
  }
  configureSettingsEventBroadcaster(mine)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    if (getSettingsEventBroadcaster() === mine) configureSettingsEventBroadcaster(previous)
  }
}

/**
 * 这个壳交给装配层的**全表**(A1)。
 *
 * 从前这里是三次 `configure*Host` 调用,「这个壳没接什么」是看不见的 —— 留账②
 * (打包态找不到内建 skills 目录)正是漏了 `skillsEnvironment` 那一项,而它在
 * 代码里没有留下任何痕迹。现在每一项都要写,没接的写 `null`:下面这九个
 * `null` 就是这个壳的能力缺口清单,一眼可数。
 *
 * 接与不接是**产品决定**,不是这一批的事:A 只负责让"没接"从静默变成一行代码。
 *
 * 调用点:`createOnethingBackend({ host: … })`,装配第一步就 `applyHostPorts`。
 */
export function createShellHostPorts(): OnethingHostPorts {
  return {
    storePath: {
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    },
    sandbox: {
      getPath: name => app.getPath(name as Parameters<typeof app.getPath>[0]),
    },
    /** OAuth 取数走 Electron 的 `net.fetch`(跟随 app 的代理 / 证书设置)。 */
    auth: {
      authFetch: createShellAuthFetch(),
    },
    /**
     * 旧 safeStorage 密文的解密器,只当迁移用(第④步批 0)。装配时后端用它解开存量凭证,
     * 封成主密钥信封;旧文件改名 `.safestorage-backup` 留底。
     */
    legacySafeStorageForMigration,
    /**
     * 终端输出的出网口(T0,方案 `apps/desktop-react/docs/terminal-browser-2026-09.md`
     * §2.1-1/2)。**注入这一格 = 这台宿主有终端** —— `hasTerminalHost()` 是
     * `terminal` 域七条 RPC 的闸,也是 `/api/capabilities.terminal` 那一位;在此
     * 之前它们在生产里恒 false / 恒拒,壳里那块终端面板是假的。
     *
     * 推送骑的是既有的全局事件 → `GET /api/events`,不新开通道:这个壳只有一条
     * IPC(`host:connection`),渲染层与 core 之间只有 HTTP/SSE。
     */
    terminal: { broadcaster: createEventBusTerminalBroadcaster() },
    // ── 以下是这个壳还没有的能力。每一行都是一笔待办,不是一次省略。 ──
    // 日志目录与 renderer console 兜底采集:壳走 `configureLogging` 自己开
    // `shell.jsonl`,那两件宿主采集能力还没接。
    logging: null,
    voice: null,
    // 留账②:打包态的内建 skills 目录靠这一项指路,这个壳还没注入。
    skillsEnvironment: null,
    todoPlan: null,
    scratchpad: null,
    plugins: null,
    gateway: null,
    evals: null,
    mcp: null,
    /**
     * 唯一一格不是 `null` 的"缺口清单"外条目(B3):这个壳是**桌面**,它服务的是
     * 本机同一个用户的同一个 store,而渲染层只走 HTTP/SSE —— 于是每一条 RPC 都
     * 是"联网调用方"。装配时就说清楚,`tools` / `search` / `evals` / `mcp` /
     * `sessions` / `files` 六个域的信任判据从第一毫秒起就是对的,不必等内嵌 HTTP
     * 面挂上来(B2 之前正是那样:面起来之前 `search.query` 直接抛)。
     */
    localTrust: { origin: 'desktop-embedded' },
    /**
     * 主进程出声(宠物 P3,`docs/design/pet-system-2026-09.md` §10.2)。这个壳的 `voice`
     * 是 `null` —— 没有渲染进程在听 `MUSIC_DJ_SPEAK` 那条推送,电台口播从前合成成功也要空等
     * 30 秒回执、一个字都不出声。出声不需要窗口:mpv / afplay 子进程就能放。
     */
    speechOutput: createShellSpeechOutput(),
  }
}
