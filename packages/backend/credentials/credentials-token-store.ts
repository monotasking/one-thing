/**
 * OAuth token 的**唯一**存放面 —— 把 `OnethingAuthService` 的「存到哪儿」这一格接到
 * `workspaces/<id>/credentials.json` 的凭证池上(批 B6 立,批 8 起默认空间也走这里)。
 *
 * ## 为什么不是第二个 token 文件
 *
 * B3 第一天就把 `entry.authType:'oauth'` + `entry.oauthToken` 写进了 schema。
 * 再开一个 `workspaces/<id>/oauth-tokens.json` 会让同一个空间的凭证分居两处:
 * 轮换要读两个文件、导出要剔两个文件、删空间要清两个文件。池就是池。
 *
 * 批 8(`docs/design/subscription-accounts-2026-09.md` §8)之前默认空间例外:它的令牌住在
 * `<store>/oauth-tokens.json` 那一把单槽里,一家只能有一个账号。那一格退役了 —— 默认空间
 * 与别的空间一样,一家一条 oauth entry 一个账号,各自内联自己的令牌。
 *
 * ## 落盘加密(批 B8-1 起)
 *
 * **整份 `credentials.json` 都加密**(第④步批 0 起用后端自己的主密钥,见
 * `credentials/credentials-pool.ts` 的「落盘加密」段)。所以这一层只做一件事:写之前
 * `await prepareCredentialsWrite()`(新装时现造钥匙),读之前等钥匙读完 —— 它写进池里的 token
 * 会跟着整份文件一起落成密文。
 */

import {
  getSpaceCredentialEntry,
  getSpaceProviderCredentials,
  isSpaceCredentialEntryCooling,
  removeSpaceProviderCredentialEntry,
  upsertSpaceProviderOAuthToken,
  type SpaceCredentialEntry,
} from './credentials-pool.js'
import type { OnethingSpaceCredentialTarget, OnethingOAuthToken } from '@onething/backend/auth'
import { credentialsReady, prepareCredentialsWrite } from './credentials-locked-state.js'

/** 池里的一条 oauth entry,读成 auth 层要的样子(令牌坏了是 `null`,条目照样列出来)。 */
export interface OnethingOAuthPoolEntry<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  entryId: string
  label: string
  token: TToken | null
  cooldownUntil?: number
}

export interface OnethingSpaceAuthTokenStore<TToken extends OnethingOAuthToken = OnethingOAuthToken> {
  /** 读**那一条**。`entryId` 缺席答 `null` —— 该落到哪一条由 `resolveEntryId` 先答。 */
  getToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<TToken | null>
  /**
   * 写。`entryId` 在 = 原地换那一条的令牌;缺席 = 登录:同一身份已在池里就更新那一条,
   * 否则追加一条。返回真正写进去的 entryId —— 新登录时它是这一步才分配出来的。
   */
  saveToken(
    providerId: string,
    token: TToken,
    target: OnethingSpaceCredentialTarget,
  ): Promise<{ entryId: string }>
  deleteToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<void>
  /**
   * `entryId` 缺席的读 / 刷新 / 退出落到哪一条(兼容口:老调用方与 CLI 只说「这一家」)。
   * 答池序里第一条**不在冷却、令牌读得出**的;都在冷却就退一步答第一条令牌读得出的。
   */
  resolveEntryId(providerId: string, target: OnethingSpaceCredentialTarget): Promise<string | undefined>
  /** 这个空间这一家的全部 oauth entry(池序)。 */
  listEntries(providerId: string, spaceId: string): Promise<Array<OnethingOAuthPoolEntry<TToken>>>
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

/**
 * 一个令牌是**谁的**(批 8 §8.2):同一身份再登一次 = 更新那一条,不出第二行。
 *
 *  - Codex:`accountId`(`chatgpt_account_id`)。同一个团队工作区里的两个人共用这个 id,
 *    所以令牌上还带着 `providerMetadata.chatgptUserId` 时把它也并进来 —— 只会让判据更严,
 *    不会把两个人合成一行。
 *  - 其它家:`email`(大小写不敏感)。
 *  - 两样都取不到 = `undefined`:**不去重**,新登录一律追加(把两个陌生人当成一个人,
 *    比多出一行难收拾得多)。
 */
export function oauthTokenIdentity(token: OnethingOAuthToken | null | undefined): string | undefined {
  if (!token) return undefined
  const accountId = typeof token.accountId === 'string' ? token.accountId.trim() : ''
  if (accountId) {
    const userId = token.providerMetadata?.chatgptUserId
    return typeof userId === 'string' && userId.trim()
      ? `account:${accountId}:${userId.trim()}`
      : `account:${accountId}`
  }
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : ''
  return email ? `email:${email}` : undefined
}

function oauthEntriesOf(spaceId: string, providerId: string): SpaceCredentialEntry[] {
  return (getSpaceProviderCredentials(spaceId, providerId)?.entries ?? [])
    .filter(entry => entry.authType === 'oauth')
}

/** `resolveEntryId` 的纯判据(测试与内存替身共用):池序、先跳冷却、令牌要读得出。 */
export function pickDefaultOAuthEntryId(
  entries: ReadonlyArray<{ entryId: string; token: OnethingOAuthToken | null; cooldownUntil?: number }>,
  now = Date.now(),
): string | undefined {
  const readable = entries.filter(entry => entry.token)
  const warm = readable.find(entry => !(typeof entry.cooldownUntil === 'number' && entry.cooldownUntil > now))
  return (warm ?? readable[0] ?? entries[0])?.entryId
}

export function createOnethingSpaceTokenStore<
  TToken extends OnethingOAuthToken = OnethingOAuthToken,
>(options: { now?: () => number } = {}): OnethingSpaceAuthTokenStore<TToken> {
  const now = options.now ?? (() => Date.now())
  return {
    async getToken(providerId, target) {
      // 钥匙串那一档的钥匙可能还在读;读完再查,免得把「还在读」当成「没登录」。
      await credentialsReady()
      const entry = getSpaceCredentialEntry(target.spaceId, providerId, target.entryId)
      if (!entry || entry.authType !== 'oauth') return null
      return parseSpaceOAuthToken<TToken>(entry.oauthToken)
    },
    async saveToken(providerId, token, target) {
      // 登录写回是用户亲手发起的写:新装时现造钥匙,钥匙丢了时换钥匙(第④步批 0)。
      await prepareCredentialsWrite()
      let entryId = target.entryId
      if (!entryId) {
        // 同一身份再登一次 = 更新那一条(§8.2)。取不到身份的家一律追加。
        const identity = oauthTokenIdentity(token)
        if (identity) {
          entryId = oauthEntriesOf(target.spaceId, providerId)
            .find(entry => oauthTokenIdentity(parseSpaceOAuthToken(entry.oauthToken)) === identity)?.id
        }
      }
      const result = upsertSpaceProviderOAuthToken(target.spaceId, providerId, {
        entryId,
        label: target.label,
        token,
      })
      return { entryId: result.entryId }
    },
    async deleteToken(providerId, target) {
      // entryId 缺席 = 没有具体目标可删。静默返回而不是清整段:
      // 「登出某个账号」与「清空这个 provider」是两个动作(批 D 勘误 10 同一条理由)。
      // 服务在调到这里之前已经把「不指名」落成了具体的一条(`resolveEntryId`)。
      if (!target.entryId) return
      await prepareCredentialsWrite()
      removeSpaceProviderCredentialEntry(target.spaceId, providerId, target.entryId)
    },
    async resolveEntryId(providerId, target) {
      if (target.entryId) return target.entryId
      await credentialsReady()
      const entries = oauthEntriesOf(target.spaceId, providerId).map(entry => ({
        entryId: entry.id,
        token: parseSpaceOAuthToken(entry.oauthToken),
        ...(isSpaceCredentialEntryCooling(entry, now()) ? { cooldownUntil: entry.cooldownUntil } : {}),
      }))
      return pickDefaultOAuthEntryId(entries, now())
    },
    async listEntries(providerId, spaceId) {
      await credentialsReady()
      return oauthEntriesOf(spaceId, providerId).map(entry => ({
        entryId: entry.id,
        label: entry.label,
        token: parseSpaceOAuthToken<TToken>(entry.oauthToken),
        ...(typeof entry.cooldownUntil === 'number' ? { cooldownUntil: entry.cooldownUntil } : {}),
      }))
    },
  }
}
