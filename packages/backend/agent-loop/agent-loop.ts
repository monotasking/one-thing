/**
 * agent-loop:一轮对话怎么跑的内核(层次 L1「领域事实」)。
 *
 * 2026-10 engine 归位(决策 D27 / D51 / D52)之后,这里装着两样东西:与服务商无关的循环原语
 * (`agent-loop-primitives.ts` 那个桶:runner、流、重试、工具调度、线格式),和前 core/engine 的内核 ——
 * `CoreStreamEngine`、agent-loop 执行器与运行时、工具编排、上下文压缩、历史重建、回合上下文、提示词片段、
 * 消息来源判据、回合主体、流发送器、引擎端口类型、回合后触发器表。这只入口就是从前的
 * `engine/engine-primitives.ts` 内核桶,原样搬来,末尾补了引擎归位时外面真在用的几组名字。
 * 2026-10-04 深层引用收口时,文件末尾再补一组「循环原语」(经 `agent-loop-primitives.ts` 那个桶转交,只交外面
 * 真在用的名字)和服务商错误分类、线格式两小组:服务商与别的功能从此只经这只入口拿 agent-loop 的东西。
 *
 * 2026-10-04 入口瘦身(D191):只交「功能外非测试读者经入口真在用的名字」(按语法树数,含相对路径引入口、
 * `export … from` 转交、动态 import 的解构:311 个,值 / 类型见决策记录);只有测试在用的 101 个名字不为测试进入口,
 * 那些测试改引入口转交自的那只内部文件(桩打在哪只文件上不变);没人经入口要的 275 个直接删掉。`Core*` 前缀的去留是另一笔。
 *
 * 它不认识具体服务商,也不认识协作、插件、设置这些功能:要它们的地方都是端口(`agent-loop-engine-ports.ts`)
 * 或由调用方交进来的函数(例如回合主体的协作驱动验票)。对外只依赖 shared、logging、tools 三处叶子。
 * 「挑哪家服务商的运行时」那两只(`engine-agent-loop-stream-{runtime,selection}`)是上层的事,住在 engine。
 */
export { createCoreId } from "./agent-loop-ids.js";

export {
	LOCAL_AGENT_EXECUTOR_ID,
	findAgentExecutorDescriptor,
	isExternalAgentExecutorId,
	listAgentExecutorDescriptors,
	localAgentExecutorDescriptor,
	unknownExternalExecutorDescriptor,
} from "./agent-loop-external-agent-providers.js";
export type {
	AgentExecutorCapabilities,
	AgentExecutorDescriptor,
	AgentExecutorId,
	AgentExecutorKind,
} from "./agent-loop-external-agent-providers.js";

export type {
	CorePromptActiveProject,
	CorePromptKnownProjects,
	CorePromptProviderConfig,
	CorePromptProviderConfigValue,
	CoreTemplateSkill,
} from "./agent-loop-prompt-types.js";

export type {
	CoreBuildPromptContextOptions,
	CoreBuildPromptOptions,
	CoreBuildPromptResult,
	CorePromptRequestMessage,
	PromptSection,
} from "./agent-loop-system-prompt.js";

export {
	CORE_PROMPT_ORDER_PLUGIN,
	CORE_PROMPT_ORDER_TOOL,
	corePromptToolSurface,
	describeToolPromptContributionProblem,
	isCorePromptFragmentActive,
	promptFragmentsFromToolContribution,
	renderCorePromptFragment,
} from "./agent-loop-prompt-fragments.js";
export type {
	CorePromptFragment,
	CoreToolPromptContribution,
} from "./agent-loop-prompt-fragments.js";

export {
	configureProviderErrorCodeDescriber,
	extractResponseBodyDetails,
	extractErrorDetails,
} from "./agent-loop-error-details.js";
export type { CoreErrorDetails } from "./agent-loop-error-details.js";

export {
	executeCoreMessageStream,
} from "./agent-loop-stream-executor.js";
export type {
	CoreInitialToolChoice,
	CoreStreamControllerRegistry,
	ExecuteCoreMessageStreamOptions,
} from "./agent-loop-stream-executor.js";
export type {
	CoreReasoningPlacement,
} from "./agent-loop-ipc-emitter.js";
export { createCoreEventOnlyEmitter } from "./agent-loop-event-only-emitter.js";
export type {
	CoreEventOnlyEventBusLike,
	CoreEventOnlySessionEvent,
	CoreEventOnlyStoreHooks,
	CoreEventOnlyStreamChannelLike,
	CoreEventOnlyStreamChunk,
	CreateCoreEventOnlyEmitterOptions,
} from "./agent-loop-event-only-emitter.js";

export {
	createCoreStreamProcessor,
	resolveToolIdentity,
} from "./agent-loop-stream-processor.js";
export type {
	CoreResolvedTool,
	CoreStreamProcessor,
	CoreStreamProcessorEmitter,
	CoreStreamProcessorLogger,
	CoreStreamProcessorStore,
	CoreStreamStepLike,
	CoreStreamToolCallLike,
	CoreToolIdentityResolver,
	CreateCoreStreamProcessorOptions,
} from "./agent-loop-stream-processor.js";

export {
	CoreStreamEngine,
	resolveStreamPermissionMode,
} from "./agent-loop-stream-engine.js";
export type {
	CoreExecutionOptions,
	CoreContextCompactResultLike,
	CoreEventBusEmitterLike,
	CoreProviderConfigWithKeyLike,
	CoreStreamEngineRuntime,
	CoreStreamMessage,
	CoreStreamPermissionModeSession,
	CoreStreamPermissionModeSettings,
	CoreStreamResultLike,
	CoreStreamSession,
	CoreStreamSettings,
} from "./agent-loop-stream-engine.js";

export { PendingMessageQueue } from "./agent-loop-message-queue.js";

export type {
	StreamEngineClockAdapter,
	StreamEngineCompactionAdapter,
	StreamEngineHistoryAdapter,
	StreamEngineIdAdapter,
	StreamEngineMediaAdapter,
	StreamEngineModelRegistryAdapter,
	StreamEnginePermissionAdapter,
	StreamEnginePromptAdapter,
	StreamEngineProviderAdapter,
	StreamEngineSkillsAdapter,
	StreamEngineStreamsAdapter,
	StreamEngineStoreAdapter,
} from "./agent-loop-engine-adapters.js";

export {
	appendOrderedPart,
	persistAgentLoopTurnContentPartsWithAdapters,
} from "./agent-loop-executor-content-parts.js";
export {
	applyAgentLoopStreamChunkWithAdapters,
	executeAgentLoopStreamLifecycleWithAdapters,
} from "./agent-loop-executor-stream-chunks.js";
export {
	buildAgentLoopFinalMessageUpdate,
	completeAgentLoopStreamWithAdapters,
	createAgentLoopNextAssistantWriterPlan,
	emitAgentLoopFinalMessageUpdateWithAdapters,
} from "./agent-loop-executor-finish.js";
export {
	createAgentLoopExecutorTurnState,
} from "./agent-loop-executor-turn-state.js";
export {
	lastUserMessageText,
	runAgentLoopPostResponseHooksWithAdapters,
} from "./agent-loop-executor-post-response.js";
export type {
	ApplyAgentLoopProviderDataRuntimeOptions,
	ApplyAgentLoopStreamChunkWithAdaptersOptions,
	ExecuteAgentLoopStreamLifecycleWithAdaptersOptions,
} from "./agent-loop-executor-stream-chunks.js";
export type {
	CompleteAgentLoopStreamWithAdaptersOptions,
	EmitAgentLoopFinalMessageUpdateWithAdaptersOptions,
} from "./agent-loop-executor-finish.js";
export type {
	CoreAgentLoopContentPartStore,
	CoreAgentLoopToolInputProcessor,
	CoreOrderedPartLike,
} from "./agent-loop-executor-turn-state.js";
export type {
	CoreAgentLoopToolExecutionStore,
} from "./agent-loop-executor-tool-steps.js";
export type {
	RunAgentLoopPostResponseHooksWithAdaptersOptions,
} from "./agent-loop-executor-post-response.js";

export {
	agentLoopInitSkills,
	agentLoopSkillContexts,
	buildAgentLoopDirectToolsWithAdapters,
	planAgentLoopPromptBuildOptions,
	planAgentLoopRuntimePreparation,
	planAgentLoopTools,
} from "./agent-loop-runtime-preparation.js";
export {
	getAgentLoopTransientTail,
	injectPendingAgentLoopMessagesWithAdapters,
	runAgentLoopAfterTurnWithAdapters,
	runAgentLoopBeforeTurnWithAdapters,
} from "./agent-loop-runtime-turn.js";
export {
	maybeCompactAgentLoopContextWithAdapters,
} from "./agent-loop-runtime-compaction.js";
export {
	clampAgentLoopRequestMaxTokens,
	providerReportedInputTokens,
	resolveAgentLoopContextBudgetWithRegistry,
} from "./agent-loop-runtime-budget.js";
export type {
	CoreAgentLoopCompactSessionLike,
	CoreAgentLoopCompactResultLike,
} from "./agent-loop-runtime-compaction.js";
export type {
	CoreAgentLoopContextBudget,
	ResolveAgentLoopContextBudgetOptions,
} from "./agent-loop-runtime-budget.js";
export type {
	CoreAgentLoopDirectToolMetadataUpdate,
	CoreAgentLoopDirectToolResultLike,
	CoreAgentLoopInitSkillSnapshot,
	CoreAgentLoopProviderHostContext,
	CoreAgentLoopProviderRuntimeConfigLike,
	CoreAgentLoopRuntimeSessionLike,
	CoreAgentLoopRuntimeSettingsLike,
	CoreAgentLoopRuntimeToolSettingsLike,
	CoreAgentLoopSkillLike,
} from "./agent-loop-runtime-preparation.js";
export type {
	CoreAgentLoopPendingMessageAdapters,
	CoreAgentLoopEphemeralTailAdapters,
	CoreAgentLoopTurnQueueAdapters,
	CorePendingAgentLoopInputMessage,
	CorePendingAgentLoopChatMessage,
} from "./agent-loop-runtime-turn.js";

export {
	buildMessageContent,
	formatMessagesForLog,
	getTextFromContent,
} from "./agent-loop-message-content.js";
export type {
	BuildMessageContentOptions,
	CoreAIMessageContent,
	CoreMessageContentSource,
} from "./agent-loop-message-content.js";

export {
	planToolCallArtifactRemoval,
	changesFromToolMetadata,
	CoreToolOrchestrator,
	executeCoreToolAndUpdate,
} from "./agent-loop-tool-orchestration.js";
export {
	coreToolCallSnapshot,
} from "./agent-loop-tool-call-cow.js";
export type {
	CoreToolExecutionStore,
	CoreExecutableSessionLike,
	ExecuteCoreToolAndUpdateOptions,
} from "./agent-loop-tool-orchestration.js";

export {
	resolveAgentLoopStreamRoute,
	shouldUseAgentLoopStream,
} from "./agent-loop-selection.js";
export type {
	CorePromptCapture,
	CoreRequestMessage,
	CoreEvalRawRequest,
	CoreEvalRawResponse,
	CoreTrigger,
	CoreTriggerContext,
} from "./agent-loop-triggers.js";
export { triggerManager } from "./agent-loop-trigger-manager.js";
export type { Trigger, TriggerContext } from "./agent-loop-trigger-manager.js";
export type {
	AgentLoopStreamEnabledBy,
	AgentLoopStreamRoute,
	AgentLoopStreamSelectionContext,
} from "./agent-loop-selection.js";

export {
	buildContextCompactCompletedContent,
	buildContextCompactFailedContent,
	buildContextCompactSummaryMessages,
	CompactTokenBudget,
	resolveContextCompactChunkTimeoutMs,
	createContextCompactMessage,
	DEFAULT_KEEP_RECENT_TURNS,
	estimateCurrentInputTokens,
	estimateSessionInputTokens,
	extractCompactFileOperations,
	formatCompactFileOperations,
	formatMessagesForSummary,
	mergeCompactFileOperations,
	stripCompactFileOperations,
	getContextCompactReason,
	normalizeContextCompactError,
	normalizeContextSummaryOutput,
	selectCompactPlan,
	shouldAutoCompactBeforeSend,
	shouldSkipAutoCompactForProviderUsageMismatch,
	summarizeContextInChunks,
} from "./agent-loop-context-compact.js";
export {
	buildContextUsageSnapshot,
	estimateTextTokens,
} from "./agent-loop-context-usage.js";
export {
	TurnContextLedger,
	renderContextUpdateBlock,
	visibleMessagesAfterSummary,
} from "./agent-loop-turn-context.js";
export type {
	TurnBlock,
	TurnContextCarrier,
	TurnContextDelta,
} from "./agent-loop-turn-context.js";
export type {
	SummarizeContextInChunksOptions,
} from "./agent-loop-context-compact.js";

export {
	buildHistoryMessages,
	buildResumeHistoryAfterToolConfirmation,
	canSplitHistoryTurnGroups,
	compactedHistoryPreamble,
	completedHistoryToolCalls,
	filterHistoryForNonToolAPI,
	historyContentPartsCoverContent,
	historyMessagesForLog,
	sanitizeToolResultForAI,
} from "./agent-loop-history.js";
export type {
	CoreBuildHistoryMessagesOptions,
	CoreCompactedHistoryLogDetails,
	CoreHistoryChatMessage,
	CoreHistoryContentPart,
	CoreHistoryMessage,
	CoreResumeAssistantMessage,
} from "./agent-loop-history.js";

export {
	canApplyGeneratedSessionTitle,
} from "./agent-loop-title.js";

export {
	buildMessageBodyShapePayload,
} from "./agent-loop-chat-logger.js";
export type {
	CoreChatLogMessageShape,
	CoreChatLogValue,
} from "./agent-loop-chat-logger.js";
export type {
	EngineMessageOrigin,
	EngineOriginTransport,
	EngineRoutedSession,
	ProductStreamEnginePorts,
	StreamEngineAgentBindingPort,
	StreamEngineCollabDrivePort,
	StreamEnginePluginInterceptPort,
	StreamEngineRoomIngressPort,
	StreamEngineSessionRouterPort,
	StreamEngineSteeringDeliveryPort,
} from "./agent-loop-engine-ports.js";

// ── 2026-10 engine 归位时一起交出的几样内核名字:外面(引擎、渠道、插件、任务、gateway、CLI 守护)真在用,
// 从前分别从 `engine/` 的入口或内部文件拿。
export {
	isSystemInternalSource,
	pluginMessageSource,
	taskMessageSource,
} from "./agent-loop-message-sources.js";
// 一条消息从哪来(`MessageOrigin` 的构造、清洗与读法)。包根归位 B(2026-10-04)从包根 `channel/origin.ts` 搬来:
// 它只靠上面那组来源判据,工具权限(L1)、渠道网关、会话命令面都要它,所以住在内核这一层。
export {
	LOCAL_CLIENT_USER_ID,
	createApiOrigin,
	createDesktopOrigin,
	createLocalClientIdentity,
	createVoiceOrigin,
	identitySessionKey,
	isSystemInternalOrigin,
	latestRealOrigin,
	originConnector,
	originDisplayName,
	originWorkspaceId,
	sanitizeRendererOrigin,
} from "./agent-loop-message-origin.js";
export { mintTurnPrincipal } from "./agent-loop-turn-principal.js";
export { NoopOnethingStreamSender } from "./agent-loop-stream-sender.js";
export type {
	BindableOnethingStreamSender,
	OnethingStreamSender,
	OnethingStreamSenderPayload,
} from "./agent-loop-stream-sender.js";
export type { IPCEmitter } from "./agent-loop-session-stream-emitter.js";
export { nextAgentLoopTurnIndexAfterFinish } from "./agent-loop-turn.js";
export { resultTextFromToolMetadata } from "./agent-loop-tool-orchestration.js";
export { collectCompactFileOperations } from "./agent-loop-compact-file-lists.js";

// ── 循环原语(深层引用收口 2026-10-04,D157):与服务商无关的那一层 —— 跑一轮循环、流与收集、能力判据、
// 工具名与工具定义、消息与工具结果的换算、执行期检查点,以及服务商实现要的全部类型。从前服务商(61 处)与
// 别的功能直接引 `agent-loop-primitives.ts` 那个桶;这里只交出外面真在用的名字。**故意经那个桶转交而不是从
// 声明文件转交**:三只测试(`skill-review-trigger`、`toc/record-turn`、`engine-system-prompt-snapshot`)在桶上
// 打桩换掉 `runAgentLoop` / `resolveAgentModelCapabilities` / `agentSupportsTools`,经桶转交,桩照样拦得住
// 改走入口的读者。
export {
	runAgentLoop,
	buildAgentLoopRuntime,
	createAgentExecutionLifetime,
	AgentExecutionCheckpointError,
	awaitAgentExecutionCheckpoint,
	isAgentExecutionCheckpointError,
} from "./agent-loop-primitives.js";
// 服务商流 → 循环事件 → 一轮回合。
export {
	agentContentToText,
	agentEventsToProviderStreamChunks,
	collectAgentTurnFromStream,
	safeParseAgentToolArguments,
	streamAgentLoopProviderChunks,
	streamAgentProviderTurnEvents,
} from "./agent-loop-primitives.js";
export type { AgentProviderStreamChunk } from "./agent-loop-primitives.js";
// 模型能力判据。
export {
	agentProviderCanRunTurn,
	agentSupportsInputModality,
	agentSupportsOutputModality,
	agentSupportsTools,
	resolveAgentModelCapabilities,
} from "./agent-loop-primitives.js";
// 工具名、工具定义、消息与工具结果的换算。
export {
	agentContentFromHistoryContent,
	agentMessagesFromHistory,
	agentModelToolsFromDefinitions,
	agentToolDefinitionsFromSourceTools,
	agentToolMessageContentToStructuredPayload,
	agentToolMessageContentToText,
	createAIToolName,
	getAIToolName,
	registerRetiredAgentToolName,
	resolveAIToolName,
} from "./agent-loop-primitives.js";
export type {
	AgentHistoryMessage,
	AgentSourceToolDefinition,
} from "./agent-loop-primitives.js";
// 循环与服务商之间的类型。
export type {
	AgentCapability,
	AgentContentPart,
	AgentCredentialRotation,
	AgentFinishReason,
	AgentInputModality,
	AgentJsonObject,
	AgentJsonValue,
	AgentLoopOptions,
	AgentLoopResult,
	AgentMessage,
	AgentMessageContent,
	AgentModelCapabilities,
	AgentOutputModality,
	AgentProvider,
	AgentProviderData,
	AgentReasoningEffort,
	AgentSkillContext,
	AgentStreamEvent,
	AgentTool,
	AgentToolCall,
	AgentToolChoice,
	AgentToolExecutionContext,
	AgentToolResult,
	AgentToolResultContentPart,
	AgentTurn,
	AgentTurnRequest,
	AgentTurnStreamEvent,
	AgentUsage,
} from "./agent-loop-primitives.js";

// 服务商错误分类与冷却(凭证轮换、鉴权、服务商基类要它)。
export {
	classifyOAuthRefreshError,
	classifyProviderError,
	providerErrorCooldownUntil,
	withProviderRetryAfter,
} from "./agent-loop-provider-error-classification.js";

// 发给模型的工具调用 / 工具结果的线格式(会话投影的规范化比较要它)。
export { stringifyToolResult, toolCallArguments } from "./agent-loop-wire-format.js";
