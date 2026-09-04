/**
 * S6 —— `search` 工具自己那一层(设计 docs/design/search-index-2026-09.md §14)。
 *
 * 这里问的全是「工具**翻译**得对不对」:参数 → 查询、主体 → 检索主体、
 * 预览载荷 → 文本、注册表 → 描述。真索引 / 真授权在
 * `backend/wiring/search/__tests__/` 那两份里(store 级),不在这一层重测。
 *
 * 端口是手搓的 —— `RunContext` 里没有引擎、没有 store(尺子⑤),所以这份用例
 * 一个 mock 框架都不用。
 */

import { describe, expect, it } from 'vitest'
import { RunContext, ToolRunner } from '@onething/core/toolkit'
import type {
  Authorizer,
  Invocation,
  Outcome,
  Scene,
  SessionSnapshot,
} from '@onething/core/toolkit'
import type { Principal } from '@onething/core/permission'
import { Decision } from '@onething/core/toolkit'
import { AbortScope, OutputBudget } from '@onething/core/toolkit'
import {
  configureSearchToolAdapters,
  createSearchTool,
  parseSearchTime,
  renderPreview,
  searchDescription,
} from '../builtin/search.js'
import type {
  SearchToolAdapters,
  SearchToolPage,
  SearchToolPrincipal,
  SearchToolQuery,
} from '../builtin/search.js'
import { ZodValidator } from '../contract.js'

/** 一次调用记下的东西 —— 用例问的是「工具递给适配器什么」。 */
interface Recorder {
  queries: Array<{ query: SearchToolQuery; principal: SearchToolPrincipal }>
  previews: string[]
}

function fakeAdapters(options: {
  kinds?: string[]
  page?: SearchToolPage
  preview?: { kind: string; payload: unknown; title?: string }
  fail?: Error
} = {}): { adapters: SearchToolAdapters; recorder: Recorder } {
  const recorder: Recorder = { queries: [], previews: [] }
  const adapters: SearchToolAdapters = {
    listKinds: () => options.kinds ?? ['chats', 'messages'],
    async search(query, principal) {
      recorder.queries.push({ query, principal })
      if (options.fail !== undefined) throw options.fail
      return options.page ?? { hits: [] }
    },
    async preview(ref) {
      recorder.previews.push(ref)
      if (options.preview === undefined) throw new Error('画不出预览')
      return options.preview
    },
  }
  return { adapters, recorder }
}

function invocationFor(input: unknown, principal: Principal, sessionId = 's-here'): Invocation {
  return { callId: 'c1', toolId: 'search', input, sessionId, principal }
}

function contextFor(principal: Principal, spaceId = 'space-a', sessionId = 's-here'): RunContext {
  const session: SessionSnapshot = { id: sessionId, metadata: { workspaceId: spaceId } }
  return new RunContext({
    invocation: invocationFor({}, principal, sessionId),
    abort: new AbortScope(),
    budget: new OutputBudget(),
    session,
  })
}

const allow: Authorizer = { async decide() { return Decision.allow() } }

/** 走完整条生命周期(校验 → plan → 授权 → apply),与真机同一条路。 */
async function run(
  input: unknown,
  principal: Principal = { kind: 'agent', agentId: 'a1' },
  spaceId = 'space-a',
): Promise<Outcome> {
  const runner = new ToolRunner({
    observer: { on: () => {} },
    authorizer: allow,
    validator: new ZodValidator(),
    session: () => ({ id: 's-here', metadata: { workspaceId: spaceId } }),
  })
  return await runner.run(createSearchTool(), invocationFor(input, principal))
}

function textOf(outcome: Outcome): string {
  const result = outcome.kind === 'ok' ? outcome.result : undefined
  return (result?.content ?? [])
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('\n')
}

/** `Result.details` —— 只有 `ok` 那一支有。 */
function detailsOf(outcome: Outcome): Record<string, unknown> | undefined {
  return outcome.kind === 'ok' ? outcome.result.details : undefined
}

describe('描述里的 kind 清单来自注册表', () => {
  it('注销一个能力,描述就少一项(工具源码里没有能力名)', () => {
    expect(searchDescription(['chats', 'messages', 'files'])).toContain('chats, messages, files')
    expect(searchDescription(['chats', 'messages'])).not.toContain('files')
  })

  it('一个能力都没有时说实话,而不是印一份空清单', () => {
    expect(searchDescription([])).toContain('this host has no search index')
  })

  it('spec 每次现算 —— 适配器换了清单,下一回合的描述就跟着换', () => {
    const tool = createSearchTool()
    const first = configureSearchToolAdapters(fakeAdapters({ kinds: ['chats', 'messages'] }).adapters)
    expect(tool.spec.description).toContain('chats, messages')
    first()

    const second = configureSearchToolAdapters(fakeAdapters({ kinds: ['chats'] }).adapters)
    expect(tool.spec.description).toContain('chats')
    expect(tool.spec.description).not.toContain('messages')
    second()
  })
})

describe('适配器没装', () => {
  it('结构化答「不可用」,不抛 —— 「这台宿主没有搜索」不是一次工具失败', async () => {
    const outcome = await run({ query: '上次那个 bug' })
    expect(outcome.kind).toBe('ok')
    expect(textOf(outcome)).toContain('search unavailable')
    expect(detailsOf(outcome)).toMatchObject({ ok: false, reason: 'no-adapters' })
  })
})

describe('参数 → 查询', () => {
  it('scope:"session" 收窄到本会话;缺省与 "all" 都不加会话过滤(只能收窄,不能放宽)', async () => {
    const { adapters, recorder } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)

    await run({ query: 'x', scope: 'session' })
    await run({ query: 'x' })
    await run({ query: 'x', scope: 'all' })

    expect(recorder.queries[0].query.sessionId).toBe('s-here')
    expect(recorder.queries[1].query.sessionId).toBeUndefined()
    expect(recorder.queries[2].query.sessionId).toBeUndefined()
    restore()
  })

  it('limit 缺省 8、上限 20(上限由契约挡,超了根本进不来)', async () => {
    const { adapters, recorder } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)

    await run({ query: 'x' })
    expect(recorder.queries[0].query.limit).toBe(8)

    // 契约挡在 plan 之前:超上限的调用**根本到不了适配器**。
    const tooBig = await run({ query: 'x', limit: 50 })
    expect(tooBig.kind).toBe('invalid')
    expect(recorder.queries).toHaveLength(1)
    restore()
  })

  it('kind 原样递下去 —— 认不认识由注册表答,不是工具答', async () => {
    const { adapters, recorder } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)
    await run({ query: 'x', kind: 'symbol' })
    expect(recorder.queries[0].query.capability).toBe('symbol')
    restore()
  })
})

describe('主体从调用坐标上来(§14.3)', () => {
  it('agent / user 各自搬过去,spaceId 从会话快照的 workspaceId 上读', async () => {
    const { adapters, recorder } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)

    await run({ query: 'x' }, { kind: 'agent', agentId: 'a1' }, 'space-a')
    await run({ query: 'x' }, { kind: 'user', userId: 'local' }, 'space-b')

    expect(recorder.queries[0].principal).toEqual({ kind: 'agent', id: 'a1', sessionId: 's-here', spaceId: 'space-a' })
    expect(recorder.queries[1].principal).toEqual({ kind: 'user', id: 'local', sessionId: 's-here', spaceId: 'space-b' })
    restore()
  })

  it('system 主体读成 agent,不是 user —— 兜底不许继承用户的可见范围', async () => {
    const { adapters, recorder } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)
    await run({ query: 'x' }, { kind: 'system', component: 'scheduler' })
    expect(recorder.queries[0].principal.kind).toBe('agent')
    expect(recorder.queries[0].principal.id).toBe('system:scheduler')
    restore()
  })
})

describe('输出', () => {
  const page: SearchToolPage = {
    hits: [
      { ref: 'messages:msg:s1:m1', capability: 'messages', id: 'msg:s1:m1', title: '那个 bug', subtitle: '开局', time: 1_780_000_000_000 },
      { ref: 'chats:chat:s1', capability: 'chats', id: 'chat:s1', title: '开局' },
    ],
    total: 7,
    relaxed: 2,
    pending: 3,
  }

  it('每条一行,末行是「说实话那三格」', async () => {
    const { adapters } = fakeAdapters({ page })
    const restore = configureSearchToolAdapters(adapters)
    const text = textOf(await run({ query: 'bug' }))

    expect(text).toContain('[messages:msg:s1:m1] messages · 那个 bug')
    expect(text).toContain('[chats:chat:s1] chats · 开局')
    expect(text).toContain('total 7 · relaxed 2 · index pending 3')
    restore()
  })

  it('没放宽 / 索引没欠账时不印那两格(恒印一句 relaxed 0 是在制造噪音)', async () => {
    const { adapters } = fakeAdapters({ page: { hits: page.hits, total: 2, relaxed: 0, pending: 0 } })
    const restore = configureSearchToolAdapters(adapters)
    const text = textOf(await run({ query: 'bug' }))
    expect(text).toContain('total 2')
    expect(text).not.toContain('relaxed')
    expect(text).not.toContain('pending')
    restore()
  })

  it('零命中照实说,total 仍是授权之后的真数', async () => {
    const { adapters } = fakeAdapters({ page: { hits: [], total: 0 } })
    const restore = configureSearchToolAdapters(adapters)
    const text = textOf(await run({ query: 'bug' }))
    expect(text).toContain('Nothing matched')
    expect(text).toContain('total 0')
    restore()
  })

  it('适配器抛了 → ok:false + 原话,不把整只工具打成崩溃', async () => {
    const { adapters } = fakeAdapters({ fail: new Error('索引起不来') })
    const restore = configureSearchToolAdapters(adapters)
    const outcome = await run({ query: 'bug' })
    expect(outcome.kind).toBe('ok')
    expect(textOf(outcome)).toContain('索引起不来')
    restore()
  })
})

describe('expand —— 四种预览载荷各转成文本', () => {
  it('message-context:前后各两条对话原文,命中那条标出来', () => {
    const text = renderPreview({
      kind: 'message-context',
      title: '开局',
      payload: {
        sessionId: 's1',
        messageId: 'm2',
        hit: { id: 'm2', role: 'assistant', text: '是索引没建' },
        before: [{ id: 'm1', role: 'user', text: '为什么搜不到' }],
        after: [{ id: 'm3', role: 'user', text: '那重建一下' }],
      },
    })
    expect(text).toContain('user: 为什么搜不到')
    expect(text).toContain('>>> assistant: 是索引没建')
    expect(text).toContain('user: 那重建一下')
  })

  it('session-overview:标题 / 条数 / 时间', () => {
    const text = renderPreview({
      kind: 'session-overview',
      payload: { sessionId: 's1', title: '开局', messageCount: 12, updatedAt: 1_780_000_000_000, preview: '第一句' },
    })
    expect(text).toContain('开局')
    expect(text).toContain('12 messages')
    expect(text).toContain('第一句')
  })

  it('note-excerpt:带行号片段', () => {
    const text = renderPreview({
      kind: 'note-excerpt',
      payload: { path: '/notes/a.md', title: '今天', excerpt: '第一行\n第二行' },
    })
    expect(text).toContain('/notes/a.md')
    expect(text).toContain('  1 | 第一行')
    expect(text).toContain('  2 | 第二行')
  })

  it('file-excerpt:只有路径(后端刻意不读正文)', () => {
    expect(renderPreview({ kind: 'file-excerpt', payload: { path: '/repo/a.ts' } })).toContain('/repo/a.ts')
  })

  it('认不出的形 → JSON 缩排,而不是一句「不支持」(新能力带来新形是常态)', () => {
    const text = renderPreview({ kind: 'symbol-def', payload: { symbol: 'createSearchTool', file: 'search.ts' } })
    expect(text).toContain('createSearchTool')
    expect(text).toContain('search.ts')
  })

  it('expand 走 preview 路,不再搜一次', async () => {
    const { adapters, recorder } = fakeAdapters({
      preview: { kind: 'file-excerpt', payload: { path: '/repo/a.ts' } },
    })
    const restore = configureSearchToolAdapters(adapters)
    const text = textOf(await run({ query: 'x', expand: 'files:/repo/a.ts' }))
    expect(recorder.previews).toEqual(['files:/repo/a.ts'])
    expect(recorder.queries).toHaveLength(0)
    expect(text).toContain('/repo/a.ts')
    restore()
  })

  it('展不开 → ok:false + 原话', async () => {
    const { adapters } = fakeAdapters()
    const restore = configureSearchToolAdapters(adapters)
    const outcome = await run({ query: 'x', expand: 'messages:gone' })
    expect(textOf(outcome)).toContain('画不出预览')
    expect(detailsOf(outcome)).toMatchObject({ ok: false })
    restore()
  })
})

describe('时间', () => {
  const now = Date.parse('2026-09-05T00:00:00Z')

  it('相对量与 ISO 都认', () => {
    expect(parseSearchTime('7d', now)).toBe(now - 7 * 86_400_000)
    expect(parseSearchTime('2w', now)).toBe(now - 14 * 86_400_000)
    expect(parseSearchTime('2026-09-01', now)).toBe(Date.parse('2026-09-01'))
  })

  it('认不出就缺席,不抛 —— 一个解析不了的时间不该把整次搜索打掉', () => {
    expect(parseSearchTime('前天下午', now)).toBeUndefined()
    expect(parseSearchTime(undefined, now)).toBeUndefined()
  })
})

describe('场景面', () => {
  it('普通聊天 / goal / task / 协作房都可见 —— 越权由 messages 的 agent 支挡,不靠这只工具自觉', () => {
    const tool = createSearchTool()
    const scenes: Scene[] = [
      { kind: 'chat', venue: 'chat' },
      { kind: 'chat', venue: 'chat', goalActive: true },
      { kind: 'chat', venue: 'chat', taskSession: true },
      { kind: 'room', venue: 'room' },
      { kind: 'agent', venue: 'agent' },
      { kind: 'work', venue: 'work' },
    ]
    for (const scene of scenes) expect(tool.visibleIn(scene)).toBe(true)
  })
})

describe('这只工具**零副作用**', () => {
  it('effects 是空的 —— 它是 ReadOnlyTool 一族,降级档也给得起', () => {
    expect(createSearchTool().spec.effects).toEqual([])
  })

  it('提示词写事实不写回避指令', () => {
    const prompt = createSearchTool().spec.prompt
    expect(prompt?.guidelines?.join('\n')).toContain('先用 search 查')
  })
})

/** `contextFor` 只是给下面这条用的:手搓 RunContext 也能单测任何工具(尺子⑤)。 */
describe('手搓 RunContext', () => {
  it('spaceId 缺席时是空串,与投影器写进 facet 的缺省一致', async () => {
    const ctx = new RunContext({
      invocation: invocationFor({}, { kind: 'agent', agentId: 'a1' }),
      abort: new AbortScope(),
      budget: new OutputBudget(),
    })
    expect(ctx.session?.metadata).toBeUndefined()
    // 有会话快照时读得到
    expect(contextFor({ kind: 'agent', agentId: 'a1' }).session?.metadata?.workspaceId).toBe('space-a')
  })
})
