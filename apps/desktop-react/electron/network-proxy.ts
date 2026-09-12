/**
 * **代理是一个策略对象,分区问它 —— 不是散在各处的 `if`**(2026-09-12,起因是一条
 * 真机报障:内置浏览器打不开 YouTube,主进程日志成串
 * `ssl_client_socket_impl.cc handshake failed … net_error -100`)。
 *
 * ## 那条报障的形状
 *
 * 用户设置里代理是开着的(`network.proxy.enabled = true`),而
 * `applyShellNetworkProxySettings()` 只对 **`session.defaultSession`** 一个人
 * `setProxy`。内嵌浏览器的每一格身份跑在 `session.fromPartition('persist:browser-<id>')`
 * 上 —— 那是**另一个** `Session` 对象,`electron/browser/` 整棵树里一处 `setProxy`
 * 都没有。于是:app 自己的网络走代理,浏览器标签**直连出网**,被墙的站在 TLS 握手
 * 那一步被关掉。日志里那串 -100 就是它。
 *
 * ## 为什么是一个对象,不是在装配点补两行
 *
 * 补两行的写法是「谁记得谁补」:今天补浏览器分区,明天多一种原生视图(方案 §7 的
 * PDF 阅读器)、多一格 profile、多一条 `fromPartition`,就又得有人记得再补一遍 ——
 * 而**漏掉的后果是静默的**(直连照样能上网,只有被墙的站才炸,炸法还是一条看不懂的
 * TLS 错)。所以这里把它立成一个对象:
 *
 *   · **策略记住当前配置**(`current`);
 *   · **谁要出网谁来登记**(`register(session)`)—— 登记那一刻若已经有配置,**当场
 *     回放**并把那个 promise 交回去;
 *   · **配置变了,策略挨个重套**(`apply(config)` 走 defaultSession + 每一个已登记的)。
 *
 * 于是「新的分区要不要代理」不再是一道要人记得的题:它建出来就登记,登记就有代理。
 *
 * ## 回放必须**等得到**,这是旧壳留下的判例
 *
 * `setProxy` 是异步的。旧壳(`apps/electron/src/browser/session.ts`,已随 Vue 宿主
 * 退役)在 `getBrowserPartitionSession` 里把回放的 promise 记成
 * `whenBrowserPartitionReady(partition)`,并要求**第一发 `loadURL` 必须等它**,理由
 * 逐字写在那只文件上:回放没落地就发请求 = **直连一发**,在只有代理能出网的网络上
 * 那一发不是慢,是失败,而且**泄露直连 IP**。这条判例原样搬过来:
 * `BrowserSessionPolicy.ready(profile)` 是那个 promise 的家,`BrowserTab.load()` 等它。
 *
 * ## 零 electron import(DIP)
 *
 * session 工厂与 dispatcher 缓存都是注入的窄口 —— 于是「配置怎么折」「登记的那几格
 * 是不是真的都套上了」「回放有没有当场发生」这三件真会藏 bug 的事在 vitest 里量得到
 * (与 `electron/browser/` 除 `index.ts` 外每一只文件同一条纪律)。
 */

import { validateOnethingAppProxyUrl } from '@onething/runtime/providers'
import type { ProxySettings } from '@shared/ipc.js'

/** `Session.setProxy` 收的那两档(Electron `ProxyConfig` 里这只壳用得到的一片)。 */
export type ElectronProxyConfig =
  | { readonly mode: 'direct' }
  | {
    readonly mode: 'fixed_servers'
    readonly proxyRules: string
    readonly proxyBypassRules: string
  }

/** Electron `Session` 上这只文件用到的**唯一**一口。 */
export interface ElectronProxySessionLike {
  setProxy(config: ElectronProxyConfig): Promise<void>
}

export interface ShellProxyPolicyPorts {
  /** app 自己那一格。**是函数不是值**:`session.defaultSession` 在 app ready 之前不该碰。 */
  defaultSession(): ElectronProxySessionLike
  /**
   * undici 那半边的代理缓存(provider 请求走它)。与 Electron 的 session 是两条独立
   * 的网络面,同一份设置要同时落到两边 —— 这一口保留旧行为,一个字没改。
   */
  clearDispatcherCache?(): void
  /** 某一格套不上怎么说。缺席 = 咽掉(一格失败不该把整发 apply 炸了)。 */
  onError?(where: string, error: unknown): void
}

/** 一次登记。`ready` = 回放落地;`unregister` = 这一格不再跟着重套(幂等)。 */
export interface ShellProxyRegistration {
  readonly ready: Promise<void>
  unregister(): void
}

/**
 * `a;b, c` → `a;b;c`。空格与空项一律丢掉 —— Chromium 的 bypass 解析器不吃空项。
 * (从 `host-ports.ts` 原样搬来,一个字符没改。)
 */
export function normalizeBypassRules(rules?: string): string {
  return (rules || '').split(/[;,]/).map(rule => rule.trim()).filter(Boolean).join(';')
}

export class ShellProxyPolicy {
  /**
   * 设置 → Electron 的配置。**纯函数**(静态),三档:
   *
   *   · 关着 → `direct`;
   *   · 开着且 URL 合法 → `fixed_servers`;
   *   · 开着但 URL 不合法 → **`direct`**,并经 `onInvalid` 说一声。回落到直连而不是
   *     抛:一个填错的代理地址不该让保存设置那一发失败,但它**必须**说出口
   *     (静默直连正是这次报障那种「看不懂的 TLS 错」的温床)。
   *
   * **`scheme://host:port` 是重拼出来的,不是 `normalizedUrl` 原样**:后者是
   * `new URL(...).toString()`,对 http(s) 会补一个尾随 `/`(`http://127.0.0.1:7890/`),
   * 而 Chromium 的 `proxyRules` 解析器把带路径的串判成非法代理 →
   * `ERR_NO_SUPPORTED_PROXIES`。这条判例是旧壳
   * (`apps/electron/src/main/ipc/network-proxy.ts`)用内嵌浏览器和 favicon 两次
   * 失败换来的,原样保留。
   */
  static fromSettings(
    proxy: ProxySettings | undefined,
    onInvalid?: (error: string) => void,
  ): ElectronProxyConfig {
    if (!proxy?.enabled) return { mode: 'direct' }

    const validated = validateOnethingAppProxyUrl(proxy.url)
    if (!validated.valid) {
      onInvalid?.(validated.error)
      return { mode: 'direct' }
    }
    const parsed = new URL(validated.normalizedUrl)
    return {
      mode: 'fixed_servers',
      proxyRules: `${parsed.protocol}//${parsed.host}`,
      proxyBypassRules: normalizeBypassRules(proxy.bypassRules),
    }
  }

  private readonly ports: ShellProxyPolicyPorts
  /**
   * 最后一次套上去的那一份。**它就是「回放」这件事的全部本钱** —— 一格分区可能在
   * 最后一次 `apply` 之后**很久**才建出来(人在设置页新加了一格身份、或者惰性的
   * tab 这才第一次被看见),没有它那一格就会直连。
   */
  private current: ElectronProxyConfig | undefined
  /** 已登记、要跟着一起重套的那几格。`Set` = 重复登记同一格不会套两遍。 */
  private readonly registered = new Set<ElectronProxySessionLike>()

  constructor(ports: ShellProxyPolicyPorts) {
    this.ports = ports
  }

  /** 此刻的配置(测试与诊断读它)。没 apply 过 = `undefined`。 */
  get config(): ElectronProxyConfig | undefined { return this.current }

  /** 此刻登记着几格(测试与日志读它)。 */
  get registeredCount(): number { return this.registered.size }

  /**
   * 把一份配置套到**这个进程的每一张网络面**上:app 自己那一格 + 每一个已登记的分区。
   *
   * 逐格 try/catch:一格套不上(分区已经销毁之类)不该让别的几格也不套。
   */
  async apply(config: ElectronProxyConfig): Promise<void> {
    this.current = config
    this.ports.clearDispatcherCache?.()

    await this.setOn(this.ports.defaultSession(), config, 'defaultSession')
    await Promise.all(
      [...this.registered].map(session => this.setOn(session, config, 'partition')),
    )
  }

  /**
   * 一格新的网络面要出网了。
   *
   * **已经有配置就当场回放**,并把那一发的 promise 交回去 —— 调用方(分区策略)
   * 把它记成 `ready(profile)`,第一发 `loadURL` 等它(判词在文件头)。
   */
  register(session: ElectronProxySessionLike): ShellProxyRegistration {
    this.registered.add(session)
    const ready = this.current
      ? this.setOn(session, this.current, 'register')
      : Promise.resolve()
    let done = false
    return {
      ready,
      unregister: () => {
        if (done) return
        done = true
        this.registered.delete(session)
      },
    }
  }

  private async setOn(
    session: ElectronProxySessionLike,
    config: ElectronProxyConfig,
    where: string,
  ): Promise<void> {
    try {
      await session.setProxy(config)
    } catch (error) {
      this.ports.onError?.(where, error)
    }
  }
}
