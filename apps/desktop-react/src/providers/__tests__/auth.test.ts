import { describe, expect, it } from 'vitest'
import type { OAuthStartResponse } from '@shared/ipc/oauth'
import {
  devicePollIsFatal,
  devicePollShouldContinue,
  devicePollShouldSlowDown,
  flowKindOf,
  formatMoment,
  standingOf,
} from '../auth'

/**
 * 登录流的判据。这一组守的是**流形由后端这一次的答案定** ——
 * 不由名册上的 `oauthFlow`、也不由 `OAuthStartResponse.flowKind` 那个字段定。
 */

function start(over: Partial<OAuthStartResponse> = {}): OAuthStartResponse {
  return { success: true, ...over }
}

describe('flowKindOf', () => {
  it('给了设备码与验证网址 = 设备码流', () => {
    expect(flowKindOf(start({ userCode: 'XKCD-2048', verificationUri: 'https://x.ai/device' }))).toBe(
      'device',
    )
  })

  it('requiresCodeEntry = 贴码流', () => {
    expect(flowKindOf(start({ requiresCodeEntry: true, state: 's' }))).toBe('paste')
  })

  it('什么都没给 = 浏览器回调流', () => {
    expect(flowKindOf(start())).toBe('browser')
  })

  it('起步就失败 = 没有流 —— 那时该画的是错误,不是流程', () => {
    expect(flowKindOf(start({ success: false, error: 'nope' }))).toBeNull()
  })

  /**
   * 这一条是整组里最要紧的:`flowKind` 说是设备码,而 `userCode` 没给。
   * 听字段的话会画出一个**空的大字框**;听答案的话退回浏览器流,至少是能走的。
   */
  it('flowKind 说设备码但没给码 —— 听答案不听字段', () => {
    expect(flowKindOf(start({ flowKind: 'device-code' }))).toBe('browser')
  })

  it('flowKind 缺席但码齐了 —— 照样是设备码流', () => {
    expect(flowKindOf(start({ userCode: 'A-1', verificationUri: 'https://a' }))).toBe('device')
  })
})

describe('设备码轮询的三种答复', () => {
  it('authorization_pending:接着问,不算失败', () => {
    expect(devicePollShouldContinue('authorization_pending', undefined)).toBe(true)
    // 有的服务商把它放在 error 里而不是 pollStatus 里 —— 两处都认。
    expect(devicePollShouldContinue(undefined, 'authorization_pending')).toBe(true)
    expect(devicePollShouldContinue(undefined, undefined)).toBe(false)
  })

  it('slow_down:加长间隔', () => {
    expect(devicePollShouldSlowDown('slow_down', undefined)).toBe(true)
    expect(devicePollShouldSlowDown(undefined, 'slow_down')).toBe(true)
  })

  it('过期与被拒是终局 —— 不该再问下去', () => {
    expect(devicePollIsFatal('expired_token')).toBe(true)
    expect(devicePollIsFatal('access_denied')).toBe(true)
    expect(devicePollIsFatal('authorization_pending')).toBe(false)
    expect(devicePollIsFatal(undefined)).toBe(false)
  })
})

describe('standingOf', () => {
  it('没登上 = signedOut', () => {
    expect(standingOf(undefined)).toBe('signedOut')
    expect(standingOf({ success: true, isLoggedIn: false })).toBe('signedOut')
  })

  it('登上了 = signedIn', () => {
    expect(standingOf({ success: true, isLoggedIn: true })).toBe('signedIn')
  })

  /**
   * 「登过但令牌过期」**不是**未登录:说成未登录会让人以为要从头走一遍完整登录流,
   * 而实际上重新授权就够了。这一格是这块判据存在的全部理由。
   */
  it('登过但过期 = expired,不是 signedOut', () => {
    expect(standingOf({ success: true, isLoggedIn: true, isExpired: true })).toBe('expired')
  })
})

describe('formatMoment', () => {
  it('缺席就是缺席 —— 不拿 0 当一个时刻', () => {
    expect(formatMoment(undefined)).toBeNull()
    expect(formatMoment(0)).toBeNull()
  })

  it('本地时区的 MM-DD HH:mm,长度恒定', () => {
    const at = new Date(2026, 7, 31, 9, 5).getTime()
    expect(formatMoment(at)).toBe('08-31 09:05')
  })
})
