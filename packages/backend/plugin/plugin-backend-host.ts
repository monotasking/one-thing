/**
 * 插件系统挂在后端进程上(第④步批 4,`docs/design/two-process-2026-10.md` §2.5):后端进程起、拆插件管理器要的三件。
 *
 * 从前插件管理器只在 Vue 桌面主进程里起(`bootstrapPluginSystem` 拆进程之前全仓零生产调用者),所以
 * `GET /api/capabilities` 的 `pluginsManage` 恒假、插件域写面答「只在桌面宿主」。现在由 `backend-launcher.ts`
 * 在桌面档与 CLI 档的装配之后起它,用的就是这里交出的三样:
 *
 *  - `backendPluginsHostPorts` —— 宿主表 `plugins` 一格:`execCommand` 是后端自己起子进程(`plugin-command-process.ts`);
 *    不给 `pickFile` —— 后端进程没有窗口,对话框在客户端开,选好的文件经 `plugins.pickFile` 的 `file` 一格交回来;
 *  - `startPluginSystem(eventBus, engine)` —— 起管理器(幂等;启动失败只记一行,与 `bootstrapPluginSystem` 同口径);
 *  - `shutdownPluginSystemWithin(ms)` —— 拆管理器,最多等 `ms`(与 MCP / ACP 子系统同一个 3 秒,理由见
 *    `mcp/mcp-subsystem.ts` 的 `DEFAULT_MCP_DISPOSE_TIMEOUT_MS`:SIGTERM 之后只有 5 秒,会话账本的落盘排在后面)。
 *    同一只管理器调多少次都是同一场等待,所以装配里那格兜底的 `pluginManager` 拆除与启动点那格不会各等 3 秒。
 *
 * 依赖:同功能的管理器与执行器。
 */
import type { PluginsHostPorts } from './plugin-host-ports.js'
import { execPluginCommandInBackendProcess } from './plugin-command-process.js'
import { bootstrapPluginSystem, getPluginManager, type PluginManager } from './plugin-manager.js'

/** 插件系统收尾的上限(毫秒)。 */
export const PLUGIN_SYSTEM_SHUTDOWN_TIMEOUT_MS = 3000

/** 后端进程交给宿主表 `plugins` 一格的那两件里的一件(另一件 `pickFile` 不给,理由见文件头)。 */
export const backendPluginsHostPorts: PluginsHostPorts = {
  execCommand: (command, args, options) => execPluginCommandInBackendProcess(command, args, options),
}

/** 起插件管理器。必须在事件总线与引擎都建好之后调(装配跑完)。 */
export function startPluginSystem(eventBus: unknown, streamEngine: unknown): Promise<PluginManager> {
  return bootstrapPluginSystem(eventBus, streamEngine)
}

/** 每只管理器一场有上限的等待:第二次调拿到的是同一个承诺,不再另起一个计时器。 */
const shutdownRaces = new WeakMap<PluginManager, Promise<boolean>>()

/**
 * 拆当前的插件管理器,最多等 `timeoutMs`;返回是否超时(超时就不再等,插件那边没拆完的照它自己的节奏收)。
 * 没有管理器 = 立即答 `false`。
 */
export function shutdownPluginSystemWithin(timeoutMs = PLUGIN_SYSTEM_SHUTDOWN_TIMEOUT_MS): Promise<boolean> {
  const manager = getPluginManager()
  if (!manager) return Promise.resolve(false)
  const existing = shutdownRaces.get(manager)
  if (existing) return existing
  const work = Promise.resolve().then(() => manager.shutdown())
  work.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(true), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  const race = Promise.race([work.then(() => false, () => false), deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  shutdownRaces.set(manager, race)
  return race
}
