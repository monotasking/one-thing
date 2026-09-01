import { describe, expect, it } from 'vitest'
import { MarkdownStream, parseFrame, PARSE_INTERVAL_MS } from '../incremental'
import { stableCut } from '../stable-cut'
import { blockKey } from '../../assemble/key'

/**
 * 流式契约的单测(§6)。四件事各有各的用例:
 *  ① 未闭合围栏三态(没闭合 / 闭合那一刻 / 闭合之后)
 *  ② 正在长的表:成表就画表,表头+半截分隔行时补齐分隔行提前认
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

/**
 * ── 表:**从它成为表的那一刻起,屏幕上就是表**(09-01 用户复测报障 + 录屏)────
 *
 * 从前这里是「未闭合的原子块按 code 显示」,退出条件 `text.endsWith('\n')`。
 * 那条件是掷骰子:一帧的文本结不结束在换行上,由 provider 的分片与 coalescer 的
 * 批次说了算。真机录屏逐帧(七列八行):2.3s 起整张表**全程是代码块**,一次都没
 * 掷中,直到 run 收尾才换成表。所以整条降级撤了(连同它的单向闸),换成两条:
 *  · 解析成表就画表;
 *  · 表头 + 半截分隔行时**把分隔行补齐**再解析,提前一步认出它(table-tail.ts)。
 */
describe('正在长的表:画表,不画源码', () => {
  it('分隔行一到齐就是表(不再按 code 逐行长)', () => {
    const s = stream()
    const growing = s.parse('m', '| a | b |\n|---|---|\n| 1 | 2', true)
    expect(growing.blocks[0]).toMatchObject({ kind: 'table' })

    const settled = s.parse('m', '| a | b |\n|---|---|\n| 1 | 2 |\n', true)
    expect(settled.blocks[0]).toMatchObject({ kind: 'table' })
    expect(settled.offsets).toEqual(growing.offsets)
  })

  it('图源码走的是另一条:围栏路由判,没闭合按 code,闭合后是 figure', () => {
    const s = stream()
    expect(s.parse('m', '```mermaid\ngraph TD', true).blocks[0]).toMatchObject({ kind: 'code' })
    expect(s.parse('m', '```mermaid\ngraph TD\n```', true).blocks[0]).toMatchObject({
      kind: 'figure',
      figKind: 'mermaid',
    })
  })

  /*
   * 逐帧喂真机那种节拍(一次几个字符,行末与行中都踩到):**一帧都不许是源码**。
   * 修前这条会红在一大片 —— 降级判据每行翻一次面,而真机上它一次都没翻回来。
   */
  it('整条流里一帧都没有把表画成源码', () => {
    const source = '| 项 | 状态 |\n|---|---|\n| 甲 | 真 |\n| 乙 | 假 |\n| 丙 | 真 |\n'
    const s = stream()
    const kinds: string[] = []
    for (let i = 3; i <= source.length; i += 3) {
      const block = s.parse('m', source.slice(0, i), true).blocks.at(-1)
      if (block) kinds.push(block.kind)
    }
    expect(kinds).not.toContain('code')
    expect(kinds.at(-1)).toBe('table')
  })

  it('表头 + 半截分隔行:补齐分隔行,提前认出这张表(列数按表头)', () => {
    const s = stream()
    const frame = s.parse('m', '| 书名 | 作者 | 分类 | 出版社 |\n|---', true)
    const block = frame.blocks.at(-1)
    expect(block).toMatchObject({ kind: 'table' })
    // 列数**按表头**,不是按已经收到的那半截分隔行。
    expect((block as { head: unknown[] }).head).toHaveLength(4)
  })

  it('补出来的字一个都不上屏:块的起点仍是表头那一行', () => {
    const s = stream()
    const frame = s.parse('m', '正文一段。\n\n| a | b |\n|-', true)
    expect(frame.blocks.map((b) => b.kind)).toEqual(['paragraph', 'table'])
    expect(frame.offsets[1]).toBe('正文一段。\n\n'.length)
  })

  it('不流了就不补 —— 落定的文本是什么就是什么(流式与冷加载同一条路)', () => {
    const s = stream()
    expect(s.parse('m', '| a | b |\n|-', false).blocks.at(-1)).toMatchObject({ kind: 'paragraph' })
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

/**
 * ── 表的**一路**:裸段落 → 表,一次,不回头(09-01 用户复测报障)────────────
 *
 * 这一条钉的是整条轨迹,不是某一帧的形。真机 2 字/帧喂十三列宽表时,第一版补齐
 * 规则在「半格只有冒号」那两个字符上造出一格非法分隔符,轨迹是
 * `p → table → p → table → …` 翻了十次 —— 屏幕上表格一闪一闪。
 */
describe('表的一路:裸段落 → 表,一次,不回头', () => {
  const HEAD = '| 项目 | 负责人 | 阶段 | 开始 | 结束 | 工时 | 进度 | 风险 | 优先级 | 依赖 | 状态 | 备注 | 验收 |'
  const SEP = '| :---: | :---: | :---: | :---: | :---: | :---: | ---: | :--- | :---: | :---: | :---: | :--- | :---: |'
  const ROW = '| 排期一 | 甲乙 | 设计 | 09-01 | 09-11 | 10 | 10% | 低 | P1 | 无 | 进行中 | 说明 | 待验 |'
  // 正文与表头之间**故意不空行** —— 模型的常见形,GFM 允许表打断段落。
  const SOURCE = `下面是排期表。\n${HEAD}\n${SEP}\n${ROW}\n${ROW}\n`

  /** 逐 N 字喂,记下最后一块的块型轨迹(相邻相同的合并)。 */
  function trail(step: number): string[] {
    const s = stream()
    const out: string[] = []
    for (let i = step; i <= SOURCE.length; i += step) {
      const kind = s.parse('m', SOURCE.slice(0, i), true).blocks.at(-1)?.kind
      if (kind && kind !== out.at(-1)) out.push(kind)
    }
    return out
  }

  it('2 字/帧:paragraph → table,就这两段', () => {
    expect(trail(2)).toEqual(['paragraph', 'table'])
  })

  it('6 字/帧同一条轨迹(粒度不改变形)', () => {
    expect(trail(6)).toEqual(['paragraph', 'table'])
  })

  it('一帧都没有 code —— 表不许以源码示人', () => {
    expect(trail(2)).not.toContain('code')
    expect(trail(6)).not.toContain('code')
  })
})
