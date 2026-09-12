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
 * (`OnethingHostPorts`,`packages/backend/host-ports.ts`):装配层第一步
 * `applyHostPorts` 逐项接线。每一项必填,没接的显式写 `null` —— 于是"这个壳
 * 缺什么能力"是可数的,而不是靠比对两个壳的调用清单才看得出来。
 *
 * 这个壳真的交出来的:auth(凭证解密的唯一口)、sandbox(下载目录)、
 * storePath(打包资源目录)、terminal(T0:PTY 输出的出网口)、settings
 * (深浅色 + **代理重套**,2026-09-12)与 localTrust(`desktop-embedded`,B3);
 * 其余十项是 `null`。
 */
import { app, nativeTheme, net, safeStorage, session } from 'electron'
import type { OnethingTokenCryptoAdapter } from '@onething/runtime/auth'
import type { OnethingHostPorts } from '@onething/backend/host-ports.js'
import {
  clearAppDispatcherCache,
  createRequiredAppFetch,
} from '@onething/backend/provider-binding/bound-fetch.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { createEventBusTerminalBroadcaster } from '@onething/backend/wiring/terminal/bus-broadcaster.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import type { ProxySettings } from '@shared/ipc.js'
import { ShellProxyPolicy } from './network-proxy.js'

const log = getLogger('shell.host-ports')

/**
 * safeStorage 是 Keychain(macOS)/ DPAPI(Windows)的门面,**绑 app 身份**:
 * 同一台机器上不同 app 加密出来的密文互相解不开。形状照
 * `apps/electron/src/auth/electron-auth.ts:43-49` 抄 —— 三个方法齐了才算数,
 * 缺一个就当没有(产品层的 token store 有明文回退,那是它记录在案的降级)。
 */
function getShellSafeStorage(): OnethingTokenCryptoAdapter | undefined {
  return safeStorage
    && typeof safeStorage.isEncryptionAvailable === 'function'
    && typeof safeStorage.encryptString === 'function'
    && typeof safeStorage.decryptString === 'function'
    ? (safeStorage as unknown as OnethingTokenCryptoAdapter)
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
 * ②宿主表的 `settings.applyNetworkProxySettings`(**改设置那一次** —— 从前这一格
 * 是 `null`,于是「在设置页改代理」只改了 provider 那半边,Electron 这半边要重启
 * 才生效)。
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
 * 这个壳交给装配层的**全表**(A1)。
 *
 * 从前这里是三次 `configure*Host` 调用,「这个壳没接什么」是看不见的 —— 留账②
 * (打包态找不到内建 skills 目录)正是漏了 `skillsEnvironment` 那一项,而它在
 * 代码里没有留下任何痕迹。现在每一项都要写,没接的写 `null`:下面这十个
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
    /**
     * 凭证解密的**唯一**口。不注入 = token 落盘是明文、而已有的 safeStorage
     * 密文一律解不开 → provider 目录看上去是空的(旧 spawn server 路径的真实症状)。
     */
    auth: {
      authFetch: createShellAuthFetch(),
      tokenCryptoAdapter: getShellSafeStorage,
    },
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
    shell: null,
    voice: null,
    // 留账②:打包态的内建 skills 目录靠这一项指路,这个壳还没注入。
    skillsEnvironment: null,
    todoPlan: null,
    scratchpad: null,
    plugins: null,
    gateway: null,
    /**
     * 深浅色 + **代理重套**(2026-09-12)。
     *
     * 这一格从前是 `null`,而那是两个洞:①`getSystemTheme` 恒答浅色(端口缺席的
     * 降级),于是壳里「跟随系统」这一档在深色系统上是错的;②`applyNetworkProxySettings`
     * 没接 → **改设置里的代理不会重套**,只有启动那一次算数。第二个洞与内嵌浏览器
     * 那条直连出网的报障是同一件事的两半:一半是「新分区没代理」(由
     * `ShellProxyPolicy.register` 的回放治),一半是「改了也不生效」(由这一行治)。
     *
     * `registerGlobalWindowShortcuts` **不写** —— 这个壳没有全局快捷键注册这件事
     * (端口是可选的,不写 = 那一句 `?.()` 什么都不做,与从前逐字相同)。
     */
    settings: {
      shouldUseDarkColors: () => nativeTheme.shouldUseDarkColors,
      applyNetworkProxySettings: proxy => applyShellNetworkProxySettings(proxy),
    },
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
  }
}
