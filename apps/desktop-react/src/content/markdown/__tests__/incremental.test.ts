import { describe, expect, it } from 'vitest'
import { MarkdownStream, parseFrame, PARSE_INTERVAL_MS } from '../incremental'
import { stableCut } from '../stable-cut'
import { blockKey } from '../../assemble/key'

/**
 * 流式契约的单测(§6)。四件事各有各的用例:
 *  ① 未闭合围栏三态(没闭合 / 闭合那一刻 / 闭合之后)
 *  ② 未闭合的 table / figure 按 code 显示,闭合原位换装
 *  ③ **key 逐字相等** —— 这是硬约束,不是整洁癖(见 assemble/key.ts 的头注)
 *  ④ 增量与全量**永远同结果**:切点判据错一次,屏幕上就会出现一份与最终结果不同的东西
 */

/** 拨得动的钟:节流窗要能测。默认每帧跳一大步,先把节流让开。 */
function stream(step = 1000) {
  let now = 0
  const s = new MarkdownStream(() => {
    now += step
    return now
  })
  return s
}

/** 一份帧的 key 列表 —— 屏幕上 React 看到的就是这些。 */
function keys(frame: { blocks: { kind: string }[]; offsets: readonly number[] }) {
  return frame.blocks.map((block, index) =>
    blockKey('seg', index, block as never, frame.offsets[index]),
  )
}

describe('未闭合围栏三态', () => {
  it('没闭合 → code(closed:false),逐行长出来', () => {
    const s = stream()
    const a = s.parse('m', '```ts\nconst a = 1', true)
    expect(a.blocks).toEqual([{ kind: 'code', lang: 'ts', source: 'const a = 1', closed: false }])

    const b = s.parse('m', '```ts\nconst a = 1\nconst b = 2', true)
    expect(b.blocks[0]).toMatchObject({ closed: false, source: 'const a = 1\nconst b = 2' })
  })

  it('闭合那一刻 → closed:true,块的 key 不变(原位换装,不重挂)', () => {
    const s = stream()
    const open = s.parse('m', '```ts\nconst a = 1\n', true)
    const closed = s.parse('m', '```ts\nconst a = 1\n```', true)
    expect(open.blocks[0]).toMatchObject({ closed: false })
    expect(closed.blocks[0]).toMatchObject({ closed: true })
    expect(keys(closed)).toEqual(keys(open))
  })

  it('闭合之后再追加正文,代码块整块不动', () => {
    const s = stream()
    const before = s.parse('m', '```ts\nx\n```', true)
    const after = s.parse('m', '```ts\nx\n```\n\n后面一段话', true)
    expect(after.blocks[0]).toEqual(before.blocks[0])
    expect(keys(after)[0]).toBe(keys(before)[0])
  })
})

describe('未闭合的原子块按 code 显示,闭合原位换装', () => {
  it('正在长的表按 code 逐行长,落定后换成 table —— 起点没变,所以是原位', () => {
    const s = stream()
    const growing = s.parse('m', '| a | b |\n|---|---|\n| 1 | 2', true)
    expect(growing.blocks[0]).toMatchObject({ kind: 'code', closed: false })

    const settled = s.parse('m', '| a | b |\n|---|---|\n| 1 | 2 |\n', true)
    expect(settled.blocks[0]).toMatchObject({ kind: 'table' })
    expect(settled.offsets).toEqual(growing.offsets)
  })

  it('图源码同理,但判据在围栏路由那一处:没闭合按 code,闭合后是 figure', () => {
    const s = stream()
    expect(s.parse('m', '```mermaid\ngraph TD', true).blocks[0]).toMatchObject({ kind: 'code' })
    expect(s.parse('m', '```mermaid\ngraph TD\n```', true).blocks[0]).toMatchObject({
      kind: 'figure',
      figKind: 'mermaid',
    })
  })

  it('不流了就不再按 code 兜 —— 判据是「还在长」,不是「最后一块是表」', () => {
    const s = stream()
    expect(s.parse('m', '| a |\n|---|\n| 1 |', false).blocks[0]).toMatchObject({ kind: 'table' })
  })
})

describe('key 稳定性:同源重解析逐字相等', () => {
  it('一段正文按帧长出来,前缀的 key 每一帧都不变', () => {
    const full = '开头一段\n\n```ts\nconst a = 1\n```\n\n结尾一段'
    const s = stream()
    let prev: string[] = []
    for (let i = 1; i <= full.length; i += 1) {
      const frame = s.parse('m', full.slice(0, i), true)
      const now = keys(frame)
      // 前缀逐字相等 = React 只打补丁,不重挂(块换型的那一格除外,那本来就该重挂)。
      const shared = Math.min(prev.length, now.length)
      for (let k = 0; k < shared; k += 1) {
        if (prev[k] !== now[k]) {
          // 唯一允许变的是**块型**(未闭合围栏闭合的那一下),起点必须仍然相同。
          expect(prev[k].split(':')[0]).toBe(now[k].split(':')[0])
        }
      }
      prev = now
    }
  })

  it('key 只认源偏移,不认下标 —— 下标平移一格不会换 key', () => {
    const block = { kind: 'paragraph', inline: [] } as never
    // 同一个起点、不同下标 = 同一个块(这正是「前面长出一个新块」时发生的事)。
    expect(blockKey('seg', 5, block, 42)).toBe(blockKey('seg', 9, block, 42))
    // 不同起点 = 不同块,哪怕下标一样。
    expect(blockKey('seg', 0, block, 42)).not.toBe(blockKey('seg', 0, block, 7))
  })

  it('流式期间前面的块 key 一帧都没换过(尾巴一直在长)', () => {
    const s = stream()
    const head = keys(s.parse('m', '开头\n\n第二段', true))[0]
    for (const text of ['开头\n\n第二段落', '开头\n\n第二段落。\n\n第三段', '开头\n\n第二段落。\n\n第三段完']) {
      expect(keys(s.parse('m', text, true))[0]).toBe(head)
    }
  })
})

describe('增量 = 全量:切点错一次,屏幕就会说谎', () => {
  const SAMPLES = [
    '一段话\n\n第二段\n\n# 标题\n\n正文',
    '- a\n\n- b\n\n收尾',
    '> 引用\n\n> 还是引用\n\n正文',
    '| a | b |\n|---|---|\n| 1 | 2 |\n\n后面',
    '```ts\nconst a = 1\n```\n\n后面\n\n```py\nx = 1\n```',
    '正文\n\n    缩进代码\n\n正文二',
    '<div>\n\n</div>\n\n正文',
    '[^1]: 脚注\n\n    还是脚注\n\n正文',
    '1. a\n\n2. b\n\n正文',
    // 08-31 真机报障那一段的骨架:段落 → `---` → 标题 → 有序列表。
    '一段话\n\n---\n\n## 标题\n\n1. 第一步',
  ]

  it.each(SAMPLES)('按帧喂完整段,每一帧都与全量解析同结果:%j', (sample) => {
    const s = stream()
    for (let i = 1; i <= sample.length; i += 1) {
      const text = sample.slice(0, i)
      expect(s.parse('m', text, false)).toEqual(parseFrame(text))
    }
  })

  /*
   * 上面那条一次喂一个字符 —— 它**永远**踩不到下面这个坑,所以不能只有它。
   *
   * 病历(08-31 真机:`---` 一条横线整个不见了):切点从前是
   * `Math.min(stableCut(text), prev.text.length)`。`stableCut` 返回的必是行首,
   * 但 `prev.text.length` 是上一帧收到多少字符 —— 由网络分片决定,不是行首。
   * 一次喂一个字符时,新出现的安全切点必然 ≤ prev.text.length,min 取到的就是
   * 那个行首,坑被喂法本身盖住了;真机一帧来好几个字符,min 就会夹在**行中间**,
   * 于是 `---` 被劈成上一帧留下的 `-`(当时被解析成列表起手式)和这一帧的 `--`
   * (解析成一段字),分隔线整条蒸发。
   *
   * 所以这条门按**多字符帧**喂,而且把 2..8 每一种块长都走一遍 —— 坑的触发条件
   * 是「帧边界正好落在某个块的起手行中间」,块长不同,落点就不同。
   */
  it.each(SAMPLES)('多字符一帧(2..8 字/帧)同样与全量解析同结果:%j', (sample) => {
    for (let chunk = 2; chunk <= 8; chunk += 1) {
      const s = stream()
      for (let i = chunk; i < sample.length + chunk; i += chunk) {
        const text = sample.slice(0, Math.min(i, sample.length))
        expect(s.parse('m', text, false)).toEqual(parseFrame(text))
      }
    }
  })

  it('帧边界劈开 `---` 时,分隔线仍然是分隔线(不是空列表 + 一段 `--`)', () => {
    const md = '一段话\n\n---\n\n## 标题'
    const s = stream()
    // 这一帧的结尾正好停在 `---` 的第一个字符之后 —— 病历里的那一刀。
    s.parse('m', '一段话\n\n-', true)
    expect(s.parse('m', md, true).blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'divider',
      'heading',
    ])
  })

  it('切点只落在「空行 + 顶格 + 开的是不可续的新块」上', () => {
    // 列表 / 引用 / 表格能跨空行续上,所以它们之后一律不切。
    expect(stableCut('- a\n\n正文')).toBe(0)
    expect(stableCut('> q\n\n正文')).toBe(0)
    // 一段普通正文之后、下一段顶格开始 —— 这是安全的。
    expect(stableCut('一段\n\n二段')).toBe(4)
    // 围栏没闭合时,里面的空行不是边界。
    expect(stableCut('```\n\n还在围栏里')).toBe(0)
  })
})

describe('解析节流:每帧至多一次', () => {
  it('节流窗里不重解析,把追加的字符贴到未闭合围栏的尾巴上', () => {
    let now = 0
    let parses = 0
    const s = new MarkdownStream(() => now)
    const parse = (text: string) => {
      parses += 1
      return s.parse('m', text, true)
    }

    parse('```ts\nconst a')
    now += 1 // 还在 16ms 窗口里
    const spliced = parse('```ts\nconst a = 1')
    expect(spliced.blocks[0]).toMatchObject({ kind: 'code', source: 'const a = 1', closed: false })

    now += PARSE_INTERVAL_MS // 窗口过了,这一帧真解析
    expect(parse('```ts\nconst a = 1\n```').blocks[0]).toMatchObject({ closed: true })
    expect(parses).toBe(3)
  })

  it('追加里含空行 / 围栏起手式时不贴,当场退回真解析', () => {
    let now = 0
    const s = new MarkdownStream(() => now)
    s.parse('m', '一段', true)
    now += 1
    // 追加了一个空行 = 会开新块,贴尾巴会显示成一段 —— 所以这里必须退回真解析。
    expect(s.parse('m', '一段\n\n二段', true).blocks).toHaveLength(2)
  })

  it('不流了就把帧缓存丢掉 —— 历史消息由装配管线按引用 memo,不留第二份', () => {
    const s = stream()
    s.parse('m', '一段', true)
    s.forget('m')
    expect(s.parse('m', '一段', false)).toEqual(parseFrame('一段'))
  })
})
