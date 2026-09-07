/**
 * `history` 的 app 接线（docs/design/collab-history-search.md §S3）。
 *
 * 这个文件守的第一条是**授权**：多给一条 = 一位同事读到它不该读的对话，
 * 这是本方案唯一不可逆的失败。其余的（游标、截断、兜底）错了会难看，
 * 授权错了会出事，所以授权的用例放在最前面且最多。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindSessionFacadeMock } from '../../../session/testing/facade-mock.js'

const DAY = 86_400_000
const NOW = new Date(2026, 7, 2, 12, 0, 0).getTime()

const mocks = vi.hoisted(() => ({
  bodyReads: [] as string[],
  sessions: new Map<string, any>(),
  metas: [] as any[],
}))

// P0.2 ③:业务代码改走 `sessionCommands` / `sessionReads`,而它们静态依赖真的
// `app/stores/sessions.ts`(→ settings → paths → 整棵存储树)。这两扇门换成共用替身,
// 读写落在下面同一份假会话表上 —— 与迁移前 `store.js` 假表的语义逐条对齐。
vi.mock('../../../session/reads.js', () => import('../../../session/testing/facade-mock.js'))
vi.mock('../../../session/commands.js', () => import('../../../session/testing/facade-mock.js'))
bindSessionFacadeMock((id: string) => { mocks.bodyReads.push(id); return mocks.sessions.get(id) })

vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({
    findMeta: id => mocks.metas.find(meta => meta.id === id) ?? mocks.sessions.get(id),
  }) }
})

vi.mock('../../../store.js', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  getSessionsList: () => mocks.metas,
  getSettings: () => ({ general: {} }),
}))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => ({}) }))
vi.mock('../../agents/index.js', () => ({
  findAgent: (id: string) => {
    const names: Record<string, string> = { iris: 'Iris', bram: 'Bram', nova: 'Nova' }
    return names[id] ? { id, name: names[id] } : null
  },
  listAgents: () => [
    { id: 'iris', name: 'Iris' },
    { id: 'bram', name: 'Bram' },
    { id: 'nova', name: 'Nova' },
  ],
}))
vi.mock('../user-identity.js', () => ({
  resolveUserIdentity: () => ({ label: 'songyitian', handle: '666666' }),
}))
// 直接读盘那一支在测试里没有真实文件 —— 让它落到 store 兜底分支，
// 转录数据仍然由上面的 store mock 提供（读盘与否是性能问题，不是语义问题）。
vi.mock('@onething/runtime/storage', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/runtime/storage')>(),
  getOnethingSessionsDir: () => '/nonexistent-for-tests',
}))

const { searchCollabHistory } = await import('../history-tool.js')

function say(id: string, agentId: string | undefined, content: string, at: number) {
  return {
    id,
    role: agentId ? 'assistant' : 'user',
    ...(agentId ? { agentId } : {}),
    content,
    timestamp: at,
    source: agentId ? 'collab-say' : 'text',
  }
}

function room(id: string, name: string, members: string[], messages: any[], extra: any = {}) {
  const meta = { id, name, kind: 'room', updatedAt: NOW, room: { memberAgentIds: members, ...extra } }
  mocks.metas.push(meta)
  mocks.sessions.set(id, { ...meta, messages })
  return meta
}

beforeEach(() => {
  mocks.bodyReads.length = 0
  mocks.sessions = new Map()
  mocks.metas = []
  // Iris 的执行会话（工具的 ctx.sessionId）
  mocks.sessions.set('exec-iris', { id: 'exec-iris', kind: 'agent', agentId: 'iris' })

  room('cumo', 'cumo', ['iris', 'bram', 'nova'], [
    say('c1', undefined, '用户：开局', NOW - 2 * DAY),
    say('c2', 'iris', 'Iris：我来当上帝', NOW - DAY),
    say('c3', 'bram', 'Bram：收到', NOW - 1000),
  ])
  room('dm-iris-bram', 'Bram ⇄ Iris', ['bram', 'iris'], [
    say('d1', 'iris', '🐺 你的身份：狼人', NOW - DAY),
    say('d2', 'bram', '收到', NOW - DAY + 1000),
  ], { dm: true })
  // Iris 不在场的房 —— 一条都不该出现
  room('dm-bram-nova', 'Bram ⇄ Nova', ['bram', 'nova'], [
    say('x1', 'bram', '别人之间的悄悄话', NOW - DAY),
  ], { dm: true })
})

/**
 * 给一条会话/房间盖归属章。
 *
 * 归属判定的规则是「两格都空 = 无主,谁都读得到」(工单 4 A3 修回 HEAD 语义):
 * **不盖章的房间是公共的**,不是「归 local-user 私有」。所以下面三条授权用例要验
 * 「别人的房读不到」,就必须把别人的房**明确盖成别人的** —— 拿不盖章冒充私有,
 * 验的是一条不存在的规则。
 */
function ownedBy(id: string, userId: string, workspaceId: string): void {
  const owner = { ownerUserId: userId, ownerWorkspaceId: workspaceId }
  Object.assign(mocks.sessions.get(id) ?? {}, owner)
  const meta = mocks.metas.find(entry => entry.id === id)
  if (meta) Object.assign(meta, owner)
}

/** 出厂那三间房都盖成 bob 的;要归 alice 的那几间由用例自己再盖。 */
function stampFixtureRoomsForeign(): void {
  for (const id of ['cumo', 'dm-iris-bram', 'dm-bram-nova']) ownedBy(id, 'bob', 'tenant-b')
}

const search = (over: Record<string, unknown> = {}) =>
  searchCollabHistory({ sessionId: 'exec-iris', limit: 30, ...over } as any)

const text = (r: any) => (r.entries ?? []).map((e: any) => e.line).join('\n')

describe('授权（多给一条就是事故）', () => {
  it('uses the separate invocation context through the real history adapter, ignoring identity in tool arguments', async () => {
    const executionContext = { userId: 'alice', workspaceId: 'tenant-a' }
    stampFixtureRoomsForeign()
    ownedBy('exec-iris', 'alice', 'tenant-a')
    ownedBy('cumo', 'alice', 'tenant-a')
    const { historyAdapters } = await import('../../toolkit/adapters.js')
    const { createHistoryTool, ZodValidator } = await import('@onething/runtime/toolkit')
    const { ToolRunner, Decision } = await import('@onething/core/toolkit')
    const runner = new ToolRunner({
      authorizer: { async decide() { return Decision.allow() } },
      observer: { on() {} }, validator: new ZodValidator(),
    })
    const result = await runner.run(createHistoryTool(historyAdapters()), {
      callId: 'history-owner', toolId: 'history', sessionId: 'exec-iris', messageId: 'message',
      principal: undefined as never,
      input: { limit: 30, executionContext: { userId: 'local-user', workspaceId: 'default' } },
      executionContext,
    })
    expect(result.kind).toBe('ok')
    const output = result.kind === 'ok' ? JSON.stringify(result.result) : ''
    expect(output).toContain('我来当上帝')
    expect(output).not.toContain('你的身份')
    expect(new Set(mocks.bodyReads)).toEqual(new Set(['cumo']))
    // 这条用例在体内动态 import 整棵 toolkit(实测编译约 5s,正压在 vitest 默认
    // 单例预算线上)。给它自己的预算,免得按机器忙闲随机红 —— 红的会是编译时间。
  }, 60_000)

  it('filters the same agent across owners and tenants before reading room bodies or counting them', async () => {
    const executionContext = { userId: 'alice', workspaceId: 'tenant-a' }
    stampFixtureRoomsForeign()
    ownedBy('exec-iris', 'alice', 'tenant-a')
    for (const [id, userId, tenant] of [
      ['own', 'alice', 'tenant-a'], ['other-user', 'bob', 'tenant-a'], ['other-tenant', 'alice', 'tenant-b'],
    ]) {
      const meta = room(id, id, ['iris'], [say(`${id}-message`, 'iris', `${id}-secret`, NOW)])
      Object.assign(meta, { ownerUserId: userId, ownerWorkspaceId: tenant })
      Object.assign(mocks.sessions.get(id), { ownerUserId: userId, ownerWorkspaceId: tenant })
    }
    const result = await searchCollabHistory({ sessionId: 'exec-iris', limit: 30 }, { executionContext })
    expect(text(result)).toContain('own-secret')
    expect(text(result)).not.toContain('other-user-secret')
    expect(text(result)).not.toContain('other-tenant-secret')
    expect(result.scannedRooms).toBe(1)
    expect(new Set(mocks.bodyReads)).toEqual(new Set(['own']))
    mocks.bodyReads.length = 0
    const unknown = await searchCollabHistory({ sessionId: 'exec-iris', limit: 30, where: 'other-user' }, { executionContext })
    expect(unknown.unknownRoom?.available).toEqual(['own'])
    expect(unknown.entries).toEqual([])
    expect(mocks.bodyReads).toEqual([])
  })

  it('rejects a foreign source before any transcript read', async () => {
    // 执行会话**明确归 bob**:无主会话是公共的,拿它冒充「别人的」验不出东西。
    ownedBy('exec-iris', 'bob', 'tenant-b')
    await expect(searchCollabHistory({ sessionId: 'exec-iris', limit: 30 }, {
      executionContext: { userId: 'alice', workspaceId: 'tenant-a' },
    })).rejects.toThrow('Session not found')
    expect(mocks.bodyReads).toEqual([])
  })

  it('只返回我在场的房；别人之间的私聊一条都不返回', async () => {
    const r = await search()
    expect(text(r)).toContain('我来当上帝')
    expect(text(r)).toContain('你的身份')
    expect(text(r)).not.toContain('别人之间的悄悄话')
  })

  it('被移出的房只到 removedAt 为止', async () => {
    const removedAt = NOW - DAY - 500
    room('old', '老群', ['bram'], [
      say('o1', 'bram', '移出之前说的', removedAt - 1000),
      say('o2', 'bram', '移出之后说的', removedAt + 1000),
    ], { formerMembers: [{ agentId: 'iris', removedAt }] })

    const r = await search({ where: '老群' })
    expect(text(r)).toContain('移出之前说的')
    expect(text(r)).not.toContain('移出之后说的')
  })

  it('where 指向我不在的房 → 不存在，而且清单里没有那间', async () => {
    const r = await search({ where: 'Bram ⇄ Nova' })
    expect(r.entries).toEqual([])
    expect(r.unknownRoom).toBeTruthy()
    expect(r.unknownRoom?.available).not.toContain('Bram ⇄ Nova')
    expect(r.unknownRoom?.available).toContain('cumo')
  })

  it('where 解析不到时不静默降级成全房搜索', async () => {
    const r = await search({ where: '压根没有这间房' })
    expect(r.unknownRoom).toBeTruthy()
    expect(r.entries).toEqual([])
  })

  it('一间房都进不去 → noRooms', async () => {
    mocks.metas = []
    const r = await search()
    expect(r.noRooms).toBe(true)
  })

  it('会话没有同事身份 → 拒绝，不默认放行', async () => {
    mocks.sessions.set('plain', { id: 'plain', kind: 'chat' })
    const r = await searchCollabHistory({ sessionId: 'plain', limit: 10 } as any)
    expect(r.ok).toBe(false)
  })

  /**
   * 场子门。`agentId` 单独一个不够用:每条新建会话都被盖上 `agentId: 'default'`,
   * 而默认 agent 没有工具白名单 ⇒ 注册表里每个工具它都看得见。网关(微信/Telegram)
   * 按远端身份建的会话正是这个形状 —— 少了这道门,对面那位陌生联系人一句话就能
   * 把用户和主助理的私聊全文拿走。与 `dm` 同一道门(dm-tool.ts);2026-08-03(C3-6)
   * 起「同一道门」不再靠人肉维持,两边共用 `venue.ts` 那一份判定。
   */
  it('普通 chat 会话即便带着 agentId 也拒绝 —— 网关那条路径就是这个形状', async () => {
    mocks.sessions.set('gateway', { id: 'gateway', agentId: 'default' })
    mocks.metas.push({
      id: 'agent-dm-default', name: 'Default Agent', kind: 'room', updatedAt: NOW,
      room: { memberAgentIds: ['default'], dm: true },
    })
    mocks.sessions.set('agent-dm-default', {
      id: 'agent-dm-default', name: 'Default Agent', kind: 'room',
      room: { memberAgentIds: ['default'], dm: true },
      messages: [say('p1', 'default', '用户跟主助理说的私事', NOW - 1000)],
    })

    const r = await searchCollabHistory({ sessionId: 'gateway', limit: 10 } as any)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('群聊/私聊/工作台')
    expect(JSON.stringify(r)).not.toContain('私事')
  })

  /**
   * 场子门等价(架构收敛 C3-6)。上面那条钉的是最贵的一格,这条钉的是整张表:
   * 手写的 kind 三连否定换成统一判定之后,五种会话的判定结果逐一不变。
   *
   * 注意 `work`:工作台**是**能查历史的,而 `COLLAB_WORK_REQUIRED_TOOLS` 里并没有
   * `history` —— 这正是场子门不能从工具地板反推的实证(见 collab/tool-surface.ts)。
   */
  it('场子门等价:room/agent/work 通,chat 与 kind 缺席拒', async () => {
    mocks.sessions.set('room-turn', { id: 'cumo', kind: 'room', agentId: 'iris' })
    mocks.sessions.set('work-iris', {
      id: 'work-iris', kind: 'work', agentId: 'iris', collab: { roomSessionId: 'cumo' },
    })
    mocks.sessions.set('chat-iris', { id: 'chat-iris', kind: 'chat', agentId: 'iris' })
    mocks.sessions.set('gateway-iris', { id: 'gateway-iris', agentId: 'iris' })

    const outcomes: Array<[string, boolean]> = []
    for (const sessionId of ['room-turn', 'exec-iris', 'work-iris', 'chat-iris', 'gateway-iris']) {
      const r = await searchCollabHistory({ sessionId, limit: 10 } as any)
      outcomes.push([sessionId, r.ok !== false])
    }
    expect(outcomes).toEqual([
      ['room-turn', true],
      ['exec-iris', true],
      ['work-iris', true],
      ['chat-iris', false],
      ['gateway-iris', false],
    ])
  })
})

describe('过滤', () => {
  it('where 用「名字#句柄」= 我和 TA 的私聊', async () => {
    const r = await search({ where: 'Bram' })
    expect(text(r)).toContain('你的身份')
    expect(text(r)).not.toContain('我来当上帝')
  })

  it('who 认名字，也认用户', async () => {
    expect(text(await search({ who: 'Bram' }))).toContain('Bram：收到')
    expect(text(await search({ who: '用户' }))).toContain('用户：开局')
  })

  it('since / until 按天', async () => {
    const day = (at: number) => {
      const d = new Date(at); const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    const r = await search({ since: day(NOW) })
    expect(text(r)).toContain('Bram：收到')
    expect(text(r)).not.toContain('用户：开局')
  })

  it('drive / 思考记录 / 运营系统行不是聊天记录，不出现在结果里', async () => {
    room('noise', '噪声房', ['iris'], [
      { id: 'n1', role: 'user', source: 'collab', content: '<turn agent="Iris">驱动行</turn>', timestamp: NOW },
      { id: 'n2', role: 'assistant', agentId: 'iris', source: 'collab-turn', content: '内部盘算', timestamp: NOW },
      { id: 'n3', role: 'system', source: 'collab', content: '他们连着聊了 6 条，我先按住了', timestamp: NOW },
      { id: 'n4', role: 'system', source: 'collab-task', content: '「某卡」进入评审', timestamp: NOW },
    ])
    const r = await search({ where: '噪声房' })
    const t = text(r)
    expect(t).not.toContain('驱动行')
    expect(t).not.toContain('内部盘算')
    expect(t).not.toContain('我先按住了')
    // MARKED 系统行是房间的事实，要留
    expect(t).toContain('进入评审')
    expect(t).toContain('系统')
  })
})

describe('关键词与兜底', () => {
  it('命中时只给命中的', async () => {
    const r = await search({ q: '身份' })
    expect(text(r)).toContain('你的身份')
    expect(text(r)).not.toContain('开局')
    expect(r.fellBackToRange).toBeFalsy()
  })

  it('没命中 → 不返回空，退回范围并标记', async () => {
    const r = await search({ q: '这句话谁都没说过' })
    expect(r.fellBackToRange).toBe(true)
    expect((r.entries ?? []).length).toBeGreaterThan(0)
  })

  it('范围本身为空时不兜底 —— 那是真的没有', async () => {
    const r = await search({ where: 'cumo', who: 'Nova', q: '随便' })
    expect(r.entries).toEqual([])
    expect(r.fellBackToRange).toBeFalsy()
  })
})

describe('分页与截断', () => {
  it('结果新的在前，带 room 属性', async () => {
    const r = await search()
    expect(r.entries?.[0]?.line).toContain('Bram：收到')
    expect(r.entries?.[0]?.line).toContain('room="cumo"')
  })

  it('游标翻页不重不漏，且严格更早', async () => {
    const first = await search({ limit: 2 })
    expect(first.entries).toHaveLength(2)
    const second = await search({ limit: 2, cursor: first.nextCursor })
    const ids = [...(first.entries ?? []), ...(second.entries ?? [])].map((e: any) => e.line)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('换了筛选条件的游标被拒绝，而不是被当成本次的续页', async () => {
    const first = await search({ limit: 2 })
    const wrong = await search({ limit: 2, cursor: first.nextCursor, q: '身份' })
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toContain('另一次查询')
  })

  it('读不懂的游标要报错，不能静默当成第一页', async () => {
    const bad = await search({ limit: 2, cursor: '这不是游标' })
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('读不懂')
  })

  /**
   * 锚点消失不是理论边角:候选房按 updatedAt 取前 10 间,两页之间任何一间房来一条
   * 新消息就可能把锚点所在的房挤出扫描集。按下标定位会返回一个空页,而空页被渲染
   * 成「这个范围里没有任何消息」——一个带确定性的否定,可消息明明还在。
   */
  it('锚点那条不在结果里了，续页照样正确（不能返回撒谎的空页）', async () => {
    const first = await search({ limit: 2 })
    const cursor = first.nextCursor!
    const anchorLine = first.entries!.at(-1)!.line

    // 锚点那条被删掉 —— 模拟它所在的房被挤出扫描集/消息被编辑
    for (const [id, session] of mocks.sessions) {
      if (!session?.messages) continue
      mocks.sessions.set(id, {
        ...session,
        messages: session.messages.filter((m: any) => !anchorLine.includes(m.content)),
      })
    }

    const second = await search({ limit: 2, cursor })
    expect(second.ok).toBe(true)
    expect((second.entries ?? []).length).toBeGreaterThan(0)
    // 且严格更早:第一页里出现过的内容不能再出现
    const firstBodies = first.entries!.map((e: any) => e.line)
    for (const entry of second.entries ?? []) expect(firstBodies).not.toContain(entry.line)
  })

  it('真的翻到尽头时说「翻完了」，而不是「什么都没有」', async () => {
    // cumo 三条 → 第一页两条 + 游标；随后把剩下那条删掉，第二页就是尽头
    const first = await search({ where: 'cumo', limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    const room = mocks.sessions.get('cumo')
    mocks.sessions.set('cumo', { ...room, messages: room.messages.slice(1) })

    const beyond = await search({ where: 'cumo', limit: 2, cursor: first.nextCursor })
    expect(beyond.entries).toEqual([])
    expect(beyond.endOfRange).toBe(true)
    // 「翻完了」要带上总数 —— 那才是这趟翻页的答案
    expect(beyond.total).toBeGreaterThan(0)
  })

  it('撞上字节上限丢掉的房也要计入 skippedRooms，不能静默', async () => {
    const big = 'x'.repeat(1_100_000)
    for (let i = 0; i < 10; i++) {
      const meta = { id: `big-${i}`, name: `大房 ${i}`, kind: 'room', updatedAt: NOW + 1000 + i, room: { memberAgentIds: ['iris'] } }
      mocks.metas.push(meta)
      mocks.sessions.set(meta.id, { ...meta, messages: [say(`b${i}`, 'iris', big, NOW - i)] })
    }
    const r = await search()
    // 8 MB 上限 ÷ 1.1 MB/间 → 扫不满 10 间
    expect(r.scannedRooms).toBeLessThan(10)
    // 真正要钉的是这条不变式:**扫过的 + 报出没扫的 = 我能进的全部**。
    // 旧写法在扫描前就把 skippedRooms 算死（只减房数上限），字节上限丢掉的房
    // 一个标记都不留 —— 那时这个等式对不上。
    const candidates = mocks.metas.filter(m => m.room?.memberAgentIds?.includes('iris')).length
    expect(r.scannedRooms! + r.skippedRooms!).toBe(candidates)
  })

  it('房太多时报出 skippedRooms', async () => {
    for (let i = 0; i < 15; i++) {
      room(`extra-${i}`, `房 ${i}`, ['iris'], [say(`e${i}`, 'iris', `第 ${i} 间`, NOW - i * 1000)])
    }
    const r = await search()
    expect(r.skippedRooms).toBeGreaterThan(0)
    expect(r.scannedRooms).toBeLessThanOrEqual(10)
  })
})
