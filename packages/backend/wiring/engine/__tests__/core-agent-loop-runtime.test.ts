import { describe, expect, it } from 'vitest'
import {
  agentLoopInitSkills,
  agentLoopSkillContexts,
  applyAgentLoopContextCompactResult,
  buildAgentLoopContextCompactEventPlan,
  buildAgentLoopDirectToolsWithAdapters,
  buildPendingAgentLoopMessageInjections,
  configWithApiKey,
  createAgentLoopCompactState,
  getAgentLoopTransientTail,
  getContextCompactReason,
  getContextUsageTriggerReason,
  maybeCompactAgentLoopContextWithAdapters,
  planAgentLoopContextCompactFinal,
  planAgentLoopContextCompactPass,
  planAgentLoopPromptBuildOptions,
  planAgentLoopRuntimePreparation,
  planAgentLoopTools,
  positiveTokenLimit,
  resolvePendingAgentLoopMessages,
  resolveAgentLoopContextBudgetValues,
  resolveAgentLoopContextBudgetWithRegistry,
  runAgentLoopAfterTurnWithAdapters,
  runAgentLoopBeforeTurnWithAdapters,
  shouldStartAgentLoopContextCompact,
} from '@onething/core/engine'
import { getOnethingAgentLoopThinkingOptions } from '@onething/runtime/agent-loop/providers'

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

  it('resolves context budget through injected model registry adapters', async () => {
    await expect(resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      providerConfig: {
        model: 'deepseek-chat',
        maxOutputByModel: { 'deepseek-chat': 900 },
      },
      chatMaxTokens: 4096,
      contextCompactThreshold: 70,
      resolveModelContextLength: async () => 32000,
      resolveModelMaxOutputTokens: async () => 8192,
    })).resolves.toEqual({
      budget: {
        modelContextLength: 32000,
        reservedOutputTokens: 900,
        thresholdPercent: 70,
      },
    })

    const calls: string[] = []
    await expect(resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      capabilities: {
        maxInputTokens: 64000,
        maxOutputTokens: 12000,
      },
      providerConfig: { model: 'deepseek-reasoner' },
      chatMaxTokens: 4096,
      resolveModelContextLength: async () => {
        calls.push('context')
        return 32000
      },
      resolveModelMaxOutputTokens: async () => {
        calls.push('output')
        return 8192
      },
    })).resolves.toEqual({
      budget: {
        modelContextLength: 64000,
        reservedOutputTokens: 6000,
        thresholdPercent: 85,
      },
    })
    expect(calls).toEqual([])
  })

  it('falls back when injected model registry lookup fails', async () => {
    const result = await resolveAgentLoopContextBudgetWithRegistry({
      providerId: 'deepseek',
      capabilities: {},
      providerConfig: { model: 'deepseek-chat' },
      chatMaxTokens: 2048,
      contextCompactThreshold: 75,
      resolveModelContextLength: async () => {
        throw new Error('registry unavailable')
      },
    })

    expect(result.budget).toEqual({
      modelContextLength: 128000,
      reservedOutputTokens: 2048,
      thresholdPercent: 75,
    })
    expect(result.error).toBeInstanceOf(Error)
  })

  it('keeps the current in-memory tool turn tail when rebuilding compacted messages', () => {
    expect(getAgentLoopTransientTail([
      { role: 'system', content: 'summary' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a"}' }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file text' },
    ])
  })

  it('builds pending steering/follow-up message injections without store or event bus', () => {
    const messages = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'original question' },
    ]

    expect(buildPendingAgentLoopMessageInjections(messages, [])).toBeUndefined()

    let nextId = 0
    const resolvedPendingMessages = resolvePendingAgentLoopMessages([
      {
        content: 'please @skill continue',
        timestamp: 100,
      },
      {
        content: 'and summarize',
        timestamp: 200,
      },
    ], {
      createId: () => `message-${++nextId}`,
      resolvePromptReferences: content => ({
        modelContent: content.replace('@skill ', ''),
        contentParts: [{ type: 'text', content }],
      }),
    })

    expect(resolvedPendingMessages).toEqual([
      {
        id: 'message-1',
        modelContent: 'please continue',
        timestamp: 100,
        contentParts: [{ type: 'text', content: 'please @skill continue' }],
      },
      {
        id: 'message-2',
        modelContent: 'and summarize',
        timestamp: 200,
        contentParts: [{ type: 'text', content: 'and summarize' }],
      },
    ])

    const injection = buildPendingAgentLoopMessageInjections(messages, resolvedPendingMessages)

    expect(injection?.messages).toEqual([
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'original question' },
      { role: 'user', content: 'please continue' },
      { role: 'user', content: 'and summarize' },
    ])
    expect(injection?.messages[0]).not.toBe(messages[0])
    expect(injection?.chatMessages).toEqual([
      {
        id: 'message-1',
        role: 'user',
        content: 'please continue',
        timestamp: 100,
        contentParts: [{ type: 'text', content: 'please @skill continue' }],
      },
      {
        id: 'message-2',
        role: 'user',
        content: 'and summarize',
        timestamp: 200,
        contentParts: [{ type: 'text', content: 'and summarize' }],
      },
    ])
  })

  it('injects already-persisted steering messages without persisting them again', async () => {
    const persisted: unknown[] = []

    const replacement = await runAgentLoopBeforeTurnWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 1,
      messages: [{ role: 'user', content: 'original question' }],
      budget: {
        modelContextLength: 1000,
        reservedOutputTokens: 100,
        thresholdPercent: 80,
      },
      compactEnabled: false,
      keepRecentTurns: 3,
      rebuildMessages: async messages => messages as Array<{ role: string; content: string }>,
      adapters: {
        createPendingMessageId: () => 'unused-id',
        resolvePromptReferences: content => ({
          modelContent: `resolved:${content}`,
          contentParts: [{ type: 'text', content }],
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{
          content: 'raw steer text',
          timestamp: 123,
          id: 'steer-message-id',
          modelContent: 'resolved steer text',
          contentParts: [{ type: 'text', content: 'raw steer text' }],
          persisted: true,
        }],
        getSession: () => ({
          contextSize: 0,
          lastInputTokens: 0,
          messages: [],
        }),
        compactSessionContext: async () => ({
          success: true,
          retainedContextSize: 0,
        }),
        emitEvent: async () => undefined,
        logger: {},
      },
    })

    expect(persisted).toEqual([])
    expect(replacement).toEqual({
      startNewResponse: true,
      messages: [
        { role: 'user', content: 'original question' },
        { role: 'user', content: 'resolved steer text' },
      ],
    })
  })

  // 2026-08-23:hard-limit 触发整条删除 —— 判定只认用户百分比。9900/10000 过线,
  // 所以是 'threshold';8000/10000(80% < 85%)不过线,哪怕"输入 + 任何预留输出"
  // 早就贴满窗口,也只能是 'none'。
  it('judges a provider turn on the user threshold only', () => {
    expect(getContextCompactReason({
      session: { contextSize: 9900 },
      sessionMessages: [],
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe('threshold')

    expect(getContextCompactReason({
      session: { contextSize: 8000 },
      sessionMessages: [],
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe(null)

    expect(getContextUsageTriggerReason({
      inputTokens: 8000,
      modelContextLength: 10000,
      thresholdPercent: 85,
    })).toBe('none')
  })

  it('plans agent-loop context compact passes and result transitions in core', () => {
    expect(shouldStartAgentLoopContextCompact({
      turn: 1,
      providerId: 'deepseek',
      compactEnabled: true,
    })).toBe(false)
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId: 'acp',
      compactEnabled: true,
    })).toBe(false)
    expect(shouldStartAgentLoopContextCompact({
      turn: 2,
      providerId: 'deepseek',
      compactEnabled: true,
    })).toBe(true)

    const budget = {
      modelContextLength: 10000,
      reservedOutputTokens: 512,
      thresholdPercent: 85,
    }
    const initial = createAgentLoopCompactState(3)
    expect(planAgentLoopContextCompactPass({
      state: initial,
      session: { messages: [], contextSize: 9000 },
      providerId: 'deepseek',
      budget,
    })).toEqual({
      kind: 'compact',
      state: initial,
      reason: 'threshold',
      keepRecentTurns: 3,
      pass: 1,
    })

    expect(planAgentLoopContextCompactPass({
      state: initial,
      session: { messages: [], contextSize: 12000 },
      providerId: 'codex',
      budget,
      providerUsageMismatch: true,
    })).toEqual({
      kind: 'skip-provider-usage-mismatch',
      state: initial,
    })

    const skipped = applyAgentLoopContextCompactResult({
      state: initial,
      reason: 'threshold',
      success: true,
      skipped: true,
    })
    expect(skipped).toEqual({
      kind: 'retry',
      state: {
        configuredKeepTurns: 3,
        keepRecentTurns: 2,
        pass: 2,
        compacted: false,
      },
    })

    // 2026-08-23:压过一次就收 —— 'hard-limit' 那条会递减 keepRecentTurns 再重来
    // 的支线随触发器一起删除,失败一律 'stop'。
    const compacted = applyAgentLoopContextCompactResult({
      state: skipped.state,
      reason: 'threshold',
      success: true,
      skipped: false,
    })
    expect(compacted).toEqual({
      kind: 'stop',
      state: {
        configuredKeepTurns: 3,
        keepRecentTurns: 2,
        pass: 2,
        compacted: true,
      },
    })

    expect(applyAgentLoopContextCompactResult({
      state: compacted.state,
      reason: 'threshold',
      success: false,
    })).toEqual({
      kind: 'stop',
      state: compacted.state,
    })

    // 收尾计划只看"这一轮压过没有",不再有把仍然超窗当错误抛出的分支。
    expect(planAgentLoopContextCompactFinal({
      state: compacted.state,
    })).toEqual({ kind: 'rebuild' })

    expect(planAgentLoopContextCompactFinal({
      state: { configuredKeepTurns: 3, keepRecentTurns: 3, pass: 1, compacted: false },
    })).toEqual({ kind: 'none' })
  })

  it('builds context compact event plans without an EventBus', () => {
    expect(buildAgentLoopContextCompactEventPlan({
      success: true,
      skipped: false,
      summary: 'summary',
      retainedContextSize: 123,
    })).toEqual([
      {
        type: 'context:compact-completed',
        success: true,
        skipped: false,
        summary: 'summary',
        error: undefined,
      },
      {
        type: 'context:size-updated',
        contextSize: 123,
      },
    ])

    expect(buildAgentLoopContextCompactEventPlan({
      success: true,
      skipped: true,
    })).toEqual([
      {
        type: 'context:compact-completed',
        success: true,
        skipped: true,
        summary: undefined,
        error: undefined,
      },
    ])
  })

  it('floors positive finite token limits only', () => {
    expect(positiveTokenLimit(10.8)).toBe(10)
    expect(positiveTokenLimit(0)).toBeUndefined()
    expect(positiveTokenLimit(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('resolves context budget values without model registry dependencies', () => {
    expect(resolveAgentLoopContextBudgetValues({
      providerConfig: {
        model: 'deepseek-chat',
      },
      registeredModelContextLength: 64000,
      registeredModelMaxOutputTokens: 8192,
      chatMaxTokens: 4096,
      contextCompactThreshold: 90,
    })).toEqual({
      modelContextLength: 64000,
      reservedOutputTokens: 4096,
      thresholdPercent: 90,
    })

    expect(resolveAgentLoopContextBudgetValues({
      capabilities: {
        maxInputTokens: 200000.9,
        maxOutputTokens: 12000,
      },
      providerConfig: {
        model: 'deepseek-reasoner',
        maxOutputByModel: {
          'deepseek-reasoner': 20000,
        },
      },
      registeredModelContextLength: 64000,
      registeredModelMaxOutputTokens: 8192,
      chatMaxTokens: 4096,
    })).toEqual({
      modelContextLength: 200000,
      reservedOutputTokens: 12000,
      thresholdPercent: 85,
    })

    expect(resolveAgentLoopContextBudgetValues({
      providerConfig: {
        model: 'custom-small',
      },
      chatMaxTokens: 2048,
    })).toEqual({
      modelContextLength: 128000,
      reservedOutputTokens: 2048,
      thresholdPercent: 85,
    })
  })

  // 回归(2026-08-23,grok-4.5/4.6 形状):models.dev 上 context 与 max output
  // 都是 500000,预留照旧取一半 = 250000。从前那条 hard-limit 线
  // (input + 250000 >= 500000 − margin)会在 ~50% 抢在用户的 90% 前面触发;
  // 现在预留只喂请求的 maxTokens,一格都不进触发判定。
  it('never lets reserved output influence the compact trigger', () => {
    const budget = resolveAgentLoopContextBudgetValues({
      providerConfig: { model: 'grok-4.5' },
      registeredModelContextLength: 500000,
      registeredModelMaxOutputTokens: 500000,
      chatMaxTokens: 4096,
      contextCompactThreshold: 90,
    })
    expect(budget).toEqual({
      modelContextLength: 500000,
      // 请求的 max_tokens 照旧是"模型最大输出的一半"——公式没动。
      reservedOutputTokens: 250000,
      thresholdPercent: 90,
    })

    const cases: Array<{ inputTokens: number; expected: 'none' | 'threshold' }> = [
      // 262435 / 500000 = 52.5%:旧 hard-limit 线上早就红了,新判据必须是 'none'。
      { inputTokens: 262435, expected: 'none' },
      { inputTokens: 449999, expected: 'none' },
      { inputTokens: 450000, expected: 'threshold' },
    ]
    for (const { inputTokens, expected } of cases) {
      expect(getContextUsageTriggerReason({
        inputTokens,
        modelContextLength: budget.modelContextLength,
        thresholdPercent: budget.thresholdPercent,
      })).toBe(expected)
      expect(getContextCompactReason({
        session: { contextSize: inputTokens },
        modelContextLength: budget.modelContextLength,
        thresholdPercent: budget.thresholdPercent,
        inputTokens,
      })).toBe(expected === 'threshold' ? 'threshold' : null)
    }
  })

  it('runs context compaction through injected adapters and rebuilds messages', async () => {
    let session = {
      contextSize: 95,
      lastInputTokens: 95,
      messages: [],
    }
    const emitted: unknown[] = []
    const compactCalls: unknown[] = []
    const rebuilt = [{ role: 'user', content: 'rebuilt' }]

    await expect(maybeCompactAgentLoopContextWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: { chat: { contextCompactEnabled: true } },
      },
      turn: 2,
      messages: [],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 6,
      adapters: {
        getSession: () => session,
        compactSessionContext: async input => {
          compactCalls.push(input)
          await input.onMessageCreated({ id: 'compact-message' })
          await input.onMessageUpdated('compact-message', { content: 'summary' })
          session = {
            contextSize: 30,
            lastInputTokens: 30,
            messages: [],
          }
          return {
            success: true,
            summary: 'summary',
            retainedContextSize: 30,
          }
        },
        emitEvent: async (_sessionId, event) => {
          emitted.push(event)
        },
        rebuildMessages: async () => rebuilt,
        logger: {},
      },
    })).resolves.toBe(rebuilt)

    expect(compactCalls).toHaveLength(1)
    expect(compactCalls[0]).toMatchObject({
      sessionId: 's1',
      providerId: 'deepseek',
      configWithApiKey: {
        model: 'deepseek-chat',
        apiKey: '',
      },
      keepRecentTurns: 6,
    })
    expect(emitted).toEqual([
      { type: 'message:created', message: { id: 'compact-message' } },
      { type: 'message:updated', messageId: 'compact-message', updates: { content: 'summary' } },
      {
        type: 'context:compact-completed',
        success: true,
        skipped: undefined,
        summary: 'summary',
        error: undefined,
      },
      { type: 'context:size-updated', contextSize: 30 },
    ])
  })

  it('skips context compaction through injected provider-usage mismatch policy', async () => {
    const logger = { warn: () => undefined }
    await expect(maybeCompactAgentLoopContextWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 2,
      messages: [],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 6,
      adapters: {
        getSession: () => ({ contextSize: 120, lastInputTokens: 120, messages: [] }),
        shouldSkipProviderUsageMismatch: () => true,
        compactSessionContext: async () => {
          throw new Error('compact should not run')
        },
        emitEvent: async () => undefined,
        rebuildMessages: async () => [{ role: 'user', content: 'unexpected' }],
        logger,
      },
    })).resolves.toBeUndefined()
  })

  it('runs before-turn steering injection before context compaction in core', async () => {
    let session = {
      contextSize: 95,
      lastInputTokens: 95,
      messages: [],
    }
    const persisted: unknown[] = []
    const rebuildInputs: unknown[] = []
    const compactCalls: unknown[] = []
    const originalContent = 'x'.repeat(360)

    const replacement = await runAgentLoopBeforeTurnWithAdapters({
      ctx: {
        sessionId: 's1',
        providerId: 'deepseek',
        providerConfig: { model: 'deepseek-chat' },
        settings: {},
      },
      turn: 2,
      messages: [{ role: 'user', content: originalContent }],
      budget: {
        modelContextLength: 100,
        reservedOutputTokens: 10,
        thresholdPercent: 80,
      },
      compactEnabled: true,
      keepRecentTurns: 3,
      rebuildMessages: async messages => {
        rebuildInputs.push(messages)
        return [{ role: 'user', content: 'rebuilt' }]
      },
      adapters: {
        createPendingMessageId: () => 'steering-message',
        resolvePromptReferences: content => ({
          modelContent: content.toUpperCase(),
          contentParts: [{ type: 'text', content }],
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{ content: 'steer', timestamp: 123 }],
        getSession: () => session,
        compactSessionContext: async input => {
          compactCalls.push(input)
          session = {
            contextSize: 20,
            lastInputTokens: 20,
            messages: [],
          }
          return {
            success: true,
            retainedContextSize: 20,
          }
        },
        emitEvent: async () => undefined,
        logger: {},
      },
    })

    expect(persisted).toEqual([{
      id: 'steering-message',
      role: 'user',
      content: 'STEER',
      timestamp: 123,
      contentParts: [{ type: 'text', content: 'steer' }],
    }])
    expect(compactCalls).toHaveLength(1)
    expect(rebuildInputs).toEqual([[
      { role: 'user', content: originalContent },
      { role: 'user', content: 'STEER' },
    ]])
    expect(replacement).toEqual({
      startNewResponse: true,
      messages: [{ role: 'user', content: 'rebuilt' }],
    })
  })

  it('runs after-turn steering before follow-up messages in core', async () => {
    let followUpDrained = false
    const persisted: unknown[] = []

    const replacement = await runAgentLoopAfterTurnWithAdapters({
      messages: [{ role: 'assistant', content: 'done' }],
      adapters: {
        createPendingMessageId: () => 'after-steering-message',
        resolvePromptReferences: content => ({
          modelContent: content,
        }),
        persistInjectedChatMessage: message => {
          persisted.push(message)
        },
        drainSteeringMessages: () => [{ content: 'steer after', timestamp: 456 }],
        drainFollowUpMessages: () => {
          followUpDrained = true
          return [{ content: 'follow up', timestamp: 789 }]
        },
      },
    })

    expect(followUpDrained).toBe(false)
    expect(persisted).toEqual([{
      id: 'after-steering-message',
      role: 'user',
      content: 'steer after',
      timestamp: 456,
      contentParts: undefined,
    }])
    expect(replacement).toEqual([
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'steer after' },
    ])
  })
})
