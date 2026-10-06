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
 *  - 设置域(`backend/settings/settings-client-api.ts`)因此**不认识 CDP** —— 它只管存那一格
 *    布尔与端口,和存主题、存语言没有任何区别;
 *  - 折叠这件事与 `applyCdpFlag` 同家(都在 `electron/browser/`),一处知识不分两地。
 *
 * 一句话判据:**「这一格设置要在 ready 之前生效」是宿主的病,不该传染给设置域。**
 *
 * ## 读一次 + 订一条,不是「每次要用时去读」
 *
 * 旗文件是**写出去给下一次启动看的**,没有第二个读者在运行期问它。所以这里的活
 * 只有两下:连上后端后读一次(把盘上那份与设置对齐 —— 有人手改过 `settings.json`、
 * 或者上一次退出时没写成),之后每次 `settings:changed` 再折一次。
 *
 * ## 订阅源是主进程那台客户端(第④步批 2b)
 *
 * 从前这里串在后端进程内那只 `settings:changed` 单槽广播器上(「先叫前一个、再干自己的」);
 * 后端出了这个进程,那只广播器就不在这里了。订阅源换成 `core-client.ts` 的设置 feed
 * (订 `GET /api/events` 上同名的全局事件、再取整份设置),处理函数一个字不变。
 *
 * ## `run/http.json` 里不再写 `cdp` 那一格(第④步批 2b)
 *
 * 发现文件归后端进程写,而 CDP 口开在 Electron 这个进程上;AI 用浏览器那一半(chrome-devtools-mcp
 * 连 CDP)用户已定不做,所以从前那只 `cdpDiscoveryExtras` 与它在发现文件里补的那一格一起退役。
 *
 * ## 零 electron import
 *
 * 与这个目录里除 `index.ts` 之外的每一只文件同一条纪律:Electron 与 backend 的
 * 触点全是**注入的结构化端口**,于是它在 vitest(node,没有 Electron 运行时)里
 * 跑得起来。类型是 `import type`,编译后一个字节都不剩。
 */

import type { AppSettings } from '@shared/ipc/settings.js'
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

export interface CdpSettingsWatcherOptions {
  /** 旗文件落在 `<storePath>/run/cdp.json`。缺席 = 按当前 store 解析。 */
  readonly storePath?: string
  /**
   * 订设置(生产里是 `core-client.ts` 的设置 feed):订上去之后先交一次当下那一份,之后每次保存再交。
   * 返回退订。
   */
  subscribe(listener: (settings: Pick<AppSettings, 'browser'>) => void): () => void
  /**
   * 写旗文件砸了怎么说。缺席 = 咽掉 —— 这一格的全部后果是「下次启动 CDP 口
   * 状态没跟上」,不该让它把一次保存设置炸掉。
   */
  onError?(error: unknown): void
}

/**
 * 装上「设置 → 旗文件」这条路。返回摘掉它的那一手(**幂等**)。
 */
export function installCdpSettingsWatcher(options: CdpSettingsWatcherOptions): () => void {
  let disposed = false
  const off = options.subscribe(settings => {
    if (disposed) return
    try {
      writeCdpLaunchFlag(options.storePath, cdpFlagFromSettings(settings))
    } catch (error) {
      options.onError?.(error)
    }
  })
  return () => {
    if (disposed) return
    disposed = true
    off()
  }
}
