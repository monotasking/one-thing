import { afterEach, describe, expect, it } from 'vitest'
import { announce, liveRegionText, resetLiveRegions } from '../live-region'

/** 播报是「清空 → 下一个宏任务写入」,所以每次断言前让出一次。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  resetLiveRegions()
})

describe('live-region', () => {
  it('第一次播报就把口挂到 body 上,两格各自带正确的 aria-live', async () => {
    expect(document.querySelector('[data-live-region]')).toBeNull()
    announce('存好了')
    await tick()

    const host = document.querySelector('[data-live-region]')
    expect(host).not.toBeNull()
    expect(host?.className).toBe('visually-hidden')

    const polite = host?.querySelector('[data-live="polite"]')
    expect(polite?.getAttribute('aria-live')).toBe('polite')
    expect(polite?.getAttribute('aria-atomic')).toBe('true')
    expect(polite?.textContent).toBe('存好了')
  })

  it('assertive 落在另一格,两格互不覆盖', async () => {
    announce('存好了')
    announce('存不进去', { level: 'assertive' })
    await tick()
    expect(liveRegionText('polite')).toBe('存好了')
    expect(liveRegionText('assertive')).toBe('存不进去')
    expect(
      document.querySelector('[data-live="assertive"]')?.getAttribute('aria-live'),
    ).toBe('assertive')
  })

  it('同一句话说两次也重播 —— 中间真的清空过', async () => {
    announce('复制好了')
    await tick()
    expect(liveRegionText('polite')).toBe('复制好了')

    announce('复制好了')
    // 还没到下一个宏任务:这一格必须是**空的**(这就是「重播」得以成立的差分)。
    expect(liveRegionText('polite')).toBe('')
    await tick()
    expect(liveRegionText('polite')).toBe('复制好了')
  })

  it('空话不播 —— 口保持原样', async () => {
    announce('有话')
    await tick()
    announce('   ')
    await tick()
    expect(liveRegionText('polite')).toBe('有话')
  })

  it('口只有一个:播十次也还是一个 host、一格 polite', async () => {
    for (let i = 0; i < 10; i += 1) announce(`第 ${i} 句`)
    await tick()
    expect(document.querySelectorAll('[data-live-region]').length).toBe(1)
    expect(document.querySelectorAll('[data-live="polite"]').length).toBe(1)
    expect(liveRegionText('polite')).toBe('第 9 句')
  })
})
