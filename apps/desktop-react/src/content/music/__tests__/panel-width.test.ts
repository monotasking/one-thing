import { describe, expect, it } from 'vitest'
import { MUSIC_DRAWER_SIDE_AT, MUSIC_WIDE_AT, formOfWidth } from '../panel-width'

/**
 * 两个阈值一处产地(音乐面 v7)。这份用例钉的是**边界落在哪一侧** ——
 * 正本写的是「≥ 900 两栏」「≥ 560 右侧抽屉」,所以 900 与 560 本身算在上面那一档。
 */
describe('一个宽 → 一种形', () => {
  it('900 与 560 都算在上面那一档', () => {
    expect(formOfWidth(MUSIC_WIDE_AT)).toEqual({ wide: true, drawer: 'side' })
    expect(formOfWidth(MUSIC_WIDE_AT - 1).wide).toBe(false)
    expect(formOfWidth(MUSIC_DRAWER_SIDE_AT).drawer).toBe('side')
    expect(formOfWidth(MUSIC_DRAWER_SIDE_AT - 1).drawer).toBe('sheet')
  })

  it('正本 §5 那六档', () => {
    expect([300, 360, 620, 900, 1040, 1280].map((w) => formOfWidth(w))).toEqual([
      { wide: false, drawer: 'sheet' },
      { wide: false, drawer: 'sheet' },
      { wide: false, drawer: 'side' },
      { wide: true, drawer: 'side' },
      { wide: true, drawer: 'side' },
      { wide: true, drawer: 'side' },
    ])
  })

  it('还没量到(0)= 最窄那一档,不猜宽', () => {
    expect(formOfWidth(0)).toEqual({ wide: false, drawer: 'sheet' })
  })
})
