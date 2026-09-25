import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingAgentFromRequest,
  createOnethingAgentFromRequestForIpc,
  deleteOnethingAgentFromRequest,
  deleteOnethingAgentFromRequestForIpc,
  listOnethingAgents,
  listOnethingAgentsForIpc,
  restoreOnethingAgentFromRequest,
  restoreOnethingAgentFromRequestForIpc,
  updateOnethingAgentFromRequest,
  updateOnethingAgentFromRequestForIpc,
} from '../ipc-operations.js'
import type { OnethingAgentDefinition } from '../store.js'

const defaultAgent: OnethingAgentDefinition = {
  id: 'default',
  name: 'Default Agent',
  systemPrompt: '',
  isDefault: true,
  createdAt: 1,
  updatedAt: 1,
}

describe('agent IPC operations', () => {
  it('projects list, create, and update responses', async () => {
    const created: OnethingAgentDefinition = {
      id: 'agent-id-1',
      name: 'Research',
      systemPrompt: 'Look things up',
      createdAt: 2,
      updatedAt: 2,
    }
    const listAgents = vi.fn(() => [defaultAgent])
    const createAgent = vi.fn((agent: { id: string; name: string; systemPrompt?: string }) => ({
      ...created,
      ...agent,
      createdAt: 2,
      updatedAt: 2,
    }))
    const updateAgent = vi.fn((agent: { agentId: string; name?: string; systemPrompt?: string }) => ({
      ...created,
      id: agent.agentId,
      name: agent.name || created.name,
      systemPrompt: agent.systemPrompt || created.systemPrompt,
      updatedAt: 3,
    }))

    await expect(listOnethingAgents({ listAgents })).resolves.toEqual({
      success: true,
      agents: [defaultAgent],
    })
    await expect(createOnethingAgentFromRequest({
      name: 'Research',
      systemPrompt: 'Look things up',
      createId: () => 'id-1',
      createAgent,
    })).resolves.toMatchObject({
      success: true,
      agent: { id: 'agent-id-1', name: 'Research' },
    })
    await expect(updateOnethingAgentFromRequest({
      agentId: 'agent-id-1',
      name: 'Research Lead',
      updateAgent,
    })).resolves.toMatchObject({
      success: true,
      agent: { id: 'agent-id-1', name: 'Research Lead' },
    })

    expect(createAgent).toHaveBeenCalledWith({
      id: 'agent-id-1',
      name: 'Research',
      systemPrompt: 'Look things up',
    })
    expect(updateAgent).toHaveBeenCalledWith({
      agentId: 'agent-id-1',
      name: 'Research Lead',
      systemPrompt: undefined,
    })
  })

  /**
   * A2 的核心分支(agent-domain-model.md §3.2):被引用过只能退休,从未被引用过
   * 才硬删,default 两条都不给。
   */
  it('retires a referenced agent and hard-deletes an unreferenced one', async () => {
    const deleteAgent = vi.fn()
    const retireAgent = vi.fn((agentId: string) => ({
      ...defaultAgent,
      id: agentId,
      name: 'Retired One',
      isDefault: undefined,
      status: 'retired' as const,
    }))

    await expect(deleteOnethingAgentFromRequest({
      agentId: 'default',
      sessions: [],
      retireAgent,
      deleteAgent,
    })).rejects.toThrow('Default Agent cannot be retired or deleted')

    // 直聊会话的 persona 绑定就是一处引用 —— 那批消息的署名指着这个 id。
    await expect(deleteOnethingAgentFromRequest({
      agentId: 'agent-used',
      sessions: [{ id: 's1', kind: 'chat', agentId: 'agent-used' }],
      retireAgent,
      deleteAgent,
    })).resolves.toEqual({
      success: true,
      outcome: 'retired',
      agent: expect.objectContaining({ id: 'agent-used', status: 'retired' }),
    })
    expect(deleteAgent).not.toHaveBeenCalled()

    // 房间成员也是引用,哪怕没有一条会话把它当 agentId。
    await expect(deleteOnethingAgentFromRequest({
      agentId: 'agent-in-room',
      sessions: [{ id: 'room-1', kind: 'room', room: { memberAgentIds: ['agent-in-room', 'other'] } }],
      retireAgent,
      deleteAgent,
    })).resolves.toMatchObject({ outcome: 'retired' })
    expect(deleteAgent).not.toHaveBeenCalled()

    await expect(deleteOnethingAgentFromRequest({
      agentId: 'agent-unused',
      sessions: [{ id: 's2', kind: 'chat', agentId: 'default' }, { id: 's3' }],
      retireAgent,
      deleteAgent,
    })).resolves.toEqual({ success: true, outcome: 'deleted' })
    expect(deleteAgent).toHaveBeenCalledWith('agent-unused')
  })

  it('restores a retired agent through its own operation', async () => {
    const restoreAgent = vi.fn((agentId: string) => ({
      ...defaultAgent,
      id: agentId,
      isDefault: undefined,
      status: 'active' as const,
    }))

    await expect(restoreOnethingAgentFromRequest({
      agentId: '',
      restoreAgent,
    })).rejects.toThrow('Agent id is required')

    await expect(restoreOnethingAgentFromRequest({
      agentId: 'agent-retired',
      restoreAgent,
    })).resolves.toEqual({
      success: true,
      agent: expect.objectContaining({ id: 'agent-retired', status: 'active' }),
    })
  })

  /**
   * 生命周期只经退休/恢复变更(§3.2):普通编辑面即便被塞了 status 也写不进去,
   * 白名单就是 update 操作里那份显式字段列表。
   */
  it('never forwards status through the ordinary update surface', async () => {
    const updateAgent = vi.fn((input: { agentId: string }) => ({ ...defaultAgent, ...input }))

    await updateOnethingAgentFromRequest({
      agentId: 'agent-1',
      name: 'Renamed',
      status: 'retired',
      kind: 'service',
      executor: { type: 'external', connectorId: 'acp' },
      updateAgent,
    })

    const forwarded = updateAgent.mock.calls[0][0] as Record<string, unknown>
    expect(forwarded.name).toBe('Renamed')
    expect('status' in forwarded).toBe(false)
    expect('kind' in forwarded).toBe(false)
    expect('executor' in forwarded).toBe(false)
  })

  it('normalizes agent adapter failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(listOnethingAgentsForIpc({
      listAgents: () => {
        throw new Error('list failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'list failed' })

    await expect(createOnethingAgentFromRequestForIpc({
      createId: () => 'id-1',
      createAgent: () => {
        throw new Error('create failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'create failed' })

    await expect(updateOnethingAgentFromRequestForIpc({
      agentId: 'agent-1',
      updateAgent: () => {
        throw new Error('update failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'update failed' })

    await expect(deleteOnethingAgentFromRequestForIpc({
      agentId: 'agent-1',
      listSessions: () => [],
      retireAgent: () => defaultAgent,
      deleteAgent: () => {
        throw new Error('delete failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'delete failed' })

    await expect(restoreOnethingAgentFromRequestForIpc({
      agentId: 'agent-1',
      restoreAgent: () => {
        throw new Error('restore failed')
      },
      logger,
    })).resolves.toEqual({ success: false, error: 'restore failed' })

    expect(logger.error).toHaveBeenCalledTimes(5)
  })

  it('loads sessions inside the delete IPC operation before applying delete rules', async () => {
    const listSessions = vi.fn(() => [{ id: 's1', kind: 'chat', agentId: 'agent-used' }])
    const deleteAgent = vi.fn()
    const retireAgent = vi.fn((agentId: string) => ({
      ...defaultAgent,
      id: agentId,
      isDefault: undefined,
      status: 'retired' as const,
    }))

    await expect(deleteOnethingAgentFromRequestForIpc({
      agentId: 'agent-used',
      listSessions,
      retireAgent,
      deleteAgent,
    })).resolves.toMatchObject({ success: true, outcome: 'retired' })

    expect(listSessions).toHaveBeenCalled()
    expect(retireAgent).toHaveBeenCalledWith('agent-used')
    expect(deleteAgent).not.toHaveBeenCalled()
  })
})
