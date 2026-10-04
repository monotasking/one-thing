import { describe, expect, it } from 'vitest'
import { agentLoopInitSkills, agentLoopSkillContexts, buildAgentLoopDirectToolsWithAdapters, planAgentLoopPromptBuildOptions, planAgentLoopRuntimePreparation, planAgentLoopTools } from '@onething/backend/agent-loop'
import { configWithApiKey } from '../agent-loop-runtime-preparation.js'
import { getOnethingAgentLoopThinkingOptions } from '@onething/backend/provider'

describe('core agent-loop runtime helpers', () => {
  it('normalizes provider configs and skill snapshots without main process types', () => {
    expect(configWithApiKey({ model: 'deepseek-chat' })).toEqual({
      model: 'deepseek-chat',
      apiKey: '',
    })

    const skills = [
      {
        id: 'skill-1',
        name: 'review',
        description: 'Review workflow',
        source: 'user' as const,
        path: '/skills/review/SKILL.md',
        directoryPath: '/skills/review',
        enabled: true,
        instructions: 'Use the checklist.',
        runtimeContext: '<note />',
        files: [{ name: 'checklist.md', path: '/skills/review/references/checklist.md', type: 'reference' }],
      },
      {
        id: 'skill-2',
        name: 'hidden',
        description: 'Hidden skill',
        source: 'user' as const,
        path: '/skills/hidden/SKILL.md',
        directoryPath: '/skills/hidden',
        enabled: true,
        instructions: 'Hidden',
        disableModelInvocation: true,
      },
    ]

    expect(agentLoopSkillContexts(skills)).toEqual([{
      name: 'review',
      description: 'Review workflow',
      instructions: 'Use the checklist.',
      source: '/skills/review/SKILL.md',
      location: '/skills/review/SKILL.md',
      disableModelInvocation: undefined,
    }])
    expect(agentLoopInitSkills(skills)[0]).toMatchObject({
      id: 'skill-1',
      name: 'review',
      files: [{ name: 'checklist.md', path: '/skills/review/references/checklist.md', type: 'reference' }],
    })
  })

  it('plans runtime preparation from session, settings, and provider config without host adapters', () => {
    const plan = planAgentLoopRuntimePreparation({
      ctx: {
        sessionId: 's1',
        providerConfig: {
          apiKey: 'secret',
          baseUrl: 'https://api.example.test',
          model: 'deepseek-chat',
          apiType: 'openai' as const,
          oauthToken: { accessToken: 'oauth-token' },
          authContext: { kind: 'oauth', token: { accessToken: 'ctx-token' } },
          modelCapabilitiesByModel: {
            'deepseek-chat': { tools: true },
          },
          models: {
            'deepseek-chat': { supportsTools: true },
          },
        },
        settings: {
          skills: { enableSkills: true },
          tools: { enableToolCalls: true, tools: { read: { enabled: true } } },
        },
      },
      session: {
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/tmp/shared'],
        agentId: 'agent-1',
      },
    })

    expect(plan).toMatchObject({
      sessionWorkingDir: '/repo',
      sessionWorkingDirRoots: ['/repo', '/tmp/shared'],
      agentId: 'agent-1',
      skillsEnabled: true,
      toolCallsEnabled: true,
      effectiveToolSettings: { enableToolCalls: true },
      providerHostContext: {
        workingDirectory: '/repo',
        localSessionId: 's1',
      },
      providerRuntimeConfig: {
        apiKey: 'secret',
        baseUrl: 'https://api.example.test',
        model: 'deepseek-chat',
        apiType: 'openai',
        oauthToken: { accessToken: 'oauth-token' },
        authContext: { kind: 'oauth', token: { accessToken: 'ctx-token' } },
      },
    })

    const defaultToolSettings: { enableToolCalls?: boolean } = { enableToolCalls: true }
    const overrideToolSettings: { enableToolCalls?: boolean } = { enableToolCalls: false }
    expect(planAgentLoopRuntimePreparation({
      ctx: {
        sessionId: 's2',
        providerConfig: { model: 'deepseek-chat' },
        settings: {
          skills: { enableSkills: false },
          tools: defaultToolSettings,
        },
        toolSettings: overrideToolSettings,
      },
      session: null,
    })).toMatchObject({
      sessionWorkingDir: undefined,
      sessionWorkingDirRoots: undefined,
      skillsEnabled: false,
      effectiveToolSettings: { enableToolCalls: false },
      toolCallsEnabled: false,
      providerHostContext: {
        workingDirectory: undefined,
        localSessionId: 's2',
      },
      providerRuntimeConfig: {
        model: 'deepseek-chat',
      },
    })
  })

  it('plans prompt build options from runtime context and host-supplied prompt inputs', () => {
    expect(planAgentLoopPromptBuildOptions({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: { locale: 'zh-CN' },
        voiceConversation: true,
      },
      agentId: 'agent-1',
      hasTools: true,
      skills: [{
        name: 'review',
        description: 'Review workflow',
        source: 'user',
        path: '/skills/review/SKILL.md',
        directoryPath: '/skills/review',
        enabled: true,
        instructions: 'Use checklist.',
      }],
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo'],
      activeProject: { hasActive: true, path: '/repo', displayPath: '~/repo', description: 'repo' },
      knownProjects: { hasAny: true, entries: [{ path: '/repo', displayPath: '~/repo', description: 'repo' }] },
      toolNames: ['read'],
      mcpToolNames: ['mcp_search'],
      historyMessages: [{ role: 'user', content: 'hello' }],
    })).toMatchObject({
      sessionId: 's1',
      agentId: 'agent-1',
      providerId: 'deepseek',
      providerConfig: { model: 'deepseek-chat' },
      settings: { locale: 'zh-CN' },
      hasTools: true,
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo'],
      toolNames: ['read'],
      mcpToolNames: ['mcp_search'],
      voiceConversation: true,
      speakMode: true,
      historyMessages: [{ role: 'user', content: 'hello' }],
    })

    expect(planAgentLoopPromptBuildOptions({
      ctx: {
        sessionId: 's2',
        providerId: 'codex',
        providerConfig: { model: 'codex' },
        settings: {},
        voiceConversation: true,
        speakMode: false,
      },
      hasTools: false,
      skills: [],
      historyMessages: [],
    }).speakMode).toBe(false)
  })

  it('plans agent-loop builtin and MCP tools without main runtime dependencies', () => {
    const readTool = {
      id: 'read',
      description: 'Read a file',
      parameters: [{ name: 'path', type: 'string', description: 'Path', required: true }],
    }
    const mcpDirectTool = {
      id: 'mcp:server:tool',
      description: 'Direct MCP tool',
    }
    const mcpRouterTool = {
      id: 'mcp_search',
      description: 'MCP router',
    }

    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: [readTool, mcpDirectTool],
      mcpRouterTool,
      toolSettings: {
        tools: {
          mcp_search: { enabled: true },
        },
      },
    })

    expect(plan.enabledTools).toEqual([readTool])
    expect(plan.hasTools).toBe(true)
    expect(plan.toolNames).toEqual(['read'])
    expect(plan.mcpToolNames).toEqual(['mcp_search'])
    expect(Object.keys(plan.modelToolDefinitions)).toEqual(['read', 'mcp_search'])

    expect(planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: [],
      mcpRouterTool,
      toolSettings: {
        tools: {
          mcp_search: { enabled: false },
        },
      },
    })).toMatchObject({
      hasTools: false,
      toolNames: [],
      mcpToolNames: [],
    })

    expect(planAgentLoopTools({
      toolLoadingEnabled: false,
      allEnabledTools: [readTool],
      mcpRouterTool,
    })).toMatchObject({
      enabledTools: [],
      hasTools: false,
      toolNames: [],
      mcpToolNames: [],
    })
  })

  it('builds direct agent-loop tools with host execution adapters in core', async () => {
    const toolPlan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: [{
        id: 'custom/tool',
        description: 'Custom tool',
        parameters: [{ name: 'path', type: 'string', description: 'Path', required: true }],
      }],
      toolSettings: {},
    })
    const executed: unknown[] = []
    const tools = buildAgentLoopDirectToolsWithAdapters({
      definitions: toolPlan.modelToolDefinitions,
      context: {
        sessionId: 's1',
        messageId: 'm1',
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/tmp/shared'],
      },
      executeToolDirectly: async (toolName, args, context) => {
        executed.push({ toolName, args, context })
        context.onMetadata?.({
          title: 'Reading',
          metadata: {
            path: args.path,
            ignored: () => undefined,
          },
        })
        context.onPartialResult?.({ content: [{ type: 'text', text: 'partial' }] })
        return {
          success: true,
          data: {
            ok: true,
            ignored: () => undefined,
          },
        }
      },
    })
    const metadata: unknown[] = []
    const partials: unknown[] = []

    expect(tools.map(tool => tool.name)).toEqual(['custom-tool'])
    await expect(tools[0].execute(
      { path: '/repo/file.txt' },
      {
        sessionId: 'runtime-session',
        messageId: 'runtime-message',
        toolCallId: 'call-1',
        onMetadata: update => metadata.push(update),
        onPartialResult: update => partials.push(update),
      },
    )).resolves.toEqual({
      content: '{"ok":true}',
      data: { ok: true },
      requiresConfirmation: undefined,
      commandType: undefined,
      aborted: undefined,
      rejected: undefined,
      rejectionReason: undefined,
    })

    expect(executed).toEqual([{
      toolName: 'custom/tool',
      args: { path: '/repo/file.txt' },
      context: expect.objectContaining({
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'call-1',
        workingDirectory: '/repo',
        workingDirectoryRoots: ['/repo', '/tmp/shared'],
      }),
    }])
    expect(metadata).toEqual([{
      title: 'Reading',
      metadata: { path: '/repo/file.txt' },
    }])
    expect(partials).toEqual([{ content: [{ type: 'text', text: 'partial' }] }])
  })

  it('normalizes onething DeepSeek thinking options per model', () => {
    expect(getOnethingAgentLoopThinkingOptions({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-reasoner',
        thinkingByModel: { 'deepseek-reasoner': true },
        thinkingEffortByModel: { 'deepseek-reasoner': 'max' },
      },
    })).toEqual({ thinking: 'enabled', reasoningEffort: 'max' })

    expect(getOnethingAgentLoopThinkingOptions({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-chat',
        thinkingByModel: { 'deepseek-chat': false },
      },
    })).toEqual({ thinking: 'disabled' })
  })
})
