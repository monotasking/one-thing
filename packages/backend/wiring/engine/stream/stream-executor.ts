/**
 * Stream Executor Module
 * Unified entry point for message streaming
 * Routes host-specific special streams before falling back to text streaming
 *
 * Uses StreamEngine for AbortController lifecycle management.
 */

import type { AppSettings, ChatMessage, ProviderConfig, ToolSettings } from '@shared/ipc.js'
import type { Principal } from '@onething/core/permission'
import type { SessionRunKind } from '@onething/core/session'
import {
  beginSessionRun,
  endSessionRun,
  ensureSessionRun,
  type BeginSessionRunInput,
} from '../../../session/runs.js'
import { sessionCommands } from '../../../session/commands.js'
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
import { consolePort, getLogger } from '../../logging/index.js'
import type { CoreStreamControllerRegistry, PendingMessageQueue, ExecuteCoreMessageStreamOptions } from '@onething/core/engine'

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
  /**
   * F4-a(§16.12):**这次执行的助手占位消息 —— 入库的那一份**,由创建点前递。
   *
   * `run/start` 是这条消息在账本上的**产地**(`appendMessage` 对 `isStreaming`
   * 的 assistant 一条事件都不写),而产地要写的 `timestamp` / `origin` /
   * `agentId` / `source` 就在那条消息上。从前是"写进 store 再回读一次" ——
   * 那不是取材需要,是值绕了一圈:这一处既不是消费者也没有别的地方可读,
   * 唯一的生产者就是它自己。
   *
   * 现在由 `store.addMessage` **把入库的那一条交回来**(端口返回值,F4-a 的
   * 唯一形状改动),创建点顺着这一格递过来。**是入库那一份而不是创建点手里
   * 那一份** —— 盖章(`stampCollabAgentId`)是 COW 的,两者不是同一个对象。
   *
   * 形状是 `Record<string, unknown>` 而不是 `ChatMessage`:core 那一侧的消息是
   * 泛型 `TMessage`,而 `StreamEngineStreamsAdapter.executeMessageStream` 的入参
   * 本来就是 `Record<string, unknown>` —— 零类型代价。
   *
   * **缺席不回落**:那几格就空着(与"占位真的没有那几格"同一个结果),不退回去
   * 读 store —— 回落等于把删掉的那条路留在原地,而它正是这一批要摘掉的东西。
   * 生产上四条引擎路径全都前递。
   */
  assistantMessage?: Record<string, unknown>
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
 * Resolve the requested output modalities for this stream —— 「这一回合要不要
 * 向 provider 要图」。
 *
 * 两条判据,顺序固定:
 *
 *  1. **codex 的原生工具表**(逐字不变)。ChatGPT 后台的模型元数据里带
 *     `nativeTools: ['image_generation']` 就要图。它必须留在最前面,因为
 *     codex 的判据还含 OAuth(`shouldResolveCodexNativeTools`)—— 账本回答不了
 *     「这次用的是订阅凭据还是 API key」。命中即返回;providerId 是 codex 而没
 *     命中的,到此为止(不再往下问账本 —— 否则 API-key 的 codex 会因为目录条目
 *     上的 `nativeTools` 而拿到图,那是行为变更)。
 *  2. **账本的 `imageOutputServedBy === 'in-loop'`**(拍板 #13,其余所有
 *     provider)。这一格说的是「图在回合里出」;谁来出、怎么拼,是方言的事:
 *     openai 走 `/v1/responses` 的原生 `image_generation` 工具(与 codex 逐字
 *     同规),openrouter 拼 `modalities`,gemini 拼 `responseModalities`。
 *     **OpenRouter / Gemini 的方言今天不读 `requestedOutputModalities`**
 *     (它们按 profile 自己决定发不发 modalities),所以对这两家填上它是无害的
 *     —— 账本已经答出 `imageOutput: true`,core 的输出模态断言
 *     (`assertAgentOutputModalitiesSupportedByCapabilities`)因此也过得去。
 *
 * 工具闸门对第 2 条同样有效:`enableToolCalls` 关掉 / 模型不支持工具时不要图
 * —— 原生出图是**工具表里的一项**,工具都关了还要图是自相矛盾的。
 */
async function resolveRequestedOutputModalities(
  params: StreamExecutionParams,
): Promise<AgentOutputModality[] | undefined> {
  if (params.requestedOutputModalities) return params.requestedOutputModalities
  try {
    const supportsTools = await modelRegistry.modelSupportsTools(
      params.configWithApiKey.model,
      params.providerId,
    )
    const nativeTools = await getCodexNativeToolsForConfig({
      providerId: params.providerId,
      providerConfig: params.configWithApiKey,
      toolSettings: params.toolSettings,
      supportsTools,
    })
    if (nativeTools.includes(CODEX_NATIVE_IMAGE_GENERATION_TOOL)) return ['image']
    if (params.providerId === 'codex') return undefined

    if (!params.toolSettings?.enableToolCalls || !supportsTools) return undefined
    return modelRegistry.modelServesImageOutputInLoop(
      params.configWithApiKey.model,
      params.providerId,
    )
      ? ['image']
      : undefined
  } catch (error) {
    log.warn('resolve native provider tools failed', {}, error)
    return undefined
  }
}

/**
 * 一条流式助手占位 → 它在账本上那一格(`run/start`)的**取材**,单实现。
 *
 * 三个调用点(创建点预开 / `executeMessageStream` 认领 / 两者共用的字段口径)
 * 必须逐格一致 —— 预开写进账本的是这一份,认领时再算一遍就成了两个产地。
 */
function buildAssistantRunInput(input: {
  assistantMessageId: string
  assistantMessage?: Record<string, unknown>
  runKind?: SessionRunKind
  triggerMessageId?: string
  providerId?: string
  model?: string
  agentId?: string
  /**
   * §17.7.1 批 2 裁定 1:这次开张**顺手创建了**那条占位消息吗。只有
   * `openAssistantRun` 传 true(它与 `store.addMessage` 同一同步段);
   * `executeMessageStream` 的认领/兜底开张不传。
   */
  createdAssistantMessage?: boolean
}): BeginSessionRunInput {
  // F4-a(§16.12):值前递 —— 这一份是 `store.addMessage` 交回的**入库那一条**
  // (盖章 COW 之后的那个对象),不是创建点手里那条,也不是回读来的。
  const placeholder = input.assistantMessage as ChatMessage | undefined
  const agentId = input.agentId ?? placeholder?.agentId
  return {
    kind: input.runKind ?? 'send',
    assistantMessageId: input.assistantMessageId,
    ...(input.providerId ? { provider: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    // A4(§13.1):占位消息上盖过的那一格就是事实(`stampCollabAgentId`)。
    ...(agentId ? { agentId } : {}),
    // §13.9:同一刻盖的另一格(`stampCollabAgentId` 的 `source: 'collab-turn'`)。
    ...(placeholder?.source ? { messageSource: placeholder.source } : {}),
    ...(input.triggerMessageId ? { triggerMessageId: input.triggerMessageId } : {}),
    ...(placeholder?.timestamp !== undefined ? { timestamp: placeholder.timestamp } : {}),
    ...(placeholder?.origin
      ? { origin: placeholder.origin as unknown as Record<string, unknown> }
      : {}),
    ...(input.createdAssistantMessage ? { createdAssistantMessage: true } : {}),
  }
}

/**
 * **F4-c c4-d(§16.27):流式助手占位的账本产地,提前到入库的同一同步段。**
 *
 * core 的三个创建点(send / edit-resend / retry)在 `store.addMessage` 返回的
 * 那一行调它 —— 中间不隔任何 `await`。于是"占位入库"与"`run/start` 落账"是
 * **同一个同步段**里的两件事,F1 的同步可见让折叠当场出生这条占位。
 *
 * 从前 `run/start` 写在 `executeMessageStream` 里,与入库隔着
 * `emit(MESSAGE_ASSISTANT_CREATED)` + 一次历史构建,窗口 p50 0.21ms
 * (§16.20 第三节实测)。§16.20 把它结案成"取样窗口,不是产地缺口"——那句话
 * 在"没有人从投影读"的世界里成立;c4-d 让物化视图成为 store 消息的唯一维护者
 * 之后,窗口就从取样问题升级成**真相缺口**(§16.26:322/644 次 `addMessage`
 * 返回时折叠里没有这条消息,读侧一换装就把写模型手里刚建好的占位清掉)。
 *
 * **不是第二个产地**(§9.3 的裁定原样成立):`sessionCommandEvents.appendMessage`
 * 对流式 assistant 照旧一条不写,`run/start` 仍然是这条消息在账本上唯一的那一格
 * —— 变的只是它**什么时候**落账。
 *
 * 这条 run **没有收尾人**(`claimed:false`)。收尾照旧归 `executeMessageStream`
 * 的 finally:它的 `ensureSessionRun` 认领这一条,拿到 `started:true`。
 */
export function openAssistantRun(options: Record<string, unknown>): void {
  const input = options as unknown as {
    sessionId: string
    assistantMessageId: string
    assistantMessage?: Record<string, unknown>
    runKind?: SessionRunKind
    triggerMessageId?: string
    providerId?: string
    model?: string
    agentId?: string
  }
  if (!input.sessionId || !input.assistantMessageId) return
  beginSessionRun(
    input.sessionId,
    // §17.7.1 批 2 裁定 1:**这一条**就是占位入库的那一格(会话账据它盖
    // `updatedAt` / `lastProvider` / `lastModel`),所以显式说出来。
    buildAssistantRunInput({ ...input, createdAssistantMessage: true }),
    { claimed: false },
  )
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
  //
  // 这里是**事件写侧的产地**:下一行的 `run/start` 就是这条占位消息在账本上的
  // 那一格。既然是产地,取材就不该"读回来"——
  //
  // **F4-a(§16.12):值前递,两处 store 回读整体删除。** F3 曾把这一处判成
  // "翻不动的第二类例外",理由是事件产地缺口(投影里根本没有这一格)。那条
  // 事实没错,但它证明的是"不能改读投影",不是"必须回读 store":此刻缺的从来
  // 不是判据,是**值的路由**。
  //
  // 路由改法是 B:`store.addMessage` 把**入库的那一条**交回创建点(端口多一格
  // 返回值,§16.11 拍板 1 的唯一豁免),创建点顺 `params.assistantMessage` 递到
  // 这里。盖章(`stampCollabAgentId`)已经在入库那一刻发生过,所以这一份上
  // `agentId` / `source` 是齐的 —— 这里不再有第二个盖章点,也不再有回读窗口。
  //
  // **F4-c c4-d(§16.27):这里通常是"认领",不是"开张"。** 创建点已经在
  // `store.addMessage` 的同一同步段里把 `run/start` 写掉了(`openAssistantRun`),
  // 这一句认领它并接过收尾;字段口径由 `buildAssistantRunInput` 单实现,两处
  // 算出来的是同一份。绕过创建点的那条路(确认后恢复 / 单测直调)照旧在这里
  // 开张 —— 判据仍然是 `assistantMessageId`。
  const { run, started } = ensureSessionRun(
    params.sessionId,
    buildAssistantRunInput({
      assistantMessageId: params.assistantMessageId,
      ...(params.assistantMessage ? { assistantMessage: params.assistantMessage } : {}),
      ...(params.runKind ? { runKind: params.runKind } : {}),
      ...(params.triggerMessageId ? { triggerMessageId: params.triggerMessageId } : {}),
      providerId: params.providerId,
      model: params.configWithApiKey.model,
      ...(params.agentId ? { agentId: params.agentId } : {}),
    }),
  )
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
      // §15.12(c):等那一次 fsync —— 一次执行收账时"已落盘"必须是真的。
      await endSessionRun(params.sessionId, run.runId, {
        outcome: isAbortLikeError(error) ? 'aborted' : 'error',
        error,
      })
    }
    throw error
  } finally {
    // 幂等:catch 已经收过就是 no-op(见 `endSessionRun`)。
    if (started) await endSessionRun(params.sessionId, run.runId, { outcome: 'completed' })
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
  const streamControllerRegistry: CoreStreamControllerRegistry<AbortController, PendingMessageQueue> = {
    registerController: (sessionId, controller) => engine.registerController(sessionId, controller),
    removeController: sessionId => engine.removeController(sessionId),
    getSteeringQueue: sessionId => engine.getSteeringQueue(sessionId),
    getFollowUpQueue: sessionId => engine.getFollowUpQueue(sessionId),
  };
  // F4-a:前递来的占位消息**到此为止** —— 它是 `run/start` 的取材,不是这次流
  // 的参数。摘掉再往下传,core 那边的参数包与本批之前逐字相同。
  const { assistantMessage: _bornAssistant, ...streamParams } = params
  const executeCoreMessageStreamOptions: ExecuteCoreMessageStreamOptions<
    StreamSender,
    AppSettings,
    ProviderConfigWithKey,
    ToolSettings,
    HistoryMessage,
    AgentOutputModality,
    PendingMessageQueue,
    unknown,
    AbortController,
    AgentLoopStreamGenerationResult
  > = {
    params: {
      ...streamParams,
      requestedOutputModalities: await resolveRequestedOutputModalities(params),
    },
    controller: abortController,
    createController: () => new AbortController(),
    registry: streamControllerRegistry,
    supportsSpecialStream: (model, providerId) =>
      modelRegistry.modelSupportsImageGeneration(model, providerId),
    processSpecialStream: input => processImageGenerationStream(input),
    executeTextStream: (ctx, historyMessages, sessionName): Promise<AgentLoopStreamGenerationResult> =>
      executeAgentLoopStreamGeneration(ctx as StreamContext, historyMessages, sessionName),
    logger: consoleLog,
  };
  const result = await executeCoreMessageStream(executeCoreMessageStreamOptions)

  return {
    handled: result.handled,
    isImageGeneration: result.usedSpecialStream,
    pausedForConfirmation: result.pausedForConfirmation,
  }
}
