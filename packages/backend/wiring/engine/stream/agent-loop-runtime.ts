import {
  buildOnethingAgentLoopStreamRuntime,
  createOnethingAgentLoopRuntimeAdapters,
  maybeCompactOnethingAgentLoopContext,
  streamOnethingAgentLoopChunks,
  type BuildOnethingAgentLoopStreamRuntimeResult,
  type OnethingAgentLoopContextBudget,
} from '@onething/runtime/agent-loop'
import type {
  AgentLoopOptions,
  AgentLoopResult,
  AgentMessage,
  AgentProviderStreamChunk,
} from '@onething/core/agent-loop'
import {
  getAgentLoopTransientTail,
} from '@onething/core/engine'
import * as store from '../../../store.js'
import { sessionCommands } from '../../../session/commands.js'
import { sessionReads } from '../../../session/reads.js'
import { goalRuntimeHooks } from '../../goals/runtime-hooks.js'
import { scratchpadRuntimeHooks } from '@onething/runtime/scratchpad/service-bound'
import { resolveAgentProfileForSessionObject } from '../../agents/profile.js'
import { getSkillsForSession } from '../../skills/session-skills.js'
import { getMCPToolDefinitionsForModel } from '@onething/runtime/mcp/index.wiring'
import * as modelRegistry from '../../providers/model-registry.js'
import { createAgentProviderFromRuntime } from '../../providers/agent-runtime.js'
import type { ChatMessage, ChatSession, SkillDefinition } from '@shared/ipc.js'
import { toJsonObject } from '@shared/json.js'
import { buildHistoryMessages, type HistoryMessage } from './message-helpers.js'
import type { StreamContext } from './stream-processor.js'
import { buildPrompt } from '../prompt/system-prompt.js'
import { SessionTurnContext, type SessionTurnContextStore } from '@onething/runtime/engine/session-turn-context.wiring'
import { buildProjectDirsPromptVars } from '../../project-dirs/index.js'
import { executeToolDirectly } from './tool-execution.js'
import { compactSessionContext } from '../context-compact.js'
import * as contextCompact from '../context-compact.js'
import { getEventBus } from '../../../events/index.js'
import { resolvePromptReferences } from '@onething/runtime/prompts/resolver.wiring'
import type { IPCEmitter } from '@onething/runtime/engine/ipc-emitter.wiring'

import { SESSION_EVENT_TYPES } from '@shared/events/index.js'
import { consolePort, getLogger } from '../../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingAgentLoopLogger } from '@onething/runtime/agent-loop/stream-runtime'
import type { ToolExecutionResult, ToolPartialResultUpdate } from '@onething/runtime/toolkit/execution-types.wiring'
import type { ContextCompactResult } from '../context-compact.js'
import type { ContentPart } from '@/types'
import type { PromptRequestMessage } from '../prompt/system-prompt.js'
import type { CoreAgentLoopRuntimeToolSettingsLike } from '@onething/core/engine'
import type { ProviderConfigWithKey } from './stream-executor.js'
import type { AppSettings, ToolDefinition } from '@shared/ipc.js'
import type { OnethingAgentLoopRuntimeHostAdapters } from '@onething/runtime/agent-loop/stream-runtime'

const log = getLogger('engine.stream')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingAgentLoopLogger = consolePort(log)


export {
  getAgentLoopTransientTail,
}

export type BuildAgentLoopStreamRuntimeResult =
  BuildOnethingAgentLoopStreamRuntimeResult<SkillDefinition> & {
    runtime?: AgentLoopOptions
  }

export interface BuildAgentLoopStreamRuntimeOptions {
  emitter?: IPCEmitter
  /**
   * §15.15:压缩重建**读 store 之前**要跑的那一步。
   *
   * 唯一的生产实现是执行器的 `settlePendingAssistantWriterBeforeStoreRead`
   * (把还挂着的那次换锚点先收尾,否则重建出来的历史会少一整轮)。不接 = 重建
   * 直接读,行为与从前逐字相同。
   */
  beforeRebuildMessages?: () => Promise<void> | void
}

export type AgentLoopContextBudget = OnethingAgentLoopContextBudget

function shouldSkipAutoCompactForProviderUsageMismatchSafe(input: {
  providerId: string
  session: ChatSession
  modelContextLength: number
  inputTokens?: number
}): boolean {
  try {
    const fn = (contextCompact as {
      shouldSkipAutoCompactForProviderUsageMismatch?: (input: {
        providerId: string
        session: ChatSession
        modelContextLength: number
        inputTokens?: number
      }) => boolean
    }).shouldSkipAutoCompactForProviderUsageMismatch
    return typeof fn === 'function' ? fn(input) : false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('shouldSkipAutoCompactForProviderUsageMismatch')) return false
    throw error
  }
}

export async function maybeCompactAgentLoopContext(options: {
  ctx: StreamContext
  turn: number
  messages: AgentMessage[]
  budget: AgentLoopContextBudget
  rebuildMessages: () => Promise<AgentMessage[]>
}): Promise<AgentMessage[] | undefined> {
  return maybeCompactOnethingAgentLoopContext({
    ctx: {
      sessionId: options.ctx.sessionId,
      providerId: options.ctx.providerId,
      providerConfig: options.ctx.providerConfig,
      settings: options.ctx.settings,
    },
    turn: options.turn,
    messages: options.messages,
    budget: options.budget,
    compactEnabled: options.ctx.settings.chat?.contextCompactEnabled !== false,
    keepRecentTurns: options.ctx.settings.chat?.contextCompactKeepRecentTurns ?? 6,
    rebuildMessages: options.rebuildMessages,
    adapters: {
      getSession: sessionId => store.getSession(sessionId),
      compactSessionContext: input => compactSessionContext(withCompactProgressEmit(input)),
      emitEvent,
      shouldSkipProviderUsageMismatch: input => shouldSkipAutoCompactForProviderUsageMismatchSafe(input),
      logger: consoleLog,
    },
  })
}

export async function buildAgentLoopRuntimeFromStreamContext(
  ctx: StreamContext,
  historyMessages: HistoryMessage[],
  options: BuildAgentLoopStreamRuntimeOptions = {},
): Promise<BuildAgentLoopStreamRuntimeResult> {
  const result = await buildOnethingAgentLoopStreamRuntime(
    ctx,
    historyMessages,
    createAgentLoopRuntimeAdapters(options),
  )
  return result as BuildAgentLoopStreamRuntimeResult
}

export async function* streamAgentLoopChunksFromStreamContext(
  ctx: StreamContext,
  historyMessages: HistoryMessage[],
): AsyncGenerator<AgentProviderStreamChunk, AgentLoopResult, void> {
  const result = yield* streamOnethingAgentLoopChunks(ctx, historyMessages, createAgentLoopRuntimeAdapters())
  return result
}

function createAgentLoopRuntimeAdapters(
  options: BuildAgentLoopStreamRuntimeOptions = {},
) {
  const agentLoopRuntimeHostAdapters: OnethingAgentLoopRuntimeHostAdapters<AppSettings, ProviderConfigWithKey, CoreAgentLoopRuntimeToolSettingsLike | undefined, ChatSession, ChatMessage, HistoryMessage, PromptRequestMessage, SkillDefinition, ToolDefinition, ContentPart[], ContextCompactResult, ToolExecutionResult, ToolPartialResultUpdate> = {
    getSession: (sessionId: string) => store.getSession(sessionId),
    getSkillsForSession,
    createProvider: createAgentProviderFromRuntime,
    resolveModelContextLength: modelRegistry.getModelContextLength,
    resolveModelMaxOutputTokens: modelRegistry.getModelMaxOutputTokens,
    getMCPToolDefinitionsForModel,
    getAgentToolAllowlist: (agentId: string | undefined, session?: unknown) => {
      // Fallback only: a run with a resolved profile reads the snapshot
      // instead (see stream-runtime.ts)。真链路恒在回合入口解析好快照
      // (agent-loop-executor.ts),这条只接住"直接 build runtime"的调用。
      //
      // C2「工具面单点」:它必须与快照**同解**,所以走的是同一个解析入口,而不是
      // 就地再写一遍会话输入 —— 旧写法只喂了 kind、漏了 dm,快照一缺席就会把 D7
      // 私聊那一格悄悄算成群房那一格。少喂一个字段就是一条潜伏分叉。
      return resolveAgentProfileForSessionObject(
        session as ChatSession | undefined,
        agentId,
      ).tools
    },
    buildProjectPromptVars: buildProjectDirsPromptVars,
    /**
     * The turn channel is attached here, on the real turn path only (a prompt
     * snapshot or an eval must never write to a session). The composer decided
     * the blocks from this very build's context; `SessionTurnContext` decides
     * which of them are new, persists that on the newest user message, and puts
     * it in this request. Repeated builds inside one turn find the field
     * already written and change nothing — identical request bytes.
     */
    buildPrompt: async (promptOptions: Parameters<typeof buildPrompt>[0]) => {
      const result = await buildPrompt({
        ...promptOptions,
        providerConfig: toJsonObject(promptOptions.providerConfig),
      } as Parameters<typeof buildPrompt>[0])
      return {
        ...result,
        messages: sessionTurnContext.attach(
          promptOptions.sessionId,
          result.messages,
          result.turn ?? [],
        ),
      }
    },
    buildHistoryMessages: (messages: ChatMessage[], session: ChatSession) =>
      buildHistoryMessages(messages, session),
    // C1:回合中重建历史时,消息从读门面现取(产品层不许自己持有 session.messages)。
    listSessionMessages: (sessionId: string) =>
      [...sessionReads.listMessages(sessionId).messages],
    // §15.15:重建读 store 之前的顺序约束(见 options 上的注释)。
    beforeRebuildMessages: options.beforeRebuildMessages,
    resolvePromptReferences(content, input) {
      const resolvedPromptRefs = resolvePromptReferences(content, { skills: input.skills })
      return {
        modelContent: resolvedPromptRefs.modelContent,
        contentParts: resolvedPromptRefs.contentParts,
      }
    },
    persistInjectedChatMessage(sessionId: string, injectedMessage: unknown) {
      store.addMessage(sessionId, injectedMessage as ChatMessage)
    },
    executeToolDirectly: (
      toolName: string,
      args: Parameters<typeof executeToolDirectly>[1],
      toolContext: Parameters<typeof executeToolDirectly>[2],
    ) =>
      executeToolDirectly(toolName, args, toolContext as Parameters<typeof executeToolDirectly>[2]),
    compactSessionContext: (input: Parameters<typeof compactSessionContext>[0]) =>
      compactSessionContext(withCompactProgressEmit(input)),
    emitEvent,
    shouldSkipProviderUsageMismatch: (input: {
      providerId: string
      session: ChatSession
      modelContextLength: number
      inputTokens?: number
    }) => shouldSkipAutoCompactForProviderUsageMismatchSafe(input),
    goal: goalRuntimeHooks,
    scratchpad: scratchpadRuntimeHooks,
    logger: consoleLog,
    createId: undefined,
  };
  return createOnethingAgentLoopRuntimeAdapters(agentLoopRuntimeHostAdapters)
}

/**
 * C6:回合中(mid-turn)那条压缩路的进度接线。核心引擎的手动/自动两路在
 * `runContextCompact` 里统一接,这条不经过那里 —— 它从 agent-loop 的 adapters
 * 直接调 `compactSessionContext`,所以进度也在这里往 eventBus 转发一次。
 */
function withCompactProgressEmit(
  input: unknown,
): Parameters<typeof compactSessionContext>[0] {
  const options = input as Parameters<typeof compactSessionContext>[0]
  return {
    ...options,
    onProgress: progress => emitEvent(options.sessionId, {
      type: SESSION_EVENT_TYPES.CONTEXT_COMPACT_PROGRESS,
      chunk: progress.chunk,
      totalChunks: progress.totalChunks,
    }),
  }
}

/**
 * One per process: it is stateless, the session store holds the record.
 * 三个端口全部走门面(P0.2 区 ②),且全部**同步** —— `attach()` 是同步的,
 * 幂等闸靠持久化的 `turnContext` 字段,写档与迁移前的
 * `store.updateMessageTurnContext`(无 hint → 常规 300ms 档)逐字等价。
 */
const sessionTurnContextStore: SessionTurnContextStore = {
  listMessages: (sessionId: string) => sessionReads.listMessages(sessionId).messages,
  getSessionMeta: (sessionId: string) => sessionReads.getSession(sessionId),
  updateMessageTurnContext: (sessionId: string, messageId: string, turnContext) =>
    sessionCommands.patchMessage(sessionId, {
      messageId,
      patch: { turnContext },
      hint: 'settle',
    }),
};
const sessionTurnContext = new SessionTurnContext(sessionTurnContextStore)

async function emitEvent(sessionId: string, event: unknown): Promise<void> {
  await getEventBus().emit(sessionId, event as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}
