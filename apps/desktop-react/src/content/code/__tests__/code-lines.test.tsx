import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CodeLines, sourceCodeLines, splitLines, type CodeLine } from '../CodeLines'

/**
 * 「行」渲染基础件的规格书(2026-09-13 批 ①)。
 *
 * 分两半:**行为**这一半按 DOM 验(三档行号、加删、当前行、两口 `data-*`、跳渲),
 * **三条硬规矩**那一半只能按样式源文本守 —— jsdom 不排版,`sticky` 与
 * `max-content` 在这里都是死字符串。守字面的代价是它挡不住「写了但写错了」,
 * 所以那三条同时有真机截图对照兜着(批 ① 的像素差报表)。
 */

const LINES: CodeLine[] = [
  { text: 'const a = 1', oldNo: 10, newNo: 10 },
  { text: 'const b = 2', newNo: 11, mark: 'add' },
  { text: 'const c = 3', oldNo: 11, mark: 'del' },
]

function draw(ui: React.ReactElement) {
  const { container } = render(ui)
  const pre = container.querySelector('pre')!
  return { container, pre, rows: Array.from(pre.querySelectorAll('code > span')) }
}

describe('三档行号', () => {
  it('none:根上不带行号档的类,行上没有号可读', () => {
    const { pre, rows } = draw(<CodeLines lines={LINES} numbers="none" />)
    expect(pre.className).not.toContain('numSingle')
    expect(pre.className).not.toContain('numBoth')
    // 号仍然挂在行上(它是数据),画不画由根上那个档说了算 —— 这正是同一串行
    // 能同时喂给三个宿主的原因。
    expect(rows[0].getAttribute('data-new-no')).toBe('10')
  })

  it('single:根上是 numSingle', () => {
    const { pre } = draw(<CodeLines lines={LINES} numbers="single" />)
    expect(pre.className).toContain('numSingle')
    expect(pre.className).not.toContain('numBoth')
  })

  it('both:根上是 numBoth,两列各读各的属性', () => {
    const { pre, rows } = draw(<CodeLines lines={LINES} numbers="both" />)
    expect(pre.className).toContain('numBoth')
    expect(rows[0].getAttribute('data-old-no')).toBe('10')
    expect(rows[0].getAttribute('data-new-no')).toBe('10')
    // 新增行**没有旧行号** —— 属性整个不在,`attr()` 读出来是空串。计数器表达不了
    // 这件事,这就是行号走数据而不走 CSS counter 的理由。
    expect(rows[1].hasAttribute('data-old-no')).toBe(false)
    expect(rows[2].hasAttribute('data-new-no')).toBe(false)
  })
})

describe('加删 / 当前行', () => {
  it('mark 落在行的类上,未改的行一个状态类都不带', () => {
    const { rows } = draw(<CodeLines lines={LINES} numbers="both" />)
    expect(rows[0].className).not.toContain('lineAdd')
    expect(rows[0].className).not.toContain('lineDel')
    expect(rows[1].className).toContain('lineAdd')
    expect(rows[2].className).toContain('lineDel')
  })

  it('当前行按 newNo 认,而且全列只有一行带 data-current', () => {
    const { pre, rows } = draw(<CodeLines lines={LINES} numbers="single" currentLine={11} />)
    expect(rows[1].getAttribute('data-current')).toBe('true')
    expect(pre.querySelectorAll('[data-current="true"]')).toHaveLength(1)
  })

  it('当前行那一格标记位只在宿主认当前行时留 —— 没有它的宿主不许被挪两像素', () => {
    // 递了数(哪怕 0)= 这个宿主认当前行;一个字没递 = 连位子都不留。
    expect(draw(<CodeLines lines={LINES} numbers="single" currentLine={0} />).pre.className).toContain('marksCurrent')
    expect(draw(<CodeLines lines={LINES} numbers="none" />).pre.className).not.toContain('marksCurrent')
  })

  it('没落过点(0 / 缺席)时没有当前行 —— 0 不是任何一行的号', () => {
    const { pre } = draw(<CodeLines lines={LINES} numbers="single" currentLine={0} />)
    expect(pre.querySelectorAll('[data-current="true"]')).toHaveLength(0)
  })
})

describe('加删符号列', () => {
  it('signs 关着时一格都不画(聊天里那块代码没有 mark,也不该多一列)', () => {
    const { rows } = draw(<CodeLines lines={LINES} numbers="both" />)
    expect(rows.some((el) => el.querySelector('[class*="sign"]'))).toBe(false)
  })

  it('signs 开着时逐行一格:加 + / 删 −(真减号)/ 未改是空格', () => {
    const { rows } = draw(<CodeLines lines={LINES} numbers="both" signs />)
    expect(rows.map((el) => el.querySelector('[class*="sign"]')?.textContent)).toEqual([
      ' ',
      '+',
      '\u2212',
    ])
  })

  it('未改那一格是空格不是空串 —— 它撑住那一列,加删行与未改行的正文起笔同线', () => {
    const { rows } = draw(<CodeLines lines={[{ text: 'x' }]} numbers="none" signs />)
    expect(rows[0].querySelector('[class*="sign"]')?.textContent).toBe(' ')
  })
})

describe('宿主的两口 data-*', () => {
  it('testId / rootAttrs 落在根上,rowAttrs 逐行落', () => {
    const { pre, rows } = draw(
      <CodeLines
        lines={LINES}
        numbers="single"
        testId="host-code"
        rootAttrs={{ 'data-host-lines': '3', 'data-host-skip': undefined }}
        rowAttrs={(_line, index) => ({ 'data-line': String(index + 1) })}
      />,
    )
    expect(pre.getAttribute('data-testid')).toBe('host-code')
    expect(pre.getAttribute('data-host-lines')).toBe('3')
    // undefined = 这一格不在场,不是空字符串(查看器的 data-viewer-skip 靠它)。
    expect(pre.hasAttribute('data-host-skip')).toBe(false)
    expect(rows.map((el) => el.getAttribute('data-line'))).toEqual(['1', '2', '3'])
  })

  it('一行的 textContent 就是那一行代码 —— 行号一个数字都不进 DOM 文本', () => {
    const { rows } = draw(<CodeLines lines={LINES} numbers="both" />)
    expect(rows.map((el) => el.textContent)).toEqual(['const a = 1', 'const b = 2', 'const c = 3'])
  })

  it('token 在场时画成带色 span,不在场时画素文本(两条路上行元素一模一样)', () => {
    const tokens = [
      { content: 'const', color: '#111', offset: 0 },
      { content: ' a', color: '#222', offset: 5 },
    ]
    const { rows } = draw(
      <CodeLines lines={[{ text: 'const a', tokens }, { text: 'plain' }]} numbers="none" />,
    )
    expect(rows[0].querySelectorAll('span[style]')).toHaveLength(2)
    expect(rows[0].textContent).toBe('const a')
    expect(rows[1].querySelectorAll('span[style]')).toHaveLength(0)
    expect(rows[1].textContent).toBe('plain')
  })
})

describe('跳渲与折行', () => {
  it('skip 打开时逐行挂 lineSkip,关着时一行都不挂', () => {
    expect(draw(<CodeLines lines={LINES} numbers="single" skip />).rows.every((el) =>
      el.className.includes('lineSkip'),
    )).toBe(true)
    expect(draw(<CodeLines lines={LINES} numbers="single" />).rows.some((el) =>
      el.className.includes('lineSkip'),
    )).toBe(false)
  })

  it('wrap 打开时根上多一格 rootWrap', () => {
    expect(draw(<CodeLines lines={LINES} numbers="single" wrap />).pre.className).toContain('rootWrap')
    expect(draw(<CodeLines lines={LINES} numbers="single" />).pre.className).not.toContain('rootWrap')
  })
})

describe('切行', () => {
  it('尾随换行切出来那个空段丢掉,中间的空行留着', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('')).toEqual([''])
  })

  it('sourceCodeLines 逐行编号,高亮缺席就只有文本', () => {
    expect(sourceCodeLines('a\nb\n')).toEqual([
      { text: 'a', newNo: 1 },
      { text: 'b', newNo: 2 },
    ])
    const withTokens = sourceCodeLines('a\nb', [[{ content: 'a', color: '#1', offset: 0 }]])
    expect(withTokens[0].tokens).toBeTruthy()
    expect(withTokens[1].tokens).toBeUndefined()
  })
})

describe('三条硬规矩(样式源文本)', () => {
  /** 读样式表的门先剥注释 —— 病历文本里也写着这些词,会让断言自红。 */
  const css = readFileSync(
    resolve(process.cwd(), 'src/content/code/CodeLines.module.css'),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  const block = (selector: string) => {
    const at = css.indexOf(selector)
    expect(at, `${selector} 不在样式表里`).toBeGreaterThan(-1)
    return css.slice(at, css.indexOf('}', at))
  }

  it('①横滚纪律:根按内容定宽,折行档退回 0', () => {
    expect(block('.root {')).toContain('min-width: max-content;')
    expect(block('.rootWrap {')).toContain('min-width: 0;')
  })

  it('①横滚纪律:行号列粘在左缘,而且带着自己那一行的底色', () => {
    const gutter = block('.numSingle .line::before,')
    expect(gutter).toContain('position: sticky;')
    // 不透明的一层(横滚时代码从底下穿过)+ 与行同源的那一层色。
    expect(gutter).toContain('background-color: var(--code-face);')
    expect(gutter).toContain('var(--code-row-tint, transparent)')
    expect(block('.numSingle .line::before {')).toContain('left: 0;')
  })

  it('那一格标记位跟着行号列走,而且行本身不带边', () => {
    expect(block('.line {')).not.toContain('border-left')
    const gutterMark = block('.marksCurrent.numSingle .line::before,')
    expect(gutterMark).toContain('border-left: var(--bw-3) solid transparent;')
    // 补回那 2px,数字与正文的起笔线才一个像素没动。
    expect(gutterMark).toContain('width: calc(var(--code-num-w) + var(--bw-3));')
    expect(block(".marksCurrent .line[data-current='true']::before {")).toContain(
      'border-left-color: var(--accent);',
    )
  })

  it('往左多铺的那一段是**投影**,不进布局,而且只给最左边那一列', () => {
    // 共用的几何那条里没有投影 —— 它在自己那条专门的选择器表上。
    expect(block('.numSingle .line::before,\n.numBoth .line::before,\n.numBoth .line::after {'))
      .not.toContain('box-shadow')
    const bleed = block(
      ".numSingle .line::before,\n.numBoth .line::before,\n.root:not(.numSingle):not(.numBoth) .sign {",
    )
    expect(bleed).toContain('box-shadow:')
    expect(bleed).toContain('calc(var(--code-gutter-bleed) * -1)')
    // 进布局的那两种写法都试过、都被真机打回(判词在样式表里)。
    expect(bleed).not.toContain('margin-left')
    expect(bleed).not.toContain('padding-left')
    // 第二列**不许**有:它的投影会盖住第一列的数字(批 ② 真机截图)。
    expect(bleed).not.toContain('.numBoth .line::after')
  })

  it('②整数行高:行高与最小高读同一个 token,对齐不用 baseline', () => {
    expect(block('.root {')).toContain('line-height: var(--code-line-h);')
    const line = block('.line {')
    expect(line).toContain('min-height: var(--code-line-h);')
    expect(line).toContain('align-items: stretch;')
    expect(line).not.toContain('baseline')
  })

  it('③跳过屏外行:逐行 content-visibility,估高读的是那个整数行高', () => {
    const skip = block('.lineSkip {')
    expect(skip).toContain('content-visibility: auto;')
    expect(skip).toContain('contain-intrinsic-block-size: auto var(--code-line-h);')
  })

  it('两列档下第二列粘住的位子跟着第一列的宽走(不然一贴边两列就叠上)', () => {
    // 正则而不是 `block()`:`.numBoth .line::after {` 在共用的几何那条选择器表里
    // 也出现一次(它是表的最后一行),按首次命中取会取到那一条。
    expect(css).toMatch(
      /\.numBoth \.line::after \{[^}]*left: calc\(var\(--code-mark-w\) \+ var\(--code-num-w\) \+ var\(--sp-1\)\);/,
    )
    // 标记位那一格宽由 `--code-mark-w` 说(缺省 0,`marksCurrent` 抬成 --bw-3)——
    // 所以第二列的落点只有**一处**产地,不必为「有没有标记位」再写一条覆盖。
    expect(block('.marksCurrent {')).toContain('--code-mark-w: var(--bw-3);')
  })

  it('符号列也粘在左缘,落点是它左边那些列的总宽(一处产地)', () => {
    const sign = block('\n.sign {')
    expect(sign).toContain('position: sticky;')
    expect(sign).toContain('left: var(--code-gutter-w);')
    // 底色两层与行号列同一条:不透明那一层是横滚时正文从底下穿过去的必需品。
    expect(sign).toContain('background-color: var(--code-face);')
    expect(sign).toContain('var(--code-row-tint, transparent)')
    // 满饱和色只上在符号身上,不上在整行文字上(行底只有 12%)。
    expect(block('.lineAdd .sign {')).toContain('color: var(--ok);')
    expect(block('.lineDel .sign {')).toContain('color: var(--danger);')
  })

  it('组件文件里零字面 px / 色值 —— 量全在 tokens.css', () => {
    expect(css).not.toMatch(/:\s*-?\d+px/)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/\brgba?\(/)
  })
})
