import {
  getDefaultOnethingTokenFilePath,
  OnethingTokenStore,
} from './token-store.js'
import type { OAuthToken } from '@shared/ipc.js'
import { getAuthHostPorts } from './host-ports.js'

export class TokenStore extends OnethingTokenStore<OAuthToken> {
  // The default path is store-path scoped (ONETHING_STORE_PATH aware) inside
  // the runtime helper. Note the singleton below captures it at module load —
  // headless hosts set the env var at process start.
  constructor(tokenFilePath = getDefaultOnethingTokenFilePath()) {
    super({
      tokenFilePath,
      cryptoAdapter: () => getAuthHostPorts().tokenCryptoAdapter?.(),
    })
  }
}

export const tokenStore = new TokenStore()
