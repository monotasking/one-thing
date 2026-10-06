import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialsStatusPayload } from '@shared/ipc/spaces'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { useStageStore } from '../../stage/store'
import { configureCredentialsPort, credentialsLockPushOfFrame, credentialsStatusOf } from '../credentials-port'
import type { CredentialsPort } from '../credentials-port'
import {
  receiveCredentialsStatus,
  retryCredentialsUnlock,
  startCredentialsLock,
  stopCredentialsLock,
  useCredentialsLock,
} from '../credentials-lock-source'

/**
 * 「凭证已锁定」横幅(第④步批 0,决策 D10)。守四件事:
 *
 *  1. 锁着 → 一条**不自动消失**的横幅,标题与第二行逐字是派工单那几句,带「重试」;
 *  2. 解开 → 横幅收掉;同一个原因不重复弹;
 *  3. 没有对应句子的原因码不画第二行(不猜);
 *  4. 推送面是不可信输入:形不对的帧丢掉。
 */
const LOCKED_TIMEOUT: CredentialsStatusPayload = { tier: 'keychain', state: 'locked', reason: 'keychain-timeout', encryption: 'master-key' }
const READY: CredentialsStatusPayload = { tier: 'keychain', state: 'ready', encryption: 'master-key' }

function toasts() {
  return useToastHub.getState().toasts
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
})

afterEach(() => {
  stopCredentialsLock()
  configureCredentialsPort(undefined)
  vi.restoreAllMocks()
})

describe('凭证锁定横幅', () => {
  it('锁着:一条不自动消失的横幅,文案逐字,带「重试」', () => {
    receiveCredentialsStatus(LOCKED_TIMEOUT)
    expect(toasts()).toHaveLength(1)
    const toast = toasts()[0]!
    expect(toast.title).toBe('凭证已锁定,需要登录的服务商暂时不能用。')
    expect(toast.body).toBe('钥匙串没有回应。')
    expect(toast.lifeMs).toBeNull()
    expect(toast.action?.label).toBe('重试')
  })

  it('三种原因码各有一句;没有对应句子的码不画第二行', () => {
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, reason: 'keychain-denied' })
    expect(toasts().at(-1)?.body).toBe('钥匙串拒绝了访问。')
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, reason: 'key-missing' })
    expect(toasts().at(-1)?.body).toBe('找不到加密凭证用的密钥,可以导入之前导出的凭证,或重新登录。')
    // 第④步批 1 补齐的两句(编排者定的文案)。
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, reason: 'keychain-failed' })
    expect(toasts().at(-1)?.body).toBe('读取钥匙串时出错。')
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, reason: 'legacy-safestorage' })
    expect(toasts().at(-1)?.body).toBe('原来的凭证还没迁移完,点「重试」再试一次。')
    // 换原因 = 换掉那一条,屏上始终只有一条横幅。
    expect(toasts()).toHaveLength(1)
  })

  it('钥匙还在读(loading)不弹横幅 —— 只在设置页那一行说', () => {
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, state: 'loading', reason: undefined })
    expect(toasts()).toHaveLength(0)
    receiveCredentialsStatus({ ...LOCKED_TIMEOUT, reason: 'loading' })
    expect(toasts()).toHaveLength(0)
    expect(useCredentialsLock.getState().status?.reason).toBe('loading')
  })

  it('同一个原因不重复弹;解开就收掉', () => {
    receiveCredentialsStatus(LOCKED_TIMEOUT)
    receiveCredentialsStatus(LOCKED_TIMEOUT)
    expect(toasts()).toHaveLength(1)
    receiveCredentialsStatus(READY)
    expect(toasts()).toHaveLength(0)
    expect(useCredentialsLock.getState().status?.state).toBe('ready')
  })

  it('「重试」调后端的 unlock,成功就收横幅', async () => {
    const unlock = vi.fn(async () => ({ success: true, status: READY }))
    configureCredentialsPort({
      ready: async () => undefined,
      status: async () => ({ success: true, status: LOCKED_TIMEOUT }),
      unlock,
      exportCredentials: async () => ({ success: false }),
      importCredentials: async () => ({ success: false }),
      onLockPush: () => () => undefined,
    } satisfies CredentialsPort)
    await startCredentialsLock()
    expect(toasts()).toHaveLength(1)

    await retryCredentialsUnlock()
    expect(unlock).toHaveBeenCalledTimes(1)
    expect(toasts()).toHaveLength(0)
  })

  it('推送帧:名字与形都对才认', () => {
    expect(credentialsLockPushOfFrame('credentials:locked', { locked: true, tier: 'file', state: 'locked', reason: 'key-missing' }))
      .toEqual({ tier: 'file', state: 'locked', reason: 'key-missing', encryption: 'master-key' })
    expect(credentialsLockPushOfFrame('oauth:flow', { tier: 'file', state: 'locked' })).toBeNull()
    expect(credentialsStatusOf({ tier: 'mystery', state: 'locked' })).toBeNull()
    expect(credentialsStatusOf({ tier: 'none', state: 'ready', reason: 'made-up' }))
      .toEqual({ tier: 'none', state: 'ready', encryption: 'none' })
  })
})
