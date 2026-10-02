/**
 * 凭证池的内存替身(批 8:令牌只有池这一个家)。形状与 `createOnethingSpaceTokenStore`
 * 逐格对齐:`entryId` 缺席的登录按身份去重、否则追加;不指名的读落到
 * `pickDefaultOAuthEntryId` 那一条 —— 两份判据共用同一个函数,替身不另写一份。
 */
import {
  oauthTokenIdentity,
  pickDefaultOAuthEntryId,
  type OnethingOAuthPoolEntry,
  type OnethingSpaceAuthTokenStore,
} from '../space-token-store.js'
import type { OnethingSpaceCredentialTarget } from '../credential-target.js'
import type { OnethingOAuthToken } from '../types.js'

interface MemoryEntry {
  id: string
  label: string
  token: OnethingOAuthToken
  cooldownUntil?: number
}

export class MemoryPoolTokenStore implements OnethingSpaceAuthTokenStore {
  readonly pools = new Map<string, MemoryEntry[]>()
  private seq = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(spaceId: string, providerId: string): string {
    return `${spaceId}|${providerId}`
  }

  entries(providerId: string, spaceId = 'default'): MemoryEntry[] {
    return this.pools.get(this.key(spaceId, providerId)) ?? []
  }

  /** 这一家在这个空间池里第一条的令牌(单账号测试的读法)。 */
  tokenOf(providerId: string, spaceId = 'default'): OnethingOAuthToken | undefined {
    return this.entries(providerId, spaceId)[0]?.token
  }

  /** 直接种一条(不走登录流)。 */
  seed(providerId: string, token: OnethingOAuthToken, spaceId = 'default', extra: Partial<MemoryEntry> = {}): string {
    const key = this.key(spaceId, providerId)
    const list = this.pools.get(key) ?? []
    const id = extra.id ?? `entry-${++this.seq}`
    list.push({ id, label: extra.label ?? `${providerId} #${list.length + 1}`, token, ...extra })
    this.pools.set(key, list)
    return id
  }

  async getToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<OnethingOAuthToken | null> {
    if (!target.entryId) return null
    return this.entries(providerId, target.spaceId).find(entry => entry.id === target.entryId)?.token ?? null
  }

  async saveToken(
    providerId: string,
    token: OnethingOAuthToken,
    target: OnethingSpaceCredentialTarget,
  ): Promise<{ entryId: string }> {
    const key = this.key(target.spaceId, providerId)
    const list = this.pools.get(key) ?? []
    let existing = target.entryId ? list.find(entry => entry.id === target.entryId) : undefined
    if (!existing && !target.entryId) {
      const identity = oauthTokenIdentity(token)
      if (identity) existing = list.find(entry => oauthTokenIdentity(entry.token) === identity)
    }
    if (existing) {
      existing.token = token
      delete existing.cooldownUntil
      this.pools.set(key, list)
      return { entryId: existing.id }
    }
    const entryId = target.entryId ?? `entry-${++this.seq}`
    list.push({ id: entryId, label: target.label ?? `${providerId} #${list.length + 1}`, token })
    this.pools.set(key, list)
    return { entryId }
  }

  async deleteToken(providerId: string, target: OnethingSpaceCredentialTarget): Promise<void> {
    if (!target.entryId) return
    const key = this.key(target.spaceId, providerId)
    this.pools.set(key, this.entries(providerId, target.spaceId).filter(entry => entry.id !== target.entryId))
  }

  async resolveEntryId(providerId: string, target: OnethingSpaceCredentialTarget): Promise<string | undefined> {
    if (target.entryId) return target.entryId
    return pickDefaultOAuthEntryId(
      this.entries(providerId, target.spaceId).map(entry => ({
        entryId: entry.id,
        token: entry.token,
        ...(entry.cooldownUntil !== undefined ? { cooldownUntil: entry.cooldownUntil } : {}),
      })),
      this.now(),
    )
  }

  async listEntries(providerId: string, spaceId: string): Promise<OnethingOAuthPoolEntry[]> {
    return this.entries(providerId, spaceId).map(entry => ({
      entryId: entry.id,
      label: entry.label,
      token: entry.token,
      ...(entry.cooldownUntil !== undefined ? { cooldownUntil: entry.cooldownUntil } : {}),
    }))
  }
}
