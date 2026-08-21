/**
 * C5-1 确定性文件清单(docs/design/context-compact-capability-2026-08.md §C5)。
 *
 * 摘要里的文件路径不再让模型「回忆」:它就在 toolCalls 的参数里躺着。这里钉的是
 * 那张分类表(app 层)与那组格式化/并集函数(core)的分工与行为。
 */
import { describe, expect, it } from 'vitest'
import {
  extractCompactFileOperations,
  formatCompactFileOperations,
  mergeCompactFileOperations,
  stripCompactFileOperations,
} from '@onething/core/engine'
import { collectCompactFileOperations } from '../compact-file-lists.js'

type ToolCallSpec = { toolId: string; arguments: Record<string, string | number> }

function assistantWith(toolCalls: ToolCallSpec[]) {
  return {
    toolCalls: toolCalls.map(call => ({
      toolId: call.toolId,
      toolName: call.toolId,
      arguments: call.arguments,
      status: 'completed',
    })),
  }
}

describe('分类表:工具名 → 路径参数', () => {
  it('read 进读清单,write / edit 进改清单', () => {
    expect(collectCompactFileOperations([
      assistantWith([
        { toolId: 'read', arguments: { path: '/repo/a.ts' } },
        { toolId: 'write', arguments: { path: '/repo/b.ts', content: 'x' } },
        { toolId: 'edit', arguments: { path: '/repo/c.ts' } },
      ]),
    ])).toEqual({
      read: ['/repo/a.ts'],
      modified: ['/repo/b.ts', '/repo/c.ts'],
    })
  })

  it('历史会话里的旧参数名(file_path / filePath)照样认', () => {
    expect(collectCompactFileOperations([
      assistantWith([
        { toolId: 'read', arguments: { file_path: '/repo/legacy.ts', limit: 20 } },
        { toolId: 'edit', arguments: { filePath: '/repo/legacy2.ts' } },
      ]),
    ])).toEqual({
      read: ['/repo/legacy.ts'],
      modified: ['/repo/legacy2.ts'],
    })
  })

  it('bash 跳过 —— 路径藏在命令文本里,清单宁可少一条也不编一条', () => {
    expect(collectCompactFileOperations([
      assistantWith([
        { toolId: 'bash', arguments: { command: 'cat /repo/secret.ts > /tmp/out' } },
      ]),
    ])).toEqual({ read: [], modified: [] })
  })

  it('不是文件工具的一律不进清单;没有路径参数的调用也不进', () => {
    expect(collectCompactFileOperations([
      assistantWith([
        { toolId: 'grep', arguments: { pattern: 'x', path: '/repo' } },
        { toolId: 'find', arguments: { pattern: '**/*.ts', path: '/repo' } },
        { toolId: 'web_search', arguments: { query: 'x' } },
        { toolId: 'read', arguments: { offset: 0 } },
      ]),
    ])).toEqual({ read: [], modified: [] })
  })

  it('同一路径只记一次(保序);既读又改的两张清单都上', () => {
    expect(collectCompactFileOperations([
      assistantWith([
        { toolId: 'read', arguments: { path: '/repo/a.ts' } },
        { toolId: 'read', arguments: { path: '/repo/b.ts' } },
        { toolId: 'read', arguments: { path: '/repo/a.ts' } },
        { toolId: 'edit', arguments: { path: '/repo/a.ts' } },
      ]),
    ])).toEqual({
      read: ['/repo/a.ts', '/repo/b.ts'],
      modified: ['/repo/a.ts'],
    })
  })

  it('没有 toolCalls 的消息安全跳过', () => {
    expect(collectCompactFileOperations([{ toolCalls: undefined }, {}])).toEqual({
      read: [],
      modified: [],
    })
  })
})

describe('清单的格式化 / 回读 / 并集(core 侧通用函数)', () => {
  it('空清单省略对应标签;两张都空则一个字节都不附加', () => {
    expect(formatCompactFileOperations({ read: [], modified: [] })).toBe('')
    expect(formatCompactFileOperations({ read: ['/a'], modified: [] }))
      .toBe('\n\n<read-files>\n/a\n</read-files>')
    expect(formatCompactFileOperations({ read: [], modified: ['/b'] }))
      .toBe('\n\n<modified-files>\n/b\n</modified-files>')
    expect(formatCompactFileOperations({ read: ['/a'], modified: ['/b'] }))
      .toBe('\n\n<read-files>\n/a\n</read-files>\n\n<modified-files>\n/b\n</modified-files>')
  })

  it('回读上一份摘要尾部的两张清单', () => {
    const summary = `## Goal\nShip C5${formatCompactFileOperations({
      read: ['/a', '/b'],
      modified: ['/c'],
    })}`

    expect(extractCompactFileOperations(summary)).toEqual({
      read: ['/a', '/b'],
      modified: ['/c'],
    })
    expect(stripCompactFileOperations(summary)).toBe('## Goal\nShip C5')
  })

  it('并集去重且保序:旧的在前,新的追加', () => {
    expect(mergeCompactFileOperations(
      { read: ['/a', '/b'], modified: ['/c'] },
      { read: ['/b', '/z'], modified: ['/c', '/y'] },
    )).toEqual({
      read: ['/a', '/b', '/z'],
      modified: ['/c', '/y'],
    })
  })

  it('没有清单的摘要 strip 后原样(只去掉首尾空白)', () => {
    expect(stripCompactFileOperations('## Goal\nno lists\n')).toBe('## Goal\nno lists')
  })
})
