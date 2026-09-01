import { act, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { freezeFlags, frozenFlagOf, useFrozenFlags } from '../list-placement'

/**
 * 位置固化原语。守的是 09-01 那条法:**交互中的列表不许在用户手底下重排**。
 *
 * 每条断言配一个反证 —— 形式是同一段剧情走「不冻」的那一路,读数必须不同;
 * 一条换成任何实现都绿的断言,什么都没守住。
 */

interface Row {
  id: string
  selected: boolean
}

const rows = (flags: Record<string, boolean>): Row[] =>
  Object.entries(flags).map(([id, selected]) => ({ id, selected }))

describe('freezeFlags / frozenFlagOf', () => {
  it('拍一张快照:每一项当时是什么就记什么', () => {
    const frozen = freezeFlags(rows({ a: true, b: false }), (r) => r.id, (r) => r.selected)
    expect(frozen.get('a')).toBe(true)
    expect(frozen.get('b')).toBe(false)
    expect(frozen.size).toBe(2)
  })

  it('快照**认识**的项读快照 —— 活值变了也不改位置', () => {
    const frozen = freezeFlags(rows({ a: true }), (r) => r.id, (r) => r.selected)
    // 活值已经变成 false(用户刚取消勾选),但位置仍按 true 算。
    expect(frozenFlagOf(frozen, 'a', false)).toBe(true)
  })

  it('快照**不认识**的项读活值 —— 它没有旧位置可守', () => {
    const frozen = freezeFlags(rows({ a: true }), (r) => r.id, (r) => r.selected)
    expect(frozenFlagOf(frozen, 'brand-new', true)).toBe(true)
    expect(frozenFlagOf(frozen, 'brand-new', false)).toBe(false)
  })

  it('反证:没有快照(undefined)就是老行为 —— 一律读活值', () => {
    expect(frozenFlagOf(undefined, 'a', false)).toBe(false)
    expect(frozenFlagOf(undefined, 'a', true)).toBe(true)
  })

  it('`false` 是一个真答案,不是「没记过」—— 不许被 ?? 吞成活值', () => {
    const frozen = freezeFlags(rows({ a: false }), (r) => r.id, (r) => r.selected)
    // 用 `??` 而不是「显式判 undefined」写这一格的话,这里会读到 true(活值)。
    expect(frozenFlagOf(frozen, 'a', true)).toBe(false)
  })
})

describe('useFrozenFlags', () => {
  function harness() {
    const seen: ReadonlyMap<string, boolean>[] = []
    function Probe({ items, token }: { items: Row[]; token: string }) {
      const frozen = useFrozenFlags(items, (r) => r.id, (r) => r.selected, token)
      seen.push(frozen)
      return null
    }
    return { seen, Probe }
  }

  it('token 不变:活值怎么翻,快照都不动,而且**引用不换**', () => {
    const { seen, Probe } = harness()
    const { rerender } = render(<Probe items={rows({ a: false, b: false })} token="t1" />)
    rerender(<Probe items={rows({ a: true, b: false })} token="t1" />)

    expect(seen[1].get('a')).toBe(false) // 勾上了,位置仍按「没勾」算
    // 引用稳定:下游拿它当 useMemo 的依赖,每帧换一个新 Map 就等于每帧重算分区。
    expect(seen[1]).toBe(seen[0])
  })

  it('token 换了才重拍(换一坑 / 拉到新目录 / 显式刷新)', () => {
    const { seen, Probe } = harness()
    const { rerender } = render(<Probe items={rows({ a: false })} token="t1" />)
    rerender(<Probe items={rows({ a: true })} token="t1" />)
    expect(seen[1].get('a')).toBe(false)

    rerender(<Probe items={rows({ a: true })} token="t2" />)
    expect(seen[2].get('a')).toBe(true)
    expect(seen[2]).not.toBe(seen[1])
  })

  it('**首帧就有快照**:拍照在渲染期,不在 effect 里', () => {
    const { seen, Probe } = harness()
    render(<Probe items={rows({ a: true })} token="t1" />)
    // 走 useEffect 的话第一帧这里是空的,而首屏之后的第一次勾选照样会跳。
    expect(seen[0].size).toBe(1)
    expect(seen[0].get('a')).toBe(true)
  })

  it('反证:把用户改的那一格放进 token,等于没冻', () => {
    const { seen, Probe } = harness()
    const { rerender } = render(<Probe items={rows({ a: false })} token="a:false" />)
    // 这正是「排序键里混进了用户正在改的那一格」——token 一变就重拍,位置照跳。
    rerender(<Probe items={rows({ a: true })} token="a:true" />)
    expect(seen[1].get('a')).toBe(true)
  })

  it('快照之后新出现的项不进快照 —— 它按活值算(见 frozenFlagOf)', () => {
    const { seen, Probe } = harness()
    const { rerender } = render(<Probe items={rows({ a: true })} token="t1" />)
    rerender(<Probe items={rows({ a: true, fresh: true })} token="t1" />)
    expect(seen[1].has('fresh')).toBe(false)
    expect(frozenFlagOf(seen[1], 'fresh', true)).toBe(true)
  })

  it('卸载重挂 = 一次新的进入,快照重拍', () => {
    const { seen, Probe } = harness()
    const first = render(<Probe items={rows({ a: false })} token="t1" />)
    act(() => first.unmount())
    render(<Probe items={rows({ a: true })} token="t1" />)
    expect(seen[seen.length - 1].get('a')).toBe(true)
  })
})
