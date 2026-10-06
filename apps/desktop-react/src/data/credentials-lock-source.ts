import { create } from 'zustand'
import type { CredentialsLockReason, CredentialsStatusPayload } from '@shared/ipc/spaces'
import { t } from '../i18n'
import type { MessageKey } from '../i18n'
import { notify, retractNotify } from '../services/notify'
import { credentialsPort } from './credentials-port'

/**
 * **凭证锁定状态**(第④步批 0,决策 D10:顶部横幅 + 重试,服务商列表上锁图标)。
 *
 * 后端自己持有加密凭证用的主密钥;钥匙串超时 / 拒绝、钥匙丢了、还有旧密文没迁完时,它答「已锁定」
 * 并发全局事件 `credentials:locked`。这一层把那一句话接到壳上,三个读者:
 *
 *  1. **横幅** —— 锁着时经 `notify` 弹一条不自动消失的通知(顶部那一排通知就是壳的横幅位置,
 *     状态色只上图标),第二行按原因码选一句话,带一道「重试」;解开就收掉;
 *  2. **服务商列表**的锁图标(`useCredentialsLocked()`);
 *  3. **设置 → 工作区**那一行档位说明(`useCredentialsTier()`)。
 *
 * 状态从两处来:连通之后问一次 `spaces.credentialsStatus`,以及 `credentials:locked` 的推送。
 * 锁定**不挡读会话**(所以不弹模态,D10 (c) 不选)。
 *
 * ── 寿命 ────────────────────────────────────────────────────────────────
 * 一条模块级订阅,`startCredentialsLock()` 起(幂等),HMR 退役复用 `stopCredentialsLock()`。
 */

interface CredentialsLockState {
  /** 后端最近一次说的状态;还没问到是 null(不画锁、不弹横幅)。 */
  status: CredentialsStatusPayload | null
  /** 「重试」正在路上。 */
  retrying: boolean
}

export const useCredentialsLock = create<CredentialsLockState>(() => ({ status: null, retrying: false }))

/** 此刻锁着吗(服务商列表的锁图标读它)。 */
export function useCredentialsLocked(): boolean {
  return useCredentialsLock((state) => state.status?.state === 'locked')
}

/**
 * 钥匙还在读(第④步批 1 补的文案:**只在设置页那一行**说「正在读取钥匙串。」,不弹横幅 —— 它是一个
 * 正常的过渡态,通常几百毫秒就过去了,弹一条错误横幅会把「慢」说成「坏」)。
 */
export function useCredentialsLoading(): boolean {
  return useCredentialsLock((state) => state.status?.state === 'loading' || state.status?.reason === 'loading')
}

/** 后端答的档位(设置页那一行说明读它);还没问到是 null。 */
export function useCredentialsTier(): CredentialsStatusPayload['tier'] | null {
  return useCredentialsLock((state) => state.status?.tier ?? null)
}

/** 横幅第二行:按原因码选一句话。没有对应句子的原因码不画第二行(不猜)。 */
const REASON_LINES: Partial<Record<CredentialsLockReason, MessageKey>> = {
  'keychain-timeout': 'credentials.reasonTimeout',
  'keychain-denied': 'credentials.reasonDenied',
  'key-missing': 'credentials.reasonKeyMissing',
  // 第④步批 1 补齐(D269 留的口,句子由编排者定)。`loading` 不在这里:它不弹横幅,见 `useCredentialsLoading`。
  'keychain-failed': 'credentials.reasonKeychainFailed',
  'legacy-safestorage': 'credentials.reasonLegacySafeStorage',
}

export function credentialsLockReasonLine(reason: CredentialsLockReason | undefined): string | undefined {
  const key = reason ? REASON_LINES[reason] : undefined
  return key ? t(key) : undefined
}

/** 屏上那条横幅在存档里的 id(收掉它用)。 */
const banner: { recordId: string | null; reason: CredentialsLockReason | undefined } = { recordId: null, reason: undefined }

function showBanner(status: CredentialsStatusPayload): void {
  // 同一个原因的横幅已经在屏上:不再弹第二条。
  if (banner.recordId && banner.reason === status.reason) return
  if (banner.recordId) retractNotify(banner.recordId)
  banner.reason = status.reason
  banner.recordId = notify(
    {
      level: 'error',
      title: t('credentials.lockedBanner'),
      ...(credentialsLockReasonLine(status.reason) ? { body: credentialsLockReasonLine(status.reason) } : {}),
      source: 'credentials',
    },
    { action: { label: t('credentials.retry'), onClick: () => void retryCredentialsUnlock() } },
  )
}

function hideBanner(): void {
  if (banner.recordId) retractNotify(banner.recordId)
  banner.recordId = null
  banner.reason = undefined
}

/** 收下一份状态:落表,锁着就亮横幅、解开就收。导出给测试。 */
export function receiveCredentialsStatus(status: CredentialsStatusPayload): void {
  useCredentialsLock.setState({ status })
  // 「还在读」不是锁定:不弹横幅,只在设置页那一行说(见 `useCredentialsLoading`)。
  if (status.state === 'locked' && status.reason !== 'loading') showBanner(status)
  else hideBanner()
}

/** 「重试」:让后端重读主密钥。结果照常经 `receiveCredentialsStatus` 落表(推送也会再来一遍)。 */
export async function retryCredentialsUnlock(): Promise<void> {
  if (useCredentialsLock.getState().retrying) return
  useCredentialsLock.setState({ retrying: true })
  try {
    const p = await credentialsPort()
    const response = await p.unlock()
    if (response.success && response.status) receiveCredentialsStatus(response.status)
  } catch {
    // 连不上就是没重试成;横幅还在,人可以再点一次。
  } finally {
    useCredentialsLock.setState({ retrying: false })
  }
}

let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

/** 连通之后起:问一次状态 + 订推送。幂等;连不上就不起(下一次 start 再试)。 */
export function startCredentialsLock(): Promise<void> {
  if (unsubscribe || starting) return starting ?? Promise.resolve()
  starting = (async () => {
    try {
      const p = await credentialsPort()
      await p.ready()
      unsubscribe = p.onLockPush(receiveCredentialsStatus)
      const response = await p.status()
      if (response.success && response.status) receiveCredentialsStatus(response.status)
    } catch {
      // 连不上 = 这一台壳看不见锁定状态;其余一切照旧。
    } finally {
      starting = undefined
    }
  })()
  return starting
}

/** 退订、收横幅、清表。测试与 HMR 用;幂等。 */
export function stopCredentialsLock(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  hideBanner()
  useCredentialsLock.setState({ status: null, retrying: false })
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopCredentialsLock)
}
