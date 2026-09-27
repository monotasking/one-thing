import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adoptViewClaim,
  isCurrentViewHolder,
  recordViewSnapshot,
  releaseViewClaim,
  resetViewClaims,
  viewClaimOf,
} from '../view-claim'

const A = Symbol('a')
const B = Symbol('b')

/**
 * 账本那一半的纯量法(通道不在场):
 *  ① 换宿主 = 交出之后一帧内有人接手 → 账原样交接,**`onGone` 不跑**(2026-09-26 起
 *    那帧「看不见」也在它里面,所以「不跑」= 视图在原地换矩形、不掉一帧);
 *  ② 真的走了 = 一帧内没人接手 → `onGone` 跑**一次**,带着最后的账(遮着没遮着由
 *    占位格决定要不要补 `unocclude`),然后销账;
 *  ③ 没遮着就走 → `onGone` 照跑一次(要藏那片地),账上写的是「没遮」。
 */

const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

afterEach(() => {
  resetViewClaims()
})

describe('view-claim', () => {
  it('出厂:没被遮、没图;接手的是同一个对象,写了下一任读得到', () => {
    const first = adoptViewClaim('v1', A)
    expect(first).toMatchObject({ occluded: false, snapshot: null })
    first.occluded = true
    recordViewSnapshot('v1', 'data:image/png;base64,AA')
    expect(viewClaimOf('v1')).toMatchObject({ occluded: true, snapshot: 'data:image/png;base64,AA' })
    const second = adoptViewClaim('v1', A)
    expect(second).toBe(first)
  })

  it('换宿主:交出之后一帧内有人接手 → 不收回、账不销', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1', A)
    claim.occluded = true
    releaseViewClaim('v1', A, retract)
    // 同一次提交里新的一任接手(React 的卸载清理与新挂载之间不隔一帧)。
    const next = adoptViewClaim('v1', B)
    await frame()
    await frame()
    expect(retract).not.toHaveBeenCalled()
    expect(next.occluded).toBe(true)
    expect(viewClaimOf('v1')).toBe(next)
  })

  it('真的走了:一帧内没人接手且遮着 → onGone 一次、带着「遮着」,账销掉', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1', A)
    claim.occluded = true
    releaseViewClaim('v1', A, retract)
    expect(retract).not.toHaveBeenCalled() // 不当场 —— 要留一帧给重挂
    await frame()
    await frame()
    expect(retract).toHaveBeenCalledTimes(1)
    expect(retract.mock.calls[0][0]).toMatchObject({ occluded: true })
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  it('没遮着就走 → onGone 照跑一次(那片地要藏),账上写的是「没遮」', async () => {
    const retract = vi.fn()
    adoptViewClaim('v1', A)
    releaseViewClaim('v1', A, retract)
    await frame()
    await frame()
    expect(retract).toHaveBeenCalledTimes(1)
    expect(retract.mock.calls[0][0]).toMatchObject({ occluded: false })
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  it('销了账之后才到的图不记(不把一份销了的账又立起来)', async () => {
    adoptViewClaim('v1', A)
    releaseViewClaim('v1', A, () => {})
    await frame()
    await frame()
    recordViewSnapshot('v1', 'data:image/png;base64,AA')
    expect(viewClaimOf('v1')).toBeUndefined()
  })

  /*
   * 2026-09-26 录屏:关掉的浮窗用上一棵树再画 120ms 出场动画,旧占位格在新的一任
   * 挂上**之后**还活着、还在量;只有最上面那一任能开口,不然旧矩形会盖回去。
   */
  it('后接手的在最上面:旧的一任还没走,开口的也只有新的一任;新的走了旧的才回到最上面', () => {
    adoptViewClaim('v1', A)
    expect(isCurrentViewHolder('v1', A)).toBe(true)
    adoptViewClaim('v1', B)
    expect(isCurrentViewHolder('v1', A)).toBe(false)
    expect(isCurrentViewHolder('v1', B)).toBe(true)
    releaseViewClaim('v1', B, () => {})
    expect(isCurrentViewHolder('v1', A)).toBe(true)
    expect(isCurrentViewHolder('v1', B)).toBe(false)
  })

  it('多交一次不会把持有数减成负数(幂等)', async () => {
    const retract = vi.fn()
    const claim = adoptViewClaim('v1', A)
    claim.occluded = true
    releaseViewClaim('v1', A, retract)
    releaseViewClaim('v1', A, retract)
    await frame()
    await frame()
    expect(retract).toHaveBeenCalledTimes(1)
  })
})
