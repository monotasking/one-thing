/**
 * A1 回归(M4,docs/design/agent-domain-model.md §4):一个被引用的 agent 从
 * agents.json 里消失之后,collab 执行链拿到的是「没有这个人」,而不是 default
 * agent 顶着它的位置。
 *
 * 旧世界里 `getAgent` 查无此人就回退 default,于是删掉小李之后一次驱动会起一条
 * 名叫「[执行] Default Agent」的会话、用 default 的人格答话、在房间里署着小李的
 * 名 —— 每个调用点都得自己写 `agent.id !== agentId` 才躲得过。
 *
 * 这条测试刻意用 **真的** agents store(其余 collab 测试一律 mock 掉 findAgent):
 * 要复现的现场正是「agents.json 里那一行没了」,把查找 mock 掉就等于把被测的
 * 东西换掉了。只有会话 store 是假的 —— 那是这条链的输出侧。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '@onething/runtime/logging'

interface FakeSession {
  id: string
  name: string
  kind?: string
  agentId?: string
  isArchived?: boolean
  collab?: { roomSessionId?: string }
  messages: unknown[]
}

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  currentSessionId: 'chat-user-was-here',
  created: [] as string[],
}))

vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return { ...actual, sessionAccess: actual.createSessionAccess({
    findMeta: id => mocks.sessions.get(id) as { ownerUserId?: string; ownerWorkspaceId?: string } | undefined,
  }) }
})

vi.mock('../../../store.js', () => ({
  // drive 现在要渲染用户署名(v3 V1),因此读一次设置里的身份。
  getSettings: () => ({}),
  updateSessionWorkingDirectory: vi.fn(),
  getSession: (id: string) => mocks.sessions.get(id),
  createSession: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    mocks.currentSessionId = id
    return session
  },
  // 幕后建会话走"不动 current 指针"的那个变体:真实 store 里它建完把指针原样
  // 还原,所以这里就是"会话建了、指针没动"。
  createSessionWithoutFocus: (id: string, name: string) => {
    const session: FakeSession = { id, name, messages: [] }
    mocks.sessions.set(id, session)
    mocks.created.push(id)
    return session
  },
  getCurrentSessionId: () => mocks.currentSessionId,
  setCurrentSessionId: (id: string) => { mocks.currentSessionId = id },
  updateSessionArchived: (id: string, archived: boolean) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.isArchived = archived
  },
  updateSessionAgent: (id: string, agentId: string) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (session) session.agentId = agentId
    return Boolean(session)
  },
  updateSessionCollab: (
    id: string,
    fields: { kind?: string | null; collab?: { roomSessionId?: string } | null },
  ) => {
    const session = mocks.sessions.get(id) as FakeSession | undefined
    if (!session) return false
    if (fields.kind !== undefined) session.kind = fields.kind ?? undefined
    if (fields.collab !== undefined) session.collab = fields.collab ?? undefined
    return true
  },
}))

const { ensureCollabAgentSession } = await import('../agent-session.js')
const { displayAgent, findAgent, getAgent, invalidateAgentsCache } =
  await import('../../agents/index.js')
const { getOnethingAgentsPath } = await import('@onething/runtime/storage')

let previousStorePath: string | undefined
let tempStore: string

function writeAgents(agents: Array<{ id: string; name: string }>): void {
  const agentsPath = getOnethingAgentsPath()
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true })
  fs.writeFileSync(agentsPath, JSON.stringify({
    version: 1,
    agents: [
      { id: 'default', name: 'Default Agent', systemPrompt: '', isDefault: true, createdAt: 1, updatedAt: 1 },
      ...agents.map(agent => ({ ...agent, systemPrompt: '', createdAt: 1, updatedAt: 1 })),
    ],
  }))
  // 进程级单例带内存缓存 —— 外部改了文件必须显式作废(生产里 UI 的删除走
  // deleteAgent,同样落在这个 store 上)。
  invalidateAgentsCache()
}

beforeEach(() => {
  previousStorePath = process.env.ONETHING_STORE_PATH
  tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-collab-agent-gone-'))
  process.env.ONETHING_STORE_PATH = tempStore
  mocks.sessions.clear()
  for (const id of ['room-1', 'room-2']) mocks.sessions.set(id, { id, name: id, kind: 'room', messages: [] })
  mocks.created.length = 0
  mocks.currentSessionId = 'chat-user-was-here'
  invalidateAgentsCache()
})

afterEach(() => {
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  invalidateAgentsCache()
  fs.rmSync(tempStore, { recursive: true, force: true })
})

describe('collab 执行链:被删掉的 agent 不再被 default 冒充', () => {
  it('删掉 agent 之后驱动拿到 null,没有会话被起成 default 的名字', () => {
    writeAgents([{ id: 'fe', name: '小李' }])

    expect(ensureCollabAgentSession('fe', 'room-1')).toBe('agent-exec-fe-room-1')
    expect((mocks.sessions.get('agent-exec-fe-room-1') as FakeSession).name).toBe('[执行] 小李')

    // 用户在 Agents 面板删掉小李,房间里还留着对它的引用。
    writeAgents([])

    expect(findAgent('fe')).toBeNull()
    expect(ensureCollabAgentSession('fe', 'room-2')).toBeNull()
    // 第二次驱动一条会话都没造出来。
    expect(mocks.created).toEqual(['agent-exec-fe-room-1'])
    expect([...mocks.sessions.values()].map(session => (session as FakeSession).name))
      .not.toContain('[执行] Default Agent')
  })

  it('旧世界的冒充只剩 deprecated 通道能复现,并且带 warn 埋点', () => {
    writeAgents([])
    // 埋点已经不是 console 的副作用,而是一条记录(L4)。
    const logs = captureRuntimeLogs()

    expect(getAgent('fe').id).toBe('default')
    const warned = logs.ofLevel('warn')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.fields?.agentId).toBe('fe')

    logs.restore()
  })

  it('渲染侧拿到「已注销」墓碑,而不是 default 的名字头像', () => {
    writeAgents([])

    expect(displayAgent('fe')).toEqual({
      id: 'fe',
      name: '已注销',
      kind: 'colleague',
      status: 'retired',
    })
  })
})
