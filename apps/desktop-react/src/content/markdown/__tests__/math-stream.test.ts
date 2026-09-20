import { describe, expect, it } from 'vitest'
import { blockKey } from '../../assemble/key'
import { MarkdownStream, parseFrame, PARSE_INTERVAL_MS } from '../incremental'
import { parseMarkdown } from '../parse'
import { stableCut } from '../stable-cut'

/**
 * 公式进流式那一半(§6)。三件事:
 *  ① 稳定切点把数学围栏与代码围栏同等对待 —— 里面的空行不是块边界;
 *  ② 逐字符喂到底,末帧与一次性解析**逐字相等**(切点判据错一次,屏幕上就会出现
 *    一份与最终结果不同的东西);
 *  ③ 「贴尾巴」那条快路遇到 `$` / `\` 退回真解析 —— 它们会改掉末块的行内结构。
 */

/** 拨得动的钟(与 incremental.test.ts 同一只)。默认每帧跳一大步,先把节流让开。 */
function stream(step = 1000) {
  let now = 0
  return new MarkdownStream(() => {
    now += step
    return now
  })
}

function keys(frame: { blocks: { kind: string }[]; offsets: readonly number[] }) {
  return frame.blocks.map((block, index) =>
    blockKey('seg', index, block as never, frame.offsets[index]),
  )
}

const OPEN = String.raw`\[`
const CLOSE = String.raw`\]`

describe('稳定切点:数学围栏与代码围栏同等对待', () => {
  it('$$ 块里的空行不是块边界(切点不落进去)', () => {
    const text = '一段\n\n$$\n\nx\n\n$$\n\n尾'
    // 切点是最后那个「尾」的行首,不是公式里那两个空行之后的任何一处。
    expect(stableCut(text)).toBe(text.indexOf('尾'))
  })

  it('\\[ 开的块同理', () => {
    const text = `一段\n\n${OPEN}\n\nx\n\n${CLOSE}\n\n尾`
    expect(stableCut(text)).toBe(text.indexOf('尾'))
  })

  it('块闭合之后的空行照样切得动 —— 保守不等于从此不切', () => {
    const text = '$$\nx\n$$\n\n后面\n\n再后面'
    expect(stableCut(text)).toBe(text.indexOf('再后面'))
  })

  it('没收尾的 $$ 之后整篇不再切(它可能在任意远处被续上)', () => {
    expect(stableCut('一段\n\n$$\nx\n\ny')).toBe(0)
  })
})

describe('逐字符喂到底:末帧 == 一次性解析', () => {
  const MATERIAL = `前言一句\n\n${OPEN}\na^2 + b^2 = c^2\n${CLOSE}\n\n行内的 $E=mc^2$ 与 $$\nS=\\sum x\n$$\n\n收尾`

  it('每一帧都是某个前缀的合法解析,末帧与 parseFrame 逐字相等', () => {
    const s = stream()
    let frame = s.parse('m', '', true)
    for (let i = 1; i <= MATERIAL.length; i += 1) {
      frame = s.parse('m', MATERIAL.slice(0, i), true)
    }
    const settled = s.parse('m', MATERIAL, false)
    expect(settled.blocks).toEqual(parseFrame(MATERIAL).blocks)
    expect(frame.blocks).toEqual(settled.blocks)
  })

  it('公式块的身份号跨帧稳定 —— 从第一个 $$ 到收尾是同一个 key,不重挂', () => {
    const text = '$$\nE=mc^2\n$$'
    const s = stream()
    const opening = s.parse('m', '$$\n', true)
    const growing = s.parse('m', '$$\nE=mc', true)
    const closed = s.parse('m', text, true)

    // micromark 的 math flow 不等收尾就开块 —— 三帧都已经是 math(这正是注册契约里
    // `midway: 'grow'` / `settled: 'same'` 那两格的依据)。
    expect([opening, growing, closed].map((frame) => frame.blocks[0].kind)).toEqual([
      'math',
      'math',
      'math',
    ])
    expect(keys(growing)).toEqual(keys(opening))
    expect(keys(closed)).toEqual(keys(opening))
    expect(closed.blocks[0]).toMatchObject({ closed: true })
    expect(growing.blocks[0]).toMatchObject({ closed: false })
  })
})

describe('贴尾巴快路:遇 $ / \\ 退回真解析', () => {
  /** 节流窗之内的第二帧才会走贴尾巴那条路(见 incremental.ts 的 `appended`)。 */
  function inWindow() {
    let now = 0
    return new MarkdownStream(() => {
      now += PARSE_INTERVAL_MS - 1
      return now
    })
  }

  it('追加一个 $ 把三个字符变成一个公式 —— 贴出来会说谎,所以不贴', () => {
    const s = inWindow()
    s.parse('m', '设 $a^2', true)
    const frame = s.parse('m', '设 $a^2$', true)
    // 贴尾巴那条路只会把 `$` 接到末尾的文字节点上;真解析给的是一个 math 节点。
    expect(frame.blocks[0]).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: '设 ' }, { type: 'math', tex: 'a^2' }],
    })
  })

  it('追加一个 \\ 可能是 \\( 的头半截,同样退回真解析', () => {
    const s = inWindow()
    s.parse('m', '见 ', true)
    const frame = s.parse('m', String.raw`见 \(x\)`, true)
    expect(frame.blocks[0]).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: '见 ' }, { type: 'math', tex: 'x' }],
    })
  })

  it('反证:不含 $ / \\ 的追加照旧走快路(这条法没有把快路整个关掉)', () => {
    const s = inWindow()
    const before = s.parse('m', '一段话', true)
    const after = s.parse('m', '一段话继续', true)
    expect(after.blocks[0]).toEqual({
      kind: 'paragraph',
      inline: [{ type: 'text', text: '一段话继续' }],
    })
    expect(keys(after)).toEqual(keys(before))
  })
})

describe('重解析的尾巴与全量同结果', () => {
  it('切点之后重解析:一段公式跨在切点后面也对得上', () => {
    const text = `落定的一段\n\n${OPEN}\nx\n${CLOSE}\n\n还在长的一段`
    const s = stream()
    s.parse('m', text.slice(0, text.indexOf(OPEN)), true)
    const frame = s.parse('m', text, true)
    expect(frame.blocks).toEqual(parseMarkdown(text).map((entry) => entry.block))
  })
})
