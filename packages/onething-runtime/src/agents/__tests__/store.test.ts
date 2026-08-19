import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureRuntimeLogs } from '../../logging/index.js'
import {
  DEFAULT_ONETHING_AGENT_ID,
  createOnethingAgentStore,
} from '../store.js'

let tempDir: string
let agentsPath: string
let timestamp: number

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-agents-test-'))
  agentsPath = path.join(tempDir, 'agents.json')
  timestamp = 1_700_000_000_000
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createStore() {
  return createOnethingAgentStore({
    agentsPath,
    now: () => timestamp,
  })
}

describe('createOnethingAgentStore', () => {
  it('initializes and persists a protected default agent', async () => {
    const store = createStore()
    await store.initialize()

    const agents = store.listAgents()

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      id: DEFAULT_ONETHING_AGENT_ID,
      name: 'Default Agent',
      systemPrompt: '',
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    expect(JSON.parse(fs.readFileSync(agentsPath, 'utf-8')).agents[0]).toMatchObject({
      id: DEFAULT_ONETHING_AGENT_ID,
      isDefault: true,
    })
    // 解析纪律(M4):查无此人 = null,不是 default 冒充。deprecated 通道的
    // fallback 行为在下面「A1 解析纪律」里单独盯。
    expect(store.findAgent('missing')).toBeNull()
    expect(store.defaultAgent().id).toBe(DEFAULT_ONETHING_AGENT_ID)
    expect(store.agentExists(DEFAULT_ONETHING_AGENT_ID)).toBe(true)
    expect(() => store.deleteAgent(DEFAULT_ONETHING_AGENT_ID)).toThrow('Default Agent cannot be deleted')
  })

  it('creates, updates, persists, and deletes custom agents', () => {
    const store = createStore()

    const created = store.createAgent({
      id: 'agent-research',
      name: 'Research',
      systemPrompt: 'Prefer concise source-backed answers.',
    })
    timestamp += 1
    const updated = store.updateAgent({
      agentId: created.id,
      name: 'Research Lead',
      systemPrompt: 'Ask one clarifying question before deep research.',
    })

    expect(created.id).toBe('agent-research')
    expect(store.agentExists(created.id)).toBe(true)
    expect(updated.name).toBe('Research Lead')
    expect(updated.updatedAt).toBe(timestamp)
    expect(JSON.parse(fs.readFileSync(agentsPath, 'utf-8')).agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-research',
          name: 'Research Lead',
        }),
      ]),
    )

    store.deleteAgent(created.id)

    expect(store.agentExists(created.id)).toBe(false)
    expect(store.listAgents().map(agent => agent.id)).toEqual([DEFAULT_ONETHING_AGENT_ID])
  })

  it('persists, updates, and clears the tool allowlist', () => {
    const store = createStore()

    const created = store.createAgent({
      id: 'agent-dj',
      name: 'DJ',
      tools: ['bash', 'bash', ' time ', ''],
    })
    expect(created.tools).toEqual(['bash', 'time'])

    // Survives a JSON round-trip (normalizeFile must carry the field).
    expect(createStore().requireAgent('agent-dj').tools).toEqual(['bash', 'time'])

    // Untouched by unrelated updates.
    const renamed = store.updateAgent({ agentId: 'agent-dj', name: 'DJ 2' })
    expect(renamed.tools).toEqual(['bash', 'time'])

    const restricted = store.updateAgent({ agentId: 'agent-dj', tools: ['bash'] })
    expect(restricted.tools).toEqual(['bash'])

    const cleared = store.updateAgent({ agentId: 'agent-dj', tools: null })
    expect(cleared.tools).toBeUndefined()
    expect(createStore().requireAgent('agent-dj').tools).toBeUndefined()
  })

  it('round-trips every capability-profile field through disk', () => {
    const store = createStore()
    const created = store.createAgent({
      id: 'agent-ops',
      name: 'Ops',
      systemPrompt: 'Careful.',
      tools: ['bash'],
      toolGrants: ['collab-work'],
      permissionMode: 'normal',
      maxTurns: 300,
      model: { providerId: 'claude', modelId: 'sonnet' },
    })

    const expected = {
      tools: ['bash'],
      toolGrants: ['collab-work'],
      permissionMode: 'normal',
      maxTurns: 300,
      model: { providerId: 'claude', modelId: 'sonnet' },
    }
    expect(created).toMatchObject(expected)
    // A fresh store re-reads and re-normalizes: a field the normalizer forgets
    // is silently dropped here rather than at the call site.
    expect(createStore().requireAgent('agent-ops')).toMatchObject(expected)

    const updated = store.updateAgent({ agentId: 'agent-ops', maxTurns: 20, permissionMode: null })
    expect(updated.maxTurns).toBe(20)
    expect(updated.permissionMode).toBeUndefined()
    expect(updated.toolGrants).toEqual(['collab-work'])

    // Nonsense values normalize away rather than reaching the engine.
    expect(store.updateAgent({ agentId: 'agent-ops', maxTurns: 0 }).maxTurns).toBeUndefined()
    expect(store.updateAgent({ agentId: 'agent-ops', maxTurns: -3 }).maxTurns).toBeUndefined()
  })

  /**
   * The picture avatar is a SECOND field, not a wider `avatar`
   * (docs/design/todo2-fix-plan.md P2): eight text surfaces render `avatar`
   * verbatim, so a media file name in there would print as characters. This
   * pins the pair as independent — and pins the clear, because a user who picks
   * a picture and changes their mind has no other way back to the emoji.
   */
  it('carries avatarImage independently of the emoji avatar, and clears it on null', () => {
    const store = createStore()
    const created = store.createAgent({
      id: 'agent-face',
      name: 'Face',
      avatar: '🔧',
      avatarImage: 'a1b2c3.png',
    })

    expect(created).toMatchObject({ avatar: '🔧', avatarImage: 'a1b2c3.png' })
    // A fresh store re-normalizes from disk: a field normalizeFile forgets dies here.
    expect(createStore().requireAgent('agent-face')).toMatchObject({
      avatar: '🔧',
      avatarImage: 'a1b2c3.png',
    })

    // Blank input normalizes away rather than persisting an empty reference.
    expect(store.createAgent({ id: 'agent-blank', name: 'Blank', avatarImage: '   ' }).avatarImage)
      .toBeUndefined()

    // Setting one leaves the other alone.
    const repictured = store.updateAgent({ agentId: 'agent-face', avatarImage: 'd4e5f6.png' })
    expect(repictured).toMatchObject({ avatar: '🔧', avatarImage: 'd4e5f6.png' })
    expect(store.updateAgent({ agentId: 'agent-face', avatar: '🎯' })).toMatchObject({
      avatar: '🎯',
      avatarImage: 'd4e5f6.png',
    })

    // null clears the picture and leaves the emoji standing as the fallback.
    const cleared = store.updateAgent({ agentId: 'agent-face', avatarImage: null })
    expect(cleared.avatarImage).toBeUndefined()
    expect(cleared.avatar).toBe('🎯')
    expect(createStore().requireAgent('agent-face').avatarImage).toBeUndefined()
  })

  it('does not rewrite the agents file on repeated list reads', () => {
    const store = createStore()
    store.listAgents()

    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    writeSpy.mockClear()

    expect(store.listAgents()).toHaveLength(1)
    expect(writeSpy).not.toHaveBeenCalled()

    writeSpy.mockRestore()
  })

  it('reads the file once and serves later reads from the cache', () => {
    const seed = createStore()
    seed.createAgent({ id: 'agent-a', name: 'A' })

    const store = createStore()
    const readSpy = vi.spyOn(fs, 'readFileSync')

    // Whatever the shape of the read (readJsonFile → existsSync + readFileSync),
    // the second and third lookups must not touch the disk at all.
    expect(store.requireAgent('agent-a').id).toBe('agent-a')
    const readsAfterFirst = readSpy.mock.calls.length
    expect(readsAfterFirst).toBeGreaterThan(0)

    store.requireAgent('agent-a')
    store.requireAgent('agent-a')
    store.listAgents()

    expect(readSpy.mock.calls.length).toBe(readsAfterFirst)

    readSpy.mockRestore()
  })

  it('invalidate() picks up an external edit of agents.json', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })
    expect(store.requireAgent('agent-a').name).toBe('A')

    const raw = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'))
    raw.agents.find((agent: { id: string }) => agent.id === 'agent-a').name = 'Edited outside'
    fs.writeFileSync(agentsPath, JSON.stringify(raw))

    expect(store.requireAgent('agent-a').name).toBe('A')
    store.invalidate()
    expect(store.requireAgent('agent-a').name).toBe('Edited outside')
  })

  it('initialize() migrates a stale file shape exactly once', async () => {
    fs.writeFileSync(agentsPath, JSON.stringify({ agents: [{ id: 'agent-a', name: 'A' }] }))

    const store = createStore()
    await store.initialize()

    // The default agent + the normalized timestamps landed on disk.
    const persisted = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'))
    expect(persisted.version).toBe(1)
    expect(persisted.agents.map((agent: { id: string }) => agent.id))
      .toEqual([DEFAULT_ONETHING_AGENT_ID, 'agent-a'])

    const writeSpy = vi.spyOn(fs, 'writeFileSync')
    await store.initialize()
    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it('serializes concurrent updates instead of losing writes', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })
    store.createAgent({ id: 'agent-b', name: 'B' })

    store.updateAgent({ agentId: 'agent-a', name: 'A2' })
    store.updateAgent({ agentId: 'agent-b', name: 'B2' })

    const persisted = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'))
    expect(persisted.agents.map((agent: { name: string }) => agent.name))
      .toEqual(['Default Agent', 'A2', 'B2'])
    expect(createStore().listAgents().map(agent => agent.name))
      .toEqual(['Default Agent', 'A2', 'B2'])
  })
})

describe('A0 domain fields (kind/status/executor)', () => {
  it('persists the fields through create and survives a reload', () => {
    const store = createStore()
    store.createAgent({
      id: 'radio-dj',
      name: 'DJ',
      kind: 'service',
      status: 'active',
      executor: { type: 'external', connectorId: 'claude-code-agent' },
    })

    const reloaded = createStore().requireAgent('radio-dj')
    expect(reloaded.kind).toBe('service')
    expect(reloaded.status).toBe('active')
    expect(reloaded.executor).toEqual({ type: 'external', connectorId: 'claude-code-agent' })
  })

  it('keeps the fields absent on legacy rows and drops junk values on normalize', async () => {
    fs.writeFileSync(agentsPath, JSON.stringify({
      agents: [
        { id: 'legacy', name: 'Legacy' },
        {
          id: 'junky',
          name: 'Junky',
          kind: 'robot',
          status: 'zombie',
          executor: { type: 'external' },
        },
      ],
    }))
    const store = createStore()
    await store.initialize()

    // Absent stays absent — the colleague/active/native defaults live in the
    // predicates/projections, never in the persisted shape (zero migration).
    const legacy = store.requireAgent('legacy')
    expect(legacy.kind).toBeUndefined()
    expect(legacy.status).toBeUndefined()
    expect(legacy.executor).toBeUndefined()

    // Unknown enum values and a connectorless external executor are dropped.
    const junky = store.requireAgent('junky')
    expect(junky.kind).toBeUndefined()
    expect(junky.status).toBeUndefined()
    expect(junky.executor).toBeUndefined()
  })

  it('updateAgent sets and clears the fields without touching neighbours', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })

    store.updateAgent({ agentId: 'agent-a', kind: 'service', status: 'retired' })
    let agent = store.requireAgent('agent-a')
    expect(agent.kind).toBe('service')
    expect(agent.status).toBe('retired')

    // An unrelated patch leaves them alone; null clears back to absent.
    store.updateAgent({ agentId: 'agent-a', name: 'A2' })
    agent = store.requireAgent('agent-a')
    expect(agent.kind).toBe('service')
    expect(agent.status).toBe('retired')

    store.updateAgent({ agentId: 'agent-a', kind: null, status: null })
    agent = store.requireAgent('agent-a')
    expect(agent.kind).toBeUndefined()
    expect(agent.status).toBeUndefined()
  })
})

/**
 * A1 解析纪律(M4,docs/design/agent-domain-model.md §4)。
 *
 * 旧世界只有一个 `getAgent`,查无此人时静默回退 default——default agent 顶着
 * 别人的名字进 roster、进署名、进执行链。这一组盯住三态分家之后的每一态:
 * 严格查找返回 null、执行链 throw、渲染拿墓碑,以及「功能兜底」(default
 * persona)与「冒充 fallback」是两件事。
 */
describe('A1 解析纪律(M4 三态 API)', () => {
  it('findAgent 严格查找:命中返回本人,查无此人/空 id 返回 null', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })

    expect(store.findAgent('agent-a')?.id).toBe('agent-a')
    expect(store.findAgent('ghost')).toBeNull()
    expect(store.findAgent('')).toBeNull()
    expect(store.findAgent(undefined)).toBeNull()
    expect(store.findAgent(null)).toBeNull()
  })

  it('requireAgent 命中返回本人,查无此人 throw 且错误信息带 agentId', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })

    expect(store.requireAgent('agent-a').name).toBe('A')
    expect(() => store.requireAgent('ghost')).toThrow(/ghost/)
    // 空 id 也 throw:执行链没有「无所谓是谁」这回事。
    expect(() => store.requireAgent(undefined)).toThrow()
  })

  it('displayAgent 只给身份面,心智/能力面字段一个都不带出去', () => {
    const store = createStore()
    store.createAgent({
      id: 'agent-a',
      name: 'A',
      systemPrompt: 'secret persona',
      tools: ['bash'],
      title: '产品经理',
      avatar: '🧑‍💼',
      color: '#abcdef',
      description: '管需求',
      permissionMode: 'ask',
      maxTurns: 7,
    })

    const identity = store.displayAgent('agent-a')
    expect(identity).toEqual({
      id: 'agent-a',
      name: 'A',
      title: '产品经理',
      avatar: '🧑‍💼',
      avatarImage: undefined,
      color: '#abcdef',
      description: '管需求',
      // 投影里缺省已解析(旧数据无 kind/status)。
      kind: 'colleague',
      status: 'active',
    })
    expect(identity).not.toHaveProperty('systemPrompt')
    expect(identity).not.toHaveProperty('tools')
    expect(identity).not.toHaveProperty('permissionMode')
    expect(identity).not.toHaveProperty('maxTurns')
  })

  it('displayAgent 对 retired 返回真身,未知 id 返回「已注销」墓碑', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-gone', name: '小李', status: 'retired' })

    // 退休不是删除:身份面照旧,只是带着 status。
    expect(store.displayAgent('agent-gone')).toMatchObject({
      id: 'agent-gone',
      name: '小李',
      status: 'retired',
    })

    // 未知 id:渲染永不炸,但绝不套 default 的名字头像。
    expect(store.displayAgent('ghost')).toEqual({
      id: 'ghost',
      name: '已注销',
      kind: 'colleague',
      status: 'retired',
    })
    expect(store.displayAgent(undefined)).toEqual({
      id: '',
      name: '已注销',
      kind: 'colleague',
      status: 'retired',
    })
  })

  it('defaultAgent 是显式的功能兜底,agents.json 没有 default 行也拿得到', async () => {
    fs.writeFileSync(agentsPath, JSON.stringify({ agents: [{ id: 'agent-a', name: 'A' }] }))
    const store = createStore()
    await store.initialize()

    const agent = store.defaultAgent()
    expect(agent.id).toBe(DEFAULT_ONETHING_AGENT_ID)
    expect(agent.isDefault).toBe(true)
  })

  it('retire/restore 只翻 status,身份面一字不动;default 硬拒', () => {
    const store = createStore()
    store.createAgent({
      id: 'agent-a',
      name: '小李',
      systemPrompt: 'persona',
      title: '产品经理',
      avatar: '🧑‍💼',
      tools: ['bash'],
    })

    timestamp += 1
    const retired = store.retireAgent('agent-a')
    expect(retired.status).toBe('retired')
    // 身份/心智/能力三面全保留 —— 墓碑要能撑住历史署名与履历。
    expect(retired).toMatchObject({
      name: '小李',
      title: '产品经理',
      avatar: '🧑‍💼',
      systemPrompt: 'persona',
      tools: ['bash'],
    })
    expect(createStore().requireAgent('agent-a').status).toBe('retired')

    const restored = store.restoreAgent('agent-a')
    expect(restored.status).toBe('active')
    expect(restored.name).toBe('小李')
    expect(createStore().requireAgent('agent-a').status).toBe('active')

    // 主助理是「这个 app 本人」(M5):退休/删除两条路都堵。
    expect(() => store.retireAgent(DEFAULT_ONETHING_AGENT_ID)).toThrow('Default Agent cannot be retired')
    expect(() => store.restoreAgent(DEFAULT_ONETHING_AGENT_ID)).toThrow('Default Agent cannot be retired')
    expect(() => store.deleteAgent(DEFAULT_ONETHING_AGENT_ID)).toThrow('Default Agent cannot be deleted')
    expect(store.requireAgent(DEFAULT_ONETHING_AGENT_ID).status).toBeUndefined()

    expect(() => store.retireAgent('ghost')).toThrow('Agent not found')
  })

  it('deprecated getAgent 只在真的发生冒充 fallback 时 warn', () => {
    const store = createStore()
    store.createAgent({ id: 'agent-a', name: 'A' })
    const logs = captureRuntimeLogs()

    // 命中:正常路径不刷屏。
    expect(store.getAgent('agent-a').id).toBe('agent-a')
    expect(logs.ofLevel('warn')).toHaveLength(0)

    // 空 id:既有的功能兜底语义(无 agentId 会话的 persona),不算冒充。
    expect(store.getAgent(undefined).id).toBe(DEFAULT_ONETHING_AGENT_ID)
    expect(store.getAgent('').id).toBe(DEFAULT_ONETHING_AGENT_ID)
    expect(logs.ofLevel('warn')).toHaveLength(0)

    // 查无此人:这就是要烧掉的那条路,埋点带上 id。
    expect(store.getAgent('ghost').id).toBe(DEFAULT_ONETHING_AGENT_ID)
    const warns = logs.ofLevel('warn')
    expect(warns).toHaveLength(1)
    expect(warns[0].fields?.agentId).toBe('ghost')
    logs.restore()
  })
})
