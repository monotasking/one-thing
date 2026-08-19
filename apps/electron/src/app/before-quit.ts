import { app } from 'electron'

type MaybePromise<T> = T | Promise<T>
type CleanupFn = () => MaybePromise<void>

export interface ElectronBeforeQuitAppLike {
  on(event: 'before-quit', listener: () => MaybePromise<void>): void
}

export interface ElectronBeforeQuitCleanupOptions {
  markVoiceQuitRequested: CleanupFn
  shutdownVoiceService: CleanupFn
  shutdownMusicService: CleanupFn
  unregisterGlobalWindowShortcuts: CleanupFn
  shutdownGateway: CleanupFn
  shutdownMCP: CleanupFn
  shutdownACP: CleanupFn
  killTrackedDetachedChildren: CleanupFn
  killAllTerminals: CleanupFn
  killAllBrowserTabs: CleanupFn
  /**
   * 拆插件系统。**必须是同步的**(签名刻意不是 CleanupFn)。
   *
   * `before-quit` 的监听器**不被 Electron await**(这里没有
   * `event.preventDefault()`),所以这张表只有**第一个 await 之前的同步段**是
   * 有保证的;之后的每一步都在和进程退出赛跑。真机走查实证:一次 Cmd+Q 里
   * `[Gateway] Stopped` 与 `[MCPManager] Shutting down...` 之后整条链就断了 ——
   * `[EventSystem] Shut down`(表里第 14 项自己的日志)一次都没出现,
   * store lock(第 17 项)也留在盘上。而更早两次退出它们又都跑完了:
   * 典型的竞速signature,也解释了为什么全套测试永远抓不到。
   *
   * 插件 dispose 是**数据关键**的(插件在 onDispose 里存盘,与
   * flushAllPendingSaves 同级),所以它必须待在同步段里,而不是排在十个 await
   * 后面。同步段执行也顺带满足两个既有约束:它早于 shutdownEventSystem
   * (dispose 还要往总线发 cleared 与 catalog-changed),且此刻总线、引擎、
   * 存储都还活着。
   *
   * `PluginManager.shutdown()` 本身是全同步的(drainCallbacks + 同步 fs),
   * 所以把它放进同步段是真的有保证,不是碰运气。
   */
  shutdownPlugins: () => void
  /**
   * 内嵌的 core HTTP/SSE 面(A 期,docs/design/one-core-2026-08.md §3)。
   *
   * 刻意是**同步**签名并排在同步段:发现文件 `<store>/run/http.json` 是
   * "这个 store 由我在服务"的宣告,它必须先于一切 await 消失,否则一次
   * Cmd+Q 竞速就会在盘上留下一条指向死进程的线索,`server:start` 还得靠
   * pid+端口两段探活才敢无视它。关端口本身是异步的,fire-and-forget。
   * 可选:没挂 HTTP 面的宿主(测试)不用给。
   */
  stopEmbeddedHttpServer?: () => void
  shutdownStreamEngine: CleanupFn
  shutdownPermission: CleanupFn
  shutdownSessionLayer: CleanupFn
  shutdownEventSystem: CleanupFn
  flushAllPendingSaves: CleanupFn
  shutdownAppLogging: CleanupFn
  releaseDesktopStoreLock: CleanupFn
  app?: ElectronBeforeQuitAppLike
  logger?: Pick<Console, 'error'>
}

export function registerElectronBeforeQuitCleanup(
  options: ElectronBeforeQuitCleanupOptions,
): void {
  const electronApp = options.app ?? app
  const logger = options.logger ?? console

  electronApp.on('before-quit', async () => {
    await runElectronBeforeQuitCleanup(options, logger)
  })
}

export async function runElectronBeforeQuitCleanup(
  options: ElectronBeforeQuitCleanupOptions,
  logger: Pick<Console, 'error'> = options.logger ?? console,
): Promise<void> {
  /*
   * ── 同步段:唯一有保证会跑完的部分 ──
   *
   * before-quit 不被 await(见 shutdownPlugins 的注释),第一个 await 之后
   * 进程可能随时消失。数据关键且能同步完成的收尾必须待在这里。
   */
  options.shutdownPlugins()
  options.stopEmbeddedHttpServer?.()

  options.markVoiceQuitRequested()
  await options.shutdownVoiceService()
  await options.shutdownMusicService()
  options.unregisterGlobalWindowShortcuts()

  await options.shutdownGateway()
  await options.shutdownMCP()
  await options.shutdownACP()

  options.killTrackedDetachedChildren()
  options.killAllTerminals()
  options.killAllBrowserTabs()

  await options.shutdownStreamEngine()
  options.shutdownPermission()
  options.shutdownSessionLayer()
  options.shutdownEventSystem()

  try {
    await options.flushAllPendingSaves()
  } catch (err) {
    logger.error('[Shutdown] flushAllPendingSaves error:', err)
  }

  await options.shutdownAppLogging()
  await options.releaseDesktopStoreLock()
}
