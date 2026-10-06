import { spacesRouter } from '@shared/ipc/spaces'
import type {
  CredentialsKeyringTier,
  CredentialsLockReason,
  CredentialsStatusPayload,
  SpacesCredentialsStatusResponse,
  SpacesExportCredentialsResponse,
  SpacesImportExportedCredentialsResponse,
  SpacesUnlockCredentialsResponse,
} from '@shared/ipc/spaces'

/**
 * 凭证的钥匙与锁定状态、口令导出 / 导入(第④步批 0)与 core 客户端之间的那一层**端口** ——
 * 与 `data/spaces-port.ts` / `data/agent-notices-source.ts` 同一形状、同一理由:横幅与设置页的判据
 * 是纯逻辑,不该为了测它去起一台 core。真实现是下面那一个,测试用 `configureCredentialsPort` 换掉
 * (默认假端口装在 `src/test/setup.ts`)。
 *
 * 形状 = `spaces` 契约里那四条(`credentialsStatus` / `unlockCredentials` / `exportCredentials` /
 * `importExportedCredentials`)+ 全局事件 `credentials:locked` 的推送面。**一条都不带凭证原文**:
 * 状态只有档位与原因码,导出交回来的是用口令封好的密文文件。
 */
export interface CredentialsPort {
  ready(): Promise<unknown>
  status(): Promise<SpacesCredentialsStatusResponse>
  unlock(): Promise<SpacesUnlockCredentialsResponse>
  exportCredentials(passphrase: string): Promise<SpacesExportCredentialsResponse>
  importCredentials(passphrase: string, data: string): Promise<SpacesImportExportedCredentialsResponse>
  /** `credentials:locked` 的推送面(认过形之后的状态)。返回退订函数。 */
  onLockPush(callback: (status: CredentialsStatusPayload) => void): () => void
}

const TIERS: ReadonlySet<CredentialsKeyringTier> = new Set(['keychain', 'file', 'none'])
const STATES: ReadonlySet<CredentialsStatusPayload['state']> = new Set(['ready', 'loading', 'locked'])
const REASONS: ReadonlySet<CredentialsLockReason> = new Set([
  'keychain-timeout',
  'keychain-denied',
  'key-missing',
  'keychain-failed',
  'legacy-safestorage',
  'loading',
])

/** 一份状态认不认(RPC 应答与推送帧共用)。形不对就丢 —— 推送面是不可信输入。 */
export function credentialsStatusOf(data: unknown): CredentialsStatusPayload | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const tier = record.tier as CredentialsKeyringTier
  const state = record.state as CredentialsStatusPayload['state']
  if (!TIERS.has(tier) || !STATES.has(state)) return null
  const reason = REASONS.has(record.reason as CredentialsLockReason) ? (record.reason as CredentialsLockReason) : undefined
  return {
    tier,
    state,
    ...(reason ? { reason } : {}),
    encryption: tier === 'none' ? 'none' : 'master-key',
  }
}

/** 一帧推送认不认:名字对、载荷形对。 */
export function credentialsLockPushOfFrame(name: string, data: unknown): CredentialsStatusPayload | null {
  return name === 'credentials:locked' ? credentialsStatusOf(data) : null
}

let port: CredentialsPort | undefined

/** 测试用:换掉端口实现。传 undefined 恢复真实现。 */
export function configureCredentialsPort(next: CredentialsPort | undefined): void {
  port = next
}

async function realPort(): Promise<CredentialsPort> {
  const { onethingClient, whenConnected } = await import('../platform/connection')
  const client = await onethingClient()
  const spacesApi = client.api(spacesRouter)
  return {
    ready: () => whenConnected(),
    status: () => spacesApi.credentialsStatus({}),
    unlock: () => spacesApi.unlockCredentials({}),
    exportCredentials: (passphrase) => spacesApi.exportCredentials({ passphrase }),
    importCredentials: (passphrase, data) => spacesApi.importExportedCredentials({ passphrase, data }),
    onLockPush: (callback) =>
      client.events.onAny((frame) => {
        const status = credentialsLockPushOfFrame(frame.name, frame.data)
        if (status) callback(status)
      }),
  }
}

let pending: Promise<CredentialsPort> | undefined

export function credentialsPort(): Promise<CredentialsPort> {
  if (port) return Promise.resolve(port)
  pending ??= realPort()
  return pending
}
