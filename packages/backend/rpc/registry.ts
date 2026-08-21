/**
 * The RPC dispatch registry — the assembly-layer half of the generic RPC
 * channel (主线 T0, docs/design/dsh-architecture-adoption-2026-08.md §3).
 *
 * A domain registers its handlers here once, during `createOnethingBackend`;
 * every host then reaches them through its ONE generic adapter (Electron's
 * `rpc:invoke` handler, the server's `POST /api/rpc`). The shells never learn
 * a domain's name.
 *
 * Import purity: this module registers nothing on load (see
 * `packages/backend/__tests__/import-side-effect-free.test.ts`). The map starts empty
 * and is only filled by explicit `registerRouterHandlers` calls from the
 * assembly sequence.
 */
import type { DomainRoutes, RouteHandlers, Router } from '@onething/core/ipc'
import {
  DESKTOP_RPC_CONTEXT,
  RPC_ERROR_CODES,
  type RpcDispatchContext,
  type RpcRequest,
  type RpcResponse,
} from '@shared/ipc/rpc.js'

/**
 * Handlers of a domain that rides this channel. Pins `RouteHandlers`' generic
 * context parameter to `RpcDispatchContext` — a handler may declare the second
 * parameter and read it, or ignore it entirely.
 */
export type RpcRouteHandlers<T extends DomainRoutes> = RouteHandlers<T, RpcDispatchContext>

interface RegisteredDomain {
  /** Method allowlist, straight off the router — an unlisted method never runs. */
  methods: ReadonlySet<string>
  handlers: Record<string, (input: unknown, context: RpcDispatchContext) => Promise<unknown>>
}

const domains = new Map<string, RegisteredDomain>()

function fail(message: string, code?: string): RpcResponse {
  return { ok: false, error: code ? { message, code } : { message } }
}

/**
 * Bind a router's handlers into the dispatch table.
 *
 * Returns an unregister function — the assembly layer's usual reversible
 * registration shape, so a backend shutdown leaves no stale handlers behind
 * (a second `createOnethingBackend` in the same process would otherwise hit
 * the duplicate guard).
 *
 * Registering a domain twice throws rather than last-writer-wins: two live
 * implementations of one domain is always a wiring bug, and silently keeping
 * one of them is exactly the class of failure this registry exists to avoid.
 */
export function registerRouterHandlers<T extends DomainRoutes>(
  router: Router<T>,
  handlers: RpcRouteHandlers<T>,
): () => void {
  if (domains.has(router.domain)) {
    throw new Error(
      `[rpc] Domain "${router.domain}" is already registered. `
      + 'Unregister the previous handlers before registering again.',
    )
  }
  const bound: RegisteredDomain['handlers'] = {}
  for (const method of router.methods) {
    bound[method] = handlers[method] as RegisteredDomain['handlers'][string]
  }
  const entry: RegisteredDomain = {
    methods: new Set<string>(router.methods),
    handlers: bound,
  }
  domains.set(router.domain, entry)
  return () => {
    // Only drop our own entry: a later re-registration owns the slot now.
    if (domains.get(router.domain) === entry) domains.delete(router.domain)
  }
}

/** Whether a domain currently has handlers bound (host diagnostics/tests). */
export function hasRpcDomain(domain: string): boolean {
  return domains.has(domain)
}

/**
 * Run one RPC envelope. Never throws — every outcome is a `RpcResponse`, so
 * IPC and HTTP serialize failures identically.
 *
 * Handler failures return the error's `message` only. No stack, no `cause`:
 * this string crosses to a renderer (and, on the server, to the network).
 *
 * `context` is the **host adapter's** word on who is asking (主线 T 批 3) and
 * is never read off the wire — see `RpcDispatchContext`. It defaults to the
 * desktop/in-process context because that is what an in-process caller (tests,
 * a future host that runs the backend directly) truthfully is; the one host
 * where the default would be a lie — `apps/server`, whose callers are on a
 * network — passes its own, and the app-layer sandbox guard refuses an
 * `'http'` context that arrives without a sandbox root rather than silently
 * running unconfined.
 */
export async function dispatchRpc(
  request: RpcRequest,
  context: RpcDispatchContext = DESKTOP_RPC_CONTEXT,
): Promise<RpcResponse> {
  const domain = typeof request?.domain === 'string' ? request.domain : ''
  const method = typeof request?.method === 'string' ? request.method : ''
  if (!domain || !method) {
    return fail('RPC request must carry a domain and a method', RPC_ERROR_CODES.BAD_REQUEST)
  }

  const entry = domains.get(domain)
  if (!entry) {
    return fail(`Unknown RPC domain "${domain}"`, RPC_ERROR_CODES.UNKNOWN_DOMAIN)
  }
  if (!entry.methods.has(method)) {
    return fail(
      `Unknown RPC method "${domain}.${method}"`,
      RPC_ERROR_CODES.UNKNOWN_METHOD,
    )
  }

  try {
    const data = await entry.handlers[method](request.payload, context)
    return { ok: true, data: data === undefined ? null : data }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Drop every registration. Tests only — production unregisters per domain. */
export function resetRpcRegistryForTests(): void {
  domains.clear()
}
