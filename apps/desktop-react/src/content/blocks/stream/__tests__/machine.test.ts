import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BlockModel } from '../../../model/blocks'
import { isStructuralEvent } from '../events'
import { BlockStreamMachine } from '../machine'

/**
 * **块流机器的五条法** —— 每一条都配一次「拆掉即红」的反证(用例本身就是反证:
 * 违法事件在 dev/测试里直接抛,所以 `expect(...).toThrow()` 就是那条法在跑)。
 */

const p = (text: string): BlockModel => ({ kind: 'paragraph', inline: [{ type: 'text', text }] })

function open(m: BlockStreamMachine, id: string, text = id) {
  m.apply({ op: 'open', id, kind: 'paragraph', model: p(text) })
}

describe('机器:五条法', () => {
  it('L1 同号不共存 —— 树上同一时刻两个同号是身份系统坏了', () => {
    const m = new BlockStreamMachine()
    open(m, 'a')
    expect(() => open(m, 'a')).toThrow(/同号共存/)
  })

  it('L1 之外:退役过的号可以回来(早成形认领可逆),只记一笔 revivals', () => {
    const m = new BlockStreamMachine()
    open(m, '0:paragraph')
    m.apply({ op: 'retract', id: '0:paragraph' })
    expect(m.revivals).toBe(0)
    open(m, '0:paragraph')
    expect(m.revivals).toBe(1)
    expect(m.violations).toBe(0)
  })

  it('L2 关了就不再变 —— append / tail / retract 一律违法', () => {
    const m = new BlockStreamMachine()
    open(m, 'a')
    m.apply({ op: 'close', id: 'a' })
    expect(() => m.apply({ op: 'append', id: 'a', model: p('x') })).toThrow(/关了的块还在长/)
    expect(() => m.apply({ op: 'tail', id: 'a', model: p('x') })).toThrow(/关了的块还在长/)
    expect(() => m.apply({ op: 'retract', id: 'a' })).toThrow(/撤回已关的块/)
  })

  it('L3 结构只在尾巴上收 —— 撤回中间那一块违法', () => {
    const m = new BlockStreamMachine()
    open(m, 'a')
    open(m, 'b')
    expect(() => m.apply({ op: 'retract', id: 'a' })).toThrow(/撤回的不是末块/)
    m.apply({ op: 'retract', id: 'b' })
    expect(m.snapshot().map((n) => n.id)).toEqual(['a'])
  })

  it('L4 收得到人 —— 追一块不存在的违法', () => {
    const m = new BlockStreamMachine()
    expect(() => m.apply({ op: 'append', id: 'ghost', model: p('x') })).toThrow(/收不到人/)
  })

  it('L5 容器成对 —— 栈空关容器、关的不是栈顶,都违法', () => {
    const m = new BlockStreamMachine()
    expect(() => m.apply({ op: 'close-container', id: 'q' })).toThrow(/容器栈是空的/)
    m.apply({ op: 'open-container', id: 'q', kind: 'quote' })
    expect(() => m.apply({ op: 'close-container', id: 'nope' })).toThrow(/不是栈顶容器/)
  })
})

describe('机器:容器栈(单调流长出来的是一棵树)', () => {
  it('开容器之后开的块进它的孩子里,关了容器又回到根上', () => {
    const m = new BlockStreamMachine()
    open(m, 'head')
    m.apply({ op: 'open-container', id: 'q', kind: 'quote' })
    open(m, 'inner')
    m.apply({ op: 'close-container', id: 'q' })
    open(m, 'after')

    const tree = m.snapshot()
    expect(tree.map((n) => n.id)).toEqual(['head', 'q', 'after'])
    expect(tree[1].children?.map((n) => n.id)).toEqual(['inner'])
    expect(tree[0].children).toBeUndefined()
  })

  it('撤回栈顶容器把它整支带走(孩子的号一起退役)', () => {
    const m = new BlockStreamMachine()
    m.apply({ op: 'open-container', id: 'q', kind: 'quote' })
    open(m, 'inner')
    // 还没 close-container:容器没长成时就是这一刻被撤回的。
    m.apply({ op: 'retract', id: 'q' })
    expect(m.snapshot()).toEqual([])
    expect(m.has('inner')).toBe(false)
    // 弹过栈了 —— 后面开的块回到根上,不会掉进那个已经不存在的容器里。
    open(m, 'after')
    expect(m.snapshot().map((n) => n.id)).toEqual(['after'])
  })

  it('关过的容器不许再撤回(L2 对容器一样成立)', () => {
    const m = new BlockStreamMachine()
    m.apply({ op: 'open-container', id: 'q', kind: 'quote' })
    m.apply({ op: 'close-container', id: 'q' })
    expect(() => m.apply({ op: 'retract', id: 'q' })).toThrow(/撤回已关的块/)
  })
})

describe('机器:活尾槽与提交的分家', () => {
  it('tail 只换画面,append 才动提交;append 一到活尾槽当场作废', () => {
    const m = new BlockStreamMachine()
    open(m, 'a', '一')
    m.apply({ op: 'tail', id: 'a', model: p('一二') })
    expect(m.snapshot()[0].model).toEqual(p('一二'))
    m.apply({ op: 'append', id: 'a', model: p('一二三') })
    expect(m.snapshot()[0].model).toEqual(p('一二三'))
    // 再问一次不会退回活尾槽那一份
    expect(m.snapshot()[0].model).toEqual(p('一二三'))
  })

  it('关块把活尾槽收进提交 —— 关的那一刻画的就是最终那一份', () => {
    const m = new BlockStreamMachine()
    open(m, 'a', '一')
    m.apply({ op: 'tail', id: 'a', model: p('一二') })
    m.apply({ op: 'close', id: 'a' })
    expect(m.snapshot()[0]).toMatchObject({ closed: true, model: p('一二') })
  })

  it('tail 不算结构变化,open/append/close/retract 算', () => {
    expect(isStructuralEvent({ op: 'tail', id: 'a', model: p('x') })).toBe(false)
    for (const event of [
      { op: 'open', id: 'a', kind: 'paragraph', model: p('x') },
      { op: 'append', id: 'a', model: p('x') },
      { op: 'close', id: 'a' },
      { op: 'retract', id: 'a' },
      { op: 'open-container', id: 'q', kind: 'quote' },
      { op: 'close-container', id: 'q' },
    ] as const) {
      expect(isStructuralEvent(event)).toBe(true)
    }
  })
})

describe('机器:快照的引用契约(memo 的地基)', () => {
  it('什么都没发生就是同一个引用;动一下换一份', () => {
    const m = new BlockStreamMachine()
    open(m, 'a')
    const first = m.snapshot()
    expect(m.snapshot()).toBe(first)
    m.apply({ op: 'tail', id: 'a', model: p('b') })
    expect(m.snapshot()).not.toBe(first)
  })
})

describe('机制层零型特例(静态门)', () => {
  /*
   * 六轮事故的元凶是「政策渗进机制」。这条门盯的是那件事的**指纹**:机制层里出现
   * 任何一处按 kind 分叉的判据。它读源文本 —— 先剥注释(病历文本里写满了 kind 的
   * 名字,不剥的话断言自己会红,这是本目录 CLAUDE.md 记过的判例)。
   */
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('machine.ts / events.ts 里没有一处 kind 名', () => {
    for (const file of ['machine.ts', 'events.ts']) {
      const src = strip(readFileSync(resolve(process.cwd(), 'src/content/blocks/stream', file), 'utf8'))
      for (const kind of ['paragraph', 'heading', 'list', 'code', 'table', 'figure', 'diff', 'divider']) {
        expect(src, `${file} 出现了 ${kind}`).not.toContain(`'${kind}'`)
      }
      expect(src, `${file} 里有按 kind 分叉的判据`).not.toMatch(/kind\s*===/)
    }
  })
})
