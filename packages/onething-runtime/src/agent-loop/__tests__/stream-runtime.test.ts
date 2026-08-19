import { describe, expect, it, vi } from 'vitest'
import type {
  AgentProvider,
} from '@onething/core/agent-loop'
import type {
  CoreBuildPromptOptions,
  CorePendingAgentLoopInputMessage,
} from '@onething/core/engine'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import { configureToolkitCatalog } from '../../toolkit/host.js'
import { buildOnethingAgentLoopStreamRuntime } from '../stream-runtime.js'

/**
 * R4b:内置工具面的唯一来源是目录(`Surface.resolve`)。这个测试原本靠
 * `getEnabledTools` 这个适配器喂一只 `bash`,那条口径已随旧树删除。
 */
class StubBashTool extends ToolkitTool<Record<string, never>, undefined> {
  readonly spec: ToolSpec = {
    id: 'bash',
    title: 'bash',
    description: 'Run a command',
    input: { type: 'object', properties: {} },
    effects: [],
    presentation: { kind: 'bash', shell: 'default' },
    concurrency: 'sequential',
  }

  async plan(): Promise<Intent<undefined>> {
    return Intent.none(undefined)
  }

  async apply(): Promise<Result> {
    return { content: [{ type: 'text', text: '' }] }
  }
}

configureToolkitCatalog(new Catalog().register(new StubBashTool()))

interface TestSettings {
  skills?: { enableSkills?: boolean }
  tools?: {
    enableToolCalls?: boolean
    tools?: Record<string, { enabled?: boolean }>
  }
  chat?: {
    maxTokens?: number
    contextCompactThreshold?: number
    contextCompactEnabled?: boolean
    contextCompactKeepRecentTurns?: number
  }
}

interface TestProviderConfig {
  model: string
  apiKey?: string
}

interface TestMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  contentParts?: Array<{ type: string; content?: string }>
}

interface TestSession {
  workingDirectory?: string
  workingDirectoryRoots?: string[]
  agentId?: string
  contextSize?: number
  messages: TestMessage[]
}

interface TestSkill {
  id: string
  name: string
  description: string
  source: 'builtin'
  path: string
  directoryPath: string
  enabled: boolean
  instructions: string
}

function testSkill(): TestSkill {
  return {
    id: 'skill-docs',
    name: 'docs',
    description: 'Write docs',
    source: 'builtin',
    path: '/skills/docs/SKILL.md',
    directoryPath: '/skills/docs',
    enabled: true,
    instructions: 'Use crisp language.',
  }
}

describe('onething agent-loop stream runtime', () => {
  it('builds agent-loop runtime through host adapters without main-process imports', async () => {
    const session: TestSession = {
      workingDirectory: '/repo',
      workingDirectoryRoots: ['/repo'],
      agentId: 'agent-1',
      messages: [],
    }
    const provider: AgentProvider = {
      id: 'test-provider',
      capabilities: {
        capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsStreaming: true,
        supportsTools: true,
        maxInputTokens: 32000,
        maxOutputTokens: 2048,
      },
      async runTurn() {
        return {
          message: { role: 'assistant', content: 'ok' },
          finishReason: 'stop',
        }
      },
    }
    const promptInputs: CoreBuildPromptOptions[] = []
    const initializedSkills: string[][] = []
    const emittedEvents: unknown[] = []
    const persistedMessages: TestMessage[] = []
    const toolExecutionContexts: Array<{
      workingDirectory?: string
      workingDirectoryRoots?: string[]
    }> = []
    let steeringDrained = false
    const steeringQueue = {
      drain(): CorePendingAgentLoopInputMessage[] {
        if (steeringDrained) return []
        steeringDrained = true
        return [{ content: 'queued /docs', timestamp: 123 }]
      },
    }

    const result = await buildOnethingAgentLoopStreamRuntime(
      {
        sessionId: 's1',
        assistantMessageId: 'a1',
        providerId: 'test-provider',
        providerConfig: { model: 'model-a', apiKey: 'key' },
        settings: {
          skills: { enableSkills: true },
          tools: { enableToolCalls: true },
          chat: { maxTokens: 4096, contextCompactThreshold: 80 },
        },
        steeringQueue,
      },
      [{ role: 'user', content: 'hello' }],
      {
        getSession: () => session,
        getSkillsForSession: () => [testSkill()],
        initializeTools: skills => {
          initializedSkills.push(skills.map(skill => skill.id))
        },
        isProviderSupported: providerId => providerId === 'test-provider',
        createProvider: () => provider,
        getMCPRouterToolDefinition: () => ({
          id: 'mcp_search',
          description: 'Search MCP',
          parameterSchema: { type: 'object', properties: {} },
        }),
        buildProjectPromptVars: () => ({
          active: { hasActive: true, path: '/repo', displayPath: '/repo' },
          known: { hasAny: false, entries: [] },
        }),
        buildPrompt: async options => {
          promptInputs.push(options)
          return {
            messages: [{ role: 'system', content: 'system' }, ...options.historyMessages],
            systemPrompt: 'system',
            developerMessages: [],
          }
        },
        buildHistoryMessages: messages => messages.map(message => ({
          role: (message as TestMessage).role,
          content: (message as TestMessage).content,
        })),
        resolvePromptReferences: content => ({
          modelContent: `resolved:${content}`,
          contentParts: [{ type: 'text', content }],
        }),
        persistInjectedChatMessage: (_sessionId, message) => {
          persistedMessages.push(message as TestMessage)
        },
        emitInjectedUserMessage: (_sessionId, message) => {
          emittedEvents.push({ type: 'message:user-created', message })
        },
        executeToolDirectly: async (_toolName, _args, toolContext) => {
          toolExecutionContexts.push({
            workingDirectory: toolContext.workingDirectory,
            workingDirectoryRoots: toolContext.workingDirectoryRoots,
          })
          return {
            success: true,
            data: { output: 'tool ok' },
          }
        },
        compactSessionContext: async () => ({
          success: true,
          skipped: true,
        }),
        emitEvent: async (_sessionId, event) => {
          emittedEvents.push(event)
        },
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
      },
    )

    expect(result.supported).toBe(true)
    if (!result.supported) throw new Error(result.reason)

    expect(result.runtime.provider).toBe(provider)
    expect(result.runtime.model).toBe('model-a')
    expect(result.runtime.workingDirectory).toBe('/repo')
    expect(result.runtime.maxTokens).toBe(1024)
    expect(result.runtime.tools?.map(tool => tool.name)).toEqual(['bash', 'mcp_search'])
    expect(result.toolNames).toEqual(['bash'])
    expect(result.mcpToolNames).toEqual(['mcp_search'])
    expect(result.enabledSkills.map(skill => skill.id)).toEqual(['skill-docs'])
    expect(initializedSkills).toEqual([['skill-docs']])
    expect(promptInputs[0]).toMatchObject({
      sessionId: 's1',
      agentId: 'agent-1',
      workingDirectory: '/repo',
      toolNames: ['bash'],
      mcpToolNames: ['mcp_search'],
    })

    session.workingDirectory = '/repo-updated'
    session.workingDirectoryRoots = ['/repo-updated']
    await result.runtime.tools?.[0]?.execute(
      { command: 'pwd' },
      {
        sessionId: 's1',
        messageId: 'a1',
        toolCallId: 'call-1',
        workingDirectory: '/repo',
      },
    )
    expect(toolExecutionContexts).toEqual([{
      workingDirectory: '/repo-updated',
      workingDirectoryRoots: ['/repo-updated'],
    }])

    const replacement = await result.runtime.beforeTurn?.({
      provider,
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      tools: result.runtime.tools ?? [],
      skills: result.runtime.skills ?? [],
      turn: 1,
    })

    expect(replacement).toMatchObject({
      startNewResponse: true,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'user', content: 'resolved:queued /docs' },
      ],
    })
    expect(persistedMessages).toMatchObject([
      {
        id: expect.any(String),
        role: 'user',
        content: 'resolved:queued /docs',
        timestamp: 123,
      },
    ])
    expect(emittedEvents).toMatchObject([
      {
        type: 'message:user-created',
        message: { content: 'resolved:queued /docs' },
      },
    ])
  })
})
