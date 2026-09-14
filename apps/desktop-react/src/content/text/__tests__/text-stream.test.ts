import { describe, expect, it } from 'vitest'
import { FORCE_CUT_FLOOR, TAIL_LIMIT, TextStream, stableTextCut } from '../text-stream'

/**
 * `TextStream` 的单测 —— **纯机制,jsdom 都不用起**。
 *
 * 这一层验的是正本 `docs/thinking-stream-2026-09.md` §2 那四条切点规则,以及那句
 * 让整件事成立的话:**冻住的块跨帧是同一个实例**。屏幕那一端由
 * `content/__tests__/thinking-segment.test.tsx` 钉。
 */

/** 造一段没有换行的字(强切那几条用它)。 */
const run = (n: number, ch = 'x') => ch.repeat(n)

describe('冻住的块:同一个实例,不是等值的新对象', () => {
  it('前缀块跨帧全等(toBe)—— memo 那一层的全部依据', () => {
    const stream = new TextStream()
    const a = stream.frame('m#0', '第一行\n第二行\n还在写', true)
    const b = stream.frame('m#0', '第一行\n第二行\n还在写一点', true)
    const c = stream.frame('m#0', '第一行\n第二行\n还在写一点点\n第四行\n尾', true)

    expect(a.blocks).toHaveLength(1)
    expect(a.blocks[0]!.text).toBe('第一行\n第二行\n')
    // 同一个对象 —— 不是 toEqual,是 toBe。
    expect(b.blocks[0]).toBe(a.blocks[0])
    expect(c.blocks[0]).toBe(a.blocks[0])
    // 后来才冻住的那一块也一样:一冻住就再不换实例。
    expect(c.blocks).toHaveLength(2)
    expect(stream.frame('m#0', '第一行\n第二行\n还在写一点点\n第四行\n尾巴', true).blocks[1]).toBe(
      c.blocks[1],
    )
  })

  it('块 id 由 frameId + 序号派生,冻住后永不变', () => {
    const stream = new TextStream()
    stream.frame('m#2', 'a\n', true)
    const frame = stream.frame('m#2', 'a\nb\nc', true)
    expect(frame.blocks.map((b) => b.id)).toEqual(['m#2#0', 'm#2#1'])
  })

  it('块与尾首尾相接,一个字符不丢 —— 拼起来逐字等于原文', () => {
    const stream = new TextStream()
    const text = 'a\nbb\nccc\ndddd'
    stream.frame('m#0', 'a\nbb\n', true)
    const frame = stream.frame('m#0', text, true)
    expect(frame.blocks.map((b) => b.text).join('') + frame.tail).toBe(text)
  })
})

describe('切点:只往前,不回退', () => {
  it('候选是最后一个换行的后一位', () => {
    expect(stableTextCut('abc\ndef', 0)).toBe(4)
    expect(stableTextCut('abc\ndef\n', 0)).toBe(8)
    expect(stableTextCut('没有换行', 0)).toBe(0)
  })

  it('最后一个换行在 prevCut 之前时原地不动(返回值 ≤ 入参 = 这一步不推进)', () => {
    expect(stableTextCut('abc\ndef', 4)).toBe(4)
  })

  it('逐帧追加,切点单调不减', () => {
    const stream = new TextStream()
    const full = '一行\n二行\n三行\n四行\n五行\n六行'
    let last = -1
    for (let i = 1; i <= full.length; i += 1) {
      const { cut } = stream.frame('m#0', full.slice(0, i), true)
      expect(cut).toBeGreaterThanOrEqual(last)
      last = cut
    }
  })
})

describe('活动尾的上限:代价由一个数钉死', () => {
  it('一整段没有空白的长 token —— 在 4,000 处硬切', () => {
    const stream = new TextStream()
    const { blocks, tail } = stream.frame('m#0', run(TAIL_LIMIT + 500), true)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.text).toHaveLength(TAIL_LIMIT)
    expect(tail).toHaveLength(500)
  })

  it('2,000 之后第一个空白处落刀,空白算进前面那一块', () => {
    // 2,500 处放一个空格,其余全是不可断的字。
    const text = `${run(2500)} ${run(2500)}`
    const { blocks, tail } = new TextStream().frame('m#0', text, true)
    expect(blocks[0]!.text).toHaveLength(2501)
    expect(blocks[0]!.text.endsWith(' ')).toBe(true)
    expect(blocks.map((b) => b.text).join('') + tail).toBe(text)
  })

  it('落刀不会落在 FORCE_CUT_FLOOR 之前(刚开头的尾不切碎)', () => {
    // 每 10 个字一个空格:2,000 之前有几百个空白,一个都不许用。
    const text = `${'0123456789 '.repeat(500)}`
    const { blocks } = new TextStream().frame('m#0', text, true)
    expect(blocks[0]!.text.length).toBeGreaterThan(FORCE_CUT_FLOOR)
  })

  it('随机追加 1000 轮:活动尾恒 ≤ 4,000,拼起来恒等于原文', () => {
    const stream = new TextStream()
    // 确定性伪随机(xorshift):fuzz 要能复现,不然红了也查不动。
    let seed = 0x2026_0914
    const rand = () => {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed) / 0x7fff_ffff
    }
    let text = ''
    /*
     * **故意造长段不换行的连跑**:随手掷骰子的话每三四轮就来一个换行,切点自己就
     * 跟上了,规则 ③ 一次都走不到 —— 那样的 fuzz 是绿的谎话(第一版真这样,拆掉
     * 强切它照样全绿)。所以这里让「不换行」成段成段地来,并且在末尾自证:
     * 这一跑里真的出现过 > 4,000 字的无换行后缀。
     */
    let streak = 0
    let longestRun = 0
    for (let i = 0; i < 1000; i += 1) {
      if (streak === 0 && rand() < 0.15) streak = 30
      const n = 1 + Math.floor(rand() * 400)
      const alphabet = streak > 0 ? (rand() < 0.5 ? '甲乙丙丁' : 'abcdef ') : 'abcde\n'
      if (streak > 0) streak -= 1
      let chunk = ''
      for (let k = 0; k < n; k += 1) chunk += alphabet[Math.floor(rand() * alphabet.length)]
      text += chunk

      const sinceNewline = text.length - (text.lastIndexOf('\n') + 1)
      longestRun = Math.max(longestRun, sinceNewline)

      const frame = stream.frame('m#0', text, true)
      expect(frame.tail.length).toBeLessThanOrEqual(TAIL_LIMIT)
      expect(frame.blocks.map((b) => b.text).join('') + frame.tail).toBe(text)
    }
    // 这一跑真的踩到了规则 ③(不然上面那条断言是空过的)。
    expect(longestRun).toBeGreaterThan(TAIL_LIMIT)
    expect(text.length).toBeGreaterThan(50_000)
  })
})

describe('live=false:全冻', () => {
  it('尾清空,余下的整段变成最后一块', () => {
    const stream = new TextStream()
    const live = stream.frame('m#0', 'a\nb\nc 还在写', true)
    expect(live.tail).toBe('c 还在写')
    // 收尾那一帧是**追加**(流只会往后长),不是换一份文本。
    const done = stream.frame('m#0', 'a\nb\nc 还在写,写完了', false)
    expect(done.tail).toBe('')
    expect(done.cut).toBe('a\nb\nc 还在写,写完了'.length)
    expect(done.blocks.map((b) => b.text).join('')).toBe('a\nb\nc 还在写,写完了')
    // 冻住那一刻**已经画好的块一个不动** —— 换身份就是 React 重挂。
    expect(done.blocks[0]).toBe(live.blocks[0])
  })

  it('从没流过的一份(冷载历史)冻出来是一块', () => {
    const { blocks, tail } = new TextStream().frame('m#0', `${run(10_000)}\n还有`, false)
    expect(blocks).toHaveLength(1)
    expect(tail).toBe('')
  })
})

describe('forget', () => {
  it('丢账之后从 0 起(块 id 也从 #0 重新来)', () => {
    const stream = new TextStream()
    stream.frame('m#0', 'a\nb\nc', true)
    stream.forget('m#0')
    const frame = stream.frame('m#0', 'a\nb\nc', true)
    expect(frame.blocks).toHaveLength(1)
    expect(frame.blocks[0]!.id).toBe('m#0#0')
    expect(frame.blocks[0]!.text).toBe('a\nb\n')
  })

  it('reset 是唯一那一口拆卸:整份丢掉', () => {
    const stream = new TextStream()
    stream.frame('a', 'x\ny', true)
    stream.frame('b', 'x\ny', true)
    stream.reset()
    expect(stream.frame('a', 'x\ny', true).blocks[0]!.id).toBe('a#0')
  })

  it('新文本不以旧文本开头(重试换了内容)= 换了一条流,从 0 重来', () => {
    const stream = new TextStream()
    const first = stream.frame('m#0', '旧的\n内容', true)
    const second = stream.frame('m#0', '全新\n的内容', true)
    expect(second.blocks[0]).not.toBe(first.blocks[0])
    expect(second.blocks[0]!.text).toBe('全新\n')
  })
})
