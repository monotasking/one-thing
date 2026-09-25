import { describe, expect, it } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'
import type { ModelOption, ProviderGroup } from '../../data/models-source'
import { UNKNOWN_MODEL_READINGS } from '../../data/models-source'
import { acpProviderIdOf, splitPickerSections } from '../agent-rows'

/**
 * 选择器的「Agent」一组(2026-09-26 用户裁定:agent 不许被画成普通模型)。钉五件:
 *  ① ACP 那一家的行**不**从 `selectedModels` 来,从名册来(启用着的那些);
 *  ② 本地 CLI(claude-code-agent)那一家整组搬进 Agent;
 *  ③ 目录说是 agent 的行(`kind: 'agent'`)也搬,判据读 kind 不读 id;
 *  ④ 没装的照样列,状态字是 missing;还没探测过就不给状态字;
 *  ⑤ 当前选中那一台哪怕被关了也列(列表里找不到当前选中是更坏的谎)。
 */

const opt = (model: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  ...UNKNOWN_MODEL_READINGS,
  contextLength: 200_000,
  model,
  ...extra,
})

function agent(id: string, over: Partial<ACPAgentState> = {}, config: Partial<ACPAgentConfig> = {}): ACPAgentState {
  return {
    config: { id, name: id.toUpperCase(), enabled: true, command: id, ...config } as ACPAgentConfig,
    status: 'disconnected',
    sessionCount: 0,
    activePromptCount: 0,
    source: 'builtin',
    detect: { installed: true, checkedAt: 1 },
    ...over,
  }
}

const GROUPS: ProviderGroup[] = [
  { id: 'claude', provider: 'Claude', models: [opt('claude-sonnet-5'), opt('odd-agent', { kind: 'agent' })] },
  { id: 'claude-code-agent', provider: 'Claude Code', models: [opt('claude-code-agent'), opt('claude-opus-4-8')] },
  { id: 'acp', provider: 'ACP', models: [opt('stale-selected')] },
]

describe('splitPickerSections', () => {
  it('模型的组里没有任何 agent 行;Agent 一组按「本地 CLI → 名册」排', () => {
    const { modelGroups, agentRows } = splitPickerSections({
      groups: GROUPS,
      acpProviderId: 'acp',
      agents: [agent('gemini'), agent('off', {}, { enabled: false })],
      current: null,
      query: '',
    })
    expect(modelGroups.map((g) => [g.id, g.models.map((m) => m.model)])).toEqual([['claude', ['claude-sonnet-5']]])
    expect(agentRows.map((r) => [r.providerId, r.model, r.label])).toEqual([
      ['claude', 'odd-agent', 'odd-agent'],
      ['claude-code-agent', 'claude-code-agent', 'Claude Code'],
      ['claude-code-agent', 'claude-opus-4-8', 'claude-opus-4-8'],
      // ACP:名册里启用着的那一台;`selectedModels` 里那条 stale-selected 不再说了算。
      ['acp', 'gemini', 'GEMINI'],
    ])
  })

  it('没装的照样列,状态字 missing;没探测过不给状态字;连着的是 running', () => {
    const { agentRows } = splitPickerSections({
      groups: [],
      acpProviderId: 'acp',
      agents: [
        agent('a', { detect: { installed: false, checkedAt: 1 } }),
        agent('b', { detect: undefined }),
        agent('c', { status: 'connected' }),
        agent('d'),
      ],
      current: null,
      query: '',
    })
    expect(agentRows.map((r) => [r.model, r.status])).toEqual([
      ['a', 'missing'],
      ['b', undefined],
      ['c', 'running'],
      ['d', 'ready'],
    ])
  })

  it('当前选中那一台被关了也列;存的是旧 id 时行上交的也是旧 id', () => {
    const { agentRows } = splitPickerSections({
      groups: [],
      acpProviderId: 'acp',
      agents: [agent('codex', { manifest: { id: 'codex', name: 'Codex', aliases: ['codex-cli'] } }, { enabled: false })],
      current: { provider: 'acp', model: 'codex-cli' },
      query: '',
    })
    expect(agentRows.map((r) => r.model)).toEqual(['codex-cli'])
  })

  it('检索词筛名册那一半(名或 id)', () => {
    const { agentRows } = splitPickerSections({
      groups: [],
      acpProviderId: 'acp',
      agents: [agent('gemini'), agent('kimi')],
      current: null,
      query: 'kim',
    })
    expect(agentRows.map((r) => r.model)).toEqual(['kimi'])
  })

  it('名册还没到:那一半先空着,不编', () => {
    expect(splitPickerSections({ groups: [], acpProviderId: 'acp', agents: undefined, current: null, query: '' }).agentRows).toEqual([])
  })

  it('ACP 那一家的 id 由本地表认出来', () => {
    expect(acpProviderIdOf([{ id: 'claude' }, { id: 'acp' }])).toBe('acp')
    expect(acpProviderIdOf([{ id: 'claude' }])).toBeUndefined()
  })
})
