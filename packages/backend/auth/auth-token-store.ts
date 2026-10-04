/**
 * `<store>/oauth-tokens.json` —— 旧的「一家一把」单槽,**只剩读**(批 8,
 * `docs/design/subscription-accounts-2026-09.md` §8)。
 *
 * 从前默认空间的订阅令牌住在这里:一家只有一个位置,第二次登录盖掉第一次(用户 09-26 报障
 * 「添加账号会覆盖上一个账号」的病根之一)。令牌如今一律住在空间凭证池里
 * (`space-token-store.ts`);这个类只留给一次性归位读旧文件
 * (`backend/credentials/credentials-default-space-migration.ts`)。**写路已删** —— 它回来就是
 * 单槽复活,`scripts/headless-boundary-check.ts` 的 `checkRuntimeOwnsAuthTokenStorage` 钉着。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getOnethingStorePath } from '../storage/storage.js'
import type { OnethingOAuthToken } from './auth-types.js'

export interface OnethingTokenCryptoAdapter {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer | Uint8Array | string
  decryptString(buffer: Buffer): string
}

export interface OnethingTokenStoreOptions {
  tokenFilePath?: string
  cryptoAdapter?: OnethingTokenCryptoAdapter | (() => OnethingTokenCryptoAdapter | undefined)
  now?: () => number
  logger?: Pick<Console, 'warn'>
}

// Store-path scoped (ONETHING_STORE_PATH aware): an isolated headless store
// must never read or clobber the user's real oauth-tokens.json. Desktop is
// unchanged — env unset resolves to ~/.onething. An explicit homeDir keeps the
// legacy resolution for callers that pin a home directory.
export function getDefaultOnethingTokenFilePath(homeDir?: string): string {
  if (homeDir !== undefined) return path.join(homeDir, '.onething', 'oauth-tokens.json')
  return path.join(getOnethingStorePath(), 'oauth-tokens.json')
}

export class OnethingTokenStore<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  private readonly tokenFilePath: string
  private readonly cryptoAdapter?: OnethingTokenCryptoAdapter | (() => OnethingTokenCryptoAdapter | undefined)
  private readonly now: () => number
  private readonly logger: Pick<Console, 'warn'>

  constructor(options: OnethingTokenStoreOptions = {}) {
    this.tokenFilePath = options.tokenFilePath ?? getDefaultOnethingTokenFilePath()
    this.cryptoAdapter = options.cryptoAdapter
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger ?? console
  }

  async getToken(providerId: string): Promise<TToken | null> {
    const tokens = await this.readAll()
    const serialized = tokens[providerId]
    if (typeof serialized !== 'string' || !serialized) return null
    return this.deserializeToken(providerId, serialized)
  }

  /** 文件里有令牌的那几家(不解密)。 */
  async listProviderIds(): Promise<string[]> {
    return Object.entries(await this.readAll())
      .filter(([, value]) => typeof value === 'string' && value.length > 0)
      .map(([providerId]) => providerId)
  }

  /**
   * 这一家的令牌读得出来吗 —— 明文 JSON 永远读得出;密文要此刻有加密器。
   * 归位据它判「这台宿主能不能完成这次搬运」,不去真解一遍。
   */
  async isReadable(providerId: string): Promise<boolean> {
    const serialized = (await this.readAll())[providerId]
    if (typeof serialized !== 'string' || !serialized) return false
    if (serialized.trim().startsWith('{')) return true
    return Boolean(this.getCryptoAdapter()?.isEncryptionAvailable())
  }

  isTokenExpired(token: TToken): boolean {
    return this.now() >= token.expiresAt
  }

  private async readAll(): Promise<Record<string, string>> {
    if (!existsSync(this.tokenFilePath)) return {}
    try {
      const content = await readFile(this.tokenFilePath, 'utf-8')
      const parsed = JSON.parse(content)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      this.logger.warn('[Auth] Failed to read OAuth token file; treating it as empty:', error)
      return {}
    }
  }

  private deserializeToken(providerId: string, serialized: string): TToken | null {
    try {
      if (serialized.trim().startsWith('{')) {
        return this.parseToken(serialized)
      }

      const cryptoAdapter = this.getCryptoAdapter()
      if (cryptoAdapter?.isEncryptionAvailable()) {
        const decrypted = cryptoAdapter.decryptString(Buffer.from(serialized, 'base64'))
        return this.parseToken(decrypted)
      }

      return this.parseToken(serialized)
    } catch (error) {
      this.logger.warn(`[Auth] Failed to decrypt OAuth token for ${providerId}:`, error)
      return null
    }
  }

  private parseToken(text: string): TToken | null {
    const parsed = JSON.parse(text) as Partial<TToken> | null
    if (!parsed?.accessToken || typeof parsed.expiresAt !== 'number') return null
    return {
      ...parsed,
      tokenType: parsed.tokenType || 'Bearer',
    } as TToken
  }

  private getCryptoAdapter(): OnethingTokenCryptoAdapter | undefined {
    return typeof this.cryptoAdapter === 'function'
      ? this.cryptoAdapter()
      : this.cryptoAdapter
  }
}
