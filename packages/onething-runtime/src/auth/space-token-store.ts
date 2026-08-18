/**
 * per-space 的 OAuth token 存放面(批 B6)—— 把 `OnethingAuthService` 的
 * 「存到哪儿」这一格接到 `workspaces/<id>/credentials.json` 的凭证池上。
 *
 * ## 为什么不是第二个 token 文件
 *
 * B3 第一天就把 `entry.authType:'oauth'` + `entry.oauthToken` 写进了 schema。
 * 再开一个 `workspaces/<id>/oauth-tokens.json` 会让同一个空间的凭证分居两处:
 * 轮换要读两个文件、导出要剔两个文件、删空间要清两个文件。池就是池。
 *
 * ## 落盘加密(批 B8-1 起)
 *
 * B6 当时的偏离是「这里的 token 是明文」—— 理由是 `credentials.json` 从 B3 起
 * 就明文存 apiKey,一半明文一半密文更说不通。批 B8-1 把口径统一到了另一头:
 * **整份 `credentials.json` 都加密**(与 `oauth-tokens.json` 同一个 safeStorage
 * 端口,见 `spaces/credentials.ts` 的「落盘加密」段)。所以这一层什么都不用做 ——
 * 它写进池里的 token 会跟着整份文件一起落成密文。
 */

import {
  getSpaceCredentialEntry,
  removeSpaceProviderCredentialEntry,
  upsertSpaceProviderOAuthToken,
} from '../spaces/credentials.js'
import type { OnethingSpaceCredentialTarget } from './credential-target.js'
import type { OnethingOAuthToken } from './types.js'

export interface OnethingSpaceAuthTokenStore<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  getToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<TToken | null>
  /** 返回真正写进去的 entryId —— 新登录时它是这一步才分配出来的。 */
  saveToken(
    providerId: string,
    token: TToken,
    target: OnethingSpaceCredentialTarget,
  ): Promise<{ entryId: string }>
  deleteToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<void>
}

/**
 * 池里的 token 是 `unknown`(那一层不解释凭证内容)。这里做**唯一**一次形状检查,
 * 口径与 `OnethingTokenStore.parseToken` 逐字一致:没有 accessToken 或
 * expiresAt 不是数字就当没登录 —— 半个 token 比没有 token 更难排查。
 */
export function parseSpaceOAuthToken<TToken extends OnethingOAuthToken = OnethingOAuthToken>(
  value: unknown,
): TToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<OnethingOAuthToken>
  if (typeof record.accessToken !== 'string' || !record.accessToken) return null
  if (typeof record.expiresAt !== 'number') return null
  return { ...record, tokenType: record.tokenType || 'Bearer' } as TToken
}

export function createOnethingSpaceTokenStore<
  TToken extends OnethingOAuthToken = OnethingOAuthToken,
>(): OnethingSpaceAuthTokenStore<TToken> {
  return {
    async getToken(providerId, target) {
      const entry = getSpaceCredentialEntry(target.spaceId, providerId, target.entryId)
      if (!entry || entry.authType !== 'oauth') return null
      return parseSpaceOAuthToken<TToken>(entry.oauthToken)
    },
    async saveToken(providerId, token, target) {
      const result = upsertSpaceProviderOAuthToken(target.spaceId, providerId, {
        entryId: target.entryId,
        label: target.label,
        token,
      })
      return { entryId: result.entryId }
    },
    async deleteToken(providerId, target) {
      // entryId 缺席 = 没有具体目标可删。静默返回而不是清整段:
      // 「登出某个账号」与「清空这个 provider」是两个动作(批 D 勘误 10 同一条理由)。
      if (!target.entryId) return
      removeSpaceProviderCredentialEntry(target.spaceId, providerId, target.entryId)
    },
  }
}
