import { describe, expect, it } from 'vitest'
import type { BlockModel } from '../../../../model/blocks'
import type { InlineNode } from '../../../../model/inline'
import { columnToText, numericColumns, tableToCsv, tableToMarkdown, cellToMarkdown } from '../serialize'

type TableModel = Extract<BlockModel, { kind: 'table' }>

const cell = (text: string): InlineNode[] => [{ type: 'text', text }]

const table = (head: string[], rows: string[][]): TableModel => ({
  kind: 'table',
  head: head.map(cell),
  rows: rows.map((row) => row.map(cell)),
})

describe('表格的序列化(动作声明什么,这里就算什么)', () => {
  it('复制为 Markdown:表头 + 默认对齐的分隔行 + 数据行', () => {
    expect(tableToMarkdown(table(['名字', '数量'], [['苹果', '3']]))).toBe(
      ['| 名字 | 数量 |', '| --- | --- |', '| 苹果 | 3 |'].join('\n'),
    )
  })

  it('Markdown 保住行内标记,竖线转义,换行压成空格(一行不能跨行)', () => {
    const model: TableModel = {
      kind: 'table',
      head: [cell('a')],
      rows: [
        [
          [
            { type: 'emphasis', strong: true, children: cell('粗') },
            { type: 'text', text: ' a|b\nc' },
            { type: 'code', text: 'x' },
            { type: 'link', href: 'http://x', children: cell('文') },
            { type: 'strike', children: cell('删') },
          ],
        ],
      ],
    }
    expect(tableToMarkdown(model).split('\n')[2]).toBe('| **粗** a\\|b c`x`[文](http://x)~~删~~ |')
  })

  it('行不齐时按最宽的补空格 —— 导出的表必须是方的', () => {
    expect(tableToMarkdown(table(['a'], [['1', '2']])).split('\n')).toEqual([
      '| a |  |',
      '| --- | --- |',
      '| 1 | 2 |',
    ])
  })

  it('复制为 CSV:只取纯文字,含逗号 / 引号 / 换行的字段加引号,引号翻倍', () => {
    const model: TableModel = {
      kind: 'table',
      head: [cell('a'), cell('b')],
      rows: [[cell('x,y'), [{ type: 'text', text: '说"这个"' }]], [cell('行1\n行2'), cell('简单')]],
    }
    expect(tableToCsv(model)).toBe(
      ['a,b', '"x,y","说""这个"""', '"行1\n行2",简单'].join('\n'),
    )
  })

  it('CSV 里的行内标记被摊平 —— 它是给表格软件吃的,不是给 markdown 吃的', () => {
    const model: TableModel = {
      kind: 'table',
      head: [cell('a')],
      rows: [[[{ type: 'emphasis', strong: true, children: cell('粗') }]]],
    }
    expect(tableToCsv(model)).toBe('a\n粗')
  })

  it('复制一列:只给这一列的数据,不带表头', () => {
    const model = table(['名字', '数量'], [['苹果', '3'], ['梨', '5']])
    expect(columnToText(model, 0)).toBe('苹果\n梨')
    expect(columnToText(model, 1)).toBe('3\n5')
    // 越界的列号给空串,不抛 —— 列号来自 DOM 上的一次点击,不该有致命性。
    expect(columnToText(model, 9)).toBe('\n')
  })
})

describe('数字列的判据:看列里装的是什么', () => {
  it('整列都是数才算数字列;混了字就不是', () => {
    expect(numericColumns(table(['名', '量', '备注'], [
      ['苹果', '3', '好'],
      ['梨', '5', '一般'],
    ]))).toEqual([false, true, false])
  })

  it('千分位 / 百分号 / 货币 / 正负号都算数', () => {
    expect(numericColumns(table(['a', 'b', 'c', 'd'], [
      ['1,234', '12.5%', '$99', '-3'],
    ]))).toEqual([true, true, true, true])
  })

  it('空格不算数据(整列空 = 不是数字列),一格不是数整列就不是', () => {
    expect(numericColumns(table(['a', 'b'], [['', '1'], ['', '待定']]))).toEqual([false, false])
  })

  it('角标不进正文 —— 导出与判据都不收它', () => {
    expect(cellToMarkdown([{ type: 'citation', sourceId: 's', index: 1 }])).toBe('')
  })
})
