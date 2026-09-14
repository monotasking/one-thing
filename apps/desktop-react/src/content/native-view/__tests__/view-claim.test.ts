import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptViewClaim,
  recordViewSnapshot,
  releaseViewClaim,
  resetViewClaims,
  viewClaimOf,
} from '../view-claim'

/**
 * 账本那一半的纯量法(通道不在场):
 *  ① 换宿主 = 交出之后一帧内有人接手 → 账原样交接,**不收回**;
 *  ② 真的走了 = 一帧内没人接手 → 遮着的话替上一任收回一次,然后销账;
 *  ③ 没遮着就走 → 什么都不发(「发了几条」这个读数不许多一条)。
 */

const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => {
  resetViewClaims()
})

describe('view-claim', () => {
  it('出厂:没被遮、没图;接手的是同一个对象,写了下一任读得到', () => {
    const first = adoptViewClaim('v1')
    expect(first).toMatchObject({ occluded: false, snapshot: null })
    first.occluded = true
    recordViewSnapshot('v1', 'data:image/png;base64,AA')
    expect(viewClaimOf('v1')).toMatchObject({ occluded: true, snapshot: 'data:image/png;base64,AA' })
    const second = adoptViewClaim('v1')
    expect(second).toBe(first)
  })

  it('换宿主:交出之后一帧内有人接手 → 不收回、账不销', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1')
    claim.occluded = true
    releaseViewClaim('v1', retract)
    // 同一次提交里新的一任接手(React 的卸载清理与新挂载之间不隔一帧)。
    const next = adoptViewClaim('v1')
    await frame()
    await frame()
    expect(retract).not.toHaveBeenCalled()
    expect(next.occluded).toBe(true)
    expect(viewClaimOf('v1')).toBe(next)
  })

  it('真的走了:一帧内没人接手且遮着 → 收回一次,账销掉', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1')
    claim.occluded = true
    releaseViewClaim('v1', retract)
    expect(retract).not.toHaveBeenCalled() // 不当场撤 —— 要留一帧给重挂
    await frame()
    await frame()
    expect(retract).toHaveBeenCalledTimes(1)
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  it('没遮着就走 → 一个字都不发,账照样销', async () => {
    const retract = vi.fn()
    adoptViewClaim('v1')
    releaseViewClaim('v1', retract)
    await frame()
    await frame()
    expect(retract).not.toHaveBeenCalled()
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  it('销了账之后才到的图不记(不把一份销了的账又立起来)', async () => {
    adoptViewClaim('v1')
    releaseViewClaim('v1', () => {})
    await frame()
    await frame()
    recordViewSnapshot('v1', 'data:image/png;base64,AA')
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  it('多交一次不会把持有数减成负数(幂等)', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1')
    claim.occluded = true
    releaseViewClaim('v1', retract)
    releaseViewClaim('v1', retract)
    await frame()
    await frame()
    expect(retract).toHaveBeenCalledTimes(1)
  })
})
