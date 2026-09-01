import { describe, expect, it } from 'vitest'
import { completeTableTail } from '../table-tail'
import { parseMarkdown } from '../parse'

/**
 * **正在出生的那张表**(09-01 用户复测报障 + 录屏)。
 *
 * 这一层只回答一件事:活尾巴的最后两行是不是「表头 + 还没写完的分隔行」,是就把
 * 分隔行补齐。补齐之后真不真是表由解析器说了算(调用方那一步再验一次),所以这里
 * 的用例分两半:**该补的补出什么**、**不该补的一个字都不动**。
 *
 * 诊断留档(真解析器逐形取证,见回报):GFM **允许表打断段落** —— 正文紧跟表头、
 * 中间不空行,照样成表。所以「表前没有空行」那条嫌疑是排除掉的,补空行会是治一个
 * 不存在的病。真正缺的只有分隔行的后半截。
 */

const HEAD = '| 书名 | 作者 | 分类 | 出版社 | 出版年份 | 页数 | 评分 |'

/** 补齐之后真解析器给出的块序 —— 用例的最终判据是它,不是字符串长什么样。 */
const shapeOf = (text: string) =>
  parseMarkdown(text).map((entry) => entry.block.kind).join(' | ')

describe('该补的:表头 + 半截分隔行', () => {
  it('一个 `-` 就够 —— 分隔行刚开头就认得出这是一张七列的表', () => {
    const completed = completeTableTail(`正文。\n${HEAD}\n|-`)
    expect(completed).toBeDefined()
    expect(shapeOf(completed!)).toBe('paragraph | table')
    expect(parseMarkdown(completed!).at(-1)!.block).toMatchObject({ head: expect.any(Array) })
    expect((parseMarkdown(completed!).at(-1)!.block as { head: unknown[] }).head).toHaveLength(7)
  })

  it('半截的那一格先收口,再补剩下的(`| :--` → 七格)', () => {
    const completed = completeTableTail(`正文。\n${HEAD}\n| :---: | :--`)
    expect(shapeOf(completed!)).toBe('paragraph | table')
  })

  it('真机录屏里的那一行(六格半,共七列)', () => {
    const completed = completeTableTail(`${HEAD}\n|------|------|------|--------|----------|-----`)
    expect(shapeOf(completed!)).toBe('table')
  })

  it('表前**没有空行**照样认 —— GFM 允许表打断段落(嫌疑 A 已排除)', () => {
    const completed = completeTableTail(`这是一段正文。\n${HEAD}\n|---`)
    expect(shapeOf(completed!)).toBe('paragraph | table')
  })

  it('补的是最保守的 `---`,不猜对齐 —— 真的冒号到了下一帧自然生效', () => {
    expect(completeTableTail('| a | b | c |\n| :-')).toBe('| a | b | c |\n| :- | --- | --- |')
  })

  /*
   * ── 半格要么收口、要么丢掉(真机 2 字/帧喂十三列表时抓到的翻面)────────────
   * 一格分隔符至少要有一个 `-`。把只有 `| ` 或 `| :` 的半格原样收口,会造出一格
   * **非法**的分隔符,整行当场不是表 —— 屏幕上「表 → 段落 → 表」来回翻十次,
   * 指纹就是 `… | :` 那两个字符。丢掉半格不会少画什么:横杠还没到,补出来的 `---`
   * 与它长得一样。
   */
  it('半格只有冒号:丢掉它,别造出一格非法分隔符', () => {
    const completed = completeTableTail('| a | b | c |\n| :---: | :')
    expect(completed).toBe('| a | b | c |\n| :---: | --- | --- |')
    expect(shapeOf(completed!)).toBe('table')
  })

  it('半格只有空白:同样丢掉', () => {
    expect(shapeOf(completeTableTail('| a | b |\n| --- | ')!)).toBe('table')
  })

  it('半格里已经有横杠:收口留着它(对齐冒号照收)', () => {
    expect(completeTableTail('| a | b | c |\n| --- | :-')).toBe('| a | b | c |\n| --- | :- | --- |')
  })

  it('格数已经够了就不必补 —— 完整的分隔行不带换行,GFM 本来就认(嫌疑 D 排除)', () => {
    expect(completeTableTail('| a | b |\n| --- | :-')).toBeUndefined()
    expect(shapeOf('| a | b |\n| --- | :-')).toBe('table')
  })

  it('丢掉半格之后一个横杠都不剩 = 还看不出是分隔行,不猜', () => {
    expect(completeTableTail('| a | b |\n| :')).toBeUndefined()
  })
})

describe('不该补的:一个字都不动', () => {
  it('分隔行已经换行落定 —— 写完了就该由 GFM 判,轮不到我们补', () => {
    expect(completeTableTail('| a | b |\n| --- |\n')).toBeUndefined()
  })

  it('格数已经够了(或者更多)', () => {
    expect(completeTableTail('| a | b |\n| --- | --- |')).toBeUndefined()
    expect(completeTableTail('| a | b |\n| --- | --- | --- |')).toBeUndefined()
  })

  it('最后一行不像分隔行(有别的字)', () => {
    expect(completeTableTail('| a | b |\n这不是分隔行')).toBeUndefined()
    expect(completeTableTail('| a | b |\n| 甲 |')).toBeUndefined()
  })

  it('分隔行里一个 `-` 都还没有 —— 只有竖线时还看不出是表', () => {
    expect(completeTableTail('| a | b |\n|')).toBeUndefined()
  })

  it('上一行不像表头(没有竖线)', () => {
    expect(completeTableTail('普通一段话\n| --- ')).toBeUndefined()
  })

  it('只有一行(没有上一行可认表头)', () => {
    expect(completeTableTail('|---')).toBeUndefined()
  })

  it('空文本 / 以换行结束', () => {
    expect(completeTableTail('')).toBeUndefined()
    expect(completeTableTail('| a |\n| --- |\n| 1 |\n')).toBeUndefined()
  })

  /*
   * 缩进四格的表在 CommonMark 里**就是**缩进代码块(实测:paragraph | code)。
   * 这里不剥缩进 —— 剥了就等于把真正的缩进代码块也改了,那是可感知的行为裁定。
   * 补齐这一步碰不到它:调用方只在「最后一块是段落」时才问,缩进块是 code。
   */
  it('缩进四格的表:补齐这一步管不着它(留给调用方的守门)', () => {
    const indented = '    | a | b |\n    |-'
    // 它自己看起来仍然「像表头 + 半截分隔行」,所以这一层会补 ——
    expect(completeTableTail(indented)).toBeDefined()
    // —— 但补完之后解析出来还是代码块,调用方那一步的「真是表才认」当场作废它。
    expect(shapeOf(completeTableTail(indented)!)).toBe('code')
  })
})
