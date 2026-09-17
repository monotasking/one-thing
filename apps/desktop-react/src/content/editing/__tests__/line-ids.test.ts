import { describe, expect, it } from 'vitest'
import { initialLineIds, nextLineIds } from '../line-ids'

describe('行身份', () => {
  const base = initialLineIds(['a', 'b', 'c', 'd'])

  it('中间插一行:前后的行身份不变,新行领新身份', () => {
    const next = nextLineIds(base, ['a', 'b', 'x', 'c', 'd'])
    expect(next.ids.filter((_, i) => i !== 2)).toEqual(base.ids)
    expect(base.ids).not.toContain(next.ids[2])
  })

  it('回车把一行拆成两行:改了字的那一行还是它自己,拆出来的是新的', () => {
    const next = nextLineIds(base, ['a', 'b1', 'b2', 'c', 'd'])
    expect(next.ids[1]).toBe(base.ids[1])
    expect(base.ids).not.toContain(next.ids[2])
    expect(next.ids.slice(3)).toEqual(base.ids.slice(2))
  })

  it('打一个字:行数不变,身份一个都不换', () => {
    expect(nextLineIds(base, ['a', 'bx', 'c', 'd']).ids).toEqual(base.ids)
  })

  it('删一行:其余的身份不变', () => {
    expect(nextLineIds(base, ['a', 'c', 'd']).ids).toEqual([base.ids[0], base.ids[2], base.ids[3]])
  })

  it('同一份行进来:原样交回(身份稳定、引用稳定)', () => {
    expect(nextLineIds(base, base.lines)).toBe(base)
  })

  it('重复的行也分得开:末尾加一行相同的,原来那几行身份不动', () => {
    const same = initialLineIds(['- [ ] ', '- [ ] '])
    const next = nextLineIds(same, ['- [ ] ', '- [ ] ', '- [ ] '])
    expect(next.ids.slice(0, 2)).toEqual(same.ids)
    expect(new Set(next.ids).size).toBe(3)
  })
})
