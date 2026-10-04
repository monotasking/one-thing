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
 * 它不认识具体服务商,也不认识协作、插件、设置这些功能:要它们的地方都是端口(`agent-loop-engine-ports.ts`)
 * 或由调用方交进来的函数(例如回合主体的协作驱动验票)。对外只依赖 shared、logging、tools 三处叶子。
 * 「挑哪家服务商的运行时」那两只(`engine-agent-loop-stream-{runtime,selection}`)是上层的事,住在 engine。
 */
export {
	buildContextCompactMergePrompt,
	buildContextCompactPrompt,
} from "./agent-loop-compact-prompt.js";
export type { ContextCompactPromptPart } from "./agent-loop-compact-prompt.js";

export { createCoreId, isClientMintedId } from "./agent-loop-ids.js";

export {
	LOCAL_AGENT_EXECUTOR_ID,
	coreProviderOwnsItsContextWindow,
	findAgentExecutorDescriptor,
	getCoreProviderExecution,
	isCoreExternalAgentProvider,
	isExternalAgentExecutorId,
	listAgentExecutorDescriptors,
	localAgentExecutorDescriptor,
	registerCoreProviderExecution,
	unknownExternalExecutorDescriptor,
} from "./agent-loop-external-agent-providers.js";
export type {
	AgentExecutorCapabilities,
	AgentExecutorDescriptor,
	AgentExecutorId,
	AgentExecutorKind,
	CoreProviderContextWindowOwner,
	CoreProviderExecutionFacts,
	CoreProviderExecutionKind,
} from "./agent-loop-external-agent-providers.js";

export type {
	CoreOSType,
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
	CorePromptChannel,
	CorePromptFragment,
	CorePromptFragmentRender,
	CorePromptSlot,
	CoreToolPromptContribution,
} from "./agent-loop-prompt-fragments.js";

export {
	configureProviderErrorCodeDescriber,
	extractResponseBodyDetails,
	extractErrorDetails,
} from "./agent-loop-error-details.js";
export type { CoreErrorDetails, ProviderErrorCodeDescriber } from "./agent-loop-error-details.js";

export {
	buildTextStreamContext,
	executeCoreMessageStream,
	resolveStreamExecutionRoute,
	specialStreamExecutionResult,
	streamExecutionErrorResult,
	textStreamExecutionResult,
} from "./agent-loop-stream-executor.js";
export type {
	CoreInitialToolChoice,
	CoreMessageStreamParams,
	CoreSpecialStreamExecutionInput,
	CoreStreamControllerLike,
	CoreStreamControllerRegistry,
	CoreStreamExecutionResult,
	CoreStreamExecutionRoute,
	CoreStreamProviderConfigWithKey,
	CoreTextStreamContext,
	ExecuteCoreMessageStreamOptions,
} from "./agent-loop-stream-executor.js";
export type {
	CoreIPCEmitter,
	CoreReasoningPlacement,
	CoreStreamCompleteData,
	CoreStreamErrorData,
} from "./agent-loop-ipc-emitter.js";
export { createCoreEventOnlyEmitter } from "./agent-loop-event-only-emitter.js";
export type {
	CoreEventOnlyEventBusLike,
	CoreEventOnlyLogger,
	CoreEventOnlySessionEvent,
	CoreEventOnlyStoreHooks,
	CoreEventOnlyStreamChannelLike,
	CoreEventOnlyStreamChunk,
	CreateCoreEventOnlyEmitterOptions,
} from "./agent-loop-event-only-emitter.js";

export {
	executeCoreDirectTool,
	metadataUpdateFromToolPreview,
} from "./agent-loop-direct-tool-execution.js";
export type {
	CoreAbortSignalLike,
	CoreDirectToolAnalysisLike,
	CoreDirectToolApprovedAnalysis,
	CoreDirectToolExecutionContext,
	CoreDirectToolExecutionContextWithApproval,
	CoreDirectToolExecutionResultLike,
	CoreDirectToolInterceptRequest,
	CoreDirectToolInterceptVerdict,
	CoreDirectToolInterceptor,
	CoreDirectToolLogger,
	CoreDirectToolMetadataUpdate,
	CoreDirectToolPermissionInput,
	CoreDirectToolPreviewLike,
	CoreDirectToolResultInterceptRequest,
	CoreDirectToolResultInterceptor,
	CoreDirectToolResultVerdict,
	CoreDirectToolResultView,
	ExecuteCoreDirectToolOptions,
} from "./agent-loop-direct-tool-execution.js";

export {
	applyCoreToolCallChunk,
	createCoreStreamProcessor,
	createCoreStreamToolCall,
	createCoreToolInputStartArtifacts,
	CoreStreamingToolInputBuffer,
	resolveToolIdentity,
} from "./agent-loop-stream-processor.js";
export type {
	CoreResolvedTool,
	CoreStreamProcessor,
	CoreStreamProcessorContext,
	CoreStreamProcessorEmitter,
	CoreStreamProcessorLogger,
	CoreStreamProcessorStore,
	CoreStreamStepLike,
	CoreStreamToolCallLike,
	CoreStreamToolCallStatus,
	CoreToolArgsFinalizedBy,
	CoreToolIdentityResolver,
	CoreToolInputBufferEntry,
	CoreToolInputFinishResult,
	CoreToolInputStartOptions,
	CreateCoreStreamProcessorOptions,
} from "./agent-loop-stream-processor.js";

export {
	createStreamingArgsParser,
	parseStreamingArgs,
} from "./agent-loop-streaming-args.js";
export type {
	StreamingArgsField,
	StreamingArgsFieldState,
	StreamingArgsParser,
	StreamingArgsValueKind,
	StreamingArgsView,
} from "./agent-loop-streaming-args.js";

export {
	CoreStreamEngine,
	isCoreProviderResolutionFailure,
	normalizeCoreStreamError,
	resolveStreamPermissionMode,
} from "./agent-loop-stream-engine.js";
export type {
	AbortLikeCommand,
	CoreCommandEnvelope,
	CoreExecutionOptions,
	CoreContextCompactResultLike,
	CoreEventBusEmitterLike,
	CoreProviderConfigWithKeyLike,
	CoreProviderResolutionFailure,
	CoreStreamEngineOptions,
	CoreStreamEngineRuntime,
	CoreStreamErrorInfo,
	CoreStreamMessage,
	CoreStreamPermissionModeSession,
	CoreStreamPermissionModeSettings,
	CoreStreamResultLike,
	CoreStreamSession,
	CoreStreamSettings,
	InjectMessageCommand,
} from "./agent-loop-stream-engine.js";

export { PendingMessageQueue } from "./agent-loop-message-queue.js";
export type {
	PendingMessage,
	QueueMode,
} from "./agent-loop-message-queue.js";

export type {
	StreamEngineClockAdapter,
	StreamEngineCompactionAdapter,
	StreamEngineHistoryAdapter,
	StreamEngineIdAdapter,
	StreamEngineMediaAdapter,
	StreamEngineModelRegistryAdapter,
	StreamEnginePermissionAdapter,
	StreamEnginePromptAdapter,
	StreamEnginePromptResolution,
	StreamEngineProviderAdapter,
	StreamEngineRuntime,
	StreamEngineSkillsAdapter,
	StreamEngineStreamsAdapter,
	StreamEngineStoreAdapter,
} from "./agent-loop-engine-adapters.js";

export {
	appendAgentLoopTurnToolCallOnce,
	appendOrderedPart,
	agentLoopToolResultStepStatus,
	applyAgentLoopFinishChunkWithAdapters,
	applyAgentLoopReasoningChunkWithAdapters,
	applyAgentLoopStreamChunkWithAdapters,
	applyAgentLoopTextChunkWithAdapters,
	applyAgentLoopToolMetadata,
	applyAgentLoopToolMetadataWithAdapters,
	applyAgentLoopToolPartialResultWithAdapters,
	applyAgentLoopProviderDataWithAdapters,
	applyAgentLoopTurnStartWithAdapters,
	applyAgentLoopToolCallFallbackWithAdapters,
	applyAgentLoopToolInputDeltaWithAdapters,
	applyAgentLoopToolInputEndWithAdapters,
	applyAgentLoopToolInputStartWithAdapters,
	applyAgentLoopToolResultWithAdapters,
	buildAgentLoopFinalMessageUpdate,
	buildAgentLoopPostResponseContexts,
	buildAgentLoopToolPartialStepUpdate,
	buildAgentLoopToolResultPresentation,
	buildAgentLoopToolStartStepUpdate,
	completeAgentLoopStreamWithAdapters,
	createAgentLoopAssistantMessage,
	createAgentLoopNextAssistantWriterPlan,
	changesFromMetadata,
	createAgentLoopExecutorTurnState,
	dispatchAgentLoopToolContentPartsWithAdapters,
	enabledToolNames,
	emitAgentLoopFinalMessageUpdateWithAdapters,
	executeAgentLoopStreamLifecycleWithAdapters,
	getAgentLoopReasoningPlacement,
	hasAgentLoopVisibleTurnActivity,
	lastUserMessageText,
	planAgentLoopToolCallFallback,
	planAgentLoopFinishChunk,
	planAgentLoopProviderData,
	planAgentLoopToolContentPartsDispatch,
	planAgentLoopTurnContentPersistence,
	persistAgentLoopTurnContentPartsWithAdapters,
	resultText,
	rememberAgentLoopToolStepId,
	runAgentLoopPostResponseHooksWithAdapters,
	settleAgentLoopToolCallResult,
	settleAgentLoopToolResultWithAdapters,
	startAgentLoopToolExecution,
	structuredToolResult,
	textFromPartialResult,
} from "./agent-loop-executor.js";
export type {
	ApplyAgentLoopProviderDataWithAdaptersOptions,
	ApplyAgentLoopProviderDataRuntimeOptions,
	ApplyAgentLoopReasoningChunkWithAdaptersOptions,
	ApplyAgentLoopStreamChunkWithAdaptersOptions,
	ApplyAgentLoopTextChunkWithAdaptersOptions,
	ApplyAgentLoopToolMetadataOptions,
	ApplyAgentLoopToolPartialResultOptions,
	ApplyAgentLoopToolCallFallbackWithAdaptersOptions,
	ApplyAgentLoopToolInputEndWithAdaptersOptions,
	ApplyAgentLoopToolInputStartWithAdaptersOptions,
	ApplyAgentLoopToolResultWithAdaptersOptions,
	ApplyAgentLoopTurnStartWithAdaptersOptions,
	CompleteAgentLoopStreamWithAdaptersOptions,
	CoreAgentLoopContentPartEmitter,
	CoreAgentLoopContentPartStore,
	CoreAgentLoopExecutorContentAccumulator,
	CoreAgentLoopAssistantMessage,
	CoreAgentLoopAssistantCreatedEvent,
	CoreAgentLoopProviderDataPart,
	CoreAgentLoopAssistantMessageOptions,
	CoreAgentLoopNextAssistantWriterPlan,
	CoreAgentLoopStreamStartEvent,
	CoreAgentLoopProviderDataPlan,
	CoreAgentLoopProviderDataPlanContext,
	CoreAgentLoopAfterAssistantResponseContext,
	CoreAgentLoopPostResponseContexts,
	CoreAgentLoopPostResponseSession,
	CoreAgentLoopPostResponseTriggerContext,
	CoreAgentProviderDataLike,
	CoreAgentLoopDataStepsPart,
	CoreAgentLoopReasoningPlacement,
	CoreAgentLoopExecutorTurnState,
	CoreAgentLoopFinalMessageLike,
	CoreAgentLoopFinalMessageUpdate,
	CoreAgentLoopSessionWithMessages,
	CoreAgentLoopStepMetadataUpdate,
	CoreAgentLoopToolPartialStepUpdate,
	CoreAgentLoopToolExecutionEndUpdate,
	CoreAgentLoopToolResultPresentation,
	CoreAgentLoopToolResultStepStatus,
	CoreAgentLoopToolResultStepUpdate,
	CoreAgentLoopToolStartStepUpdate,
	CoreAgentLoopFinishPlan,
	CoreAgentLoopFinishState,
	CoreAgentLoopToolCallWithMetadata,
	CoreAgentLoopToolMetadataUpdate,
	CoreAgentToolResultLike,
	CoreAgentLoopUsage,
	CoreAgentLoopStreamGenerationResult,
	CoreAgentLoopFallbackToolCallLike,
	CoreAgentLoopToolCallFallbackPlan,
	CoreAgentLoopToolCallForSettlement,
	CoreAgentLoopToolCallIdentity,
	CoreAgentLoopToolContentPartDispatchPlan,
	CoreAgentLoopToolExecutionEmitter,
	CoreAgentLoopToolExecutionStore,
	CoreAgentLoopToolChunkApplyResult,
	CoreAgentLoopToolInputProcessor,
	CoreAgentLoopToolResultSettlementResult,
	CoreSettledAgentLoopToolCallResult,
	CoreAgentLoopTurnContentPersistencePlan,
	CoreHistoryMessageWithContent,
	CoreOrderedPartLike,
	CorePreparedToolNames,
	CoreToolCallChanges,
	CoreToolPartialResultUpdate,
	CoreToolResult,
	CoreToolResultContentPart,
	DispatchAgentLoopToolContentPartsOptions,
	EmitAgentLoopFinalMessageUpdateWithAdaptersOptions,
	ExecuteAgentLoopStreamLifecycleWithAdaptersOptions,
	PersistAgentLoopTurnContentPartsOptions,
	RunAgentLoopPostResponseHooksWithAdaptersOptions,
	SettleAgentLoopToolResultOptions,
	StartAgentLoopToolExecutionOptions,
} from "./agent-loop-executor.js";

export {
	agentLoopInitSkills,
	agentLoopSkillContexts,
	applyAgentLoopContextCompactResult,
	buildAgentLoopContextCompactEventPlan,
	buildAgentLoopDirectToolsWithAdapters,
	buildPendingAgentLoopMessageInjections,
	configWithApiKey,
	createAgentLoopCompactState,
	getAgentLoopTransientTail,
	injectPendingAgentLoopMessagesWithAdapters,
	maybeCompactAgentLoopContextWithAdapters,
	planAgentLoopContextCompactFinal,
	planAgentLoopContextCompactPass,
	planAgentLoopPromptBuildOptions,
	planAgentLoopRuntimePreparation,
	planAgentLoopTools,
	clampAgentLoopRequestMaxTokens,
	positiveTokenLimit,
	providerReportedInputTokens,
	resolvePendingAgentLoopMessages,
	resolveAgentLoopContextBudgetValues,
	resolveAgentLoopContextBudgetWithRegistry,
	runAgentLoopAfterTurnWithAdapters,
	runAgentLoopBeforeTurnWithAdapters,
	shouldStartAgentLoopContextCompact,
} from "./agent-loop-runtime.js";
export type {
	CoreAgentLoopCompactLogger,
	CoreAgentLoopCompactSessionLike,
	CoreAgentLoopCompactionAdapters,
	CoreAgentLoopCompactionContext,
	CoreAgentLoopCompactFinalPlan,
	CoreAgentLoopCompactEventPlan,
	CoreAgentLoopCompactResultLike,
	CoreAgentLoopCompactPassPlan,
	CoreAgentLoopCompactReason,
	CoreAgentLoopCompactResultPlan,
	CoreAgentLoopCompactState,
	CoreAgentLoopContextBudget,
	CoreAgentLoopContextBudgetResolution,
	CoreAgentLoopDirectToolMetadataUpdate,
	CoreAgentLoopDirectToolResultLike,
	CoreAgentLoopDirectToolRuntimeContext,
	CoreAgentLoopInitSkillSnapshot,
	CoreAgentLoopMessage,
	CoreAgentLoopModelLimits,
	CoreAgentLoopPendingMessageAdapters,
	CoreAgentLoopProviderConfig,
	CoreAgentLoopPromptBuildInput,
	CoreAgentLoopPromptRuntimeContextLike,
	CoreAgentLoopProviderHostContext,
	CoreAgentLoopProviderRuntimeConfigFor,
	CoreAgentLoopProviderRuntimeConfigLike,
	CoreAgentLoopRuntimeContextLike,
	CoreAgentLoopRuntimePreparationPlan,
	CoreAgentLoopRuntimeSessionLike,
	CoreAgentLoopRuntimeSettingsLike,
	CoreAgentLoopRuntimeToolSettingsLike,
	CoreAgentLoopProviderConfigWithOptionalKey,
	CoreAgentLoopToolPlan,
	CoreAgentLoopToolSettings,
	CoreAgentLoopEphemeralTailAdapters,
	CoreAgentLoopTurnCompactionAdapters,
	CoreAgentLoopTurnMessages,
	CoreAgentLoopTurnQueueAdapters,
	CorePendingAgentLoopInputMessage,
	CorePendingAgentLoopChatMessage,
	CorePendingAgentLoopInjectionResult,
	CorePendingAgentLoopPromptResolution,
	CorePendingAgentLoopRuntimeMessage,
	CoreResolvedPendingAgentLoopMessage,
	CoreAgentLoopSkillContext,
	CoreAgentLoopSkillLike,
	CoreAgentLoopThinkingContext,
	BuildAgentLoopDirectToolsWithAdaptersOptions,
	MaybeCompactAgentLoopContextOptions,
	ResolveAgentLoopContextBudgetOptions,
	RunAgentLoopAfterTurnWithAdaptersOptions,
	RunAgentLoopBeforeTurnWithAdaptersOptions,
} from "./agent-loop-runtime.js";

export {
	buildMessageContent,
	formatMessagesForLog,
	getTextFromContent,
} from "./agent-loop-message-content.js";
export type {
	BuildMessageContentOptions,
	CoreAIMessageContent,
	CoreMessageAttachment,
	CoreMessageContentSource,
} from "./agent-loop-message-content.js";

export {
	filterContentParts,
	filterSteps,
	planToolCallArtifactRemoval,
	buildMCPPartialResultUpdate,
	buildMCPPermissionPlan,
	buildToolExecutionFinalPresentation,
	buildToolExecutionPartialStepUpdate,
	buildToolMetadataStepUpdate,
	changesFromToolMetadata,
	CoreToolOrchestrator,
	executeCoreToolAndUpdate,
	queuedTailToolCallIdsAfter,
	recordToolCallSignature,
	removeToolCallsById,
	resolveMCPPermissionResourceName,
	shouldStopAfterTool,
	isMCPRouterToolName,
	isReadOnlyMCPRouterCall,
	markToolCallAbortedBeforeExecution,
	stableStringify,
	streamableToolResult,
	textFromStructuredToolResult,
	toolCallSignature,
	toolResultObject,
} from "./agent-loop-tool-orchestration.js";
export {
	coreToolCallSnapshot,
	findCoreToolCall,
	patchCoreToolCall,
	replaceCoreToolCall,
} from "./agent-loop-tool-call-cow.js";
export type {
	CoreRepeatedToolCallResult,
	CoreContentPartLike,
	CoreMutableToolCallLike,
	CoreMCPPartialResultUpdate,
	CoreMCPPermissionEffect,
	CoreMCPPermissionPlan,
	CoreMCPPermissionPreview,
	CoreStepLike,
	CoreToolCallDataLike,
	CoreToolCallAbortUpdateOptions,
	CoreToolCallArtifactRemovalPlan,
	CoreToolExecutionPartialStepUpdate,
	CoreToolCallChangesLike,
	CoreToolCallLike,
	CoreToolExecutionJob,
	CoreToolExecutionJobLike,
	CoreToolCallWithChanges,
	CoreToolExecutionEndUpdate,
	CoreToolExecutionEmitter,
	CoreToolExecutionFailureLike,
	CoreToolExecutionFinalPresentation,
	CoreToolExecutionFinalStepStatus,
	CoreToolExecutionFinalStepUpdate,
	CoreToolExecutionResultLike,
	CoreToolExecutionStore,
	CoreToolExecutionStreamContextLike,
	CoreToolExecutionToolCallLike,
	CoreToolMetadataStepUpdate,
	CoreToolMetadataUpdate,
	CoreToolOrchestratorLogger,
	CoreToolOrchestratorOptions,
	CoreExecutableMessageLike,
	CoreExecutableSessionLike,
	CoreExecutableStepLike,
	CoreExecutableToolCallLike,
	CoreToolResultContentLike,
	CoreToolResultLike,
	ExecuteCoreToolAndUpdateOptions,
} from "./agent-loop-tool-orchestration.js";

export {
	resolveAgentLoopStreamRoute,
	shouldUseAgentLoopStream,
} from "./agent-loop-selection.js";

export { CoreTriggerManager } from "./agent-loop-triggers.js";
export type {
	CorePromptCapture,
	CorePromptSection,
	CoreRequestMessage,
	CoreEvalRawRequest,
	CoreEvalRawResponse,
	CoreTrigger,
	CoreTriggerContext,
	CoreTriggerManagerLogger,
} from "./agent-loop-triggers.js";
export { TriggerManager, triggerManager } from "./agent-loop-trigger-manager.js";
export type { Trigger, TriggerContext } from "./agent-loop-trigger-manager.js";
export type {
	AgentLoopStreamEnabledBy,
	AgentLoopStreamRoute,
	AgentLoopStreamSelectionContext,
	AgentLoopStreamSettingsLike,
} from "./agent-loop-selection.js";

export {
	buildContextCompactCompletedContent,
	buildContextCompactFailedContent,
	buildContextCompactSummaryMessages,
	chunkText,
	COMPACT_MODIFIED_FILES_TAG,
	COMPACT_READ_FILES_TAG,
	CONTEXT_COMPACT_CHUNK_TIMEOUT_MS,
	CONTEXT_COMPACT_CHUNK_TIMEOUT_MIN_SECONDS,
	CONTEXT_COMPACT_CHUNK_TIMEOUT_MAX_SECONDS,
	COMPACT_CHUNK_FILL_RATIO,
	COMPACT_FALLBACK_RESERVED_OUTPUT_TOKENS,
	COMPACT_PROMPT_OVERHEAD_TOKENS,
	CompactTokenBudget,
	CONTEXT_COMPACT_MAX_CONCURRENCY,
	CONTEXT_COMPACT_TOTAL_BUDGET_CHUNKS,
	CONTEXT_COMPACT_TOTAL_BUDGET_MS,
	resolveContextCompactChunkTimeoutMs,
	resolveContextCompactTotalBudgetMs,
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
	MAX_CHUNK_CHARS,
	MIN_CHUNK_CHARS,
	normalizeContextCompactError,
	normalizeContextSummaryOutput,
	resolveCompactCharsPerToken,
	resolveCompactChunkChars,
	resolveCompactOutputTokens,
	selectCompactPlan,
	shouldAutoCompactBeforeSend,
	shouldSkipAutoCompactForProviderUsageMismatch,
	SUMMARY_TOOL_RESULT_MAX_CHARS,
	summarizeContextInChunks,
} from "./agent-loop-context-compact.js";
export {
	buildContextUsageSnapshot,
	estimateHistoryMessagesInputTokens,
	estimateTextTokens,
	getContextUsageTriggerReason,
	normalizeContextLength,
	normalizeContextThresholdPercent,
} from "./agent-loop-context-usage.js";
export type {
	CoreContextUsageSessionLike,
	CoreContextUsageSnapshot,
	CoreContextUsageSource,
	CoreContextUsageTriggerReason,
} from "./agent-loop-context-usage.js";
export {
	LEGACY_TURN_CONTEXT_SECTION_ID,
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
	CompactCalibration,
	CompactCalibrationSource,
	CompactCharsPerToken,
	CompactOutputAllowance,
	CompactPlan,
	CoreContextCompactReason,
	CoreContextCompactSummaryMessage,
	CoreCompactAttachment,
	CoreCompactFileOperations,
	CoreCompactMessage,
	CoreCompactSession,
	CoreCompactToolCall,
	CoreContextCompactChunkPlan,
	CoreContextSummaryChunkInput,
	CoreContextSummaryMergeInput,
	CoreContextSummaryRequest,
	SummarizeContextInChunksOptions,
} from "./agent-loop-context-compact.js";

export {
	COMPACTED_HISTORY_RETAINED_PAYLOAD_BUDGET_CHARS,
	COMPACTED_HISTORY_TOOL_RESULT_BUDGET_CHARS,
	COMPACTED_HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS,
	HISTORY_STRING_HARD_CAP_CHARS,
	HISTORY_TOOL_RESULT_BUDGET_CHARS,
	HISTORY_TOOL_RESULTS_TOTAL_BUDGET_CHARS,
	buildCompactedToolResultContent,
	buildHistoryToolResultContent,
	buildHistoryMessages,
	buildResumeHistoryAfterToolConfirmation,
	canSplitHistoryTurnGroups,
	compactedFailureToolResultForAI,
	compactedHistoryPreamble,
	compactedToolResultPlaceholder,
	completedHistoryToolCalls,
	filterHistoryForNonToolAPI,
	getHistoryProviderData,
	getMessageReasoningContent,
	historyContentPartsCoverContent,
	historyMessagesForLog,
	historyMessagePayloadLength,
	jsonLength,
	sanitizeToolResultForAI,
	sanitizeCompactedToolResultForAI,
	sanitizeHistoryToolResultForAI,
	retainedHistoryPayloadLength,
	summarizeRetainedMessagesForLog,
} from "./agent-loop-history.js";
export type {
	CoreCompactedToolResultOptions,
	CoreBuildHistoryMessagesOptions,
	CoreCompactedHistoryLogDetails,
	CoreHistoryChatMessage,
	CoreHistoryContentPart,
	CoreHistoryMessage,
	CoreHistoryToolCall,
	CoreResumeAssistantMessage,
	CoreResumeToolCall,
} from "./agent-loop-history.js";

export {
	canApplyGeneratedSessionTitle,
	generateTitleFromMessage,
	normalizeSessionTitle,
	resolveToolCallModel,
} from "./agent-loop-title.js";
export type {
	StreamEngineProviderConfigLike,
	StreamEngineSettingsWithProviders,
	StreamEngineToolCallModelSettings,
} from "./agent-loop-title.js";

export {
	buildMessageBodyShapePayload,
	chatLogContentTextLength,
	chatLogJsonLength,
} from "./agent-loop-chat-logger.js";
export type {
	CoreChatLogMessageShape,
	CoreChatLogRecord,
	CoreChatLogRow,
	CoreChatLogToolCall,
	CoreChatLogToolResult,
	CoreChatLogTotals,
	CoreChatLogValue,
} from "./agent-loop-chat-logger.js";
export type {
	EngineAgentModelBinding,
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
	PLUGIN_MESSAGE_SOURCE_PREFIX,
	SYSTEM_INTERNAL_MESSAGE_SOURCES,
	TASK_MESSAGE_SOURCE_PREFIX,
} from "./agent-loop-message-sources.js";
// 一条消息从哪来(`MessageOrigin` 的构造、清洗与读法)。包根归位 B(2026-10-04)从包根 `channel/origin.ts` 搬来:
// 它只靠上面那组来源判据,工具权限(L1)、渠道网关、会话命令面都要它,所以住在内核这一层。
export {
	LOCAL_CLIENT_USER_ID,
	cloneOrigin,
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
export type { CollabDriveProver } from "./agent-loop-turn-principal.js";
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
