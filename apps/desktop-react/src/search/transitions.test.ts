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
import type { SearchMaterial } from './transitions'
import type { FileSearchEntry } from '@shared/ipc/files'
import { CHAPTERS, SESSIONS } from '../data/__fixtures__/sessions'

/**
 * 「provider」同时踩中三种命中:会话标题、会话预览、文件路径 ——
 * 所以排序与混排都能用它一次钉死。
 *
 * 第四种(文件里的一行)在 D5 之后**不存在**:真实产地 `files.list` 是按名字
 * 找文件,给不出行号与行文,那两格随 mock 一起退役(见 transitions.ts 文件头)。
 */
const Q = 'provider'

/**
 * 文件侧素材 = `files.list` 交回来的那份 `entries`。这不是 mock 表的替身:
 * 它是**一次带词查询的结果**,所以它里面的每一条都已经是命中 —— 纯函数不再滤第二遍。
 */
const FILES: FileSearchEntry[] = [
  { path: '/repo/packages/onething-runtime/src/providers/model-capability.ts', type: 'file' },
  { path: '/repo/packages/onething-runtime/src/providers/model-registry.ts', type: 'file' },
  { path: '/repo/docs/design/provider-oop-2026-08.md', type: 'file' },
]

/**
 * 会话侧的时间在这一层已经是**拼好的那句话**(相对时间要查字典,纯函数不产
 * 界面字符串)。测试里给一个固定值就够 —— 这批用例验的是行的解剖,不是时间。
 */
const TIME = '14:22'
const material: SearchMaterial = {
  sessions: SESSIONS,
  chapters: CHAPTERS,
  files: FILES,
  timeOf: () => TIME,
}

describe('searchRows(平铺 + 排序)', () => {
  it('空词一行不出 —— 空态是另一张列表,不是「搜了个空」', () => {
    expect(searchRows('', 'all', material)).toEqual([])
    expect(searchRows('   ', 'all', material)).toEqual([])
  })

  it('无结果就是空数组,不造占位行', () => {
    expect(searchRows('zzzzzz', 'all', { ...material, files: [] })).toEqual([])
  })

  it('文件侧**不再滤第二遍** —— 后端已经按词滤过,壳再滤一遍就是两个产地各说一次', () => {
    // 词与素材刻意对不上(去抖窗口内会真的出现这一刻):素材照样原样转述。
    const rows = searchRows('zzzzzz', 'files', material)
    expect(rows.map((r) => r.origin)).toEqual(FILES.map((f) => ({ kind: 'path', path: f.path })))
  })

  it('文件侧只有 title 级的行 —— body 级(代码行)在真实产地上不存在', () => {
    const rows = searchRows(Q, 'files', material)
    expect(rows.length).toBe(FILES.length)
    expect(rows.every((r) => r.tier === 'title')).toBe(true)
    expect(rows.every((r) => r.code === false)).toBe(true)
  })

  it('文件落点不带行号 —— 不补一个 :1 去凑格式', () => {
    const row = searchRows(Q, 'files', material)[0]
    expect(row.target).toEqual({ kind: 'file', path: FILES[0].path })
    expect(targetText(row.target)).toBe(FILES[0].path)
  })

  it('接入目录那类命中用后端给的 label 当主文(没有才退回文件名)', () => {
    const labelled: FileSearchEntry[] = [
      { path: '/somewhere/notes', type: 'directory', source: 'note', label: '笔记' },
    ]
    expect(searchRows(Q, 'files', { ...material, files: labelled })[0].text).toBe('笔记')
  })

  it('标题 / 文件名 / 章节标题命中整段排在正文与代码行命中之前', () => {
    const rows = searchRows(Q, 'all', material)
    const lastTitle = rows.map((r) => r.tier).lastIndexOf('title')
    const firstBody = rows.map((r) => r.tier).indexOf('body')
    expect(lastTitle).toBeGreaterThanOrEqual(0)
    expect(firstBody).toBeGreaterThanOrEqual(0)
    expect(lastTitle).toBeLessThan(firstBody)
  })

  it('同级里会话与文件交替出现,不按类型分堆', () => {
    const titles = searchRows(Q, 'all', material).filter((r) => r.tier === 'title')
    expect(titles.map((r) => r.domain).slice(0, 2)).toEqual(['session', 'file'])
  })

  it('会话标题命中的出处是「项目名 · 时间」,徽是会话', () => {
    const row = searchRows(SESSIONS[0].title, 'sessions', material)[0]
    expect(row.badge).toEqual({ kind: 'session' })
    expect(row.tier).toBe('title')
    expect(originText(row.origin)).toBe(`start-electron · ${TIME}`)
  })

  it('文件命中的徽是扩展名、主文是文件名、出处是整条路径', () => {
    const row = searchRows(Q, 'files', material)[1]
    expect(row.badge).toEqual({ kind: 'file', ext: 'TS' })
    expect(row.text).toBe('model-registry.ts')
    expect(originText(row.origin)).toBe(FILES[1].path)
  })
})

describe('scope 过滤', () => {
  it('会话档只出会话行', () => {
    const rows = searchRows(Q, 'sessions', material)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.domain === 'session')).toBe(true)
  })

  it('文件档只出文件行', () => {
    const rows = searchRows(Q, 'files', material)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.domain === 'file')).toBe(true)
  })

  it('所有档 = 两侧之和', () => {
    expect(searchRows(Q, 'all', material).length).toBe(
      searchRows(Q, 'sessions', material).length + searchRows(Q, 'files', material).length,
    )
  })
})

describe('recentRows(空态的「最近」)', () => {
  it('只有会话,长度封顶', () => {
    const rows = recentRows('all', material)
    expect(rows.length).toBe(RECENT_LIMIT)
    expect(rows.every((r) => r.domain === 'session')).toBe(true)
  })

  it('行的解剖与命中行一样:徽 + 名称 + 出处(时间)', () => {
    const [session] = recentRows('all', material)
    expect(session.text).toBe(SESSIONS[0].title)
    expect(originText(session.origin)).toBe(TIME)
  })

  /*
   * D5 的诚实缺口:「最近打开的文件」在后端没有产地。空词去 files.list 拿回来的
   * 是工作目录里随便前 N 个文件,把它叫「最近」就是编 —— 所以这一侧恒空,
   * **哪怕素材里有东西**(下面第二条断言正是钉这一点)。
   */
  it('文件侧恒空 —— 素材里有东西也不出行', () => {
    expect(recentRows('files', material)).toEqual([])
    expect(recentRows('all', material).some((r) => r.domain === 'file')).toBe(false)
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

  it('带行号的落点与 fileLine 出处同一个拼法;不带行号就是整条路径', () => {
    expect(targetText({ kind: 'file', path: 'a/b/c.ts', line: 12 })).toBe('c.ts:12')
    expect(targetText({ kind: 'file', path: 'a/b/c.ts' })).toBe('a/b/c.ts')
  })
})

/**
 * D1:会话侧接真数据之后新增/改变的三条判据。
 */
describe('会话侧的素材(D1)', () => {
  it('章节只在**已经拉到手**的那份缓存里找 —— 没拉过的会话不会凭空多出行', () => {
    const q = '摸清三处读取点'
    expect(searchRows(q, 'sessions', { ...material, chapters: {} })).toEqual([])
    const rows = searchRows(q, 'sessions', material)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('os-provider:chapter:seg-1:title')
    expect(rows[0].badge).toEqual({ kind: 'message' })
  })

  it('预览(第一条用户消息)是正文级命中,不因为挂在会话头上就升级', () => {
    const rows = searchRows('15487', 'sessions', material)
    expect(rows.map((r) => r.tier)).toEqual(['body'])
    expect(rows[0].badge).toEqual({ kind: 'message' })
  })

  it('不属于任何项目的会话,出处只剩时间', () => {
    const rows = searchRows('随手记', 'sessions', material)
    expect(originText(rows[0].origin)).toBe(TIME)
  })

  it('消息正文搜不到 —— D1 的诚实缺口(后端没有跨会话内容检索面)', () => {
    // 「记一下今天的三件事」是 previewText,搜得到;真正的第二条、第三条消息搜不到。
    expect(searchRows('记一下今天', 'sessions', material).length).toBe(1)
  })
})
