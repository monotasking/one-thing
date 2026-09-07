import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentModelCapabilities, AgentProvider } from '@onething/core/agent-loop'
import type { ToolDefinition } from '@shared/ipc.js'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import { configureToolkitCatalog } from '@onething/runtime/toolkit'

const deepseekTextCapabilities: AgentModelCapabilities = {
  capabilities: ['text-input', 'text-output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
}

const deepseekToolCapabilities: AgentModelCapabilities = {
  capabilities: ['text-input', 'text-output', 'tool-calls'],
  inputModalities: ['text'],
  outputModalities: ['text'],
}

function deepseekProviderWithCapabilities(capabilities: AgentModelCapabilities): AgentProvider {
  return {
    id: 'deepseek',
    capabilities,
  }
}

/** 目录里那只 `read` —— 快照的工具面从这里来。 */
class SnapshotReadTool extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec = {
    id: 'read',
    title: 'Read',
    description: 'Read files',
    input: { type: 'object', properties: {} },
    effects: ['read'],
    presentation: { kind: 'file', shell: 'default' },
    concurrency: 'parallel',
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(() => ({
    id: 's1',
    agentId: 'agent-1',
    workingDirectory: '/tmp/project',
    workingDirectoryRoots: ['/tmp/project'],
  })),
  getSettings: vi.fn(() => ({
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: {
          model: 'deepseek-v4-flash',
          selectedModels: ['deepseek-v4-flash'],
        },
      },
    },
    chat: { agentLoopStream: true },
    skills: { enableSkills: false },
    tools: { enableToolCalls: false, tools: {} },
  })),
  findAgent: vi.fn(() => ({ id: 'agent-1', name: 'Agent One' })),
  getEffectiveProviderConfig: vi.fn(() => ({
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    providerConfig: {
      model: 'deepseek-v4-flash',
      selectedModels: ['deepseek-v4-flash'],
      baseUrl: 'https://api.deepseek.com',
    },
  })),
  resolveProviderAuth: vi.fn(async () => ({ kind: 'api-key', apiKey: 'key' })),
  isProviderSupported: vi.fn(() => true),
  modelSupportsTools: vi.fn(async () => false),
  getCodexNativeToolsForConfig: vi.fn(async () => []),
  getSkillsForSession: vi.fn(() => []),
  getMCPRouterToolDefinition: vi.fn<() => ToolDefinition | null>(() => null),
  getMCPToolDefinitionsForModel: vi.fn<() => ToolDefinition[]>(() => []),
  createAgentProviderFromRuntime: vi.fn(() => deepseekProviderWithCapabilities(deepseekTextCapabilities)),
  resolveAgentModelCapabilities: vi.fn(async (provider: AgentProvider) => provider.capabilities),
  agentSupportsTools: vi.fn((capabilities: AgentModelCapabilities) => capabilities.capabilities.includes('tool-calls')),
  buildProjectDirsPromptVars: vi.fn(() => ({ active: undefined, known: [] })),
  buildPrompt: vi.fn(async () => ({
    systemPrompt: 'system prompt',
    messages: [{ role: 'system', content: 'system prompt' }],
  })),
}))

vi.mock('../../../../store.js', () => ({
  getSession: mocks.getSession,
  getSettings: mocks.getSettings,
}))
// Agent profile lookup uses the same explicit metadata fixture as prompt assembly.
vi.mock('../../../../stores/sessions.js', () => ({ getSession: mocks.getSession }))

// 解析纪律(M4):快照 host 走 `findAgent(id) ?? defaultAgent()`;夹具对任何
// id 都返回同一个 agent,两条腿的结果一致。
vi.mock('../../../agents/index.js', () => ({
  findAgent: mocks.findAgent,
  defaultAgent: () => mocks.findAgent(),
}))

vi.mock('../../stream/provider-helpers.js', () => ({
  getEffectiveProviderConfig: mocks.getEffectiveProviderConfig,
  resolveProviderAuth: mocks.resolveProviderAuth,
}))

vi.mock('../../../providers/index.js', () => ({
  isProviderSupported: mocks.isProviderSupported,
}))

vi.mock('../../../providers/model-registry.js', () => ({
  modelSupportsTools: mocks.modelSupportsTools,
}))

vi.mock('../../stream/codex-native-tools.js', () => ({
  getCodexNativeToolsForConfig: mocks.getCodexNativeToolsForConfig,
}))

vi.mock('@onething/runtime/mcp/index.wiring', () => ({
  getMCPRouterToolDefinition: mocks.getMCPRouterToolDefinition,
  getMCPToolDefinitionsForModel: mocks.getMCPToolDefinitionsForModel,
}))

vi.mock('../../../providers/agent-runtime.js', () => ({
  createAgentProviderFromRuntime: mocks.createAgentProviderFromRuntime,
}))

vi.mock('@onething/core/agent-loop', async importOriginal => ({
  ...await importOriginal<typeof import('@onething/core/agent-loop')>(),
  resolveAgentModelCapabilities: mocks.resolveAgentModelCapabilities,
  agentSupportsTools: mocks.agentSupportsTools,
}))

vi.mock('../../../variables/index.js', () => ({
}))

vi.mock('../../../project-dirs/index.js', () => ({
  buildProjectDirsPromptVars: mocks.buildProjectDirsPromptVars,
}))

vi.mock('../system-prompt.js', () => ({
  buildPrompt: mocks.buildPrompt,
}))

const { buildSystemPromptSnapshot } = await import('../system-prompt-snapshot.js')

describe('system prompt snapshot agent-loop route', () => {
  afterEach(() => {
  configureToolkitCatalog(undefined)
    vi.clearAllMocks()
    vi.unstubAllEnvs()
  })

  it('exposes the active agent-loop stream route for supported providers', async () => {
    const snapshot = await buildSystemPromptSnapshot('s1')

    expect(snapshot.providerId).toBe('deepseek')
    expect(snapshot.model).toBe('deepseek-v4-flash')
    expect(snapshot.agentLoopStream).toMatchObject({
      enabled: true,
      enabledBy: 'settings',
      providerSupported: true,
      active: true,
    })
    expect(snapshot.agentLoopStream.supportedProviderIds).toEqual(expect.arrayContaining(['deepseek', 'acp']))
    expect(mocks.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'deepseek',
      hasTools: false,
      historyMessages: [],
    }))
  })

  it('shows unsupported providers as enabled but inactive when the setting is on', async () => {
    mocks.getEffectiveProviderConfig.mockReturnValueOnce({
      providerId: 'unsupported-provider',
      model: 'legacy-test',
      providerConfig: {
        model: 'legacy-test',
        selectedModels: ['legacy-test'],
        baseUrl: 'https://legacy.test/v1',
      },
    })

    const snapshot = await buildSystemPromptSnapshot('s1')

    expect(snapshot.agentLoopStream).toMatchObject({
      enabled: true,
      enabledBy: 'settings',
      providerSupported: false,
      active: false,
    })
  })

  it('builds snapshot tool names from agent-loop tool definitions and MCP router tools', async () => {
    mocks.getSettings.mockReturnValueOnce({
      ai: {
        provider: 'deepseek',
        providers: {
          deepseek: {
            model: 'deepseek-v4-flash',
            selectedModels: ['deepseek-v4-flash'],
          },
        },
      },
      chat: { agentLoopStream: true },
      skills: { enableSkills: false },
      tools: {
        enableToolCalls: true,
        tools: {
          mcp_search: { enabled: true, autoExecute: false },
        },
      },
    })
    mocks.createAgentProviderFromRuntime.mockReturnValueOnce(
      deepseekProviderWithCapabilities(deepseekToolCapabilities),
    )
    // R4b:快照的工具面来自**目录**(`resolveToolkitSurface`),旧的
    // `getEnabledToolsAsync` 那条口径随旧树删除。
    configureToolkitCatalog(new Catalog().register(new SnapshotReadTool()))
    mocks.getMCPToolDefinitionsForModel.mockReturnValueOnce([{
      id: 'mcp_search',
      name: 'MCP Search',
      description: 'Search MCP tools',
      enabled: true,
      autoExecute: false,
      category: 'custom',
      source: 'mcp',
      parameters: [],
    }])

    const snapshot = await buildSystemPromptSnapshot('s1')

    expect(mocks.modelSupportsTools).not.toHaveBeenCalled()
    expect(mocks.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      hasTools: true,
      toolNames: ['read'],
      mcpToolNames: ['mcp_search'],
    }))
    expect(snapshot.tools).toMatchObject({
      enableToolCalls: true,
      modelSupportsTools: true,
      hasTools: true,
      configuredCount: 2,
      modelFacingCount: 2,
    })
    expect(snapshot.tools.builtin.map(tool => tool.modelFacingName)).toEqual(['read'])
    expect(snapshot.tools.mcp.map(tool => tool.modelFacingName)).toEqual(['mcp_search'])
  })
})
