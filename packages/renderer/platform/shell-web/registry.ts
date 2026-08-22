/**
 * web 壳的派发表 —— 结构债 P4 终态批 A1-a(2026-08-23)。
 *
 * 桌面那侧的壳路由派发表在 `apps/electron/src/ipc/shell-registry.ts`(处理者碰
 * `BrowserWindow` / `dialog` / `Notification`);浏览器里没有主进程,所以 web 的
 * 「宿主」就是渲染层自己 —— 这张表就住在这里,`platformApi.shellInvoke` 直接打它。
 *
 * 为什么要一张表而不是 `web.ts` 里的一坨 if:窗口系在 web 上并不是一律"做不到"。
 * 开设置窗 = 页内换 hash、开图片预览 = 页内广播、执行搜索动作 = 一次 REST 往返,
 * 只有一部分是诚实的降级。有了表,web 也是「契约 + 处理者表」,和桌面同结构,
 * 调用点 F12 进契约之后两边各有一处可去。
 *
 * 没注册的域 / 方法回一个**结构化**的 `no-host-shell`,而不是抛 —— 与桌面侧
 * `dispatchShell` 的 never-reject 语义一致。
 */
import type { DomainRoutes, RouteHandlers, Router } from '@onething/core/ipc'
import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'

/** 这个宿主壳上没有这个域 / 方法。 */
export const WEB_SHELL_MISSING_CODE = 'no-host-shell'

export type WebShellRouteHandlers<T extends DomainRoutes> = RouteHandlers<T, undefined>

interface RegisteredWebShellDomain {
  methods: ReadonlySet<string>
  handlers: Record<string, (input: unknown) => Promise<unknown>>
}

const domains = new Map<string, RegisteredWebShellDomain>()

function missing(name: string): RpcResponse {
  return {
    ok: false,
    error: {
      code: WEB_SHELL_MISSING_CODE,
      message: `${name} is available on the desktop host only`,
    },
  }
}

export function registerWebShellDomain<T extends DomainRoutes>(
  router: Router<T>,
  handlers: WebShellRouteHandlers<T>,
): () => void {
  if (domains.has(router.domain)) {
    throw new Error(
      `[shell-web] Domain "${router.domain}" is already registered. `
      + 'Unregister the previous handlers before registering again.',
    )
  }
  const bound: RegisteredWebShellDomain['handlers'] = {}
  for (const method of router.methods) {
    bound[method] = handlers[method] as RegisteredWebShellDomain['handlers'][string]
  }
  const entry: RegisteredWebShellDomain = {
    methods: new Set<string>(router.methods),
    handlers: bound,
  }
  domains.set(router.domain, entry)
  return () => {
    if (domains.get(router.domain) === entry) domains.delete(router.domain)
  }
}

export function hasWebShellDomain(domain: string): boolean {
  return domains.has(domain)
}

/** 跑一次壳信封。**从不抛** —— 任何结局都是一个 `RpcResponse`。 */
export async function dispatchWebShell(request: RpcRequest): Promise<RpcResponse> {
  const domain = typeof request?.domain === 'string' ? request.domain : ''
  const method = typeof request?.method === 'string' ? request.method : ''
  if (!domain || !method) return missing('This shell request')

  const entry = domains.get(domain)
  if (!entry) return missing(`"${domain}"`)
  if (!entry.methods.has(method)) return missing(`"${domain}.${method}"`)

  try {
    const data = await entry.handlers[method](request.payload)
    return { ok: true, data: data === undefined ? null : data }
  } catch (error) {
    return {
      ok: false,
      error: { message: error instanceof Error ? error.message : String(error) },
    }
  }
}

/** 清空整张表。仅测试用。 */
export function resetWebShellRegistryForTests(): void {
  domains.clear()
}
