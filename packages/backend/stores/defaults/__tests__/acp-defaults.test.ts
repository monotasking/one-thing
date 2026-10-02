/**
 * ACP 设置归一的性质(A1-a 起)。
 *
 * 内置 agent 不再写在 defaults 里 —— 它们是种子文件 `resources/acp-agents/*.json`,由装配层的
 * 名册合并(`backend/runtime/acp/wiring/registry.ts`)。这里只剩「形状」:出厂名册为空、用户条目按 id
 * 去重、只归一带着的格(稀疏覆盖原样往返)、新加的两格按规矩收。
 */
import { describe, expect, it } from 'vitest'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'
import {
  DEFAULT_ACP_SETTINGS,
  NON_VENDOR_PROVIDER_SEEDS as DEFAULT_PROVIDER_CONFIGS,
  normalizeACPSettings,
} from '../settings.js'

describe('ACP 设置归一', () => {
  it('出厂名册是空的 —— 内置条目来自种子文件,不是 TS 字面量', () => {
    expect(DEFAULT_ACP_SETTINGS.agents).toEqual([])
    expect(normalizeACPSettings(undefined).agents).toEqual([])
  })

  it('ACP provider 的首装模型表跟着种子 id 走', () => {
    expect(DEFAULT_PROVIDER_CONFIGS.acp?.model).toBe('claude-code')
    expect(DEFAULT_PROVIDER_CONFIGS.acp?.selectedModels).toEqual(['claude-code', 'codex', 'gemini', 'copilot'])
  })

  it('用户条目原样留下(归一只动形状),同 id 只留第一条', () => {
    const stored = normalizeACPSettings({
      enabled: true,
      agents: [
        { id: 'kimi', name: 'Kimi Code', enabled: true, command: '/opt/kimi/bin/kimi', args: ['acp', '--verbose'] },
        { id: 'kimi', name: 'dup', enabled: true, command: 'other' },
      ],
    })
    expect(stored.agents).toHaveLength(1)
    expect(stored.agents[0]?.command).toBe('/opt/kimi/bin/kimi')
    expect(stored.agents[0]?.args).toEqual(['acp', '--verbose'])
  })

  it('没命令的条目也留着(起法可能来自种子);只归一带着的格', () => {
    const stored = normalizeACPSettings({
      enabled: true,
      agents: [
        { id: 'broken', name: 'Broken', enabled: true, command: '' },
        { id: 'claude-work', name: 'Claude·工作', enabled: true, command: '', basedOn: 'claude-code' },
      ],
    })
    expect(stored.agents.map(agent => agent.id)).toEqual(['broken', 'claude-work'])
    expect(stored.agents[1]?.basedOn).toBe('claude-code')
    expect(stored.agents[0]).toEqual({ id: 'broken', name: 'Broken', enabled: true, command: '' })
  })

  it('稀疏覆盖原样往返:`{ id, enabled }` 不被补成整份', () => {
    const sparse = { id: 'kimi', enabled: true } as unknown as ACPAgentConfig
    expect(normalizeACPSettings({ enabled: true, agents: [sparse] }).agents).toEqual([{ id: 'kimi', enabled: true }])
    const argsOnly = { id: 'gemini', args: ['--experimental-acp'] } as unknown as ACPAgentConfig
    expect(normalizeACPSettings({ enabled: true, agents: [argsOnly] }).agents).toEqual([argsOnly])
  })

  it('secretEnv 只收合法的环境变量名;basedOn 只收 agent id', () => {
    const stored = normalizeACPSettings({
      enabled: true,
      agents: [{
        id: 'custom',
        name: 'Custom',
        enabled: true,
        command: 'custom-acp',
        secretEnv: ['API_KEY', 'bad key', '1NOPE'],
        basedOn: 'Not An Id',
      }],
    })
    expect(stored.agents[0]?.secretEnv).toEqual(['API_KEY'])
    expect(stored.agents[0]?.basedOn).toBeUndefined()
  })

  it('注册表开关只在关着时落一格', () => {
    expect(normalizeACPSettings({ enabled: true, agents: [] }).registry).toBeUndefined()
    expect(normalizeACPSettings({ enabled: true, agents: [], registry: { enabled: false } }).registry)
      .toEqual({ enabled: false })
  })

  it('A3-a 改名:老 permissionMode 照原词搬进 unattended、老名删掉;缺席不合成(= 拒)', () => {
    const agents = normalizeACPSettings({
      enabled: true,
      agents: [
        { id: 'a', permissionMode: 'allow' },
        { id: 'b', permissionMode: 'reject' },
        { id: 'c', permissionMode: 'allow', unattended: 'reject' },
        { id: 'd', unattended: 'bogus' },
        { id: 'e' },
      ] as never,
    }).agents as unknown as Array<Record<string, unknown>>
    expect(agents.map(agent => agent.unattended)).toEqual(['allow', 'reject', 'reject', 'reject', undefined])
    expect(agents.some(agent => 'permissionMode' in agent)).toBe(false)
    expect('unattended' in agents[4]!).toBe(false)
  })

  it('A3-b 退役的四格(文件 / 终端开关与终端上限)从老盘上摘掉,不再写回', () => {
    const [agent] = normalizeACPSettings({
      enabled: true,
      agents: [{
        id: 'a', command: 'x', allowFileSystemAccess: true, allowTerminalAccess: true, maxTerminals: 3, maxTerminalOutputBytes: 9,
      }] as never,
    }).agents as unknown as Array<Record<string, unknown>>
    expect(Object.keys(agent!).sort()).toEqual(['command', 'id'])
  })

  it('A4-b:退役的 mcpServers 摘掉;hostTools / forwardMcpServers 带着才归一成布尔,缺席不合成', () => {
    const agents = normalizeACPSettings({
      enabled: true,
      agents: [
        { id: 'a', command: 'x', mcpServers: [{ name: 'legacy' }], hostTools: 0, forwardMcpServers: 'yes' },
        { id: 'b', command: 'x', hostTools: false, forwardMcpServers: true },
        { id: 'c', command: 'x' },
      ] as never,
    }).agents as unknown as Array<Record<string, unknown>>
    expect(agents[0]).toEqual({ id: 'a', command: 'x', hostTools: true, forwardMcpServers: false })
    expect(agents[1]).toEqual({ id: 'b', command: 'x', hostTools: false, forwardMcpServers: true })
    expect(Object.keys(agents[2]!).sort()).toEqual(['command', 'id'])
  })
})
