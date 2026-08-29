import { describe, expect, it } from 'vitest'
import {
  RECENT_LIMIT,
  fileExt,
  fileName,
  moveRow,
  nextScope,
  originText,
  recentRows,
  searchRows,
  targetText,
} from './transitions'
import { FILES } from './data'
import { SESSIONS } from '../expose/data'

/**
 * 「provider」是这批 mock 里唯一同时踩中四种命中的词:
 * 会话标题、会话正文、文件路径、文件里的一行 —— 所以排序与混排都能用它一次钉死。
 */
const Q = 'provider'

describe('searchRows(平铺 + 排序)', () => {
  it('空词一行不出 —— 空态是另一张列表,不是「搜了个空」', () => {
    expect(searchRows('', 'all')).toEqual([])
    expect(searchRows('   ', 'all')).toEqual([])
  })

  it('无结果就是空数组,不造占位行', () => {
    expect(searchRows('zzzzzz', 'all')).toEqual([])
  })

  it('标题 / 文件名 / 章节标题命中整段排在正文与代码行命中之前', () => {
    const rows = searchRows(Q, 'all')
    const lastTitle = rows.map((r) => r.tier).lastIndexOf('title')
    const firstBody = rows.map((r) => r.tier).indexOf('body')
    expect(lastTitle).toBeGreaterThanOrEqual(0)
    expect(firstBody).toBeGreaterThanOrEqual(0)
    expect(lastTitle).toBeLessThan(firstBody)
  })

  it('同级里会话与文件交替出现,不按类型分堆', () => {
    const titles = searchRows(Q, 'all').filter((r) => r.tier === 'title')
    expect(titles.map((r) => r.domain).slice(0, 2)).toEqual(['session', 'file'])
  })

  it('会话标题命中的出处是「项目名 · 时间」,徽是会话', () => {
    const row = searchRows(SESSIONS[0].title, 'sessions')[0]
    expect(row.badge).toEqual({ kind: 'session' })
    expect(row.tier).toBe('title')
    expect(originText(row.origin)).toBe(`onething · ${SESSIONS[0].time}`)
  })

  it('文件里的一行是代码行:等宽、出处是「文件名:行号」、目标带行号', () => {
    const row = searchRows('catalogCache', 'files')[0]
    expect(row.code).toBe(true)
    expect(row.badge).toEqual({ kind: 'file', ext: 'TS' })
    expect(originText(row.origin)).toBe('model-registry.ts:96')
    expect(row.target).toEqual({
      kind: 'file',
      path: 'packages/onething-runtime/src/providers/model-registry.ts',
      line: 96,
    })
  })
})

describe('scope 过滤', () => {
  it('会话档只出会话行', () => {
    const rows = searchRows(Q, 'sessions')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.domain === 'session')).toBe(true)
  })

  it('文件档只出文件行', () => {
    const rows = searchRows(Q, 'files')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.domain === 'file')).toBe(true)
  })

  it('所有档 = 两侧之和', () => {
    expect(searchRows(Q, 'all').length).toBe(
      searchRows(Q, 'sessions').length + searchRows(Q, 'files').length,
    )
  })
})

describe('recentRows(空态的「最近打开」)', () => {
  it('会话与文件混排,长度封顶', () => {
    const rows = recentRows('all')
    expect(rows.length).toBe(RECENT_LIMIT)
    expect(rows.map((r) => r.domain).slice(0, 4)).toEqual(['session', 'file', 'session', 'file'])
  })

  it('行的解剖与命中行一样:徽 + 名称 + 出处(时间 / 路径)', () => {
    const [session, file] = recentRows('all')
    expect(session.text).toBe(SESSIONS[0].title)
    expect(originText(session.origin)).toBe(SESSIONS[0].time)
    expect(file.text).toBe('model-capability.ts')
    expect(originText(file.origin)).toBe(FILES[0].path)
  })

  it('scope 一样管空态', () => {
    expect(recentRows('files').every((r) => r.domain === 'file')).toBe(true)
    expect(recentRows('sessions').every((r) => r.domain === 'session')).toBe(true)
  })
})

describe('scope 轮转', () => {
  it('Tab 往前一圈回到原地', () => {
    expect(nextScope('all', 1)).toBe('sessions')
    expect(nextScope('sessions', 1)).toBe('files')
    expect(nextScope('files', 1)).toBe('all')
  })

  it('⇧Tab 反向', () => {
    expect(nextScope('all', -1)).toBe('files')
    expect(nextScope('files', -1)).toBe('sessions')
    expect(nextScope('sessions', -1)).toBe('all')
  })
})

describe('走行', () => {
  it('夹住两端,不回卷', () => {
    expect(moveRow(0, -1, 3)).toBe(0)
    expect(moveRow(2, 1, 3)).toBe(2)
    expect(moveRow(0, 1, 3)).toBe(1)
  })

  it('空列表永远停在 0', () => {
    expect(moveRow(0, 1, 0)).toBe(0)
  })
})

describe('路径与出处的拼法', () => {
  it('文件名与扩展徽', () => {
    expect(fileName('docs/design/provider-oop-2026-08.md')).toBe('provider-oop-2026-08.md')
    expect(fileExt('docs/design/provider-oop-2026-08.md')).toBe('MD')
    expect(fileExt('Makefile')).toBe('MAKEFILE')
  })

  it('五种出处各有各的拼法', () => {
    expect(originText({ kind: 'session', session: '重构' })).toBe('重构')
    expect(originText({ kind: 'fileLine', file: 'a.ts', line: 7 })).toBe('a.ts:7')
    expect(originText({ kind: 'projectTime', project: 'onething', time: '14:22' })).toBe(
      'onething · 14:22',
    )
    expect(originText({ kind: 'time', time: '昨天' })).toBe('昨天')
    expect(originText({ kind: 'path', path: 'a/b.ts' })).toBe('a/b.ts')
  })

  it('toast 报的落点与 fileLine 出处同一个拼法', () => {
    expect(targetText({ kind: 'file', path: 'a/b/c.ts', line: 12 })).toBe('c.ts:12')
  })
})
