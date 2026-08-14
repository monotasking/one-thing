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

/** Router instance - carries domain name, channel map, and type info */
export interface Router<T extends DomainRoutes> {
  readonly domain: string
  readonly channels: { readonly [K in keyof T]: string }
  readonly methods: readonly (keyof T & string)[]
}

/** Handler implementations for a router */
export type RouteHandlers<T extends DomainRoutes> = {
  [K in keyof T]: (input: T[K]['input']) => Promise<T[K]['output']>
}

/** Client API type for a router */
export type RouteAPI<T extends DomainRoutes> = {
  [K in keyof T]: (input: T[K]['input']) => Promise<T[K]['output']>
}

function toKebab(str: string): string {
  return str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

export function getChannelName(domain: string, method: string): string {
  return `${domain}:${toKebab(method)}`
}

export function defineRouter<T extends DomainRoutes>(
  domain: string,
  methods: (keyof T & string)[],
): Router<T> {
  const channels = {} as Record<keyof T & string, string>
  for (const method of methods) {
    channels[method] = getChannelName(domain, method)
  }
  return Object.freeze({
    domain,
    channels: Object.freeze(channels),
    methods: Object.freeze(methods),
  }) as Router<T>
}
