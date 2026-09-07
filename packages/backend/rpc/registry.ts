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
import type { DomainRoutes, RouteHandlers, RouteSessionAccess, Router } from '@onething/core/ipc'
import type { SessionAccessOperation } from '@shared/contracts/session-access.js'
import { sessionAccess } from '../session/access.js'
import { getCurrentBackendInstance } from '../current.js'
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

/**
 * 一次派发**这条连接自己带来的能力**(工单 4 C3)。
 *
 * 与 `RpcDispatchContext` 的分工是硬的:context 是**身份与作用域**,纯数据、可
 * 序列化、可 spread;这里放的是**函数端口**,它属于「谁在服务这次请求」而不是
 * 「谁在调用」。从前 workspace 监听端口是用一个 Symbol + `Object.defineProperty`
 * 挂在 context 上的 —— 非枚举,`{ ...context }` 一过就没了,而 context 在这条路上
 * 到处被 spread。分开之后没有那种隐形丢失,类型上也说得出口。
 *
 * 端口是**可选**的:没有这一格的宿主(桌面、CLI)一格都不注入,域自己按缺席降级。
 */
export interface RpcDispatchPorts {
  /** 只有 workspace 沙箱内的不可信调用者会走到它;桌面那条路是投影桩。 */
  workspaceWatch?: {
    startWorkspaceWatch?(scope: string, root: string): Promise<{ success: boolean; error?: string }>
    stopWorkspaceWatch?(scope: string, root: string): Promise<{ success: boolean; error?: string }>
  }
}

/** 域可以只声明前两个参数;要连接能力的那几条显式接第三个。 */
export type RpcRouteHandlersWithPorts<T extends DomainRoutes> = {
  [K in keyof T]: (
    input: T[K]['input'],
    context?: RpcDispatchContext,
    ports?: RpcDispatchPorts,
  ) => Promise<T[K]['output']>
}

interface RegisteredDomain {
  /** Method allowlist, straight off the router — an unlisted method never runs. */
  methods: ReadonlySet<string>
  /** 契约自述的会话授权;缺席的方法照旧由处理者自己判(工单 5 §6)。 */
  session: { readonly [method: string]: RouteSessionAccess<SessionAccessOperation> | undefined }
  handlers: Record<string, (input: unknown, context: RpcDispatchContext, ports?: RpcDispatchPorts) => Promise<unknown>>
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
  handlers: RpcRouteHandlersWithPorts<T>,
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
    session: (router.session ?? {}) as RegisteredDomain['session'],
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
  ports?: RpcDispatchPorts,
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

  /*
   * 契约自述的会话授权,**执法在这一处**(工单 5 §6,triage C1)。
   *
   * 它排在 `runTask` 之前:一次没通过授权的调用不该在关机账上留下一格在途任务。
   * 声明缺席的方法这里一个字都不做 —— 27 个域里还没迁的那些,派发行为逐字不变。
   */
  const declared = entry.session[method]
  if (declared) {
    try {
      const payload = (request.payload ?? {}) as Record<string, unknown>
      const sessionId = payload[declared.param]
      if (typeof sessionId === 'string' && sessionId) {
        if (declared.optional) sessionAccess.resolveOptional(context, sessionId, declared.op)
        else sessionAccess.resolve(context, sessionId, declared.op)
      } else if (!declared.optional) {
        // 声明了「这条命令作用在某条会话上」却没交出 id:与从前处理者手写那一句
        // `resolve(context, undefined, …)` 同一个结局(具名的 SESSION_NOT_FOUND)。
        sessionAccess.resolve(context, '', declared.op)
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }

  try {
    const backend = getCurrentBackendInstance()
    // 没有端口就**不递第三个参数**:域处理者的调用形状因此与从前逐字相同
    // (宿主没有这一格时,`toHaveBeenCalledWith(payload, context)` 仍然成立)。
    const invoke = () => ports === undefined
      ? entry.handlers[method](request.payload, context)
      : entry.handlers[method](request.payload, context, ports)
    const data = await (backend ? backend.runTask(`rpc:${domain}.${method}`, invoke) : invoke())
    return { ok: true, data: data === undefined ? null : data }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/** Drop every registration. Tests only — production unregisters per domain. */
export function resetRpcRegistryForTests(): void {
  domains.clear()
}
