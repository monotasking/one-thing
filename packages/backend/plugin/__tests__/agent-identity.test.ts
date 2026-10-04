/**
 * M0 / F4 —— 身份透传的另外两处灌入点(第一处 promptContext 的验收在
 * `plugin/__tests__/plugin-prompt-context-agent-id.test.ts`)。
 *
 *  - **插件工具 ctx**:agent-loop 的直调工具面 → `executeCorePluginTool` → 插件;
 *  - **afterAssistantResponse ctx**:回合收尾时由会话本体摊到 ctx 的一等字段。
 *
 * 三处必须是**同一个语义**。各自去查 `session.agentId` 是最自然也最错的写法:
 * 群房里那个字段被协调器逐次翻面,现查等于每处各算各的,而 memory 的
 * "自己的 scope + global" 会安静地读到别人的记忆。
 *
 * 同样钉住的还有一条边界:**agentId 不是权限依据**。principal 与它并肩存在、
 * 互不替代 —— 权限降级到 system 的那一刻不该把插件的作用域也一起擦掉。
 */
import { describe, expect, it } from 'vitest'
import { buildAgentLoopDirectToolsWithAdapters } from '@onething/backend/agent-loop'
import { buildAgentLoopPostResponseContexts } from '../../agent-loop/agent-loop-executor-post-response.js'
import { executeCorePluginTool } from '../plugin-api-builder.js'
import { systemPrincipal } from '@shared/permission/principal'

describe('F4 — the plugin tool ctx carries the turn agentId', () => {
  it('threads agentId from the agent-loop runtime context into the tool execution context', async () => {
    const seen: Array<Record<string, unknown>> = []

    const tools = buildAgentLoopDirectToolsWithAdapters({
      definitions: {
        memory_query: { name: 'memory_query', description: 'q', parameters: [] } as never,
      },
      context: {
        sessionId: 's1',
        messageId: 'm1',
        principal: systemPrincipal('test'),
        agentId: 'researcher',
      },
      async executeToolDirectly(_name, _args, context) {
        seen.push(context as unknown as Record<string, unknown>)
        return { success: true, content: 'ok' }
      },
    })

    await tools[0].execute({}, { toolCallId: 'tc1' } as never)

    expect(seen).toHaveLength(1)
    expect(seen[0].agentId).toBe('researcher')
    // 与 principal 并肩,不互相替代:身份降级不该顺手擦掉作用域。
    expect(seen[0].principal).toEqual(systemPrincipal('test'))
  })

  it('executeCorePluginTool hands agentId to the plugin, defaulting to undefined', async () => {
    const calls: Array<string | undefined> = []
    const tool = {
      name: 'remember',
      description: 'd',
      parameters: {},
      async execute(_args: unknown, ctx: { agentId?: string }) {
        calls.push(ctx.agentId)
        return { title: 't', output: 'o', metadata: {} }
      },
    }

    await executeCorePluginTool(tool, {}, {
      sessionId: 's1',
      messageId: 'm1',
      agentId: 'researcher',
    })
    await executeCorePluginTool(tool, {}, { sessionId: 's1', messageId: 'm1' })

    expect(calls).toEqual(['researcher', undefined])
  })
})

describe('F4 — the afterAssistantResponse ctx carries the turn agentId', () => {
  const base = {
    sessionId: 's1',
    assistantMessageId: 'a1',
    lastAssistantMessage: 'done',
    historyMessages: [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'done' },
    ],
    providerId: 'openai',
    providerConfig: {},
    settings: {},
    toolIterations: 1,
    skillManageCalled: false,
    prepared: { toolNames: [], mcpToolNames: [] } as never,
  }

  it('lifts session.agentId onto the hook context as a first-class field', () => {
    const contexts = buildAgentLoopPostResponseContexts({
      ...base,
      session: { messages: [], agentId: 'researcher' },
    })

    expect(contexts?.afterAssistantResponseContext.agentId).toBe('researcher')
    // 触发器那条 ctx 刻意不摊 —— 它的既有消费者用的是 session 本体,
    // 多一份摊平的事实就多一处要保持同步的地方。
    expect((contexts?.triggerContext as { agentId?: string }).agentId).toBeUndefined()
  })

  it('omits agentId entirely when the session has no agent bound', () => {
    const contexts = buildAgentLoopPostResponseContexts({
      ...base,
      session: { messages: [] },
    })

    expect(contexts?.afterAssistantResponseContext.agentId).toBeUndefined()
    expect('agentId' in (contexts?.afterAssistantResponseContext ?? {})).toBe(false)
  })
})
