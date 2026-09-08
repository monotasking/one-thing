/**
 * Route payloads must survive the process boundary (structured clone over
 * Electron IPC, JSON over HTTP).
 *
 * That contract is enforced by the transport, not by this type. `JsonValue`
 * was tried first and is why `defineRouter` had zero adoption among the
 * shared domain contracts: TypeScript gives an *interface* no implicit index
 * signature, so every one of the repo's ~40 domain request/response
 * interfaces failed `extends JsonObject` and no domain could be defined
 * without being rewritten into type aliases first.
 */
export type RoutePayload = unknown

/** Route configuration - input/output types for a single IPC method */
export interface RouteConfig<Input extends RoutePayload = RoutePayload, Output extends RoutePayload = RoutePayload> {
  input: Input
  output: Output
}

/** Domain routes - maps method names to their route configs */
export type DomainRoutes = Record<string, RouteConfig>

/**
 * 一个方法的**会话授权自述**(工单 5 §6,triage C1)。
 *
 * 从前每个域处理者自己在函数第一行手写一句「解析这条会话的写权限」—— 27 个域 153
 * 处,加一个域就要记得抄一次,而漏抄不会有任何东西红。改成契约里一格之后,执法只
 * 在 `dispatchRpc` 一处:**加一个域接授权 = 契约里一格 + 零改 registry**。
 *
 * `param` 是 payload 里承载会话 id 的字段名;`op` 是动词(词汇表由上层钉,core 不
 * 认识任何一个具体动词 —— 这正是它能住在零依赖包里的原因);`optional` 为真时走
 * 「会话不在盘上也放行」那一档(草稿纸那种未落地的会话)。
 */
export interface RouteSessionAccess<Op extends string = string> {
  param: string
  op: Op
  optional?: boolean
}

/** Router instance - carries domain name, channel map, and type info */
export interface Router<T extends DomainRoutes, Op extends string = string> {
  readonly domain: string
  readonly channels: { readonly [K in keyof T]: string }
  readonly methods: readonly (keyof T & string)[]
  /**
   * 声明了会话授权的方法;没声明的方法在这张表里缺席,派发行为一字不变。
   *
   * 整张表**可缺席** —— feature 在运行时手搓一个 router 字面量挂域是开着的扩展点
   * (`features/builtin/self-evolution.ts` 那条),它没有理由被迫写一格空对象。
   */
  readonly session?: { readonly [K in keyof T & string]?: RouteSessionAccess<Op> }
}

/**
 * Handler implementations for a router.
 *
 * The second parameter is the **dispatch context** — who is asking, minted by
 * the host adapter after that host authenticated the call (主线 T 批 3). It is
 * deliberately optional: a handler that does not declare it simply ignores it,
 * which is why the nine domains that landed before 批 3 did not need a single
 * edit, and an in-process caller (a test, another app-layer module) may call a
 * handler directly without inventing one. A handler that DOES read it takes the
 * `(input, context = DESKTOP_RPC_CONTEXT)` shape — the same default
 * `dispatchRpc` uses, and a truthful one, because the only caller that reaches
 * a handler without a context is in-process. The dangerous direction — a
 * networked host — always goes through `dispatchRpc`, which always passes one.
 *
 * `Ctx` stays generic here because `packages/core` may not import the shared
 * IPC package (boundary rule); the app layer pins it to `RpcDispatchContext`.
 */
export type RouteHandlers<T extends DomainRoutes, Ctx = unknown> = {
  [K in keyof T]: (input: T[K]['input'], context?: Ctx) => Promise<T[K]['output']>
}

/**
 * 一次调用的**传输级**选项(2026-09-07 加)。
 *
 * 「传输级」是判据:这里只放与**这一发怎么送出去**有关的东西,不放载荷 ——
 * 载荷永远在 `input` 里,由域契约说了算。今天只有一格。
 */
export interface RouteCallOptions {
  /**
   * 撤回这一发。传输把它交给底下那条请求(HTTP 是 `fetch` 的 `signal`),
   * 宿主再据此铸出 `RpcDispatchContext.signal`,于是「调用方不要了」这件事
   * 一路传得到处理者手里。缺席 = 这一发送出去就等到底(与从前逐字相同)。
   */
  signal?: AbortSignal
}

/** Client API type for a router */
export type RouteAPI<T extends DomainRoutes> = {
  [K in keyof T]: (input: T[K]['input'], options?: RouteCallOptions) => Promise<T[K]['output']>
}

function toKebab(str: string): string {
  return str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

export function getChannelName(domain: string, method: string): string {
  return `${domain}:${toKebab(method)}`
}

export function defineRouter<T extends DomainRoutes, Op extends string = string>(
  domain: string,
  methods: (keyof T & string)[],
  session: { [K in keyof T & string]?: RouteSessionAccess<Op> } = {},
): Router<T, Op> {
  const channels = {} as Record<keyof T & string, string>
  for (const method of methods) {
    channels[method] = getChannelName(domain, method)
  }
  for (const method of Object.keys(session)) {
    if (!methods.includes(method as keyof T & string)) {
      throw new Error(`[router] "${domain}" declares session access for unknown method "${method}"`)
    }
  }
  return Object.freeze({
    domain,
    channels: Object.freeze(channels),
    methods: Object.freeze(methods),
    session: Object.freeze({ ...session }),
  }) as Router<T, Op>
}
