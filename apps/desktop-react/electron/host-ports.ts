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
 * 这个壳真的交出来的三件:auth(凭证解密的唯一口)、sandbox(下载目录)、
 * storePath(打包资源目录);其余十二项是 `null`。
 */
import { app, net, safeStorage, session } from 'electron'
import type { OnethingTokenCryptoAdapter } from '@onething/runtime/auth'
import type { OnethingHostPorts } from '@onething/backend/host-ports.js'
import {
  clearAppDispatcherCache,
  createRequiredAppFetch,
  validateProxyUrl,
} from '@onething/backend/provider-binding/bound-fetch.js'
import { getSettings } from '@onething/backend/stores/settings.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'
import type { ProxySettings } from '@shared/ipc.js'

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

function normalizeBypassRules(rules?: string): string {
  return (rules || '').split(/[;,]/).map(rule => rule.trim()).filter(Boolean).join(';')
}

/**
 * 设置里的代理落到这个进程上。两处消费者:undici 的 dispatcher 缓存(provider
 * 请求走它)与 Electron 的 defaultSession(窗口自己的网络)。
 *
 * 与旧壳那份的**唯一**差别:这里没有 `persist:browser` 分区要同步 —— 内嵌浏览器
 * 是旧壳的功能,这个壳还没有。少一行不是漏,是这个宿主没有那件东西。
 *
 * Chromium 的 proxyRules 解析器不吃尾随 `/`(会判成非法代理 →
 * ERR_NO_SUPPORTED_PROXIES),所以这里按 `scheme://host:port` 重拼。
 */
export async function applyShellNetworkProxySettings(
  proxy: ProxySettings = getSettings().network?.proxy ?? { enabled: false, url: '' },
): Promise<void> {
  clearAppDispatcherCache()

  if (!proxy.enabled) {
    await session.defaultSession.setProxy({ mode: 'direct' })
    return
  }

  const validated = validateProxyUrl(proxy.url)
  if (!validated.valid) {
    log.warn('proxy settings invalid, Electron proxy not applied', { error: validated.error })
    await session.defaultSession.setProxy({ mode: 'direct' })
    return
  }
  const parsed = new URL(validated.normalizedUrl!)
  await session.defaultSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: `${parsed.protocol}//${parsed.host}`,
    proxyBypassRules: normalizeBypassRules(proxy.bypassRules),
  })
}

/**
 * 这个壳交给装配层的**全表**(A1)。
 *
 * 从前这里是三次 `configure*Host` 调用,「这个壳没接什么」是看不见的 —— 留账②
 * (打包态找不到内建 skills 目录)正是漏了 `skillsEnvironment` 那一项,而它在
 * 代码里没有留下任何痕迹。现在每一项都要写,没接的写 `null`:下面这十二个
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
    // ── 以下是这个壳还没有的能力。每一行都是一笔待办,不是一次省略。 ──
    // 日志目录与 renderer console 兜底采集:壳走 `configureLogging` 自己开
    // `shell.jsonl`,那两件宿主采集能力还没接。
    logging: null,
    shell: null,
    voice: null,
    terminal: null,
    // 留账②:打包态的内建 skills 目录靠这一项指路,这个壳还没注入。
    skillsEnvironment: null,
    todoPlan: null,
    scratchpad: null,
    plugins: null,
    gateway: null,
    settings: null,
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
