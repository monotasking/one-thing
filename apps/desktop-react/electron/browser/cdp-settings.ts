/**
 * 设置里那一格 CDP 开关 → **启动旗文件**的那条路(B2′,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-5 / §9-4)。
 *
 * ## 为什么这件事住在宿主里,而不是设置域里
 *
 * `--remote-debugging-port` 只能在 app `ready` 之前加(`cdp-flag.ts` 的文件头写着
 * 为什么),而设置要装配之后才读得到 —— 两件事在时间上永远碰不到头。所以这一格
 * 设置的**启动期投影**是 `<store>/run/cdp.json`,而把设置折成那个文件的人是**宿主**:
 *
 *  - 设置域(`backend/rpc/domains/settings.ts`)因此**不认识 CDP** —— 它只管存那一格
 *    布尔与端口,和存主题、存语言没有任何区别;
 *  - 折叠这件事与 `applyCdpFlag` 同家(都在 `electron/browser/`),一处知识不分两地。
 *
 * 一句话判据:**「这一格设置要在 ready 之前生效」是宿主的病,不该传染给设置域。**
 *
 * ## 读一次 + 订一条,不是「每次要用时去读」
 *
 * 旗文件是**写出去给下一次启动看的**,没有第二个读者在运行期问它。所以这里的活
 * 只有两下:装配完读一次(把盘上那份与设置对齐 —— 有人手改过 `settings.json`、
 * 或者上一次退出时没写成),之后每次 `settings:changed` 再折一次。
 *
 * ## 单槽端口要**串联**,不是覆盖
 *
 * `configureSettingsEventBroadcaster` 是一个单槽端口,而内嵌 HTTP 面已经占着它
 * (它要把设置变更扇成 SSE)。所以这里照 `server/runtime.ts:1473` 那条判例:
 * 先取走前一个,装一个「先叫前一个、再干自己的」,拆的时候原样装回去。
 * 覆盖 = 壳的设置页从此收不到 `settings:changed` 的回声。
 *
 * ## 零 electron import
 *
 * 与这个目录里除 `index.ts` 之外的每一只文件同一条纪律:Electron 与 backend 的
 * 触点全是**注入的结构化端口**,于是它在 vitest(node,没有 Electron 运行时)里
 * 跑得起来。类型是 `import type`,编译后一个字节都不剩。
 */

import type { AppSettings } from '@shared/ipc/settings.js'
import type { HttpDiscoveryExtras } from '@shared/backend/http-discovery.js'
import type {
  SettingsEvent,
  SettingsEventBroadcaster,
} from '@onething/backend/wiring/settings/events.js'
import { writeCdpLaunchFlag, type CdpLaunchFlag } from './cdp-flag.js'

/** Chromium 那个开关的名字。三处(append / 探活 / 发现文件)共用一个串。 */
export const CDP_SWITCH_NAME = 'remote-debugging-port'

/**
 * 设置里那一格 → 旗文件要写什么。`null` = 把旗文件删掉。
 *
 * **端口不合法就当关着**,不回落到缺省口:一个人把端口写成 `0` 的意思是
 * 「我不要这个东西按 9333 开」,替他挑一个口是自作主张。归一那一层
 * (`mergeWithDefaults`)本来就会把脏值夹回缺省,所以走到这里还不合法的,
 * 是有人绕过归一直接喂进来的。
 */
export function cdpFlagFromSettings(settings: Pick<AppSettings, 'browser'>): CdpLaunchFlag | null {
  const cdp = settings.browser?.cdp
  if (!cdp?.enabled) return null
  const port = cdp.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { port }
}

/** `app.commandLine` 里本模块要问的那两句。真 `app` 直接喂得进来(结构相容)。 */
export interface CdpCommandLineProbe {
  hasSwitch(name: string): boolean
  getSwitchValue(name: string): string
}

/**
 * 这个进程**此刻真的**开着 CDP 口吗 —— 开着就交出发现文件要补的那一格。
 *
 * 判据是命令行,**不是设置**:设置改了要重启才生效,按设置写发现文件等于说谎
 * (别的客户端会照着那个口去连,然后收一句「连接被拒绝」)。
 *
 * 命令行上没有、或者值不是一个合法端口(空串 / `0` / 非数字)→ `undefined`,
 * 于是那个键根本不出现在 `run/http.json` 里。
 */
export function cdpDiscoveryExtras(commandLine: CdpCommandLineProbe): HttpDiscoveryExtras | undefined {
  if (!commandLine.hasSwitch(CDP_SWITCH_NAME)) return undefined
  const port = Number.parseInt(commandLine.getSwitchValue(CDP_SWITCH_NAME), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { cdp: { port } }
}

export interface CdpSettingsWatcherOptions {
  /** 旗文件落在 `<storePath>/run/cdp.json`。缺席 = 按当前 store 解析。 */
  readonly storePath?: string
  /** 当下的设置。装配完调一次。 */
  readSettings(): Pick<AppSettings, 'browser'>
  /** 单槽端口的读口(串联用)。 */
  getBroadcaster(): SettingsEventBroadcaster | null
  /** 单槽端口的写口。 */
  setBroadcaster(next: SettingsEventBroadcaster | null): void
  /**
   * 写旗文件砸了怎么说。缺席 = 咽掉 —— 这一格的全部后果是「下次启动 CDP 口
   * 状态没跟上」,不该让它把装配或者一次保存设置炸掉。
   */
  onError?(error: unknown): void
}

/**
 * 装上「设置 → 旗文件」这条路。返回摘掉它的那一手(**幂等**)。
 *
 * 摘掉时把单槽端口**原样装回去** —— 装回去的是「装我的时候那里放着的那一个」,
 * 不是 `null`:内嵌 HTTP 面的扇出还在它上面挂着(与 `server/runtime.ts` 的
 * `restoreSettingsEventBroadcaster` 同一条纪律)。
 */
export function installCdpSettingsWatcher(options: CdpSettingsWatcherOptions): () => void {
  const apply = (settings: Pick<AppSettings, 'browser'>): void => {
    try {
      writeCdpLaunchFlag(options.storePath, cdpFlagFromSettings(settings))
    } catch (error) {
      options.onError?.(error)
    }
  }

  // ① 开场对齐一次:盘上那份未必等于设置那一格(有人手改过 settings.json、
  //    或者上一次退出时旗文件没写成)。
  try {
    apply(options.readSettings())
  } catch (error) {
    options.onError?.(error)
  }

  // ② 串联进单槽端口:先叫前一个,再折自己这一格。
  const previous = options.getBroadcaster()
  const mine: SettingsEventBroadcaster = (event: SettingsEvent) => {
    previous?.(event)
    apply(event.settings)
  }
  options.setBroadcaster(mine)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 只在还是**我**占着那一格时才还原 —— 中间有人又串了一层的话,把它的那一层
    // 一起抹掉比不还原更坏。
    if (options.getBroadcaster() === mine) options.setBroadcaster(previous)
  }
}
