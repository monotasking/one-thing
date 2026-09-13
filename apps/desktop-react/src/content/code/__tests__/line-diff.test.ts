import { describe, expect, it } from 'vitest'
import { blocksOf, lineDiff } from '../line-diff'

/**
 * 行级 diff 的规格书(2026-09-13 批 ③-b)。
 *
 * 这只东西是纯函数,所以它该被**逐种形状**验一遍 —— 空 / 全同 / 全换 / 首尾增删 /
 * 交错 / 单边缺席 / 两万行。改动面上看到的每一条线索(两列行号、加删、块表)
 * 最后都落在这张表上。
 */

/** 一行的紧凑读法:`旧号|新号|标记|文本`,缺席写 `-`。 */
const shape = (source: string, target: string) =>
  lineDiff(source ? source.split('\n') : [], target ? target.split('\n') : []).lines.map(
    (line) => `${line.oldNo ?? '-'}|${line.newNo ?? '-'}|${line.mark ?? 'ctx'}|${line.text}`,
  )

describe('形状', () => {
  it('空 → 空:一行都没有', () => {
    expect(lineDiff([], [])).toEqual({ lines: [], blocks: [] })
  })

  it('全同:每一行两个号都有,一个 mark 都没有,块表是空的', () => {
    const out = lineDiff(['a', 'b', 'c'], ['a', 'b', 'c'])
    expect(shape('a\nb\nc', 'a\nb\nc')).toEqual(['1|1|ctx|a', '2|2|ctx|b', '3|3|ctx|c'])
    expect(out.blocks).toEqual([])
  })

  it('全换:先整篇删、再整篇增,两段算**一个**块(连着)', () => {
    const out = lineDiff(['a', 'b'], ['x', 'y'])
    expect(shape('a\nb', 'x\ny')).toEqual(['1|-|del|a', '2|-|del|b', '-|1|add|x', '-|2|add|y'])
    expect(out.blocks).toEqual([0])
  })

  it('只有 head(文件删掉了)= 整篇 del', () => {
    const out = lineDiff(['a', 'b'], [])
    expect(out.lines.every((line) => line.mark === 'del')).toBe(true)
    expect(out.lines.map((line) => line.newNo)).toEqual([undefined, undefined])
    expect(out.blocks).toEqual([0])
  })

  it('只有 work(新文件)= 整篇 add', () => {
    const out = lineDiff([], ['a', 'b'])
    expect(out.lines.every((line) => line.mark === 'add')).toBe(true)
    expect(out.lines.map((line) => line.oldNo)).toEqual([undefined, undefined])
    expect(out.blocks).toEqual([0])
  })

  it('首增:第一行是 add,后面的 ctx 两个号各走各的', () => {
    expect(shape('b\nc', 'a\nb\nc')).toEqual(['-|1|add|a', '1|2|ctx|b', '2|3|ctx|c'])
  })

  it('尾删:最后一行是 del,它只有旧号', () => {
    expect(shape('a\nb\nc', 'a\nb')).toEqual(['1|1|ctx|a', '2|2|ctx|b', '3|-|del|c'])
  })

  it('交错:两处改动 = 两个块,中间那一行未改', () => {
    const out = lineDiff(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'D'])
    expect(shape('a\nb\nc\nd', 'a\nB\nc\nD')).toEqual([
      '1|1|ctx|a',
      '2|-|del|b',
      '-|2|add|B',
      '3|3|ctx|c',
      '4|-|del|d',
      '-|4|add|D',
    ])
    expect(out.blocks).toEqual([1, 4])
  })

  it('改一行 = 删一行 + 加一行,但**只算一处**改动', () => {
    const out = lineDiff(['keep', 'old', 'tail'], ['keep', 'new', 'tail'])
    expect(out.blocks).toEqual([1])
  })

  it('一段删三行加两行也只算一处 —— 人读 diff 时它就是一件事', () => {
    const out = lineDiff(['a', '1', '2', '3', 'z'], ['a', 'x', 'y', 'z'])
    expect(out.blocks).toHaveLength(1)
  })
})

describe('两列行号是两个计数器', () => {
  it('新增行不占旧号,删除行不占新号,未改行两边都占', () => {
    const out = lineDiff(['a', 'b'], ['a', 'x', 'b'])
    expect(out.lines.map((line) => [line.oldNo, line.newNo, line.mark])).toEqual([
      [1, 1, undefined],
      [undefined, 2, 'add'],
      [2, 3, undefined],
    ])
  })
})

describe('blocksOf', () => {
  it('只认「连续」:中间夹一行未改就断成两块', () => {
    expect(blocksOf([{ text: 'a', mark: 'add' }, { text: 'b' }, { text: 'c', mark: 'del' }])).toEqual([0, 2])
    expect(blocksOf([{ text: 'a', mark: 'add' }, { text: 'b', mark: 'del' }])).toEqual([0])
    expect(blocksOf([{ text: 'a' }])).toEqual([])
  })
})

describe('超量:两万行', () => {
  const many = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed} line ${i}`)

  it('两万行、改十处:≤ 50ms(剥公共头尾之后真要算的只有几行)', () => {
    const head = many(20_000, 'src')
    const work = head.slice()
    for (let i = 0; i < 10; i += 1) work[i * 1_500 + 7] = `changed ${i}`
    const started = performance.now()
    const out = lineDiff(head, work)
    const ms = performance.now() - started
    expect(out.blocks).toHaveLength(10)
    expect(out.lines.filter((line) => line.mark).length).toBe(20)
    expect(ms, `实测 ${ms.toFixed(1)}ms`).toBeLessThan(50)
  })

  /*
   * **这一格量的是「不炸」,不是 50ms**:超预算那一支要造四万个行对象,那是分配与
   * GC 的钱,不是算法的钱 —— 单跑实测 36ms,而满载的 vitest(十六个 worker 抢一台
   * 机器)里量到过 158ms。给的这个上界仍然拦得住真正的退化:去掉预算闸的话这一格
   * 要跑的是 O(N·D) = 20000×40000,秒级起步。
   */
  it('两万行全换:不炸(单跑 36ms;答案照旧是整篇删 + 整篇增)', () => {
    const started = performance.now()
    const out = lineDiff(many(20_000, 'old'), many(20_000, 'new'))
    const ms = performance.now() - started
    expect(out.lines).toHaveLength(40_000)
    expect(out.blocks).toEqual([0])
    expect(ms, `实测 ${ms.toFixed(1)}ms`).toBeLessThan(400)
  })

  it('两千行、每隔一行改一行:算得出来,而且中间未改的行仍是 ctx', () => {
    const head = many(2_000, 'src')
    const work = head.map((text, i) => (i % 2 === 0 ? `changed ${i}` : text))
    const started = performance.now()
    const out = lineDiff(head, work)
    const ms = performance.now() - started
    expect(out.blocks.length).toBeGreaterThan(500)
    expect(out.lines.some((line) => !line.mark)).toBe(true)
    // 单跑实测 23ms;同上,满载时给足余量。
    expect(ms, `实测 ${ms.toFixed(1)}ms`).toBeLessThan(400)
  })
})
