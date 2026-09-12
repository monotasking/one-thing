import { markAllTerminalsDetached } from '@onething/runtime/terminal/service.wiring'

/**
 * **窗口页面重载 = 终端消费者走了**(T2,方案 §2.1 与 T1 留账那一行)。
 *
 * ── 病(它为什么值一段接线)────────────────────────────────────────────────
 * 终端的流控是**代次 + 回执**:服务端每发一段就记一笔未回执字节,攒过高水位
 * (128KB)就**暂停读 PTY**,等壳把「画上去了」回执回来。壳那一侧一重载,
 * 上一份订阅连同它欠着的那笔账一起没了 —— 而服务端并不知道,它看到的只是
 * 「回执停了」。于是那格终端冻在高水位上,直到 `ackStallMs`(5 秒)那只停滞表
 * 响了才自动 detach。
 *
 * 服务本来就有那条自动兜底(`TerminalService` 的 stall timer),所以这一段治的
 * 不是「会不会恢复」,是**那五秒**:重载之后新的 attach 立刻就到,而它撞上的是
 * 一台还在暂停里的 PTY。`markAllTerminalsDetached()` 把「消费者已经证明不在了」
 * 这句话**当场**说给服务听 —— 它是宿主才知道的事实,服务猜不出来。
 *
 * ── 判据三条,每一条都是有意的 ──────────────────────────────────────────
 *  · **主框架**:子框架(未来的内嵌页、devtools)导航与终端的消费者无关;
 *  · **非同文档**:`pushState` / 锚点跳转不换文档,订阅一条都没断;
 *  · **非首次**:窗口第一次 `loadURL` / `loadFile` 也是一次 `did-start-navigation`,
 *    而那时壳还一格终端都没 attach 过 —— 那一发调下去是一句无害的空话,
 *    但它会让这段接线读起来像「开窗就 detach」。判据写出来,读的人不用猜。
 *
 * ── 关窗那条**不接**(派工单明写)──────────────────────────────────────
 * 关窗走的是 `backend.dispose()` → `killAllTerminals()`:那几格 PTY 真的被杀掉,
 * 再去说一句「它们 detach 了」既没有意义也晚了一步。
 *
 * ── 为什么是自己一只文件 ────────────────────────────────────────────────
 * `main.ts` 那边只留一行调用(它是别批的脏文件,只许加不许改);判据与病历住在
 * 这里,顺带这只文件在 vitest 里跑得起来 —— 它收的是一个**结构化的口**
 * (`on` / `off` 两件),不 import electron。
 */

/** 这段接线要的全部:一扇窗的 `webContents` 上那两口。 */
export interface NavigationEmitter {
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown
  off(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown
}

/** `WebContentsDidStartNavigationEventParams` 里这段接线真的会读的那两格。 */
export interface NavigationDetails {
  isMainFrame: boolean
  isSameDocument: boolean
}

/**
 * 挂上去,交回摘钩子那一口。
 *
 * `detach` 可注入只为测试 —— 生产里它恒等于 `markAllTerminalsDetached`,
 * 而那只函数在没有终端的宿主上是一句安全的空话(它自己的注释:`No-op safe`)。
 */
export function installTerminalReloadDetach(
  contents: NavigationEmitter,
  detach: () => void = markAllTerminalsDetached,
): () => void {
  let navigated = false
  const onNavigation = (details: NavigationDetails) => {
    if (!details.isMainFrame || details.isSameDocument) return
    // 第一次是开窗那一发(见文件头「非首次」)。
    if (!navigated) {
      navigated = true
      return
    }
    detach()
  }
  contents.on('did-start-navigation', onNavigation)
  return () => {
    contents.off('did-start-navigation', onNavigation)
  }
}
