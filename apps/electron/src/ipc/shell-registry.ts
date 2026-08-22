/**
 * 宿主壳路由的派发表 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 这是 `packages/backend/rpc/registry.ts` 的**宿主侧对称件**:同一个
 * `RpcRequest` / `RpcResponse` 信封、同一套 `defineRouter` 契约、同样的
 * never-reject 语义、同样的 `UNKNOWN_DOMAIN` / `UNKNOWN_METHOD` / `BAD_REQUEST`
 * 结构化错误码。差别只有一个:**这张表上的处理者住在宿主**。
 *
 * 为什么必须是两张表:`rpc:invoke` 的处理者住在装配层(`packages/backend`,
 * checker 禁 import electron),而开设置窗、关窗、原生对话框、系统通知、深链应答
 * 这些事只有 Electron 本体做得了。合成一张表 = 装配层的 dispatch 里出现 electron
 * 处理者,而那道边界正是 `packages/backend` 存在的理由。分成两张,调用点仍然是
 * 「F12 进契约 → F12 进处理者表」,和数据面同结构。
 *
 * **本文件不 import electron**,是刻意的:它是 portable 树(`apps/electron/src/ipc`)
 * 的一员,单测里不需要跑起一个 Electron 就能钉住派发语义。真正碰 electron 的胶水
 * 在 `apps/electron/src/main/ipc/shell-rpc.ts`(唯一的 `ipcMain.handle`)与各域自己的
 * 注册点。
 *
 * Import 纯度:本模块加载时**什么也不注册**,表从空的开始,只由显式的
 * `registerShellDomain` 调用填。
 */
import type { DomainRoutes, RouteHandlers, Router } from '@onething/core/ipc'
import {
  RPC_ERROR_CODES,
  type RpcRequest,
  type RpcResponse,
} from '@shared/ipc/rpc.js'

/**
 * 谁在问 —— `dispatchShell` 的第二个参数,**不是 `RpcRequest` 的字段**。
 *
 * 和 `RpcDispatchContext` 同一条规矩:身份由宿主在自己那道认证之后**盖章**,
 * 永远不从信封里读。信封是渲染层递上来的,context 不是。
 *
 * 今天只有一格:`callerId` = `event.sender.id`,也就是发起这次调用的那扇窗。
 * `window.close` 靠它认「关哪扇」,search 的两条靠它认「从哪扇窗按的」。
 * 将来要别的格再加,加法与 `RpcDispatchContext` 一致 —— 宿主铸,不读信封。
 */
export interface ShellDispatchContext {
  /** 发起这次调用的 webContents id。in-process 调用(测试)可以不给。 */
  callerId?: number
}

/** 一个壳域的处理者集合。把 `RouteHandlers` 的 context 泛型钉到 `ShellDispatchContext`。 */
export type ShellRouteHandlers<T extends DomainRoutes> = RouteHandlers<T, ShellDispatchContext>

interface RegisteredShellDomain {
  /** 方法白名单,直接来自 router —— 表上没有的方法永远不会跑。 */
  methods: ReadonlySet<string>
  handlers: Record<string, (input: unknown, context: ShellDispatchContext) => Promise<unknown>>
}

const domains = new Map<string, RegisteredShellDomain>()

function fail(message: string, code?: string): RpcResponse {
  return { ok: false, error: code ? { message, code } : { message } }
}

/**
 * 把一个 router 的处理者绑进派发表。
 *
 * 返回反注册函数(宿主的老规矩:可逆注册),重复注册同一个域**抛错**而不是
 * 后来者覆盖 —— 一个域有两份活实现永远是接线 bug,悄悄留下其中一份正是这张表
 * 要防的那类故障。
 */
export function registerShellDomain<T extends DomainRoutes>(
  router: Router<T>,
  handlers: ShellRouteHandlers<T>,
): () => void {
  if (domains.has(router.domain)) {
    throw new Error(
      `[shell] Domain "${router.domain}" is already registered. `
      + 'Unregister the previous handlers before registering again.',
    )
  }
  const bound: RegisteredShellDomain['handlers'] = {}
  for (const method of router.methods) {
    bound[method] = handlers[method] as RegisteredShellDomain['handlers'][string]
  }
  const entry: RegisteredShellDomain = {
    methods: new Set<string>(router.methods),
    handlers: bound,
  }
  domains.set(router.domain, entry)
  return () => {
    // 只摘自己那一条:后来的重注册已经拥有这个槽位了。
    if (domains.get(router.domain) === entry) domains.delete(router.domain)
  }
}

/** 某个壳域此刻有没有绑上处理者(宿主自检 / 测试用)。 */
export function hasShellDomain(domain: string): boolean {
  return domains.has(domain)
}

/**
 * 跑一次壳信封。**从不抛** —— 任何结局都是一个 `RpcResponse`,所以失败在两个
 * 宿主(Electron IPC / web 页内)上序列化成同一个形状,渲染层的
 * `createRouterClient` 是唯一把它变回 throw 的地方。
 *
 * 处理者失败只回 `message`:这串字要过线到渲染层,不带 stack、不带 cause。
 */
export async function dispatchShell(
  request: RpcRequest,
  context: ShellDispatchContext = {},
): Promise<RpcResponse> {
  const domain = typeof request?.domain === 'string' ? request.domain : ''
  const method = typeof request?.method === 'string' ? request.method : ''
  if (!domain || !method) {
    return fail('Shell request must carry a domain and a method', RPC_ERROR_CODES.BAD_REQUEST)
  }

  const entry = domains.get(domain)
  if (!entry) {
    return fail(`Unknown shell domain "${domain}"`, RPC_ERROR_CODES.UNKNOWN_DOMAIN)
  }
  if (!entry.methods.has(method)) {
    return fail(
      `Unknown shell method "${domain}.${method}"`,
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

/** 清空整张表。仅测试用 —— 生产按域反注册。 */
export function resetShellRegistryForTests(): void {
  domains.clear()
}
