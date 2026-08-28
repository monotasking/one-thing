import type { AppSettings, ChatMessage, ChatSession } from '@shared/ipc.js'
import type { ProviderConfigWithKey } from './stream/stream-executor.js'
import { generateChatResponse } from '../providers/index.js'
import { runBeforeContextCompactHooks, type BeforeContextCompactContext } from '@onething/runtime/plugins/lifecycle.wiring'
import * as store from '../../store.js'
import { sessionReads } from '../../session/reads.js'
import { landSessionAccountUsage } from '../../session/usage.js'
import { sessionLifecycleEvents } from '../../session/lifecycle-events.js'
import { billCompactUsage } from '../usage/bill-side-line.js'
import {
  buildContextCompactCompletedContent,
  buildContextCompactContent,
  buildContextCompactFailedContent,
  buildContextCompactSummaryMessages,
  buildContextUsageSnapshot,
  createCoreId,
  createContextCompactMessage,
  DEFAULT_KEEP_RECENT_TURNS,
  extractCompactFileOperations,
  formatCompactFileOperations,
  formatMessagesForSummary,
  mergeCompactFileOperations,
  normalizeContextCompactError,
  resolveCompactChunkChars,
  resolveContextCompactChunkTimeoutMs,
  selectCompactPlan,
  stripCompactFileOperations,
  shouldSkipAutoCompactForProviderUsageMismatch as shouldSkipAutoCompactForProviderUsageMismatchByUsage,
  summarizeContextInChunks, type SummarizeContextInChunksOptions,
} from '@onething/core/engine'
import { buildHistoryMessages } from './stream/message-helpers.js'
import { collectCompactFileOperations } from '@onething/runtime/engine/compact-file-lists'
import * as modelRegistry from '../providers/model-registry.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('engine.compact')

export {
  estimateCurrentInputTokens,
  estimateSessionInputTokens,
  estimateTextTokens,
  formatMessagesForSummary,
  getContextCompactReason,
  normalizeContextSummaryOutput,
  selectCompactPlan,
  shouldAutoCompactBeforeSend,
} from '@onething/core/engine'

export function shouldSkipAutoCompactForProviderUsageMismatch(options: {
  providerId: string
  session: Pick<ChatSession, 'contextSize' | 'lastInputTokens'>
  modelContextLength: number
  inputTokens?: number
}): boolean {
  if (options.providerId !== 'codex') return false
  return shouldSkipAutoCompactForProviderUsageMismatchByUsage(options)
}

export interface ContextCompactResult {
  success: boolean
  skipped?: boolean
  summary?: string
  message?: ChatMessage
  compactedThroughMessageId?: string
  retainedContextSize?: number
  error?: string
}

export async function compactSessionContext(options: {
  sessionId: string
  providerId: string
  configWithApiKey: ProviderConfigWithKey
  settings: AppSettings
  keepRecentTurns?: number
  onMessageCreated?: (message: ChatMessage) => Promise<void>
  onMessageUpdated?: (messageId: string, updates: Partial<ChatMessage>) => Promise<void>
  /**
   * C6:分块进度。与刷 marker 的 onChunkComplete 是**同一处**回调 —— 调用方
   * 拿它转发 `context:compact-progress` 到 eventBus。单块压缩不回调。
   */
  onProgress?: (progress: { chunk: number; totalChunks: number }) => void | Promise<void>
}): Promise<ContextCompactResult> {
  const session = store.getSession(options.sessionId)
  if (!session) {
    return { success: false, error: 'Session not found' }
  }

  const plan = selectCompactPlan(
    session,
    // C1:读走门面(P0.2);core 不再从 session 上取 messages。
    sessionReads.listMessages(options.sessionId).messages,
    options.keepRecentTurns,
  )
  if (!plan) {
    return {
      success: true,
      skipped: true,
      error: `Nothing to compact yet. Need more than ${options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS} recent turns.`,
    }
  }

  const compactMessage = createContextCompactMessage({
    id: createCoreId(),
    timestamp: Date.now(),
    compactedMessageCount: plan.messagesToSummarize.length,
    compactedThroughMessageId: plan.cutoffMessage.id,
  }) as ChatMessage

  // P0(2026-08-14):**追加**到尾部,不再 insertMessageAfter 插历史中部。
  // 渲染器的 handleMessageCreated 一律 push 到末尾 —— 从前实时与重载后的位置
  // 不一致(标记「跳位」)。切点语义没丢:它写在 compactedThroughMessageId 里。
  // 模型历史只按 summaryUpToMessageId 切片,标记在数组里的位置对请求零影响。
  store.addMessage(options.sessionId, compactMessage)
  await options.onMessageCreated?.(compactMessage)

  try {
    const configWithApiKeyForHooks: BeforeContextCompactContext['configWithApiKey'] = {
      ...options.configWithApiKey,
    }
    // N7-a:某插件的 beforeContextCompact 返回了替换摘要 → 跳过宿主自压,直接用它。
    // 无人返回(或全体抛错 / 超时,fail-open)→ 回落宿主的 summarizeInChunks。
    const replacement = await runBeforeContextCompactHooks({
      sessionId: options.sessionId,
      providerId: options.providerId,
      configWithApiKey: configWithApiKeyForHooks,
      settings: options.settings,
      keepRecentTurns: options.keepRecentTurns,
      messagesToSummarize: plan.messagesToSummarize,
    })

    // C5-1:两张清单由代码从 toolCalls 里确定性提取,不进模型的手 ——
    // previousSummary 传给模型前先把旧清单剥掉,回来再由代码并集重附。
    const previousFileOperations = plan.previousSummary
      ? extractCompactFileOperations(plan.previousSummary)
      : { read: [], modified: [] }
    const previousSummaryForModel = plan.previousSummary
      ? stripCompactFileOperations(plan.previousSummary) || undefined
      : undefined
    const fileOperations = mergeCompactFileOperations(
      previousFileOperations,
      collectCompactFileOperations(plan.messagesToSummarize),
    )

    let summary: string
    if (replacement) {
      log.debug('using plugin replacement summary', {
        sessionId: options.sessionId,
        pluginId: replacement.pluginId,
        hookId: replacement.hookId,
        length: replacement.summary.length,
      })
      summary = replacement.summary
    } else {
      const formattedMessages = formatMessagesForSummary(plan.messagesToSummarize)
      summary = await summarizeInChunks({
        sessionId: options.sessionId,
        providerId: options.providerId,
        configWithApiKey: options.configWithApiKey,
        settings: options.settings,
        messages: formattedMessages,
        previousSummary: previousSummaryForModel,
        // P3 进度:多块摘要每块完成后刷一次占位消息(复用 message:updated,
        // 零新协议)。单块压缩不回调,不多发事件。
        onChunkComplete: async (progress) => {
          const progressContent = buildContextCompactContent({
            status: 'compacting',
            compactedMessageCount: plan.messagesToSummarize.length,
            compactedThroughMessageId: plan.cutoffMessage.id,
            progress,
          })
          store.updateMessageContent(options.sessionId, compactMessage.id, progressContent)
          await options.onMessageUpdated?.(compactMessage.id, { content: progressContent })
          // C6:同一处回调再往事件面走一条 —— 状态条读的是它,不是 marker。
          await options.onProgress?.(progress)
        },
      })
    }

    // 空摘要闸(2026-08-15):deepseek-v4-pro 实测把 reasoning 与正文算在同一个
    // max_tokens 池里 —— 思考先把 1600 喝干,content 回来是空串,而这里此前照走
    // 成功路径:marker 标 completed、旧摘要被一份空摘要**覆盖**、锚点推进。那是
    // 数据损失,不是显示问题。C5 让格式可校验了(六节 Markdown 必有 ## Goal),
    // 空/无 Goal 一律抛错走既有失败路径:marker failed、旧摘要原样保留。
    // 插件替换摘要(N7-a)的格式不归宿主 prompt 管,只校非空;宿主自压的
    // 才按 C5 六节格式校 ## Goal。
    // 两个闸是**两种**失败(空 vs 格式不合),而 catch 那里只有一句
    // 「compact session failed」,模型到底回了什么一个字都不落 —— 失败的压缩因此
    // 无法排障。各自记一条,并带上返回文本的截断预览(全文可能上万字,不进日志)。
    const summaryBody = stripCompactFileOperations(summary).trim()
    const summaryPreview = (text: string) =>
      text.length > 400 ? `${text.slice(0, 400)}…` : text
    if (!summaryBody) {
      log.warn('compact rejected: model returned an empty summary', {
        sessionId: options.sessionId,
        providerId: options.providerId,
        model: options.configWithApiKey.model,
        fromPluginReplacement: Boolean(replacement),
        rawLength: summary.length,
        rawPreview: summaryPreview(summary),
      })
      throw new Error('Context compact returned an empty summary.')
    }
    if (!replacement && !/^##\s+Goal\b/m.test(summaryBody)) {
      log.warn('compact rejected: summary has no "## Goal" section', {
        sessionId: options.sessionId,
        providerId: options.providerId,
        model: options.configWithApiKey.model,
        summaryLength: summaryBody.length,
        summaryPreview: summaryPreview(summaryBody),
      })
      throw new Error('Context compact returned a summary without a "## Goal" section.')
    }
    summary = `${summaryBody}${formatCompactFileOperations(fileOperations)}`

    const finalContent = buildContextCompactCompletedContent(
      summary,
      plan.messagesToSummarize.length,
      plan.cutoffMessage.id,
    )

    store.updateSessionSummary(options.sessionId, summary, plan.cutoffMessage.id)
    store.updateMessageContent(options.sessionId, compactMessage.id, finalContent)
    const retainedContextSize = await computeRetainedContextSizeAfterCompact({
      sessionId: options.sessionId,
      providerId: options.providerId,
      configWithApiKey: options.configWithApiKey,
      settings: options.settings,
    })
    await options.onMessageUpdated?.(compactMessage.id, { content: finalContent })

    // S1a(§10.6 第 5 条):压缩是 surface 上的一次 replace —— 被压掉的那一段
    // 不再进模型历史,但**在聊天记录里照旧显示**(两种"看不见"是两回事,
    // 见 core 归约器的头注释)。range 与 sourceEventSeqs 由活 surface 算出。
    sessionLifecycleEvents.sessionCompacted(options.sessionId, {
      messageId: compactMessage.id,
      summary,
      compactedMessageCount: plan.messagesToSummarize.length,
      compactedThroughMessageId: plan.cutoffMessage.id,
      model: options.configWithApiKey.model,
      provider: options.providerId,
      status: 'completed',
      // #15 裁定 2:压完还剩多少上下文,是这一刻只有写者知道的事实 —— 落进账本,
      // 折叠侧从此不必等下一次请求才对上。
      retainedContextSize,
    })
    // #15 裁定 1:容器上那两格由**账**落格。落点从写事件之**前**挪到之**后**
    // 一行 —— 账要先知道这件事,才落得出来;落不下来(没记账)回落老写者。
    if (!landSessionAccountUsage(options.sessionId)) {
      store.updateSessionContextSize(
        options.sessionId,
        retainedContextSize,
        'context-compact-retained-usage',
      )
    }

    return {
      success: true,
      summary,
      message: { ...compactMessage, content: finalContent },
      compactedThroughMessageId: plan.cutoffMessage.id,
      retainedContextSize,
    }
  } catch (error) {
    log.error('compact session failed', { sessionId: options.sessionId }, error)
    const errorMessage = normalizeContextCompactError(error)
    const failedContent = buildContextCompactFailedContent(
      errorMessage,
      plan.messagesToSummarize.length,
      plan.cutoffMessage.id,
    )
    store.updateMessageContent(options.sessionId, compactMessage.id, failedContent)
    await options.onMessageUpdated?.(compactMessage.id, { content: failedContent })

    // 失败的压缩也记一条:它在 UI 上是一张红卡,不是"什么都没发生"。
    // `status:'failed'` 的节点在模型历史里什么都不发(没有摘要可发),所以
    // **不带 replace** —— 一段没被压缩成功的历史不该被遮蔽掉。
    sessionLifecycleEvents.sessionCompacted(options.sessionId, {
      messageId: compactMessage.id,
      summary: '',
      compactedMessageCount: plan.messagesToSummarize.length,
      compactedThroughMessageId: plan.cutoffMessage.id,
      model: options.configWithApiKey.model,
      provider: options.providerId,
      status: 'failed',
      error: errorMessage,
    })

    return {
      success: false,
      message: { ...compactMessage, content: failedContent },
      error: errorMessage,
    }
  }
}

async function computeRetainedContextSizeAfterCompact(options: {
  sessionId: string
  providerId: string
  configWithApiKey: ProviderConfigWithKey
  settings: AppSettings
}): Promise<number> {
  const session = store.getSession(options.sessionId)
  if (!session) return 0

  // 2026-08-23:预留输出量不再参与用量判定(hard-limit 已删),只查窗口长度。
  let modelContextLength = 128000
  try {
    modelContextLength = await modelRegistry.getModelContextLength(options.configWithApiKey.model, options.providerId)
  } catch (error) {
    log.warn('resolve model context budget after compact failed', { model: options.configWithApiKey.model, providerId: options.providerId }, error)
  }

  // C1:读走门面,且**在 addMessage / 压缩的那串 await 之后现取** —— 这个函数
  // 是压缩收尾时才调用的,捕获调用前那一份数组会漏掉压缩标记那条。
  const historyMessages = buildHistoryMessages(
    [...sessionReads.listMessages(options.sessionId).messages],
    session,
  )
  const usage = buildContextUsageSnapshot({
    session,
    historyMessages,
    modelContextLength,
    thresholdPercent: options.settings.chat?.contextCompactThreshold ?? 85,
    providerId: options.providerId,
    model: options.configWithApiKey.model,
  })

  log.debug('retained usage after compact', {
    sessionId: options.sessionId,
    providerId: options.providerId,
    model: options.configWithApiKey.model,
    visibleInputTokens: usage.visibleInputTokens,
    providerInputTokens: usage.providerInputTokens,
    requestEstimatedInputTokens: usage.requestEstimatedInputTokens,
    modelContextLength: usage.modelContextLength,
    source: usage.source,
  })

  return usage.visibleInputTokens
}

/**
 * 摘要请求的输出上限 = 模型自己的物理上限(2026-08-15 拍板:不设人为限制,
 * 链上任何地方都不许藏一个 4096)。注册表严格查询:查得到就原样传,查不到就
 * 不传,让 provider 走自家默认(Anthropic 会自己报 max_tokens 必填 —— 真实错误
 * 比编的数诚实)。1600/4096 那两个常量都曾在 deepseek-v4-pro 上把思考+正文的
 * 共池喝干,正文空手而归。
 */
async function resolveSummaryMaxTokens(model: string, providerId: string): Promise<number | undefined> {
  try {
    return await modelRegistry.getKnownModelMaxOutputTokens(model, providerId)
  } catch (error) {
    log.warn('resolve summary max output tokens failed', { model, providerId }, error)
    return undefined
  }
}

async function summarizeInChunks(options: {
  sessionId: string
  providerId: string
  configWithApiKey: ProviderConfigWithKey
  settings: AppSettings
  messages: string
  previousSummary?: string
  onChunkComplete?: (progress: { chunk: number; totalChunks: number }) => Promise<void>
}): Promise<string> {
  const maxTokens = await resolveSummaryMaxTokens(options.configWithApiKey.model, options.providerId)
  // 单块超时来自设置(默认 300s,夹在 [30s, 30min]);总预算闸在 core 引擎里同源计算。
  const chunkTimeoutMs = resolveContextCompactChunkTimeoutMs(
    options.settings.chat?.contextCompactChunkTimeoutSeconds,
  )

  // 块大小随模型窗口走(2026-08-21):200k 窗口下多数会话就此退回单块,
  // 不再被一个写死的 80k 硬切成好几段。注册表查不到窗口就退回 80k。
  let modelContextLength: number | undefined
  try {
    modelContextLength = await modelRegistry.getModelContextLength(
      options.configWithApiKey.model,
      options.providerId,
    )
  } catch (error) {
    log.warn(
      'resolve model context length for compact chunking failed',
      { model: options.configWithApiKey.model, providerId: options.providerId },
      error,
    )
    modelContextLength = undefined
  }
  const maxChunkChars = resolveCompactChunkChars({
    transcript: options.messages,
    modelContextLength,
    reservedOutputTokens: maxTokens ?? 8_192,
  })

  // 批级中止:任一块失败就把在途的其余块一起掐掉 —— map-reduce 里剩下的块
  // 已经没有用武之地了,让它们跑完只是白烧 token 和时间。
  const batchController = new AbortController()

  const summarizeContextInChunksOptions: SummarizeContextInChunksOptions = {
    messages: options.messages,
    previousSummary: options.previousSummary,
    maxChunkChars,
    onPlanned: ({ totalChunks, maxChunkChars: plannedChunkChars }) => {
      log.debug('compact chunking', {
        sessionId: options.sessionId,
        transcriptChars: options.messages.length,
        modelContextLength,
        maxChunkChars: plannedChunkChars,
        chunks: totalChunks,
      })
    },
    onChunkComplete: options.onChunkComplete,
    summarizeChunk: async (request) => {
      // P3:压缩的生死时限归后端。每块摘要请求挂一个 AbortSignal 超时 ——
      // 从前后端分块摘要无时限,长会话必然撞上前端的墙钟假超时。超时抛错,
      // 由上层既有的 catch 走失败路径(marker 改 failed + completed(false))。
      const controller = new AbortController()
      const abortFromBatch = () => {
        controller.abort((batchController.signal as { reason?: unknown }).reason)
      }
      if (batchController.signal.aborted) abortFromBatch()
      else batchController.signal.addEventListener('abort', abortFromBatch, { once: true })

      // 超时和"被批中止"必须分得清:被别的块拖垮的块报成"超时"是在说谎,
      // 用户会照着这条去调一个根本不相干的超时设置。
      let timedOut = false
      const timer = setTimeout(
        () => {
          timedOut = true
          controller.abort(new Error('Context compact chunk timed out'))
        },
        chunkTimeoutMs,
      )
      let finishReason: string | undefined
      try {
        const text = await generateChatResponse(
          options.providerId,
          options.configWithApiKey,
          buildContextCompactSummaryMessages(request),
          {
            temperature: 0,
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            abortSignal: controller.signal,
            onFinish: (info) => { finishReason = info.finishReason },
            // 摘要是机械转写,不需要思考;而且在 deepseek-v4-pro 上 reasoning 与
            // 正文共用 max_tokens,默认开思考会把预算喝干、正文空手而归(实测
            // finish_reason=length, reasoning_tokens=1600, content=''),这里**有意**关。
            // deepseek.ts 里那段"context compaction 曾被误关思考"的注记说的是
            // 无人表态时的推断默认;这里是明确表态,两者不冲突。
            thinking: false,
            onUsage: billCompactUsage(
              options.providerId,
              options.configWithApiKey.model,
              options.sessionId,
            ),
          },
        )
        // 截断必须可见(2026-08-15):此前被 max_tokens 掐断的半截/空摘要照走成功
        // 路径,用户只看到"压缩完成"却不知道为什么摘要残缺、更不知道该去哪调。
        // 现在说清楚是谁掐的、掐在多少,并走失败路径不覆盖旧摘要。
        if (finishReason === 'length') {
          throw new Error(
            maxTokens !== undefined
              ? `Context compact output was truncated by max_tokens (${maxTokens}, the model's registered max output).`
              : 'Context compact output was truncated by the provider\'s default max_tokens (no model max output is registered for this model).',
          )
        }
        return text
      } catch (error) {
        const failure = timedOut
          ? new Error(
              `Context compact timed out after ${Math.round(chunkTimeoutMs / 1000)}s while summarizing.`,
            )
          : error
        batchController.abort(failure)
        throw failure
      } finally {
        clearTimeout(timer)
        batchController.signal.removeEventListener('abort', abortFromBatch)
      }
    },
  };
  return summarizeContextInChunks(summarizeContextInChunksOptions)
}
