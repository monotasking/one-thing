import { describe, expect, it } from 'vitest'
import type { ProjectedToolCall } from '../../model/segments'
import { resolveToolPresenter } from '../presenter'
import { presentToolStep } from '../../assemble/present'
// 表是模块级的:这一句把四个内建 presenter 注册上(与生产同一个 barrel)。
import '../presenters'

/**
 * presenter 表的单测(§5.1)。
 *
 * 每个 presenter 两问:**行说了什么**、**详情落成哪种块**。第三问由兜底那条钉着:
 * 没人认领的工具也得有诚实的展示。
 *
 * 这里的素材按**账本上真的那三种结局形态**造(见 `tools/result.ts` 顶部):规范形
 * `{content,details}`、工具自己那份 `{output,metadata}`、裸字符串。presenter 若只
 * 认得其中一种,屏幕上就会「成果词有时有有时没有」—— 那是最难查的一类 UI bug,
 * 所以它在这一层就得被钉住。
 */

const T0 = 1_700_000_000_000

function call(patch: Record<string, unknown> = {}): ProjectedToolCall {
  return {
    id: 'c1',
    toolId: 'read',
    toolName: 'read',
    arguments: {},
    status: 'completed',
    timestamp: T0,
    ...patch,
  } as unknown as ProjectedToolCall
}

const rowOf = (c: ProjectedToolCall) => resolveToolPresenter(c).row(c)
const detailOf = (c: ProjectedToolCall) => resolveToolPresenter(c).detail(c)

describe('read', () => {
  const base = {
    toolId: 'read',
    toolName: 'read',
    arguments: { path: '/repo/src/deep/App.tsx' },
  }

  it('行 = 文件名(全路径进 title),图标是文件', () => {
    const row = rowOf(call({ ...base }))
    expect(row).toMatchObject({ icon: 'FileText', name: 'App.tsx', title: '/repo/src/deep/App.tsx' })
  })

  it('成果词「N 行」读的是工具自己写的 lineCount(规范形)', () => {
    const row = rowOf(call({ ...base, result: { content: [], details: { lineCount: 42 } } }))
    expect(row.outcome).toEqual({ key: 'chat.tool.lines', vars: { n: 42 } })
  })

  it('工具自己那份 `{output, metadata}` 也认得 —— 三种形态一次认全', () => {
    const row = rowOf(call({ ...base, result: { output: 'x', metadata: { lineCount: 7 } } }))
    expect(row.outcome).toEqual({ key: 'chat.tool.lines', vars: { n: 7 } })
  })

  it('读不到行数就空着 —— 现数一遍输出的换行是另一个数,不是它说的那个', () => {
    expect(rowOf(call({ ...base, result: 'a\nb\nc' })).outcome).toBeUndefined()
  })

  it('detail = code 块,lang 按扩展名推,file 檐位是全路径', () => {
    const detail = detailOf(call({ ...base, result: { content: [{ type: 'text', text: 'const a = 1' }] } }))
    expect(detail).toEqual([
      { kind: 'code', lang: 'tsx', source: 'const a = 1', file: '/repo/src/deep/App.tsx', closed: true },
    ])
  })

  it('认不出的扩展名 = 素文本,不拿扩展名硬当语言', () => {
    const detail = detailOf(call({ ...base, arguments: { path: 'notes.xyz' }, result: 'hi' }))
    expect(detail[0]).toMatchObject({ lang: null })
  })

  it('失败时右端是后端那句原话,成果词不许盖掉它', () => {
    const row = rowOf(call({ ...base, status: 'failed', error: 'ENOENT: no such file', result: { details: { lineCount: 3 } } }))
    expect(row.outcome).toEqual({ text: 'ENOENT: no such file' })
  })
})

describe('edit / write', () => {
  const base = { toolId: 'edit', toolName: 'edit', arguments: { path: '/repo/a.ts' } }

  it('行 = 文件名 + 「+a −d」,统计取 changes(不去数 diff 文本)', () => {
    const row = rowOf(call({ ...base, changes: { filePath: '/repo/a.ts', additions: 12, deletions: 3, diff: '@@' } }))
    expect(row).toMatchObject({ icon: 'Pencil', name: 'a.ts' })
    expect(row.outcome).toEqual({ key: 'chat.tool.diffStat', vars: { add: 12, del: 3 } })
  })

  it('拿不到结构化统计就不显示 —— 不替引擎重算一遍', () => {
    expect(rowOf(call({ ...base, result: 'ok' })).outcome).toBeUndefined()
  })

  it('detail:有 diff 时落 diff 一等块(P2 留账在 P3 结清)', () => {
    const detail = detailOf(
      call({ ...base, changes: { filePath: '/repo/a.ts', diff: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx' } }),
    )
    expect(detail).toEqual([
      {
        kind: 'diff',
        file: '/repo/a.ts',
        source: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
        hunks: [
          {
            header: '@@ -1,2 +1,2 @@',
            oldStart: 1,
            newStart: 1,
            lines: [
              { kind: 'del', text: 'old' },
              { kind: 'add', text: 'new' },
              { kind: 'ctx', text: 'ctx' },
            ],
          },
        ],
        stat: { add: 1, del: 1 },
      },
    ])
  })

  it('±统计优先取引擎给的 changes,不用解析器数出来的那份(行与檐必须同一个数)', () => {
    const [block] = detailOf(
      call({ ...base, changes: { filePath: '/repo/a.ts', additions: 12, deletions: 3, diff: '+a\n-b' } }),
    )
    expect(block).toMatchObject({ kind: 'diff', stat: { add: 12, del: 3 } })
  })

  it('引擎给了看不出结构的方言时退回 code(lang:"diff")—— 降级,不报错', () => {
    const detail = detailOf(call({ ...base, changes: { filePath: '/repo/a.ts', diff: 'not really a diff' } }))
    expect(detail).toEqual([
      { kind: 'code', lang: 'diff', source: 'not really a diff', file: '/repo/a.ts', closed: true },
    ])
  })

  it('write 走同一个 presenter,没有 diff 时按扩展名画文件内容', () => {
    const detail = detailOf(
      call({ toolId: 'write', toolName: 'write', arguments: { path: 'x.json' }, result: { output: '{}' } }),
    )
    expect(detail).toEqual([{ kind: 'code', lang: 'json', source: '{}', file: 'x.json', closed: true }])
  })

  it('参数里没写路径时退到 changes 里那一份', () => {
    const row = rowOf(call({ toolId: 'edit', toolName: 'edit', arguments: {}, changes: { filePath: '/repo/b.ts' } }))
    expect(row).toMatchObject({ name: 'b.ts', title: '/repo/b.ts' })
  })
})

describe('bash', () => {
  const base = { toolId: 'bash', toolName: 'bash', arguments: { command: 'npm run test -- --run' } }

  it('行 = 命令首词 + 参数摘要(首词是「它是什么」,其余是「怎么做」)', () => {
    const row = rowOf(call({ ...base }))
    expect(row).toMatchObject({
      icon: 'Terminal',
      name: 'npm',
      summary: 'run test -- --run',
      title: 'npm run test -- --run',
    })
  })

  it('多行命令压成一行 —— 行上不许出现换行', () => {
    expect(rowOf(call({ ...base, arguments: { command: 'cd x\n&& ls' } }))).toMatchObject({
      name: 'cd',
      summary: 'x && ls',
    })
  })

  it('成果词 = 退出码语义:0 与非 0 是两句话', () => {
    expect(rowOf(call({ ...base, result: { output: '', metadata: { exitCode: 0 } } })).outcome)
      .toEqual({ key: 'chat.tool.exitOk' })
    expect(rowOf(call({ ...base, result: { output: '', metadata: { exitCode: 2 } } })).outcome)
      .toEqual({ key: 'chat.tool.exitCode', vars: { code: 2 } })
  })

  it('detail = 输出的 code 块,不推语言(终端输出不是任何一门语言)', () => {
    expect(detailOf(call({ ...base, result: { output: 'ok\n' } }))).toEqual([
      { kind: 'code', lang: null, source: 'ok\n', closed: true },
    ])
  })

  it('没有输出就不产块 —— 空 code 块比没有块更难读', () => {
    expect(detailOf(call({ ...base }))).toEqual([])
  })
})

describe('web_search / web_open', () => {
  it('search 的行 = 查询词', () => {
    const row = rowOf(call({ toolId: 'web_search', toolName: 'web_search', arguments: { query: 'react 19 用法' } }))
    expect(row).toMatchObject({ icon: 'Globe', name: 'react 19 用法' })
  })

  it('open 的行 = 域名(www 剥掉)—— 全 URL 的后半截多半是追踪参数', () => {
    const row = rowOf(call({ toolId: 'web_open', toolName: 'web_open', arguments: { url: 'https://www.example.com/a?utm=1' } }))
    expect(row).toMatchObject({ name: 'example.com', title: 'https://www.example.com/a?utm=1' })
  })

  it('URL 解析不了就原样用那串字符,不吞掉', () => {
    const row = rowOf(call({ toolId: 'web_open', toolName: 'web_open', arguments: { url: 'not a url' } }))
    expect(row.name).toBe('not a url')
  })

  it('成果词 = 结果条数(工具自己写的那几种数组认哪个算哪个)', () => {
    const row = rowOf(
      call({
        toolId: 'web_search',
        toolName: 'web_search',
        arguments: { query: 'x' },
        result: { output: '', metadata: { results: [1, 2, 3] } },
      }),
    )
    expect(row.outcome).toEqual({ key: 'chat.tool.results', vars: { n: 3 } })
  })

  it('detail = 结果摘要的纯文本块', () => {
    const detail = detailOf(
      call({ toolId: 'web_search', toolName: 'web_search', arguments: { query: 'x' }, result: { output: '1. a\n2. b' } }),
    )
    expect(detail).toEqual([{ kind: 'code', lang: null, source: '1. a\n2. b', closed: true }])
  })
})

describe('兜底:没人认领的工具零配置就有诚实的展示', () => {
  it('行 = 工具名 + 状态 + 耗时,图标是扳手', () => {
    const row = rowOf(call({ toolId: 'brand_new', toolName: 'brand_new', status: 'completed', durationMs: 90 }))
    expect(row).toMatchObject({ icon: 'Wrench', name: 'brand_new', durationMs: 90 })
    expect(row.outcome).toBeUndefined()
  })

  it('详情落 source-fallback:参数与结果 JSON 原样', () => {
    const detail = detailOf(call({ toolName: 'brand_new', toolId: 'brand_new', arguments: { a: 1 }, result: 'r' }))
    expect(detail[0]).toMatchObject({ kind: 'source-fallback', reason: 'tool-default' })
  })
})

/**
 * ── 报错那一行:抬头不许孤零零收在冒号上(09-01 自查走查)────────────────
 *
 * 后端几个内建工具的 `formatError` 是两段式:抬头一行(冒号收尾)+ 逐条理由。
 * 行上只放一句话,从前取的是**第一行** —— 屏幕上于是永远是
 * 「Invalid read parameters:」顶着一片空白(自查 shots/G-toolerr.png)。
 */
describe('失败行:一句话要说完', () => {
  const failed = (error: string) =>
    presentToolStep({
      id: 'c9', toolId: 'read', toolName: 'read', arguments: {},
      status: 'failed', timestamp: 0, error,
    } as never).row.outcome

  it('抬头 + 逐条理由 = 并成一句(去掉理由前的列表记号)', () => {
    expect(failed('Invalid read parameters:\n- path: Required\n\nUsage: read({ path })')).toEqual({
      text: 'Invalid read parameters: path: Required',
    })
  })

  it('抬头之后**真的没有下文** = 连冒号一起去掉,不留指向空处的标点', () => {
    expect(failed('Invalid read parameters:')).toEqual({ text: 'Invalid read parameters' })
    expect(failed('Invalid read parameters:\n\n')).toEqual({ text: 'Invalid read parameters' })
  })

  it('中文冒号同判(插件与 MCP 工具的报错常是中文的)', () => {
    expect(failed('参数不对:\n- path:必填')).toEqual({ text: '参数不对: path:必填' })
  })

  it('本来就是一句完整的话:一个字不动', () => {
    expect(failed('ENOENT: no such file or directory')).toEqual({
      text: 'ENOENT: no such file or directory',
    })
  })
})
