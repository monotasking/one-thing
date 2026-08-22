import type { RpcRequest, RpcResponse } from '@shared/ipc/rpc.js'

/**
 * 通用 RPC 信封的 mobile 客户端 —— 结构债 P4 终态批 E1-a(拍板 #32)。
 *
 * 在这之前 `apps/mobile` 是全仓最后一个直打 server REST 的客户端:五条数据面
 * 各自认一条路径(`GET /api/sessions`、`POST /api/sessions`、
 * `POST /api/session-messages/page`、`POST /api/streams/abort`、
 * `POST /api/sessions/:id/commands`),其中最后一条在命令入口 router 化那天被删,
 * mobile 的发消息从此 404 —— 一个客户端认路径而不认信封,就会这样静默掉队。
 *
 * 现在它和 web / 桌面走同一条:**一个 URL(`POST /api/rpc`)、一个信封
 * (`{domain, method, payload}`)、一个失败形状(`{ok:false, error}`)**。加一个域
 * 不再需要动这个文件,server 那边也不再需要为 mobile 留薄适配路由。
 *
 * ## 为什么只 `import type`,不 import 值
 *
 * `RpcRequest` / `RpcResponse` 是纯类型声明,Babel 在 Metro 看到之前就把
 * `import type` 整行擦掉(metro.config.js 里那条注释说的就是这件事)。
 * `@shared/ipc/rpc.ts` 本身是零 import 的叶子文件,所以 tsc 这一侧也是气密的 ——
 * 既拿到了和服务端逐字同一份形状,又没有把任何运行时依赖拖进 RN 包。
 * 反过来,**值**(比如 `RPC_ERROR_CODES`)一律不 import:那会经由 barrel 把
 * `@onething/core/interaction`(`node:crypto`)拖进来。
 */

/** onething-server 在哪、怎么向它证明身份。 */
export interface ServerTarget {
  host: string
  port: number
  token: string
}

/** HTTP 层面的失败(非 2xx)—— 连信封都没拿到。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 信封层面的失败(HTTP 200 + `{ok:false, error}`)。
 *
 * 通用信封刻意用结果联合而不是 HTTP 状态码表达失败(见 `@shared/ipc/rpc.ts` 的
 * 抬头):调用点因此只需要 catch 一种东西,而 `code` 只在**请求没走到处理者**时
 * 才有值(`UNKNOWN_DOMAIN` / `UNKNOWN_METHOD` / `BAD_REQUEST`)。
 */
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export function baseUrlOf(target: ServerTarget): string {
  return `http://${target.host}:${target.port}`
}

/**
 * 裸 HTTP —— 只剩两个用户:`GET /api/capabilities`(配对时的连通性 / 鉴权探针,
 * 它不是一个 RPC 域)和本文件的 `rpc()` 自己。SSE 走 `sse.ts`。
 */
export async function httpRequest<T>(
  target: ServerTarget,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(baseUrlOf(target) + path, {
    ...init,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(init?.body ? { 'content-type': 'application/json' } : undefined),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ApiError(response.status, text || response.statusText)
  }
  return (await response.json()) as T
}

/**
 * 打一次 `POST /api/rpc`。
 *
 * `T` 是那条路由的 output 类型 —— 由调用点(`api.ts`)按 router 声明填,和服务端
 * 的 `RouteHandlers` 用的是**同一批 `@shared` 类型**,所以形状对不上是编译期的事。
 */
export async function rpc<T>(
  target: ServerTarget,
  domain: string,
  method: string,
  payload: unknown,
): Promise<T> {
  const envelope: RpcRequest = { domain, method, payload }
  const response = await httpRequest<RpcResponse>(target, '/api/rpc', {
    method: 'POST',
    body: JSON.stringify(envelope),
  })
  if (!response.ok) throw new RpcError(response.error.message, response.error.code)
  return response.data as T
}
