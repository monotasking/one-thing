import { describe, expect, it, vi } from 'vitest'
import { isBlockActionRunnable, runBlockAction, type ZoomContent } from '../actions'

/**
 * `zoom` 的**两个取件口**(图片批加)。
 *
 * 守的是那条「声明了不等于露得出来」:一个动作要有执行器才上屏,而 zoom 的执行器
 * 判据从「有 svg」变成「两个取件口有其一」。少了这一组,给位图接上第二个取件口时
 * 最容易忘的恰恰是 `isBlockActionRunnable` 那一行 —— 忘了的表现是**檐上那颗「放大」
 * 整个不出现**,而屏幕上一切正常,没有任何报错。
 */
describe('zoom:两个取件口', () => {
  it('一个都没有 → 不露出(点了没反应比没这个钮更糟)', () => {
    expect(isBlockActionRunnable({ verb: 'zoom' })).toBe(false)
  })

  it('有 svg 取件口 → 露出', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', svg: () => '<svg/>' })).toBe(true)
  })

  it('**有 image 取件口 → 也露出**(位图那一档)', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', image: () => ({ src: 'x.png', alt: 'a' }) })).toBe(true)
  })

  it('取件口在、此刻交不出东西 → 仍然露出:那是诚实的中间态,不是坏钮', () => {
    expect(isBlockActionRunnable({ verb: 'zoom', image: () => undefined })).toBe(true)
  })
})

describe('zoom:执行器把内容交给浮层', () => {
  const runtime = (openZoom: (c: ZoomContent) => void) => ({ toggleSource: () => undefined, openZoom })

  it('位图那一支:浮层收到 `{ image }`', async () => {
    const openZoom = vi.fn()
    await runBlockAction(
      { verb: 'zoom', image: () => ({ src: 'file:///a.png', alt: '猫' }) },
      runtime(openZoom),
    )
    expect(openZoom).toHaveBeenCalledWith({ image: { src: 'file:///a.png', alt: '猫' } })
  })

  it('矢量那一支:浮层收到 `{ svg }`', async () => {
    const openZoom = vi.fn()
    await runBlockAction({ verb: 'zoom', svg: () => '<svg/>' }, runtime(openZoom))
    expect(openZoom).toHaveBeenCalledWith({ svg: '<svg/>' })
  })

  it('取不到东西 → 什么都不做,**不开一个空浮层**', async () => {
    const openZoom = vi.fn()
    await runBlockAction({ verb: 'zoom', image: () => undefined }, runtime(openZoom))
    expect(openZoom).not.toHaveBeenCalled()
  })
})
