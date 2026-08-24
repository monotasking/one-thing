/**
 * Agent 档案 CRUD 域,端到端穿过 dispatcher(主线 T1 第二批)。
 *
 * 钉的是与被删掉那两条线的等价:desktop 的 `@main/ipc/agents.ts` 和 server 的
 * `runtime.agents` 适配器都把 runtime 的 `*ForIpc` 一族当唯一实现,自己只递
 * 适配器。这里守的就是那份「只递不判」——尤其是「删除」的两条路(退休 vs 硬删)
 * 归 runtime 判,传输面不许自己加分支,以及引用检查吃的是 meta-only 的会话
 * 快索引(`getSessionsList`),不是会带出全部转录的 `getSessions`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentsRouter } from '@shared/ipc/agents.js'

const store = vi.hoisted(() => ({
  DEFAULT_AGENT_ID: 'default',
  agentExists: vi.fn(),
  createAgent: vi.fn(),
  deleteAgent: vi.fn(),
  listAgents: vi.fn(),
  restoreAgent: vi.fn(),
  retireAgent: vi.fn(),
  updateAgent: vi.fn(),
}))

const sessions = vi.hoisted(() => ({ getSessionsList: vi.fn() }))

vi.mock('../../wiring/agents/index.js', () => store)
vi.mock('../../stores/index.js', () => sessions)

const AGENT = {
  id: 'fe',
  name: '小李',
  systemPrompt: 'persona',
  createdAt: 1,
  updatedAt: 2,
}

async function loadDomain() {
  const [
    { dispatchRpc, registerRouterHandlers, resetRpcRegistryForTests },
    { agentsRpcHandlers },
  ] = await Promise.all([
    import('../registry.js'),
    import('../domains/agents.js'),
  ])
  return { dispatchRpc, resetRpcRegistryForTests, registerRouterHandlers, agentsRpcHandlers }
}

describe('agents RPC domain', () => {
  let dispose: (() => void) | undefined

  beforeEach(async () => {
    store.listAgents.mockReset().mockReturnValue([AGENT])
    store.createAgent.mockReset().mockImplementation((input: { id: string }) => ({ ...AGENT, ...input }))
    store.updateAgent.mockReset().mockImplementation((input: { agentId: string }) => ({ ...AGENT, ...input }))
    store.deleteAgent.mockReset().mockReturnValue(true)
    store.retireAgent.mockReset().mockReturnValue({ ...AGENT, status: 'retired' })
    store.restoreAgent.mockReset().mockReturnValue({ ...AGENT, status: 'active' })
    sessions.getSessionsList.mockReset().mockReturnValue([])
    const { resetRpcRegistryForTests, registerRouterHandlers, agentsRpcHandlers } = await loadDomain()
    resetRpcRegistryForTests()
    dispose = registerRouterHandlers(agentsRouter, agentsRpcHandlers)
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  it('list hands the app-layer roster back untouched', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'agents', method: 'list', payload: {} }))
      .resolves.toEqual({ ok: true, data: { success: true, agents: [AGENT] } })
  })

  it('create mints an id and forwards every optional field', async () => {
    const { dispatchRpc } = await loadDomain()

    const response = await dispatchRpc({
      domain: 'agents',
      method: 'create',
      payload: { name: '小李', systemPrompt: 'persona', title: '前端', maxTurns: 12 },
    })

    expect(response.ok).toBe(true)
    expect(store.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: '小李',
      systemPrompt: 'persona',
      title: '前端',
      maxTurns: 12,
    }))
  })

  it('delete of a never-referenced agent is a hard delete', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'agents', method: 'delete', payload: { agentId: 'fe' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true, outcome: 'deleted' } })
    expect(store.retireAgent).not.toHaveBeenCalled()
    // meta-only 快索引 —— 不是会带出全部转录的 getSessions。
    expect(sessions.getSessionsList).toHaveBeenCalled()
  })

  it('delete of a referenced agent retires it and gives the tombstone back', async () => {
    const { dispatchRpc } = await loadDomain()
    sessions.getSessionsList.mockReturnValue([{ id: 'session-1', agentId: 'fe' }])

    await expect(dispatchRpc({ domain: 'agents', method: 'delete', payload: { agentId: 'fe' } }))
      .resolves.toMatchObject({
        ok: true,
        data: { success: true, outcome: 'retired', agent: { id: 'fe', status: 'retired' } },
      })
    expect(store.deleteAgent).not.toHaveBeenCalled()
  })

  it('restore is its own verb, not an update field', async () => {
    const { dispatchRpc } = await loadDomain()

    await expect(dispatchRpc({ domain: 'agents', method: 'restore', payload: { agentId: 'fe' } }))
      .resolves.toMatchObject({ ok: true, data: { success: true, agent: { status: 'active' } } })
    expect(store.restoreAgent).toHaveBeenCalledWith('fe')
    expect(store.updateAgent).not.toHaveBeenCalled()
  })
})
