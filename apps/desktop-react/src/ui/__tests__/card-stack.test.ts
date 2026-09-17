import { describe, expect, it } from 'vitest'
import { layoutCardStack } from '../card-stack'

const G = { visible: 3, inset: 6, offset: 7, rotate: 3, gap: 10, slack: 12 }
const items = (n: number, width = 76) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, width }))

describe('layoutCardStack', () => {
  it('收拢:只画最上 visible 张,逐张探出 + 错角,宽 = 最右可见卡右缘 + 余量', () => {
    const l = layoutCardStack(items(5), false, G)
    expect(l.cards.map((c) => c.hidden)).toEqual([true, true, false, false, false])
    expect(l.cards.slice(2).map((c) => [c.left, c.rotate])).toEqual([[6, -3], [13, 0], [20, 3]])
    expect(l.stackWidth).toBe(20 + 76 + 12)
  })

  it('展开:从左往右累计,零旋转,宽交给容器', () => {
    const l = layoutCardStack(items(3), true, G)
    expect(l.cards.map((c) => [c.left, c.rotate, c.hidden])).toEqual([[0, 0, false], [86, 0, false], [172, 0, false]])
    expect(l.rowWidth).toBe(172 + 76)
    expect(l.stackWidth).toBeNull()
  })
})
