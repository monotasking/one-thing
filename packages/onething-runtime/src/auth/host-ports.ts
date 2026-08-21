import type { OnethingTokenCryptoAdapter } from './token-store.js'

/**
 * Host injection points for OAuth. The Electron host supplies net.fetch (with
 * app-fetch fallback) and safeStorage encryption-at-rest; headless hosts leave
 * both unset and get plain app fetch + plaintext token files (the runtime
 * token store's documented fallback).
 *
 * Late-bound: both are consulted per call, so wiring at host startup takes
 * effect even though the auth singletons are constructed at module import.
 */
export interface AuthHostPorts {
  authFetch?: typeof fetch
  tokenCryptoAdapter?: () => OnethingTokenCryptoAdapter | undefined
}

let hostPorts: AuthHostPorts = {}

export function configureAuthHost(ports: AuthHostPorts): void {
  hostPorts = ports
}

export function getAuthHostPorts(): AuthHostPorts {
  return hostPorts
}
