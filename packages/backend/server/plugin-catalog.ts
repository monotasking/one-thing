/**
 * server 侧插件目录的**单槽端口** —— 结构债 P4 终态批 C2。
 *
 * apps/server 的插件目录是**另一棵树**的只读镜像:
 * `owners/<uid>/<wid>/plugin-store/plugins`(不是 `<store>/plugins`),entry 全是
 * noop,插件代码在 server 上从不执行;唯一真会落盘的是 enable 标志。这套语义连同
 * `ServerPluginCatalogManager` 一起住在 `server/runtime.ts` 的装配闭包里(它要
 * `dataRoot` / `options.pluginCommands` / 会话所有权判定 / eventBus 才组得出来)。
 *
 * C2 把六条读/开关面(list / enable / disable / refresh / commands /
 * executeCommand)从 `/api/plugins*` 那六条 REST 路由搬到了 `plugins` RPC 域。
 * 域住在装配层、拿不到那个闭包,所以这里立一个单槽端口:
 * `createOnethingServerRuntime` 装配时把**同一批闭包**注入进来,
 * `rpc/domains/plugins.ts` 在 `transport === 'http'` 那一支上原样调用。
 * **实现一行没搬、语义一字未改** —— 换的只是入口。
 *
 * 未注入 = 这台进程没有 server 运行时(桌面 IPC、CLI、单元测试)。那一支上域
 * 走的是桌面那条真路(`getPluginManager()`),永远不会问到这里。
 *
 * 判例同 `wiring/settings/events.ts` 的广播端口:**late-bound**(每次现读)、
 * 注册返回一个还原函数,于是 HTTP 面关掉时不会把上一位占用者的槽一起清掉
 * (桌面内嵌 HTTP 面 + `server:start` 在同一个进程里先后起落时的唯一正确语义)。
 */
import type { RuntimeRequestContext } from '@onething/core'

/**
 * 六件事的原始形状 —— 逐字就是从前 `OnethingRuntimeFacade` 上那只
 * `RuntimePluginsAdapter`(该类型已随本批从 core 删除:它只有这一个实现者、
 * 一个读者)。
 */
export interface ServerPluginCatalogPort {
  list(context?: RuntimeRequestContext): Promise<unknown>
  enable(pluginId: string, context?: RuntimeRequestContext): Promise<unknown>
  disable(pluginId: string, context?: RuntimeRequestContext): Promise<unknown>
  refresh(context?: RuntimeRequestContext): Promise<unknown>
  commands(context?: RuntimeRequestContext): Promise<unknown>
  executeCommand(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
}

let port: ServerPluginCatalogPort | null = null

/**
 * 注册这台进程的 server 插件目录。返回**还原**函数(不是清空):
 * 谁装的谁还原,后来者的槽不会被前一位的 shutdown 抹掉。
 */
export function configureServerPluginCatalogPort(
  next: ServerPluginCatalogPort | null,
): () => void {
  const previous = port
  port = next
  return () => {
    if (port === next) port = previous
  }
}

export function getServerPluginCatalogPort(): ServerPluginCatalogPort | null {
  return port
}
