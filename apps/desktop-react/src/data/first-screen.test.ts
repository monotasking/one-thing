import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_SCREEN_YIELD_MS,
  markFirstScreenLanded,
  markFirstScreenPending,
  resetFirstScreen,
  whenFirstScreen,
} from './first-screen'

/**
 * **首屏让路**这道闸自己的四条(工单 6 ①,判据在 `first-screen.ts` 头上)。
 *
 * 它治的病在真机上是「③ 冷载首屏偶发 989ms,其中九成不是首屏自己的活」——
 * 那一下量得到但复现不稳,所以这里钉的是它的**机制**:两条边、天花板、
 * 池命中不多等一拍、再冷开一次仍然让路。
 */
afterEach(() => {
  resetFirstScreen()
  vi.useRealTimers()
})

/** 把微任务队列跑干净 —— 这道闸最多让过一个微任务。 */
async function ticks(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

describe('first screen yield', () => {
  it('lets everyone through when nobody announced a first screen', async () => {
    const seen: string[] = []
    void whenFirstScreen('nobody-opened-me').then(() => seen.push('panel'))
    await ticks()
    expect(seen).toEqual(['panel'])
  })

  it('holds panel reads between the two edges and releases them on landing', async () => {
    const seen: string[] = []
    markFirstScreenPending('s1')
    void whenFirstScreen('s1').then(() => seen.push('panel'))
    await ticks()
    // 页还在飞:面板那一发一个字节都还没出门。
    expect(seen).toEqual([])

    markFirstScreenLanded('s1')
    await ticks()
    expect(seen).toEqual(['panel'])
  })

  it('does not make one session wait on another', async () => {
    const seen: string[] = []
    markFirstScreenPending('s1')
    void whenFirstScreen('s2').then(() => seen.push('other-session'))
    await ticks()
    expect(seen).toEqual(['other-session'])
  })

  it('gives up at the ceiling so a first screen that never lands cannot starve the panels', async () => {
    vi.useFakeTimers()
    const seen: string[] = []
    markFirstScreenPending('stuck')
    void whenFirstScreen('stuck').then(() => seen.push('panel'))
    await vi.advanceTimersByTimeAsync(FIRST_SCREEN_YIELD_MS - 1)
    expect(seen).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(seen).toEqual(['panel'])
  })

  it('costs a pool hit nothing: an already-landed session resolves without a tick', async () => {
    markFirstScreenPending('warm')
    markFirstScreenLanded('warm')
    let resolved = false
    // `Promise.resolve()` 那一路要一个微任务;已落地那条快路当场就是它。
    void whenFirstScreen('warm').then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(true)
  })

  it('yields again when the same session is cold-opened a second time', async () => {
    markFirstScreenPending('again')
    markFirstScreenLanded('again')
    // 被挤出停靠池之后再开一次,仍然是一次真的冷开。
    markFirstScreenPending('again')
    const seen: string[] = []
    void whenFirstScreen('again').then(() => seen.push('panel'))
    await ticks()
    expect(seen).toEqual([])
    markFirstScreenLanded('again')
    await ticks()
    expect(seen).toEqual(['panel'])
  })
})
