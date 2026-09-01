import { describe, expect, it } from 'vitest'
import { commitTable } from '../table-tail'
import { parseMarkdown } from '../parse'

/**
 * **表的承诺政策**(09-01 用户复测报障 + 录屏;R4b 把它从「补半截分隔行」推到
 * 「行首第一根竖线就承诺」)。
 *
 * 这一层只回答一件事:活尾巴里有没有一张正在出生的表,有就把源码补成解析器认得的
 * 样子。补齐之后真不真是表由解析器说了算(调用方那一步再验一次),所以用例的最终
 * 判据一律是 `shapeOf`(真解析器给出的块序),不是字符串长什么样。
 *
 * 诊断留档(真解析器逐形取证):GFM **允许表打断段落** —— 正文紧跟表头、中间不空行,
 * 照样成表。所以「表前没有空行」那条嫌疑是排除掉的,补空行会是治一个不存在的病。
 *
 * ── R4b 翻掉的那几条旧期望(逐条记档)────────────────────────────────
 * 「分隔行还没写 / 写了一半还看不出是分隔行 / 压根没写分隔行」这几形,R4a 时一律
 * 返回 undefined(= 屏幕上是裸文本)。R4b 全部改成**承诺**,理由是 117 列的真机读数:
 * 裸挂 850ms,而且成表那一刻裸文本段落从 179px 塌到 22px,底下内容整体上跳 157px。
 * 承诺错了怎么办 → 见「承诺收得回来」那一组。
 */

const HEAD = '| 书名 | 作者 | 分类 | 出版社 | 出版年份 | 页数 | 评分 |'

/** 补齐之后真解析器给出的块序 —— 用例的最终判据是它。 */
const shapeOf = (text: string) =>
  parseMarkdown(text).map((entry) => entry.block.kind).join(' | ')

const committed = (source: string) => {
  const result = commitTable(source)
  expect(result, `没有承诺:${JSON.stringify(source)}`).toBeDefined()
  return result!
}

/** 承诺之后那张表有几列。 */
const columnsOf = (text: string) => {
  const table = parseMarkdown(text).find((entry) => entry.block.kind === 'table')
  return (table?.block as { head: unknown[] } | undefined)?.head.length
}

describe('承诺:行首第一根竖线就认(R4b)', () => {
  it('表头还在写 —— 竖线到了第二根就承诺,不等分隔行', () => {
    const result = committed('下面是表。\n| 书名 | 作')
    expect(shapeOf(result.text)).toBe('paragraph | table')
    expect(columnsOf(result.text)).toBe(2)
  })

  it('表头刚换行、分隔行一个字都还没来 —— 照样承诺', () => {
    const result = committed(`${HEAD}\n`)
    expect(shapeOf(result.text)).toBe('table')
    expect(columnsOf(result.text)).toBe(7)
  })

  it('分隔行刚开了一根竖线(`|`)—— 补成整行,不许把它当成一行数据', () => {
    // R4a 这一形返回 undefined(屏幕退回裸文本);更早的写法会把 `|` 当数据行画出来,
    // 下一帧又消失 —— 那是竖向抖动的制造机。
    const result = committed('| a | b |\n|')
    expect(shapeOf(result.text)).toBe('table')
    expect(columnsOf(result.text)).toBe(2)
    expect(parseMarkdown(result.text).find(e => e.block.kind === 'table')!.block)
      .toMatchObject({ rows: [] })
  })

  it('分隔行只写了个冒号(`| :`)—— 丢掉半格,补满', () => {
    const result = committed('| a | b |\n| :')
    expect(shapeOf(result.text)).toBe('table')
    expect(columnsOf(result.text)).toBe(2)
  })

  it('一根竖线不算表 —— `| 见下文` 是散文的常见起手', () => {
    expect(commitTable('| 见下文')).toBeUndefined()
    expect(commitTable('|---')).toBeUndefined()
  })
})

describe('承诺:表头 + 半截分隔行(R4a 立的那一半,一个字没改)', () => {
  it('一个 `-` 就够 —— 分隔行刚开头就认得出这是一张七列的表', () => {
    const result = committed(`正文。\n${HEAD}\n|-`)
    expect(shapeOf(result.text)).toBe('paragraph | table')
    expect(columnsOf(result.text)).toBe(7)
  })

  it('半截的那一格先收口,再补剩下的(`| :--` → 七格)', () => {
    expect(shapeOf(committed(`正文。\n${HEAD}\n| :---: | :--`).text)).toBe('paragraph | table')
  })

  it('真机录屏里的那一行(六格半,共七列)', () => {
    expect(shapeOf(committed(`${HEAD}\n|------|------|------|--------|----------|-----`).text)).toBe('table')
  })

  it('表前**没有空行**照样认 —— GFM 允许表打断段落(嫌疑 A 已排除)', () => {
    expect(shapeOf(committed(`这是一段正文。\n${HEAD}\n|---`).text)).toBe('paragraph | table')
  })

  it('补的是最保守的 `---`,不猜对齐 —— 真的冒号到了下一帧自然生效', () => {
    expect(committed('| a | b | c |\n| :-').text).toBe('| a | b | c |\n| :- | --- | --- |')
  })

  /*
   * ── 半格要么收口、要么丢掉(真机 2 字/帧喂十三列表时抓到的翻面)────────────
   * 一格分隔符至少要有一个 `-`。把只有 `| ` 或 `| :` 的半格原样收口,会造出一格
   * **非法**的分隔符,整行当场不是表 —— 屏幕上「表 → 段落 → 表」来回翻十次,
   * 指纹就是 `… | :` 那两个字符。
   */
  it('半格只有冒号:丢掉它,别造出一格非法分隔符', () => {
    expect(committed('| a | b | c |\n| :---: | :').text).toBe('| a | b | c |\n| :---: | --- | --- |')
  })

  it('半格里已经有横杠:收口留着它(对齐冒号照收)', () => {
    expect(committed('| a | b | c |\n| --- | :-').text).toBe('| a | b | c |\n| --- | :- | --- |')
  })

  it('格数已经够了就不必补 —— 完整的分隔行不带换行,GFM 本来就认', () => {
    expect(commitTable('| a | b |\n| --- | :-')).toBeUndefined()
    expect(shapeOf('| a | b |\n| --- | :-')).toBe('table')
    expect(commitTable('| a | b |\n| --- | --- |')).toBeUndefined()
    expect(commitTable('| a | b |\n| --- | --- | --- |')).toBeUndefined()
  })
})

describe('承诺:分隔行漏写(用户截图二的前半)', () => {
  it('表头之后直接来数据行 —— 插一整行分隔行,数据照实进表', () => {
    const result = committed('| a | b |\n| 甲 | 一 |')
    expect(shapeOf(result.text)).toBe('table')
    expect(columnsOf(result.text)).toBe(2)
  })

  it('表头之后来的是散文 —— 表照立,那行散文被 GFM 收成一行数据', () => {
    // 不是我们把它塞进表的:GFM 的表在**空行**之前一直收行。承诺只负责把分隔行补上,
    // 之后的事按 GFM 的规矩走 —— 收尾不承诺,整段照实画回段落(那是既有拍板)。
    expect(shapeOf(committed('| a | b |\n这不是分隔行').text)).toBe('table')
    expect(shapeOf('| a | b |\n这不是分隔行')).toBe('paragraph')
  })
})

describe('承诺收得回来:分隔行写完了而格数对不上(用户截图二)', () => {
  /*
   * 唯一一处「承诺可以收回」的地方,而它不是反悔:这一行写完之前答案还没出来,
   * 一写完 GFM 的判决就出来了 —— 知道了还继续画成表才是撒谎。照既有拍板
   * 「模型写错照实画」当场退回段落,而且从此稳定(下一帧同一条判据,不会来回翻)。
   */
  it('表头三格、分隔行两格:写完那一刻收回承诺', () => {
    expect(commitTable('| a | b | c |\n| --- | --- |\n')).toBeUndefined()
    expect(commitTable('| a | b | c |\n| --- | --- |\n| 甲 | 一 | 二 |\n')).toBeUndefined()
    // 而它确实不是表 —— 我们只是照实画。
    expect(shapeOf('| a | b | c |\n| --- | --- |\n')).toBe('paragraph')
  })

  it('收回之后**稳定**:再多来几行数据,判据照样成立,不来回翻', () => {
    for (const more of ['', '| 甲 | 一 | 二 |', '| 甲 | 一 | 二 |\n| 乙 | 三 | 四 |']) {
      expect(commitTable(`| a | b | c |\n| --- | --- |\n${more}`)).toBeUndefined()
    }
  })

  it('格数**对得上**的完整分隔行:解析器自己认得,不必补', () => {
    expect(commitTable('| a | b |\n| --- | --- |\n')).toBeUndefined()
    expect(commitTable('| a |\n| --- |\n| 1 |\n')).toBeUndefined()
  })
})

describe('不该碰的:一个字都不动', () => {
  it('空文本', () => {
    expect(commitTable('')).toBeUndefined()
  })

  /*
   * 缩进四格的表在 CommonMark 里**就是**缩进代码块(实测:paragraph | code)。
   * 不剥缩进 —— 剥了就等于把真正的缩进代码块也改了,那是可感知的行为裁定。
   * R4a 时靠调用方的「真是表才认」挡住它;R4b 起判据自己就把它挡在门外
   * (`^ {0,3}\|` 不认四格缩进),少一次白算。
   */
  it('缩进四格的表:判据自己挡住,不进承诺', () => {
    expect(commitTable('    | a | b |\n    |-')).toBeUndefined()
    expect(shapeOf('    | a | b |\n    |-')).toBe('code')
  })

  it('上一行不像表头(没有竖线)', () => {
    expect(commitTable('普通一段话\n| --- ')).toBeUndefined()
  })
})

describe('单调性由构造保证(承诺不可逆)', () => {
  /*
   * 「承诺不可逆」不需要一本承诺账:判据只许在文本增长时从假变真。这条用例把一张表
   * 逐字符喂进去,断言**承诺一旦做出就不再收回** —— 唯一允许的反向是分隔行写错
   * (上面那一组),而这条素材的分隔行是对的。
   */
  it('逐字符喂一张七列表:承诺做出之后每一帧都还在', () => {
    const source = `${HEAD}\n| --- | --- | --- | --- | --- | --- | --- |\n| a | b | c | d | e | f | g |`
    let promised = false
    for (let i = 1; i <= source.length; i += 1) {
      const upto = source.slice(0, i)
      const result = commitTable(upto)
      const isTable = result
        ? shapeOf(result.text).includes('table')
        : shapeOf(upto).includes('table')
      if (promised) expect(isTable, `第 ${i} 个字符处承诺被收回了:${JSON.stringify(upto)}`).toBe(true)
      if (isTable) promised = true
    }
    expect(promised).toBe(true)
  })
})
