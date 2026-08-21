/**
 * Stream Executor Module
 * Unified entry point for message streaming
 * Routes host-specific special streams before falling back to text streaming
 *
 * Uses StreamEngine for AbortController lifecycle management.
 */

import type { AppSettings, ProviderConfig, ToolSettings } from '@shared/ipc.js'
import type { Principal } from '@onething/core/permission'
import type { SessionRunKind } from '@onething/core/session'
import { endSessionRun, ensureSessionRun } from '../../session/runs.js'
import { sessionCommands } from '../../session/commands.js'
import { sessionReads } from '../../session/reads.js'
import * as modelRegistry from '../../providers/model-registry.js'
import {
  CODEX_NATIVE_IMAGE_GENERATION_TOOL,
  getCodexNativeToolsForConfig,
} from './codex-native-tools.js'
import { processImageGenerationStream } from './image-stream.js'
import {
  executeAgentLoopStreamGeneration,
  type AgentLoopStreamGenerationResult,
} from './agent-loop-executor.js'
import { type StreamContext, type StreamSender } from './stream-processor.js'
import { getStreamEngine } from '../index.js'
import type { HistoryMessage } from './message-helpers.js'
import type { ProviderAuthContext } from '@onething/runtime/auth/types.wiring'
import type { AgentOutputModality } from '@onething/core/agent-loop'
import {
  executeCoreMessageStream,
} from '@onething/core/engine'
import type { CoreInitialToolChoice } from '@onething/core/engine'
import { consolePort, getLogger } from '../../wiring/logging/index.js'

const log = getLogger('engine.stream')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


// Re-export for convenience
export type { HistoryMessage }

/**
 * Provider config with API key
 */
export interface ProviderConfigWithKey extends ProviderConfig {
  apiKey: string
  model: string
  authContext?: ProviderAuthContext
}

/**
 * Parameters for unified stream execution
 */
export interface StreamExecutionParams {
  sender: StreamSender
  sessionId: string
  assistantMessageId: string
  messageContent: string  // The prompt (for image) or last user message (for context)
  historyMessages: HistoryMessage[]
  configWithApiKey: ProviderConfigWithKey
  providerId: string
  requestedOutputModalities?: AgentOutputModality[]
  settings: AppSettings
  toolSettings?: ToolSettings
  sessionName?: string
  voiceConversation?: boolean
  speakMode?: boolean
  /** Billing attribution label for this turn's usage records (default 'chat'). */
  usageSource?: string
  /**
   * Force the run's FIRST model call into a (named) tool call — W18b, narrowed
   * to `say` by name in W22. Set only by the collab room drive, whose entire
   * output space is the tool surface.
   */
  initialToolChoice?: CoreInitialToolChoice
  /** Actor behind this turn; minted at the engine boundary, carried to tools. */
  principal?: Principal
  /**
   * S1a(§10.2):这次执行是**哪一种** —— send / retry / edit-resend / resume。
   * 由 core 引擎的四个入口各自盖章;缺省按 `send` 记(总比记成"不知道"强,
   * 而"不知道"在追踪面上就是一条断掉的线)。
   */
  runKind?: SessionRunKind
  /** 触发这次执行的那条消息(用户消息 / 被重试的那条)。 */
  triggerMessageId?: string
  /** 这次执行归属的 agent(人格)。 */
  agentId?: string
}

/**
 * Result of stream execution
 */
export interface StreamExecutionResult {
  handled: boolean
  isImageGeneration: boolean
  pausedForConfirmation?: boolean
}

/**
 * Unified stream execution entry point
 * Automatically detects whether to use a host-specific special stream or text streaming
 *
 * @param params Stream execution parameters
 * @param abortController Optional abort controller for cancellation
 * @returns Result indicating how the stream was handled
 */
/**
 * Resolve the requested output modalities for this stream.
 * Mirrors the system-prompt snapshot's native-tool resolution
 * (getNativeProviderTools) so the request body matches what the
 * prompt tells the model: when the Codex native image_generation
 * tool is available, request image output so the provider attaches it.
 */
async function resolveRequestedOutputModalities(
  params: StreamExecutionParams,
): Promise<AgentOutputModality[] | undefined> {
  if (params.requestedOutputModalities) return params.requestedOutputModalities
  try {
    const nativeTools = await getCodexNativeToolsForConfig({
      providerId: params.providerId,
      providerConfig: params.configWithApiKey,
      toolSettings: params.toolSettings,
      supportsTools: await modelRegistry.modelSupportsTools(
        params.configWithApiKey.model,
        params.providerId,
      ),
    })
    return nativeTools.includes(CODEX_NATIVE_IMAGE_GENERATION_TOOL) ? ['image'] : undefined
  } catch (error) {
    log.warn('resolve native provider tools failed', {}, error)
    return undefined
  }
}

/**
 * S1a:**每一次执行的入口**(§10.6 第 1 条)。
 *
 * runId 在这里生成一次 —— 它是四条引擎路径(send / retry / edit-resend /
 * resume)与两条流路径(图片特化流 / agent-loop 文本流)唯一的交汇点。放在
 * 更下游(agent-loop executor)的话图片生成那一路就没有 run;放在更上游
 * (core 引擎)的话 core 就要 import 装配层的落盘。
 *
 * `run/end` 在 finally 里,**每一条**出口都走到:正常收尾 / abort / 抛错。
 */
export async function executeMessageStream(
  params: StreamExecutionParams,
  abortController?: AbortController
): Promise<StreamExecutionResult> {
  const engine = getStreamEngine()
  // 助手占位消息在进这扇门之前就建好了 —— 把它的时刻带进 `run/start`,投影
  // 物化出来的那一条才与事实同一个时刻(S1b 的影子断言按它比)。
  const assistantPlaceholder = sessionReads.getMessage(
    params.sessionId,
    params.assistantMessageId,
  )
  const assistantTimestamp = assistantPlaceholder?.timestamp
  const { run, started } = ensureSessionRun(params.sessionId, {
    kind: params.runKind ?? 'send',
    assistantMessageId: params.assistantMessageId,
    provider: params.providerId,
    model: params.configWithApiKey.model,
    // A4(§13.1):占位消息上盖过的那一格就是事实(`stampCollabAgentId`)。
    // core 的入口从不传 `params.agentId`,所以在此之前这一格从来没有产地。
    ...(params.agentId ?? assistantPlaceholder?.agentId
      ? { agentId: (params.agentId ?? assistantPlaceholder?.agentId) as string }
      : {}),
    // §13.9:同一刻盖的另一格(`stampCollabAgentId` 的 `source: 'collab-turn'`)。
    ...(assistantPlaceholder?.source
      ? { messageSource: assistantPlaceholder.source }
      : {}),
    ...(params.triggerMessageId ? { triggerMessageId: params.triggerMessageId } : {}),
    ...(assistantTimestamp !== undefined ? { timestamp: assistantTimestamp } : {}),
    ...(assistantPlaceholder?.origin
      ? { origin: assistantPlaceholder.origin as unknown as Record<string, unknown> }
      : {}),
  })
  // 盖在助手消息上(`ChatMessage.runId`):影子期按它把消息切成 run 来比对。
  if (started) {
    sessionCommands.patchMessage(params.sessionId, {
      messageId: params.assistantMessageId,
      patch: { runId: run.runId },
      hint: 'settle',
    })
  }

  try {
    return await runMessageStream(engine, params, abortController)
  } catch (error) {
    if (started) {
      endSessionRun(params.sessionId, run.runId, {
        outcome: isAbortLikeError(error) ? 'aborted' : 'error',
        error,
      })
    }
    throw error
  } finally {
    // 幂等:catch 已经收过就是 no-op(见 `endSessionRun`)。
    if (started) endSessionRun(params.sessionId, run.runId, { outcome: 'completed' })
  }
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError')
}

async function runMessageStream(
  engine: ReturnType<typeof getStreamEngine>,
  params: StreamExecutionParams,
  abortController?: AbortController,
): Promise<StreamExecutionResult> {
  const result = await executeCoreMessageStream({
    params: {
      ...params,
      requestedOutputModalities: await resolveRequestedOutputModalities(params),
    },
    controller: abortController,
    createController: () => new AbortController(),
    registry: {
      registerController: (sessionId, controller) => engine.registerController(sessionId, controller),
      removeController: sessionId => engine.removeController(sessionId),
      getSteeringQueue: sessionId => engine.getSteeringQueue(sessionId),
      getFollowUpQueue: sessionId => engine.getFollowUpQueue(sessionId),
    },
    supportsSpecialStream: (model, providerId) =>
      modelRegistry.modelSupportsImageGeneration(model, providerId),
    processSpecialStream: input => processImageGenerationStream(input),
    executeTextStream: (ctx, historyMessages, sessionName): Promise<AgentLoopStreamGenerationResult> =>
      executeAgentLoopStreamGeneration(ctx as StreamContext, historyMessages, sessionName),
    logger: consoleLog,
  })

  return {
    handled: result.handled,
    isImageGeneration: result.usedSpecialStream,
    pausedForConfirmation: result.pausedForConfirmation,
  }
}
