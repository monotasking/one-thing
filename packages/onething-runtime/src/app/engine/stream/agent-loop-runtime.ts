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
  buildAgentLoopContextHardLimitError,
  getAgentLoopContextBlockReason,
  getAgentLoopTransientTail,
} from '@onething/core/engine'
import * as store from '../../store.js'
import { goalRuntimeHooks } from '../../goals/runtime-hooks.js'
import { scratchpadRuntimeHooks } from '../../scratchpad/index.js'
import { resolveAgentProfileForSessionObject } from '../../agents/profile.js'
import { getSkillsForSession } from '../../skills/session-skills.js'
import { getMCPToolDefinitionsForModel } from '../../mcp/index.js'
import * as modelRegistry from '../../providers/model-registry.js'
import { createAgentProviderFromRuntime } from '../../providers/agent-runtime.js'
import {
  getEnabledToolsAsync,
  initializeAsyncTools,
  setInitContext,
} from '../../tools/index.js'
import type { ChatMessage, ChatSession, SkillDefinition } from '@shared/ipc.js'
import { toJsonObject } from '@shared/json.js'
import { buildHistoryMessages, type HistoryMessage } from './message-helpers.js'
import type { StreamContext } from './stream-processor.js'
import { buildPrompt } from '../prompt/index.js'
import { buildProjectDirsPromptVars } from '../../project-dirs/index.js'
import { executeToolDirectly } from './tool-execution.js'
import { compactSessionContext } from '../context-compact.js'
import * as contextCompact from '../context-compact.js'
import { getEventBus } from '../../events/index.js'
import { resolvePromptReferences } from '../../prompts/resolver.js'
import type { IPCEmitter } from './ipc-emitter.js'

export {
  buildAgentLoopContextHardLimitError,
  getAgentLoopContextBlockReason,
  getAgentLoopTransientTail,
}

export type BuildAgentLoopStreamRuntimeResult =
  BuildOnethingAgentLoopStreamRuntimeResult<SkillDefinition> & {
    runtime?: AgentLoopOptions
  }

export interface BuildAgentLoopStreamRuntimeOptions {
  emitter?: IPCEmitter
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
      compactSessionContext: input => compactSessionContext(input as Parameters<typeof compactSessionContext>[0]),
      emitEvent,
      shouldSkipProviderUsageMismatch: input => shouldSkipAutoCompactForProviderUsageMismatchSafe(input),
      logger: console,
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
  return createOnethingAgentLoopRuntimeAdapters({
    getSession: (sessionId: string) => store.getSession(sessionId),
    getSkillsForSession,
    async initializeTools(skills) {
      setInitContext({
        skills,
      })
      await initializeAsyncTools()
    },
    createProvider: createAgentProviderFromRuntime,
    resolveModelContextLength: modelRegistry.getModelContextLength,
    resolveModelMaxOutputTokens: modelRegistry.getModelMaxOutputTokens,
    getEnabledTools: getEnabledToolsAsync,
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
    buildPrompt: (promptOptions: Parameters<typeof buildPrompt>[0]) => buildPrompt({
      ...promptOptions,
      providerConfig: toJsonObject(promptOptions.providerConfig),
    } as Parameters<typeof buildPrompt>[0]),
    buildHistoryMessages: (messages: ChatMessage[], session: ChatSession) =>
      buildHistoryMessages(messages, session),
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
      compactSessionContext(input as Parameters<typeof compactSessionContext>[0]),
    emitEvent,
    shouldSkipProviderUsageMismatch: (input: {
      providerId: string
      session: ChatSession
      modelContextLength: number
      inputTokens?: number
    }) => shouldSkipAutoCompactForProviderUsageMismatchSafe(input),
    goal: goalRuntimeHooks,
    scratchpad: scratchpadRuntimeHooks,
    logger: console,
    createId: undefined,
  })
}

async function emitEvent(sessionId: string, event: unknown): Promise<void> {
  await getEventBus().emit(sessionId, event as Parameters<ReturnType<typeof getEventBus>['emit']>[1])
}
