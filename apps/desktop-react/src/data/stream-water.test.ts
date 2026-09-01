import { describe, expect, it } from 'vitest'
import { StreamWater } from './stream-water'
import type { StreamDeltaStamp } from '@shared/events/index.js'

/**
 * 水位表(R2)。要证的只有三件事,每件对着一条审查记录:
 *
 *  · **只存连续前缀**(条 3):偏移恰等于水位才收 —— 带洞的字符串比没有更坏;
 *  · **懒拼 + 记忆**(条 5):十万字的段每帧天真拼接是 O(n²);
 *  · **清格不改结果**(第六不变式):账本追平才退役,所以打包行那一帧零像素变化。
 */

const stamp = (over: Partial<StreamDeltaStamp> = {}): StreamDeltaStamp => ({
  messageId: 'a1', runId: 'r1', requestIndex: 1, partIndex: 0, kind: 'text', charOffset: 0, gen: 0, ...over,
})

const textOf = (water: StreamWater, messageId: string, partIndex = 0): string | undefined =>
  water.parts(messageId).find(part => part.partIndex === partIndex)?.text()

describe('只存连续前缀(审查条 3)', () => {
  it('接得上就收,水位往前走', () => {
    const water = new StreamWater()
    expect(water.feed(stamp({ charOffset: 0 }), '好').outcome).toBe('accepted')
    expect(water.feed(stamp({ charOffset: 1 }), '的').outcome).toBe('accepted')
    expect(textOf(water, 'a1')).toBe('好的')
  })

  it('回声(偏移比水位小)= 已经有了,丢', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好的')
    expect(water.feed(stamp({ charOffset: 0 }), '好的').outcome).toBe('echo')
    expect(textOf(water, 'a1')).toBe('好的')
  })

  it('缺段(偏移比水位大)= 前面断了,**丢并计数**,不拼出带洞的字符串', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好')
    expect(water.feed(stamp({ charOffset: 99 }), '继续').outcome).toBe('gap')
    expect(textOf(water, 'a1')).toBe('好')
    expect(water.gapCount).toBe(1)
  })

  it('一段的第一条必须是它的第 0 个字(半路加入的那一段等账本)', () => {
    const water = new StreamWater()
    expect(water.feed(stamp({ charOffset: 5 }), '中途').outcome).toBe('gap')
    expect(water.parts('a1')).toHaveLength(0)
  })

  it('段与段各走各的水位(partIndex 是身份)', () => {
    const water = new StreamWater()
    water.feed(stamp({ partIndex: 0, charOffset: 0 }), '正文')
    water.feed(stamp({ partIndex: 1, kind: 'reasoning', charOffset: 0 }), '想法')
    expect(textOf(water, 'a1', 0)).toBe('正文')
    expect(textOf(water, 'a1', 1)).toBe('想法')
    expect(water.parts('a1').map(part => part.partIndex)).toEqual([0, 1])
  })

  it('换代号进键:gen 不同就是两段(换代律的位子)', () => {
    const water = new StreamWater()
    water.feed(stamp({ gen: 0, charOffset: 0 }), '旧的')
    expect(water.feed(stamp({ gen: 1, charOffset: 0 }), '新的').outcome).toBe('accepted')
    expect(water.parts('a1')).toHaveLength(2)
  })

  it('消息与消息互不相干', () => {
    const water = new StreamWater()
    water.feed(stamp({ messageId: 'a1', charOffset: 0 }), '甲')
    water.feed(stamp({ messageId: 'a2', charOffset: 0 }), '乙')
    expect(textOf(water, 'a1')).toBe('甲')
    expect(textOf(water, 'a2')).toBe('乙')
  })
})

describe('懒拼 + 记忆(审查条 5)', () => {
  it('没长新块就直接给上一份(同一个字符串引用)', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好')
    const once = water.parts('a1')[0].text()
    const twice = water.parts('a1')[0].text()
    expect(twice).toBe(once)
    // 引用相同 —— 拼过一次就记住了,不是每次现拼出一个长得一样的新串。
    expect(Object.is(once, twice)).toBe(true)
  })

  it('长了新块就重拼,长度与内容都对', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好')
    water.parts('a1')[0].text()
    water.feed(stamp({ charOffset: 1 }), '的')
    expect(textOf(water, 'a1')).toBe('好的')
    expect(water.parts('a1')[0].length).toBe(2)
  })

  it('一万条 delta 攒起来不炸(分块攒,读时才拼一次)', () => {
    const water = new StreamWater()
    let offset = 0
    for (let i = 0; i < 10_000; i += 1) {
      water.feed(stamp({ charOffset: offset }), 'x')
      offset += 1
    }
    expect(water.parts('a1')[0].length).toBe(10_000)
    expect(textOf(water, 'a1')).toHaveLength(10_000)
  })
})

describe('清格(第六不变式的落点)', () => {
  it('账本追平了才退役', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好的')
    water.settle('a1', new Map([[0, 1]])) // 账本只画得出 1 个字 —— 还不够
    expect(textOf(water, 'a1')).toBe('好的')
    water.settle('a1', new Map([[0, 2]])) // 追平了
    expect(water.parts('a1')).toHaveLength(0)
  })

  it('账本没提到的段不动(它还没结算)', () => {
    const water = new StreamWater()
    water.feed(stamp({ partIndex: 7, charOffset: 0 }), '还没结算')
    water.settle('a1', new Map([[0, 99]]))
    expect(textOf(water, 'a1', 7)).toBe('还没结算')
  })

  it('清光了整条消息也一起丢(不留空壳)', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好的')
    water.settle('a1', new Map([[0, 2]]))
    expect(water.version('a1')).toBe(0)
  })

  it('收尾整条丢', () => {
    const water = new StreamWater()
    water.feed(stamp({ charOffset: 0 }), '好的')
    water.clearMessage('a1')
    expect(water.parts('a1')).toHaveLength(0)
  })
})
