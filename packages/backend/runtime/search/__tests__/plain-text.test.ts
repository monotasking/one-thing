/**
 * 「行上的字是给人读的一句话,不是源码」(检索面终稿 R8)—— `toDisplayText` 与
 * 吃它的那条摘要链。
 *
 * 三件要证的事,少一件这条链就白改:
 *  ① 记号真的剥掉了(用户 09-05 看见的 `**` / 反引号 / `###` 不再上屏);
 *  ② **区间还对得上**(剥字容易,难的是剥完之后高亮还落在同一批字上);
 *  ③ **幂等**(它同时站在索引写路与查询路上,跑两遍不能打架)。
 */
import { describe, expect, it } from 'vitest'

import { snippetOf, queryRangesOf } from '../capabilities/indexed.js'
import { mapDisplayRangeToSource, plainTextOf, toDisplayText } from '../text/plain.js'

describe('toDisplayText:剥记号 + 回原文的路', () => {
  it('强调 / 行内代码 / 标题 / 列表 / 链接的记号都不上屏', () => {
    expect(plainTextOf('**粗体**与 `code` 与 ~~删除~~')).toBe('粗体与 code 与 删除')
    expect(plainTextOf('### 标题')).toBe('标题')
    expect(plainTextOf('- 第一项\n- 第二项')).toBe('第一项\n第二项')
    expect(plainTextOf('1. 一\n2. 二')).toBe('一\n二')
    expect(plainTextOf('> 引用一句')).toBe('引用一句')
    expect(plainTextOf('见 [文档](https://example.com/x) 那一段')).toBe('见 文档 那一段')
    expect(plainTextOf('![一张图](img.png)')).toBe('一张图')
  })

  it('围栏丢掉栏杆、留下代码;分隔线整行丢', () => {
    expect(plainTextOf('前\n```ts\nconst a = 1 * 2\n```\n后')).toBe('前\nconst a = 1 * 2\n后')
    expect(plainTextOf('上\n---\n下')).toBe('上\n下')
  })

  it('**词中间的 `_` / `*` 不是记号**(不然 get_user_profile 会塌成一个词)', () => {
    expect(plainTextOf('get_user_profile 与 2*3')).toBe('get_user_profile 与 2*3')
    expect(plainTextOf('转义的 \\*星号\\* 照出')).toBe('转义的 *星号* 照出')
  })

  it('不是 markdown 的输入恒等,映射是恒等映射', () => {
    const plain = toDisplayText('一句白话 with words')
    expect(plain.text).toBe(plain.source)
    expect(plain.map).toEqual([...Array(plain.source.length + 1).keys()])
  })

  it('幂等:剥过的串再剥一遍还是它自己', () => {
    const source = '## 标题\n\n**粗**的 `code` 与 [链接](a.md)\n\n```\nx = 1\n```\n'
    const once = plainTextOf(source)
    expect(plainTextOf(once)).toBe(once)
  })

  it('偏移映射把剥过的坐标送得回原文,**右端不吃掉紧跟着的记号**', () => {
    const source = '前面 **命中词** 后面'
    const plain = toDisplayText(source)
    const at = plain.text.indexOf('命中词')
    const back = mapDisplayRangeToSource(plain, { start: at, end: at + 3 })
    expect(source.slice(back.start, back.end)).toBe('命中词')
  })
})

describe('snippetOf:剥记号之后开窗,区间落在屏上那串字上', () => {
  it('摘要里零记号,而 ranges 切出来正好是命中词', () => {
    const source = `${'铺垫'.repeat(40)}这里有 **身份牌** 这个词${'收尾'.repeat(40)}`
    const snippet = snippetOf(source, ['身份'])
    expect(snippet.text).not.toContain('*')
    expect(snippet.text).toContain('身份牌')
    const range = snippet.ranges[0]!
    expect(snippet.text.slice(range.start, range.end)).toBe('身份')
  })

  it('两端截断如实报,窗口就是全文时两格都是 false', () => {
    const long = snippetOf(`${'甲'.repeat(200)}身份牌${'乙'.repeat(200)}`, ['身份'])
    expect(long.truncatedStart).toBe(true)
    expect(long.truncatedEnd).toBe(true)
    expect(long.offset).toBeGreaterThan(0)

    const short = snippetOf('**身份牌**在这', ['身份'])
    expect(short.truncatedStart).toBe(false)
    expect(short.truncatedEnd).toBe(false)
    expect(short.text).toBe('身份牌在这')
  })

  it('**前缀命中也标亮**(旧判据要求词元逐字相等,于是 `jir` 一条高亮都画不出)', () => {
    const snippet = snippetOf('the jira ticket', ['jir'])
    const range = snippet.ranges[0]!
    expect(snippet.text.slice(range.start, range.end)).toBe('jira')
  })

  it('窗口边缘那半个命中不标 —— 高亮永远是一整个词', () => {
    // 命中挤在正文最末尾:窗口从命中前 1/6 处开,末尾那个不会被切一半标出来。
    const snippet = snippetOf(`${'甲'.repeat(300)}身份牌`, ['身份'])
    for (const range of snippet.ranges) {
      expect(range.start).toBeGreaterThanOrEqual(0)
      expect(range.end).toBeLessThanOrEqual(snippet.text.length)
      expect(snippet.text.slice(range.start, range.end)).toBe('身份')
    }
  })

  it('命中前置约 1/6 窗宽:命中不在行首、也不在行中央', () => {
    const snippet = snippetOf(`${'甲'.repeat(300)}身份牌${'乙'.repeat(300)}`, ['身份'])
    const at = snippet.ranges[0]!.start
    // 120 字窗、1/6 前置 → 命中大致落在第 20 个字附近;判据放宽成「靠前但不贴边」。
    expect(at).toBeGreaterThan(0)
    expect(at).toBeLessThan(snippet.text.length / 3)
  })
})

describe('queryRangesOf:预览与列表同一个高亮产地', () => {
  it('区间相对**传进去的那段原文**,而不是剥过记号的串', () => {
    const source = '开头 **身份牌** 收尾'
    const ranges = queryRangesOf(source, '身份')
    expect(ranges).toHaveLength(1)
    expect(source.slice(ranges[0]!.start, ranges[0]!.end)).toBe('身份')
  })

  it('没有查询词就不标(缺席 = 没带词,不是「没命中」)', () => {
    expect(queryRangesOf('身份牌', '')).toEqual([])
    expect(queryRangesOf('', '身份')).toEqual([])
  })

  it('与 `snippetOf` 认的是同一批字(前缀也算)', () => {
    const ranges = queryRangesOf('the jira ticket', 'jir')
    expect('the jira ticket'.slice(ranges[0]!.start, ranges[0]!.end)).toBe('jira')
  })
})
