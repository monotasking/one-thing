import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@shared/ipc/search'
import {
  fileExt,
  fileName,
  itemRefOf,
  originText,
  resultRows,
  targetText,
} from './transitions'

/**
 * 检索面的纯函数(S4b 之后**只剩一条造行路**)。
 *
 * 这一批用例守的两件事,每一件都对着 §4.0 那张枚举点清账表的一格:
 *  · 造行只认后端的回执(`resultRows`);
 *  · 出处的拼法只有一处产地(`originText` / `targetText`)。
 *
 * ── 分页与分节那五组用例搬走了(迁移第 ⑤ 步)─────────────────────────────
 * `sectionsOf` / `sectionsWindow` / `flatRows` 归 `./sequence.test.ts`,
 * `remoteSide` / `pageWindow` / `moreState` 归 `./paging.test.ts` —— 它们验的是
 * **分节与分页**这两件事,而这两件事从这一批起各有自己的产地(`sequence.ts` /
 * `paging.ts`)。函数本体本批一个都没删(删旧是第 ⑨ 步),只是用例先按新家归位:
 * 到第 ⑨ 步删旧那一天,该跟着走的用例已经在它该在的文件里了。
 */

const result = (over: Partial<SearchResult> = {}): SearchResult => ({
  id: 'r1',
  type: 'message',
  title: '命中的那一行',
  target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
  ...over,
})

describe('resultRows(唯一那条造行路)', () => {
  it('出处取 subtitle,退到 detail —— 壳不去猜第三个产地', () => {
    expect(resultRows([result({ subtitle: '那间会话' })], 'messages')[0].origin)
      .toEqual({ kind: 'path', path: '那间会话' })
    expect(resultRows([result({ detail: '兜底那句' })], 'messages')[0].origin)
      .toEqual({ kind: 'path', path: '兜底那句' })
    // 两格都没有 = 空出处,而不是编一句话。
    expect(resultRows([result()], 'messages')[0].origin).toEqual({ kind: 'path', path: '' })
  })

  it('capability 是**入参**给的那一个 —— 行知道自己是谁产的(预览 / 分组都读它)', () => {
    expect(resultRows([result()], 'messages')[0].capability).toBe('messages')
  })

  it('没有 target 的丢掉 —— 一条按下去什么都不发生的行比不画更让人怀疑', () => {
    const orphan: SearchResult = { id: 'x', type: 'plugin', title: '没有落点' }
    expect(resultRows([orphan, result()], 'messages').map(r => r.id)).toEqual(['r1'])
  })

  it('高亮 / facets / inline 预览**原样驮着**,壳一格都不解释', () => {
    const row = resultRows([result({
      matchRanges: [{ start: 1, end: 3 }],
      facets: { archived: true, spaceId: 'w2', 认不得的键: 7 },
      preview: { kind: 'session-overview', payload: { sessionId: 's1' } },
    })], 'chats')[0]
    expect(row.highlight).toEqual([{ start: 1, end: 3 }])
    // **不认识不等于该丢掉**:认不得的键照样在。
    expect(row.facets).toEqual({ archived: true, spaceId: 'w2', 认不得的键: 7 })
    expect(row.preview?.kind).toBe('session-overview')
  })

  it('三格都缺席时**键也不在**(不是 undefined 占位)—— 与契约上的「缺席 = 不知道」同口径', () => {
    const row = resultRows([result()], 'messages')[0]
    expect('highlight' in row).toBe(false)
    expect('facets' in row).toBe(false)
    expect('preview' in row).toBe(false)
  })
})

describe('itemRefOf(预览 / 动作请求里那条 items)', () => {
  it('三格:能力 + 它自己那套 id + 目标载荷', () => {
    const row = resultRows([result()], 'messages')[0]
    expect(itemRefOf(row)).toEqual({
      capability: 'messages',
      id: 'r1',
      target: { kind: 'message', payload: { sessionId: 's1', messageId: 'm1' } },
    })
  })
})


describe('路径与出处', () => {
  it('fileName / fileExt:没有扩展名就把整个名字大写', () => {
    expect(fileName('/a/b/c.ts')).toBe('c.ts')
    expect(fileExt('/a/b/c.ts')).toBe('TS')
    expect(fileExt('/a/notebook')).toBe('NOTEBOOK')
  })

  it('originText:分隔符是标点不是文案', () => {
    expect(originText({ kind: 'fileLine', file: 'a.ts', line: 12 })).toBe('a.ts:12')
    expect(originText({ kind: 'projectTime', project: 'P', time: '刚刚' })).toBe('P · 刚刚')
    expect(originText({ kind: 'path', path: '/x/y' })).toBe('/x/y')
  })

  it('targetText:不带行号时**不补一个 :1** 去凑格式', () => {
    expect(targetText({ kind: 'file', payload: { filePath: '/a/b.ts' } })).toBe('/a/b.ts')
    expect(targetText({ kind: 'file', payload: { filePath: '/a/b.ts', line: 3 } })).toBe('b.ts:3')
  })
})

