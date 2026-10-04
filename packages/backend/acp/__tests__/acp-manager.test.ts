import { afterEach, describe, expect, it } from 'vitest'
import { ACPManager } from '../acp-manager.js'

afterEach(async () => {
  ACPManager.setAgentAliases({})
  await ACPManager.shutdown()
})

describe('runtime ACP manager', () => {
  it('projects configured agents without starting host-specific code', () => {
    ACPManager.initialize({
      enabled: true,
      agents: [{
        id: 'agent-1',
        name: 'Test Agent',
        enabled: true,
        command: 'test-command',
        args: ['--model', 'test'],
        env: { TEST_ENV: '1' },
      }],
    })

    expect(ACPManager.getAgentStates()).toEqual([{
      config: {
        id: 'agent-1',
        name: 'Test Agent',
        enabled: true,
        command: 'test-command',
        args: ['--model', 'test'],
        env: { TEST_ENV: '1' },
      },
      status: 'disconnected',
      sessionCount: 0,
      activePromptCount: 0,
    }])
  })

  it('returns settings copies so callers cannot mutate manager state', () => {
    ACPManager.initialize({
      enabled: true,
      agents: [{
        id: 'agent-1',
        name: 'Test Agent',
        enabled: true,
        command: 'test-command',
        args: ['a'],
        env: { A: '1' },
      }],
    })

    const settings = ACPManager.getSettings()
    settings.agents[0].args?.push('mutated')
    settings.agents[0].env!.A = 'mutated'

    expect(ACPManager.getSettings().agents[0]).toMatchObject({
      args: ['a'],
      env: { A: '1' },
    })
  })

  it('旧 id 认回现 id(A1-a:名册递进来的 aliases);名册里真有旧 id 时以它为准', () => {
    ACPManager.setAgentAliases({ 'codex-cli': 'codex' })
    ACPManager.initialize({
      enabled: true,
      agents: [{ id: 'codex', name: 'Codex', enabled: true, command: 'codex-acp' }],
    })
    expect(ACPManager.getAgentState('codex-cli')?.config.id).toBe('codex')

    ACPManager.updateSettings({
      enabled: true,
      agents: [
        { id: 'codex', name: 'Codex', enabled: true, command: 'codex-acp' },
        { id: 'codex-cli', name: 'Mine', enabled: true, command: '/opt/codex' },
      ],
    })
    expect(ACPManager.getAgentState('codex-cli')?.config.command).toBe('/opt/codex')
  })
})
