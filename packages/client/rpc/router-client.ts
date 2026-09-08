/**
 * The generic RPC client (主线 T0).
 *
 * Turns a router definition into a typed method object over ONE `invoke`
 * function. Each transport supplies its own `invoke` (`electronAPI.rpcInvoke`
 * on the Vue desktop, `POST /api/rpc` over HTTP everywhere else) and every
 * domain reuses it, so adding a domain never touches transport plumbing again.
 *
 * This file imports the router *definition* from `@shared/ipc` and the router
 * type kernel from `@onething/core/ipc` — nothing else. A client must never
 * reach into `@onething/backend`: the dependency points one way.
 *
 * `RpcResponse.ok === false` becomes a thrown `RpcError` here — the single
 * place where the result union turns back into the exception shape every
 * existing caller already handles.
 *
 * C0 搬家记录(`docs/design/client-sdk-2026-09.md` §3):产地是
 * `packages/renderer/platform/router-client.ts`。本批**不删原件** —— Vue renderer
 * 改成从这里再导出是 C2 的事,那之前两份并存,原件的注释里那句"渲染层"是它自己
 * 的语境,不是这份的。
 */
import type { DomainRoutes, RouteAPI, RouteCallOptions, Router } from '@onething/core/ipc'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'

export type RpcInvoke = (request: RpcRequest, options?: RouteCallOptions) => Promise<RpcResponse>

/** Error thrown for a failed RPC. `code` is set only when the request never reached a handler. */
export class RpcError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

export function createRouterClient<T extends DomainRoutes>(
  router: Router<T>,
  invoke: RpcInvoke,
): RouteAPI<T> {
  const api = {} as Record<string, (input: unknown, options?: RouteCallOptions) => Promise<unknown>>
  for (const method of router.methods) {
    // 第二格**只透传**:这一层不解释 `signal`,也不替调用方兜住 abort ——
    // 被撤回的 `fetch` 抛出来的仍然是 fetch 自己那条 `AbortError`(调用方本来就
    // 是那个 abort 的人,它认得出自己干了什么)。
    api[method] = async (payload: unknown, options?: RouteCallOptions) => {
      const response = await invoke({ domain: router.domain, method, payload }, options)
      if (!response || typeof response !== 'object' || !('ok' in response)) {
        throw new RpcError(
          `Malformed RPC response for ${router.domain}.${method}`,
        )
      }
      if (response.ok) return response.data
      throw new RpcError(
        response.error?.message ?? `RPC ${router.domain}.${method} failed`,
        response.error?.code,
      )
    }
  }
  return api as RouteAPI<T>
}
