/**
 * 通用 RPC 客户端 —— **本体已搬进 `@onething/client`**(C2,
 * `docs/design/client-sdk-2026-09.md` §5.2)。
 *
 * 这里只剩一行再导出,活着是为了**不动 renderer 里几十处既有 import 路径**
 * (Vue 渲染层已退役,不做新功能;本批的目的只有一条:不留两份实现)。
 * 随 Vue 宿主退役一起删。
 *
 * 新代码不要用它:域客户端的正路是 `platform/client.ts` 的
 * `clientApi(xxxRouter)` —— 它拿的是同一份 `createRouterClient`,外加"按 router
 * 记忆"与"按访问解析宿主"两件事。
 */
export { RpcError, createRouterClient } from '@onething/client'
export type { RpcInvoke } from '@onething/client'
