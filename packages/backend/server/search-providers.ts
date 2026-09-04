/**
 * server 侧搜索的**单槽端口** —— 结构债 P4 终态批 A1-b(2026-08-23)。
 *
 * apps/server 的搜索和桌面的搜索是**同一件事的两个口径**:桌面查的是整台机器上
 * 那一份会话 / 文件 / 提示词表(进程单槽里那份 `SearchService` + store 级索引),
 * server 查的是 per-owner 沙箱里的那一份 —— 归属判定、工作区根、变量仓、提示词仓
 * 全都按请求上下文取。后者连同它要的 `workspaceRoot` / `getSessionForContext` /
 * `settingsByOwner` 一起住在 `server/runtime.ts` 的装配闭包里,组不出第二份。
 *
 * A1-b 把 `search:query`(桌面)与 `POST /api/search/query`(server)一起搬到了
 * `search` RPC 域。域住在装配层、拿不到那个闭包,所以这里立一个单槽端口:
 * `createOnethingServerRuntime` 装配时把**同一个闭包**注入进来,
 * `rpc/domains/search.ts` 在**不可信**那一支上(`isHostLocallyTrusted()` 为假;
 * B2 之前问的是 `transport === 'http'`)原样调用。
 * **实现一行没搬、语义一字未改** —— 换的只是入口(判例逐字同 C2 的
 * `server/plugin-catalog.ts`)。
 *
 * 未注入 = 这台进程没有 server 运行时(桌面、CLI、单元测试)。那一支上域走的是
 * 本机那条真路(进程单槽里的 `SearchService`),永远不会问到这里。
 *
 * late-bound(每次现读)+ 注册返回**还原**函数:桌面内嵌 HTTP 面与 `server:start`
 * 在同一个进程里先后起落时,后者的 shutdown 不会把前者的槽一起清掉。
 */
import type { RuntimeRequestContext } from '@onething/core'

export interface ServerSearchPort {
  query(request: unknown, context?: RuntimeRequestContext): Promise<unknown>
}

let port: ServerSearchPort | null = null

export function configureServerSearchPort(next: ServerSearchPort | null): () => void {
  const previous = port
  port = next
  return () => {
    if (port === next) port = previous
  }
}

export function getServerSearchPort(): ServerSearchPort | null {
  return port
}
