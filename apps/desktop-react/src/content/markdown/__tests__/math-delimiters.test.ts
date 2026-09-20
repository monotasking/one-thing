import { describe, expect, it } from 'vitest'
import { normalizeMathDelimiters } from '../math-delimiters'

/**
 * 定界符归一的单测。
 *
 * 第一组是**性质**而不是例子:等长与前缀稳定这两条是整套源偏移体系的地基,它们
 * 不该靠「我想得到的那几个输入」来守。后面几组是那些判据各自的反证。
 */

/** 用得最多的那两个字面量,写成 raw 免得满屏反斜杠转义。 */
const OPEN = String.raw`\[`
const CLOSE = String.raw`\]`

describe('等长(源偏移的地基)', () => {
  const SAMPLES = [
    '',
    '普通一段话,没有任何反斜杠',
    String.raw`行内 \(a^2\) 公式`,
    String.raw`块 \[x\] 写在一行里`,
    `${OPEN}\nE=mc^2\n${CLOSE}`,
    '$$\nE=mc^2\n$$',
    String.raw`转义的 \\( 不是公式`,
    '`代码里的 \\(x\\)` 与外面的 \\(y\\)',
    '```\n' + String.raw`\(x\)` + '\n```',
    String.raw`没配上对的 \( 半截`,
    String.raw`中文 \(α+β\) 与 emoji 🙂 \(γ\)`,
    `混着\r\n换行 ${OPEN}x${CLOSE}`,
    `  ${OPEN}  \n  x\n  ${CLOSE}  `,
  ]

  for (const text of SAMPLES) {
    it(`逐字等长:${JSON.stringify(text.slice(0, 28))}`, () => {
      expect(normalizeMathDelimiters(text)).toHaveLength(text.length)
    })
  }

  it('换行一个不多一个不少(手动切行不许吃掉或补出 \\n)', () => {
    const text = `a\n\n${OPEN}\nx\n${CLOSE}\n\nb\n`
    const out = normalizeMathDelimiters(text)
    expect(out.split('\n')).toHaveLength(text.split('\n').length)
  })
})

describe('前缀稳定(流式的地基)', () => {
  /**
   * 「已完成的行的任意前缀,归一结果等于整体归一结果的同长前缀」。
   *
   * 这一条才是 `\[` **无条件**换成 `$$`(不等它的 `\]` 到)的理由:等配对意味着
   * 同一行在收到下文之后换一种译法,屏幕上就会出现一次回跳。
   */
  const WHOLE = `前言\n\n${OPEN}\na^2 + b^2\n${CLOSE}\n\n后记 ${String.raw`\(c\)`}`

  it('逐行前缀都对得上', () => {
    const full = normalizeMathDelimiters(WHOLE)
    let at = 0
    for (const line of WHOLE.split('\n')) {
      at += line.length
      expect(normalizeMathDelimiters(WHOLE.slice(0, at))).toBe(full.slice(0, at))
      at += 1 // 那个换行
    }
  })
})

describe('换:行内成对、块独占一行', () => {
  it('行内 \\(…\\) 同一行成对就换', () => {
    expect(normalizeMathDelimiters(String.raw`见 \(x^2\) 处`)).toBe('见 $$x^2$$ 处')
  })

  it('行内 \\[…\\] 同一行成对也换(它会被提升成块公式,见 to-blocks)', () => {
    expect(normalizeMathDelimiters(String.raw`\[x\]`)).toBe('$$x$$')
  })

  it('trim 后恰好是 \\[ 的一行无条件换,缩进与行尾空白原样留着', () => {
    expect(normalizeMathDelimiters(`  ${OPEN}  \nx`)).toBe('  $$  \nx')
  })

  it('\\] 只在数学围栏开着时换 —— 孤零零一行 \\] 什么都不是', () => {
    expect(normalizeMathDelimiters(`${CLOSE}\n正文`)).toBe(`${CLOSE}\n正文`)
    expect(normalizeMathDelimiters(`${OPEN}\nx\n${CLOSE}`)).toBe('$$\nx\n$$')
  })

  it('`$$` 开的围栏里那一行 \\] 是它自己的内容,不许当收尾', () => {
    // 认成收尾会把这个块从中间劈开 —— 判据在 fences.ts 的 MATH.close。
    expect(normalizeMathDelimiters(`$$\n${CLOSE}\n$$`)).toBe(`$$\n${CLOSE}\n$$`)
  })
})

describe('不换:四处免疫', () => {
  it('围栏代码里一个字都不换', () => {
    const text = '```tex\n' + String.raw`\(x\)` + `\n${OPEN}\ny\n${CLOSE}\n` + '```'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('~~~ 围栏同理,而且 ` 关不掉 ~', () => {
    const text = '~~~\n' + String.raw`\(x\)` + '\n```\n' + String.raw`\(y\)` + '\n~~~'
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('数学围栏里的 \\( 是 TeX 自己的字', () => {
    const text = `$$\n${String.raw`\(x\)`}\n$$`
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('同一行的行内码里不换,码外面照换', () => {
    // 反引号在模板串里写不进去,这一组用普通串 + 手写转义。
    expect(normalizeMathDelimiters('`\\(a\\)` 和 \\(b\\)')).toBe('`\\(a\\)` 和 $$b$$')
  })

  it('反引号没配上对就不是行内码,里面照换', () => {
    expect(normalizeMathDelimiters('` \\(a\\) 尾')).toBe('` $$a$$ 尾')
  })

  it('\\\\( —— 反斜杠被转义掉了,后面那个括号是普通括号', () => {
    const text = String.raw`算式 \\(x\\) 收尾`
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('没配上对的半截原样不动', () => {
    expect(normalizeMathDelimiters(String.raw`开了 \( 没关`)).toBe(String.raw`开了 \( 没关`)
    expect(normalizeMathDelimiters(String.raw`只有 \) 收尾`)).toBe(String.raw`只有 \) 收尾`)
  })

  it('跨行不算成对(行内那一档只在一行之内找)', () => {
    const text = String.raw`\(x` + '\n' + String.raw`y\)`
    expect(normalizeMathDelimiters(text)).toBe(text)
  })

  it('别的转义整对跳过,不会把 `\\*` 里的星号当下一轮起手', () => {
    const text = String.raw`\*强调\* 与 \(x\)`
    expect(normalizeMathDelimiters(text)).toBe(String.raw`\*强调\* 与 $$x$$`)
  })
})

describe('已知并接受的一处误伤', () => {
  it('成对的 \\[…\\] 转义会被当成公式 —— 记在案的代价,不是漏网', () => {
    // 判词在 math-delimiters.ts 的头注:没有上下文就答不出「这一处是 TeX 还是转义」,
    // 而真实语料里 `\[…\]` 十次有九次半是公式。
    expect(normalizeMathDelimiters(String.raw`\[不是链接\]`)).toBe('$$不是链接$$')
  })
})
