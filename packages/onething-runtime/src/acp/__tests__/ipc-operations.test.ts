import { describe, expect, it, vi } from 'vitest'
import {
  addOnethingACPAgentForIpc,
  cancelOnethingACPSessionForIpc,
  connectOnethingACPAgentForIpc,
  getOnethingACPAgentsForIpc,
  normalizeOnethingACPAgentConfig,
  removeOnethingACPAgentForIpc,
  sparseOnethingACPRosterOverride,
  updateOnethingACPAgentForIpc,
} from '../ipc-operations.js'
import type { AcpAgentManifest } from '../manifest.js'
import type { OnethingACPSettingsLike } from '../ipc-operations.js'

interface TestAgentConfig {
  id?: string
  name?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  enabled?: boolean
  permissionMode?: 'allow' | 'reject'
  idleTimeoutMs?: number
  secretEnv?: string[]
}

interface TestAgentState {
  config: TestAgentConfig
  status: string
}

function createAdapters(settings: OnethingACPSettingsLike<TestAgentConfig>) {
  const manager = {
    updateSettings: vi.fn(),
    getAgentStates: vi.fn((): TestAgentState[] => []),
    getAgentState: vi.fn((agentId: string): TestAgentState | undefined => ({
      config: { id: agentId, command: 'agent' },
      status: 'disconnected',
    })),
    connectAgent: vi.fn(async (agentId: string): Promise<TestAgentState> => ({
      config: { id: agentId, command: 'agent' },
      status: 'connected',
    })),
    disconnectAgent: vi.fn(),
    refreshAgent: vi.fn(async (agentId: string): Promise<TestAgentState> => ({
      config: { id: agentId, command: 'agent' },
      status: 'connected',
    })),
    cancelSession: vi.fn(),
  }

  return {
    manager,
    getSettings: vi.fn(() => settings),
    saveSettings: vi.fn(),
  }
}

describe('ACP IPC operations', () => {
  it('normalizes ACP agent config with stable defaults', () => {
    expect(normalizeOnethingACPAgentConfig({
      name: '  ',
      command: '  codex  ',
      args: undefined,
      enabled: undefined,
      permissionMode: 'anything',
    }, () => 'acp-test')).toEqual({
      id: 'acp-test',
      name: 'codex',
      command: 'codex',
      args: [],
      env: undefined,
      enabled: true,
      permissionMode: 'allow',
    })
  })

  it('lists agents after syncing manager settings', async () => {
    const adapters = createAdapters({
      enabled: true,
      agents: [{ id: 'agent-1', command: 'codex' }],
    })
    adapters.manager.getAgentStates.mockReturnValue([{
      config: { id: 'agent-1', command: 'codex' },
      status: 'connected',
    }])

    await expect(getOnethingACPAgentsForIpc(adapters)).resolves.toEqual({
      success: true,
      agents: [{
        config: { id: 'agent-1', command: 'codex' },
        status: 'connected',
      }],
    })
    expect(adapters.manager.updateSettings).toHaveBeenCalledWith({
      enabled: true,
      agents: [{ id: 'agent-1', command: 'codex' }],
    })
  })

  it('adds and updates agents through settings adapters', async () => {
    const adapters = createAdapters({ enabled: true, agents: [] })

    await expect(addOnethingACPAgentForIpc({
      ...adapters,
      config: { command: '  codex  ' },
      createId: () => 'acp-1',
    })).resolves.toEqual({
      success: true,
      agent: {
        config: { id: 'acp-1', command: 'agent' },
        status: 'disconnected',
      },
    })
    expect(adapters.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      agents: [{
        id: 'acp-1',
        name: 'codex',
        command: 'codex',
        args: [],
        env: undefined,
        enabled: true,
        permissionMode: 'allow',
      }],
    })

    const updateAdapters = createAdapters({
      enabled: true,
      agents: [{ id: 'acp-1', command: 'old' }],
    })
    await expect(updateOnethingACPAgentForIpc({
      ...updateAdapters,
      config: { id: 'acp-1', command: 'new' },
    })).resolves.toMatchObject({ success: true })
    expect(updateAdapters.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      agents: [expect.objectContaining({ id: 'acp-1', command: 'new' })],
    })
  })

  it('rejects invalid or duplicate agent configs', async () => {
    const adapters = createAdapters({
      enabled: true,
      agents: [{ id: 'acp-1', command: 'codex' }],
    })

    await expect(addOnethingACPAgentForIpc({
      ...adapters,
      config: { id: 'acp-2', command: ' ' },
    })).resolves.toEqual({
      success: false,
      error: 'ACP agent command is required',
    })

    await expect(addOnethingACPAgentForIpc({
      ...adapters,
      config: { id: 'acp-1', command: 'codex' },
    })).resolves.toEqual({
      success: false,
      error: 'ACP agent "acp-1" already exists',
    })

    await expect(updateOnethingACPAgentForIpc({
      ...adapters,
      config: { id: 'missing', command: 'codex' },
    })).resolves.toEqual({
      success: false,
      error: 'ACP agent "missing" not found',
    })
  })

  it('routes remove, connect, and cancel through host manager adapters', async () => {
    const adapters = createAdapters({
      enabled: true,
      agents: [
        { id: 'keep', command: 'keep' },
        { id: 'drop', command: 'drop' },
      ],
    })

    await expect(removeOnethingACPAgentForIpc({
      ...adapters,
      agentId: 'drop',
    })).resolves.toEqual({ success: true })
    expect(adapters.manager.disconnectAgent).toHaveBeenCalledWith('drop')
    expect(adapters.saveSettings).toHaveBeenCalledWith({
      enabled: true,
      agents: [{ id: 'keep', command: 'keep' }],
    })

    await expect(connectOnethingACPAgentForIpc({
      getSettings: adapters.getSettings,
      manager: adapters.manager,
      agentId: 'keep',
    })).resolves.toEqual({
      success: true,
      agent: { config: { id: 'keep', command: 'agent' }, status: 'connected' },
    })
    expect(adapters.manager.connectAgent).toHaveBeenCalledWith('keep')

    await expect(cancelOnethingACPSessionForIpc({
      sessionId: 'session-1',
      agentId: 'keep',
      cancelSession: adapters.manager.cancelSession,
    })).resolves.toEqual({ success: true })
    expect(adapters.manager.cancelSession).toHaveBeenCalledWith('session-1', 'keep')
  })

  describe('种子 / 注册表那一台的覆盖是稀疏的(A1-a)', () => {
    const KIMI: AcpAgentManifest = {
      id: 'kimi',
      name: 'Kimi Code',
      description: '月之暗面的命令行编程 agent。',
      launch: { command: 'kimi', args: ['acp'] },
    }
    /** 壳回显的整份生效配置。 */
    const ECHO = {
      id: 'kimi',
      name: 'Kimi Code',
      description: '月之暗面的命令行编程 agent。',
      command: 'kimi',
      args: ['acp'],
      env: {},
      permissionMode: 'allow' as const,
    }
    const rosterAdapters = (agents: TestAgentConfig[] = []) => ({
      ...createAdapters({ enabled: true, agents }),
      isRosterAgent: (id: string) => id === 'kimi',
      rosterManifest: (id: string) => (id === 'kimi' ? KIMI : undefined),
    })

    it('(a) 回显整份生效配置 + enabled:true → 只存 { id, enabled: true }', async () => {
      const adapters = rosterAdapters()
      await expect(updateOnethingACPAgentForIpc({ ...adapters, config: { ...ECHO, enabled: true } }))
        .resolves.toMatchObject({ success: true })
      expect(adapters.saveSettings).toHaveBeenCalledWith({ enabled: true, agents: [{ id: 'kimi', enabled: true }] })
    })

    it('(b) 只改了参数 → 覆盖只带 args(调用方给了 enabled 才带 enabled)', async () => {
      const adapters = rosterAdapters([{ id: 'kimi', enabled: true }])
      await updateOnethingACPAgentForIpc({ ...adapters, config: { ...ECHO, args: ['acp', '--verbose'] } })
      expect(adapters.saveSettings).toHaveBeenCalledWith({ enabled: true, agents: [{ id: 'kimi', args: ['acp', '--verbose'] }] })

      const withEnabled = rosterAdapters()
      await updateOnethingACPAgentForIpc({ ...withEnabled, config: { ...ECHO, enabled: false, args: ['acp', '--verbose'] } })
      expect(withEnabled.saveSettings).toHaveBeenCalledWith({
        enabled: true,
        agents: [{ id: 'kimi', enabled: false, args: ['acp', '--verbose'] }],
      })
    })

    it('不要求命令;名字不被合成成 ACP Agent;其余带着的格(超时 / secretEnv)原样留', () => {
      expect(sparseOnethingACPRosterOverride({ id: 'kimi', name: '', command: '', idleTimeoutMs: 5, secretEnv: ['K'] }, KIMI))
        .toEqual({ id: 'kimi', idleTimeoutMs: 5, secretEnv: ['K'] })
      expect(sparseOnethingACPRosterOverride({ id: 'kimi', name: 'Kimi·工作', permissionMode: 'reject' }, KIMI))
        .toEqual({ id: 'kimi', name: 'Kimi·工作', permissionMode: 'reject' })
    })

    it('addAgent 对还没有覆盖的那一台存稀疏覆盖;已有覆盖答重复', async () => {
      const adapters = rosterAdapters()
      await addOnethingACPAgentForIpc({ ...adapters, config: { ...ECHO, enabled: true } })
      expect(adapters.saveSettings).toHaveBeenCalledWith({ enabled: true, agents: [{ id: 'kimi', enabled: true }] })

      const existing = rosterAdapters([{ id: 'kimi', enabled: true }])
      await expect(addOnethingACPAgentForIpc({ ...existing, config: ECHO }))
        .resolves.toEqual({ success: false, error: 'ACP agent "kimi" already exists' })
    })

    it('用户自己手加的条目(不是种子 / 注册表)仍然整份存、仍然要命令', async () => {
      const adapters = { ...createAdapters({ enabled: true, agents: [{ id: 'mine', command: 'x' }] }), isRosterAgent: () => false }
      await expect(updateOnethingACPAgentForIpc({ ...adapters, config: { id: 'mine', command: '' } }))
        .resolves.toEqual({ success: false, error: 'ACP agent command is required' })
    })
  })
})
