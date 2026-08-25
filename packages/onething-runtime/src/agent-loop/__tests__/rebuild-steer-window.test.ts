/**
 * §15.15:**压缩重建必须看到收尾之后的 store。**
 *
 * 病根的形状(与 U0 的换锚点同一条链):`rotateAssistantWriterIdentity` 在
 * agent-loop 发 `response-boundary` 的**同步点**就把身份换掉,而上一条 assistant 的
 * `isStreaming` 要等消费侧那一半(`createNextAssistantWriter` → `finalize()`)才落成
 * false。afterTurn 发的 boundary 之后,**下一轮的 `beforeTurn` 排在那个 turn-start
 * 之前** —— 压缩重建就跑在 `beforeTurn` 里。于是重建去读 store 时上一条 assistant
 * 还挂着 `isStreaming`,`buildHistoryMessages` 见了整条跳过
 * (`core/engine/history.ts` :753/:812),**模型真的看不到上一条回复**。
 *
 * 这条测试就是那件事的反证:同一条重建路,
 *  - 不接 `beforeRebuildMessages`(= 修前):重建出来的历史里没有上一条 assistant;
 *  - 接上(宿主在那个口里把收尾补掉):上一条 assistant 回来了。
 *
 * 历史构造走的是**真的那一份**(`buildOnethingHistoryMessages`),不是就地抄一条
 * `isStreaming` 判断 —— 否则这条测试只是在证明测试自己。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider } from '@onething/core/agent-loop'
import { Catalog, Intent, Tool as ToolkitTool } from '@onething/core/toolkit'
import type { Result, ToolSpec } from '@onething/core/toolkit'
import { configureToolkitCatalog } from '../../toolkit/host.js'
import { buildOnethingHistoryMessages } from '../../sessions/history-messages.js'
import { buildOnethingAgentLoopStreamRuntime } from '../stream-runtime.js'

class NoopTool extends ToolkitTool<Record<string, never>, undefined> {
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

configureToolkitCatalog(new Catalog().register(new NoopTool()))

const PREVIOUS_ANSWER = 'the answer from the interrupted response'

interface StoreMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  isStreaming?: boolean
}

/** 换锚点的同步那一半跑完、消费侧还没接手时,store 里就是这个样子。 */
function midRotationMessages(): StoreMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'first question', timestamp: 1 },
    // 同步点已经把 run 换掉,但收尾(isStreaming:false)还没跑。
    { id: 'a1', role: 'assistant', content: PREVIOUS_ANSWER, timestamp: 2, isStreaming: true },
    { id: 'u2', role: 'user', content: 'steered question', timestamp: 3 },
  ]
}

const provider: AgentProvider = {
  id: 'test-provider',
  capabilities: {
    capabilities: ['text-input', 'text-output', 'streaming', 'tool-calls'],
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsStreaming: true,
    supportsTools: true,
    maxInputTokens: 10000,
    maxOutputTokens: 512,
  },
  async runTurn() {
    return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }
  },
}

/**
 * 跑一次"这一轮判成压缩重建"的 `beforeTurn`,返回重建后交给模型的那份消息。
 *
 * @param settleBeforeRebuild 宿主接不接 `beforeRebuildMessages`(= 修后 / 修前)。
 */
async function rebuildOnceInSteerWindow(settleBeforeRebuild: boolean): Promise<unknown[]> {
  const messages = midRotationMessages()
  const session = { workingDirectory: '/repo', messages }

  const result = await buildOnethingAgentLoopStreamRuntime(
    {
      sessionId: 's1',
      assistantMessageId: 'a2',
      providerId: 'test-provider',
      providerConfig: { model: 'model-a', apiKey: 'key' },
      settings: {
        skills: { enableSkills: false },
        tools: { enableToolCalls: false },
        chat: {
          maxTokens: 512,
          contextCompactThreshold: 85,
          contextCompactEnabled: true,
          contextCompactKeepRecentTurns: 6,
        },
      },
    },
    [{ role: 'user', content: 'steered question' }],
    {
      getSession: () => session,
      listSessionMessages: () => session.messages,
      getSkillsForSession: () => [],
      isProviderSupported: (providerId: string) => providerId === 'test-provider',
      createProvider: () => provider,
      resolveModelContextLength: () => 10000,
      resolveModelMaxOutputTokens: () => 512,
      buildProjectPromptVars: () => ({
        active: { hasActive: false },
        known: { hasAny: false, entries: [] },
      }),
      buildPrompt: async options => ({
        messages: [{ role: 'system' as const, content: 'system' }, ...options.historyMessages],
        systemPrompt: 'system',
        developerMessages: [],
      }),
      // 真的那一份历史构造(`isStreaming` 整条跳过就发生在它里面)。
      buildHistoryMessages: (storeMessages: StoreMessage[]) =>
        buildOnethingHistoryMessages(storeMessages) as never,
      ...(settleBeforeRebuild
        ? {
            // 宿主的收尾那一半(执行器侧是
            // `settlePendingAssistantWriterBeforeStoreRead`,这里只留它的效果)。
            beforeRebuildMessages: () => {
              const previous = session.messages.find(message => message.id === 'a1')
              if (previous) previous.isStreaming = false
            },
          }
        : {}),
      resolvePromptReferences: (content: string) => ({ modelContent: content }),
      persistInjectedChatMessage: () => {},
      executeToolDirectly: async () => ({ success: true, data: { output: '' } }),
      // 压缩成功且没跳过 = 这一轮判成 rebuild。
      compactSessionContext: async () => ({
        success: true,
        summary: 'compacted',
        retainedContextSize: 0,
      }),
      emitEvent: async () => {},
      logger: { info: vi.fn(), warn: vi.fn() },
    },
  )

  if (!result.supported) throw new Error(result.reason)

  const replacement = await result.runtime.beforeTurn?.({
    provider,
    model: 'model-a',
    // 长到越过 85% 那条线,这一轮才会判成压缩(→ 重建)。
    messages: [{ role: 'user', content: 'hello '.repeat(10000) }],
    tools: [],
    skills: [],
    turn: 2,
  })

  // beforeTurn 的返回是"整份消息"或"带 startNewResponse 的替换体",这条路恒为后者。
  if (!replacement || Array.isArray(replacement)) return replacement ?? []
  return replacement.messages
}

describe('压缩重建落在 steer 换锚点窗口里(§15.15)', () => {
  it('修前:上一条 assistant 还挂着 isStreaming,重建出来的历史真的少一整轮', async () => {
    const messages = await rebuildOnceInSteerWindow(false)
    // 重建确实跑了、也确实读到了 store(两条 user 消息都在)……
    expect(JSON.stringify(messages)).toContain('first question')
    expect(JSON.stringify(messages)).toContain('steered question')
    // ……唯独上一条 assistant 被 `isStreaming` 整条滤掉了。
    expect(JSON.stringify(messages)).not.toContain(PREVIOUS_ANSWER)
  })

  it('修后:重建先等宿主把收尾跑完,上一条 assistant 回到历史里', async () => {
    const messages = await rebuildOnceInSteerWindow(true)
    expect(JSON.stringify(messages)).toContain('first question')
    expect(JSON.stringify(messages)).toContain(PREVIOUS_ANSWER)
  })
})
