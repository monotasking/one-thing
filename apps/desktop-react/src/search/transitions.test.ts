import { describe, expect, it } from 'vitest'
import {
  SEARCH_FIRST_PAGE,
  browseRows,
  fileExt,
  fileName,
  moreState,
  moveRow,
  nextScope,
  originText,
  pageWindow,
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

/**
 * 空词 = **浏览态**(09-01 用户裁定推翻了从前那张硬截 8 条的「最近」)。
 * 用户原话:「我要能够在这里面看到所有的条数,所有的记录,要能够翻页」。
 */
describe('browseRows(空词的浏览列表)', () => {
  it('全部会话,一条不截 —— 截断只发生在渲染层的分页窗口里', () => {
    const rows = browseRows('all', material)
    expect(rows.length).toBe(SESSIONS.length)
    expect(rows.every((r) => r.domain === 'session')).toBe(true)
  })

  /*
   * 这一条钉的是「数据层不许自己先截一刀」:它一截,底下那句「共 N 条」报的就是
   * 一个自己刚截过的数 —— 用户看到的「所有的条数」会是假的。
   */
  it('会话再多也全给 —— 超量(500 条)一条不少', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...SESSIONS[0], id: `bulk-${i}` }))
    expect(browseRows('all', { ...material, sessions: many }).length).toBe(500)
  })

  it('次序照现状:与入参那张表逐条同序,一次都不重排', () => {
    expect(browseRows('all', material).map((r) => r.text)).toEqual(SESSIONS.map((s) => s.title))
  })

  it('行的解剖与命中行一样:徽 + 名称 + 出处(时间)', () => {
    const [session] = browseRows('all', material)
    expect(session.text).toBe(SESSIONS[0].title)
    expect(originText(session.origin)).toBe(TIME)
  })

  /*
   * D5 的诚实缺口(09-01 复核后**保留**):「最近打开的文件」在后端没有产地。
   * 会话侧能从「最近 8 条」放开到「全部」,是因为它的产地(整张 listMeta)本来就是
   * 全量的;文件侧没有这样一个产地 —— 空词去 files.list 拿回来的是工作目录里随便
   * 前 N 个文件。所以这一侧恒空,**哪怕素材里有东西**(第二条断言正是钉这一点)。
   */
  it('文件侧恒空 —— 素材里有东西也不出行(没有产地,不伪造)', () => {
    expect(browseRows('files', material)).toEqual([])
    expect(browseRows('all', material).some((r) => r.domain === 'file')).toBe(false)
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

/**
 * 底部那一行的判据表。后端只有 limit 没有游标,于是「还有没有更多」这件事
 * 全部压在 `files`(文件侧四态)上 —— 这一组就是那张表逐格的读法。
 *
 * 08-31 拍板:这一行在**搜索态下常驻**。从前「第一页装得下就什么都不画」把
 * 「有几条」变成了翻过页的人才配知道的事,现在它要么是按钮要么是读数,但一直在。
 */
describe('moreState:底部那一行说什么', () => {
  const base = { searching: true, page: 1, total: SEARCH_FIRST_PAGE + 5, files: 'exhausted' as const }

  /*
   * 09-01 再收一格:空词从前落 'none'(于是那张列表既没总数也不能翻页),
   * 现在它是浏览态 —— 'none' 只剩「一条都没有」这唯一一格。
   */
  it("'none' 只剩一格:一条都没有", () => {
    expect(moreState({ ...base, total: 0 }).kind).toBe('none')
    expect(moreState({ ...base, total: 0, searching: false }).kind).toBe('none')
    // 空词 + 有行 = 浏览态,底下照样有一行东西。
    expect(moreState({ ...base, searching: false }).kind).not.toBe('none')
  })

  it('文件侧取尽 = 总数是知道的,于是计数照实写', () => {
    expect(moreState(base)).toEqual({
      kind: 'more',
      shown: SEARCH_FIRST_PAGE,
      total: SEARCH_FIRST_PAGE + 5,
    })
  })

  it('文件侧「给满了」不等于「还有」—— 总数不知道就是 null,不猜一个数', () => {
    expect(moreState({ ...base, files: 'more' })).toEqual({
      kind: 'more',
      shown: SEARCH_FIRST_PAGE,
      total: null,
    })
  })

  /*
   * 「不许诺」说的是**不写「加载更多」**(那是一句「后面还有」的断言),
   * 不是「什么都不说」:此刻这几条是会话侧已经定了的数,照实报出来。
   */
  it('第一页没落定就不许诺,但条数照实报 —— 报数不是许诺', () => {
    expect(moreState({ ...base, total: 3, files: 'pending' })).toEqual({ kind: 'count', shown: 3 })
  })

  it('第一页文件侧塌了:那句「没搜成」归列表上面那行,这条 item 是重试的入口', () => {
    // 塌了 = 这一半从没答过话,所以「还有没有更多」是不知道 —— 于是 total 为 null。
    expect(moreState({ ...base, total: 3, files: 'failed' })).toEqual({
      kind: 'more',
      shown: 3,
      total: null,
    })
  })

  it('翻过页之后,加载中与失败由这条 item 自己说', () => {
    expect(moreState({ ...base, page: 2, files: 'pending' }).kind).toBe('loading')
    expect(moreState({ ...base, page: 2, files: 'failed' }).kind).toBe('error')
  })

  it('全都装下 + 文件侧取尽 = 「共 N 条 · 已全部显示」', () => {
    expect(moreState({ ...base, page: 2 })).toEqual({ kind: 'end', total: SEARCH_FIRST_PAGE + 5 })
  })

  /*
   * 08-31 拍板的那一格:从前这里返回 'none'(理由是「一条按不动的按钮让人犹豫」),
   * 结果第一页就装得下的那些搜索 —— 也就是绝大多数 —— 屏幕上一个数都没有,
   * 「共 N 条」成了翻过页的人才看得到的东西。它是**读数**不是按钮,所以第一页就该在。
   */
  it('第一页就取尽也照样说「共 N 条」—— 读数不必等翻页', () => {
    expect(moreState({ ...base, total: 3 })).toEqual({ kind: 'end', total: 3 })
    // 只看会话那一档(文件侧恒定「取尽」)同样落在这一格。
    expect(moreState({ ...base, total: SEARCH_FIRST_PAGE })).toEqual({
      kind: 'end',
      total: SEARCH_FIRST_PAGE,
    })
  })

  /*
   * 全遍历。从前是 4 文件态 × 2 页 × 3 条数 = 24 格(只有搜索态);
   * 09-01 空词进表,乘上 searching 两值 = **48 格**。
   */
  const FILES_SIDES = ['exhausted', 'more', 'pending', 'failed'] as const
  const PAGES = [1, 2]
  const TOTALS = [1, SEARCH_FIRST_PAGE, SEARCH_FIRST_PAGE + 5]
  const GRID = [true, false].flatMap((searching) =>
    FILES_SIDES.flatMap((files) =>
      PAGES.flatMap((page) => TOTALS.map((total) => ({ searching, page, total, files }))),
    ),
  )

  it('48 格全遍历:只要有行,底下就一定有一行东西 —— 没有一格是 none', () => {
    expect(GRID.length).toBe(48)
    for (const input of GRID) {
      expect(moreState(input).kind, JSON.stringify(input)).not.toBe('none')
    }
  })

  /*
   * 浏览态的那 24 格:行全部来自会话侧(整表在手),所以「还有没有更多」这件事
   * **不去问文件侧** —— 四种文件态给出同一个答案,而且永远不会是加载中 / 失败
   * (浏览态一次请求都不发,拿这两句去吓人就是编)。
   */
  it('浏览态的 24 格与文件侧无关,而且只可能是 more / end 两种', () => {
    for (const input of GRID.filter((x) => !x.searching)) {
      const got = moreState(input)
      expect(['more', 'end'], JSON.stringify(input)).toContain(got.kind)
      expect(moreState({ ...input, files: 'exhausted' }), JSON.stringify(input)).toEqual(got)
    }
  })

  it('浏览态:装不下就是「加载更多 · 已显示 a / 共 b」,总数当场就知道(不是 null)', () => {
    expect(moreState({ searching: false, page: 1, total: 500, files: 'pending' })).toEqual({
      kind: 'more',
      shown: SEARCH_FIRST_PAGE,
      total: 500,
    })
  })

  it('浏览态:翻到装得下的那一页就换成读数「共 N 条 · 已全部显示」', () => {
    const total = pageWindow(2)
    expect(moreState({ searching: false, page: 2, total, files: 'failed' })).toEqual({
      kind: 'end',
      total,
    })
  })
})
