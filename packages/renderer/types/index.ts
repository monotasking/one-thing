import type {
	NotifyActivateEvent,
	ChatMessage,
	ChatMessageMention,
	ChatMessageReaction,
	ChatMessageReactionActor,
	ChatMessageReplyTo,
	ChatSession,
	ContextVariable,
	AgentDefinition,
	AgentsListResponse,
	AgentCreateResponse,
	AgentUpdateRequest,
	AgentUpdateResponse,
	AgentDeleteResponse,
	AgentRestoreResponse,
	UserPrompt,
	PromptReferenceSnapshot,
	PromptListResponse,
	PromptGetResponse,
	PromptCreateRequest,
	PromptCreateResponse,
	PromptUpdateRequest,
	PromptUpdateResponse,
	PromptDeleteRequest,
	PromptDeleteResponse,
	SessionMeta,
	SessionDetails,
	GetSessionsListResponse,
	ActivateSessionResponse,
	GetSessionMessagesResponse,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	UserMessageMarker,
	GetSessionUserMarkersResponse,
	AISettings,
	AppSettings,
	AIProvider,
	ProviderConfig,
	ModelCapabilityOverride,
	CustomProviderConfig,
	ProviderInfo,
	CodexProviderUsage,
	CodexUsageLimit,
	CodexUsageWindow,
	ProviderEnvStatus,
	GetProviderEnvStatusResponse,
	ProviderUsageResponse,
	ModelInfo,
	OpenRouterModel,
	ColorTheme,
	BaseTheme,
	MessageListDensity,
	TypographyDensity,
	KeyboardShortcut,
	ShortcutSettings,
	EditorSettings,
	ChatSettings,
	ProxySettings,
	NetworkSettings,
	GatewayStatus,
	MessageOrigin,
	ChannelUserLink,
	ChannelUserProfile,
	VoiceAudioChunkPayload,
	VoiceEndpointingMode,
	VoiceEvent,
	VoiceLatencyMilestone,
	VoiceLatencyMilestoneName,
	VoiceRuntimeCommand,
	VoiceRuntimeState,
	VoiceSettings,
	VoiceStartRequest,
	VoiceStopRequest,
	VoiceSubmitUtteranceRequest,
	VoiceSubmitTranscriptRequest,
	VoiceSynthesizeRequest,
	VoiceTestASRRequest,
	VoiceTestTTSRequest,
	VoiceGetStateResponse,
	VoiceSubmitUtteranceResponse,
	VoiceSynthesizeResponse,
	VoiceTTSModel,
	VoiceTTSModelsResponse,
	MusicEvent,
	MusicGetStateResponse,
	MusicSetupRequest,
	MusicSetupResponse,
	MusicNowPlaying,
	MusicCommand,
	MusicCommandRequest,
	MusicCommandResponse,
	MusicRadioState,
	MusicListProvidersResponse,
	MusicGetProgrammeResponse,
	MusicOpenRadioRequest,
	MusicSearchRequest,
	MusicSearchResponse,
	MusicSearchRecordDTO,
	MusicRequestSongRequest,
	MusicRequestSongResponse,
	MusicProgrammeActionRequest,
	MusicProgrammeEntryDTO,
	MusicProviderDescriptorDTO,
	MusicSetProviderRequest,
	MusicBaseResponse,
	MusicLyricLine,
	MusicLyrics,
	MusicDjSpeak,
	MusicRuntimeState,
	MusicPlayerBackend,
	MusicRadioSource,
	MusicEnvStatus,
	MusicSettings,
	MessageAttachment,
	AttachmentMediaType,
	MediaKind,
	MediaSource,
	MediaAsset,
	MediaAssetLink,
	MediaAssetMetadata,
	MediaQuery,
	MediaUsageTag,
	MediaIngestFileInput,
	MediaIngestFilesRequest,
	MediaIngestFilesResponse,
	MediaSaveAsRequest,
	MediaSaveAsResponse,
	MediaGalleryResponse,
	MediaRebuildResponse,
	MarkdownResolveAssetRequest,
	MarkdownResolveAssetResponse,
	MarkdownSaveAttachmentsRequest,
	MarkdownSaveAttachmentsResponse,
	GetSystemPromptSnapshotResponse,
	SystemPromptSkillSnapshot,
	SystemPromptSnapshot,
	SystemPromptToolSnapshot,
	GetSessionsResponse,
	CreateSessionResponse,
	CreateSessionOptions,
	SwitchSessionResponse,
	DeleteSessionResponse,
	RenameSessionResponse,
	CreateBranchResponse,
	UpdateSessionPinResponse,
	GetSettingsResponse,
	SaveSettingsResponse,
	ToolDefinition,
	ToolParameter,
	ToolCall,
	DiffHunk,
	DiffHunkLine,
	ToolResult,
	ToolPartialResult,
	ToolRenderKind,
	PermissionMode,
	ToolSettings,
	BashToolSettings,
	GetToolsResponse,
	ExecuteToolResponse,
	ContentPart,
	Step,
	StepType,
	// UIMessage types (AI SDK 6.x compatible)
	UIMessage,
	UIMessagePart,
	TextUIPart,
	ReasoningUIPart,
	ToolUIPart,
	ToolUIState,
	FileUIPart,
	StepUIPart,
	ErrorUIPart,
	MessageMetadata,
	UIMessageChunk,
	UIMessageStreamData,
	// MCP types
	MCPServerConfig,
	MCPServerState,
	MCPToolInfo,
	MCPResourceInfo,
	MCPPromptInfo,
	MCPSettings,
	MCPTransportType,
	MCPGetServersResponse,
	MCPAddServerResponse,
	MCPUpdateServerResponse,
	MCPRemoveServerResponse,
	MCPConnectServerResponse,
	MCPDisconnectServerResponse,
	MCPLogoutServerResponse,
	MCPProbeServerResponse,
	MCPRefreshServerResponse,
	MCPGetToolsResponse,
	MCPCallToolResponse,
	MCPGetResourcesResponse,
	MCPReadResourceResponse,
	MCPGetPromptsResponse,
	MCPGetPromptResponse,
	MCPReadConfigFileResponse,
	// ACP types
	ACPAgentConfig,
	ACPAgentState,
	ACPSettings,
	ACPGetAgentsResponse,
	ACPAddAgentResponse,
	ACPUpdateAgentResponse,
	ACPRemoveAgentResponse,
	ACPConnectAgentResponse,
	ACPDisconnectAgentResponse,
	ACPRefreshAgentResponse,
	ACPCancelSessionResponse,
	// Skills types (Official Claude Code Skills)
	SkillDefinition,
	SkillFile,
	SkillSource,
	SkillSettings,
	SkillDirectoryConfig,
	PluginCommandInfo,
	GetPluginCommandsResponse,
	ExecutePluginCommandResponse,
	AbortPluginRequestResult,
	PluginNotificationPayload,
	PluginRequestPayload,
	PluginRequestProgressPayload,
	PluginRequestResult,
	PluginConfigResponse,
	PickPluginFileRequest,
	PickPluginFileResponse,
	SetPluginConfigResponse,
	UninstallPluginResponse,
	InstallPluginRequest,
	InstallPluginResponse,
	UpdatePluginResponse,
	CheckPluginUpdatesResponse,
	GetPluginMarketRequest,
	GetPluginMarketResponse,
	PluginLifecycleInfoResponse,
	ReadPluginTarballResponse,
	PluginFootprintResponse,
	SchedulerSchedule,
	SchedulerRunDetailDTO,
	SchedulerTaskSnapshotDTO,
	SchedulerGetRequest,
	SchedulerGetResponse,
	SchedulerCreateTaskRequest,
	SchedulerUpdateTaskRequest,
	SchedulerDeleteTaskRequest,
	SchedulerWriteTaskResponse,
	SchedulerDeleteTaskResponse,
	SchedulerListRunsRequest,
	SchedulerListRunsResponse,
	SchedulerGetRunRequest,
	SchedulerGetRunResponse,
	SchedulerListResponse,
	SchedulerRunNowRequest,
	SchedulerRunNowResponse,
	SchedulerSetEnabledRequest,
	SchedulerSetEnabledResponse,
	SearchRequest,
	SearchResponse,
	SearchWindowGuideState,
	SearchWindowShownPayload,
	// Permission types
	PermissionInfo,
	PermissionResponse,
	// Interaction types (agent 提问 → 用户应答)
	InteractionAnswer,
	InteractionGetPendingResponse,
	InteractionOption,
	InteractionOrigin,
	InteractionOutcome,
	InteractionQuestion,
	InteractionQuestionAnswer,
	InteractionRequest,
	InteractionRespondRequest,
	InteractionRespondResponse,
	// Theme types
	ThemeMeta,
	Theme,
	GetThemesResponse,
	GetThemeResponse,
	ApplyThemeResponse,
	RefreshThemesResponse,
	// Variables types
	VariablesListResponse,
	VariablesSetResponse,
	VariablesDeleteResponse,
	// Session goal types
	SessionGoal,
	SessionGoalStatus,
	// Session TOC types
	SessionSegment,
	SessionSegmentFile,
	SessionSegmentOutcome,
	GoalDiffsResponse,
	GoalFileDiff,
	GoalGetResponse,
	GoalSetRequest,
	GoalSetResponse,
	// Token usage / billing types
	GetUsageSummaryRequest,
	GetUsageSummaryResponse,
	GetSessionUsageRequest,
	GetSessionUsageResponse,
	OnethingUsageBreakdownEntry,
	OnethingUsageBucket,
	OnethingUsagePricingQuality,
	OnethingUsageProjectTotals,
	OnethingUsageSummaryGranularity,
	// Generic RPC envelope (主线 T0)
	RpcRequest,
	RpcResponse,
	// Project directories types (independent module)
	ProjectDirsListResponse,
	ProjectDirsGetResponse,
	ProjectDirsAddResponse,
	ProjectDirsUpdateResponse,
	ProjectDirsRemoveResponse,
	// Space (workspace) types (independent module)
	SpaceRecord,
	SpacesListResponse,
	SpacesCreateRequest,
	SpacesCreateResponse,
	SpacesUpdateRequest,
	SpacesUpdateResponse,
	SpacesRemoveResponse,
	SpaceOverlayPayload,
	SpacesChangedEvent,
	SpacesSetOverlayRequest,
	SpacesGetOverlayResponse,
	SpacesGetProviderSettingsResponse,
	SpacesSetProviderSettingsRequest,
	SpacesSetProviderSettingsResponse,
	SpacesSetOverlayResponse,
	OAuthCredentialTargetRequest,
	SpaceCredentialEntrySummary,
	SpaceCredentialStrategySummary,
	SpaceProviderCredentialSummary,
	SpaceCredentialsSummary,
	SpaceCredentialImportSkip,
	SpacesGetCredentialsResponse,
	SpacesSetCredentialRequest,
	SpacesSetCredentialResponse,
	SpacesSetCredentialPoolRequest,
	SpacesSetCredentialPoolResponse,
	SpacesClearCredentialRequest,
	SpacesClearCredentialResponse,
	SpacesImportCredentialsResponse,
	TodoPlanChangedPayload,
	TodoPlanCreateRequest,
	TodoPlanCreateResponse,
	TodoPlanDocument,
	TodoPlanGetRequest,
	TodoPlanGetResponse,
	TodoPlanRenameRequest,
	TodoPlanRenameResponse,
	TodoPlanDeleteRequest,
	TodoPlanDeleteResponse,
	TodoPlanSnapshot,
	TodoPlanUpdateResponse,
	TodoPlanUpdateRequest,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	ScratchpadAdoptRequest,
	ScratchpadAdoptResponse,
	ScratchpadChangedPayload,
	ScratchpadDeleteRequest,
	ScratchpadDeleteResponse,
	ScratchpadDocument,
	ScratchpadGetRequest,
	ScratchpadGetResponse,
	ScratchpadUpdateRequest,
	ScratchpadUpdateResponse,
	PracticeConfig,
	PracticeConfigResponse,
	PracticeEventPayload,
	PracticeLedgerRecord,
	PracticePhaseEdge,
	PracticeSnapshot,
	PracticeSummaryGranularity,
	PracticeLogRequest,
	PracticeLogResponse,
	PracticeRecentRequest,
	PracticeRecentResponse,
	PracticeSetConfigRequest,
	PracticeStartRequest,
	PracticeStateResponse,
	PracticeStopRequest,
	PracticeSummaryRequest,
	PracticeSummaryResult,
} from "@shared/ipc";
import type { DeepLinkConfirmRequest } from "@shared/ipc/deeplink";
import type {
	SessionEventEnvelope,
	StreamChunk,
} from "@shared/events";

/**
 * 流通道上的一片。底座是 `StreamChunk`,`messageId` 不在分片自己的契约里 ——
 * 它是发出前由 `SessionStreamCoalescer` 盖的号(装配层的 `OutgoingStreamChunk`),
 * 老的重放数据里可能没有。
 */
export type SessionStreamPayload = {
	sessionId: string;
	chunk: StreamChunk & { messageId?: string };
};

export type {
	ChatMessage,
	ChatMessageMention,
	ChatMessageReaction,
	ChatMessageReactionActor,
	ChatMessageReplyTo,
	ChatSession,
	ContextVariable,
	SessionGoal,
	SessionGoalStatus,
	SessionSegment,
	SessionSegmentFile,
	SessionSegmentOutcome,
	GoalDiffsResponse,
	GoalFileDiff,
	GoalGetResponse,
	GoalSetRequest,
	GoalSetResponse,
	GetUsageSummaryRequest,
	GetUsageSummaryResponse,
	GetSessionUsageRequest,
	GetSessionUsageResponse,
	RpcRequest,
	RpcResponse,
	PracticeConfig,
	PracticeConfigResponse,
	PracticeEventPayload,
	PracticeLedgerRecord,
	PracticePhaseEdge,
	PracticeSnapshot,
	PracticeSummaryGranularity,
	PracticeLogRequest,
	PracticeLogResponse,
	PracticeRecentRequest,
	PracticeRecentResponse,
	PracticeSetConfigRequest,
	PracticeStartRequest,
	PracticeStateResponse,
	PracticeStopRequest,
	PracticeSummaryRequest,
	PracticeSummaryResult,
	OnethingUsageBreakdownEntry,
	OnethingUsageBucket,
	OnethingUsagePricingQuality,
	OnethingUsageProjectTotals,
	OnethingUsageSummaryGranularity,
	AgentDefinition,
	AgentsListResponse,
	AgentCreateResponse,
	AgentUpdateRequest,
	AgentUpdateResponse,
	AgentDeleteResponse,
	AgentRestoreResponse,
	UserPrompt,
	PromptReferenceSnapshot,
	PromptListResponse,
	PromptGetResponse,
	PromptCreateRequest,
	PromptCreateResponse,
	PromptUpdateRequest,
	PromptUpdateResponse,
	PromptDeleteRequest,
	PromptDeleteResponse,
	CreateSessionOptions,
	SpaceRecord,
	SpacesListResponse,
	SpacesCreateRequest,
	SpacesCreateResponse,
	SpacesUpdateRequest,
	SpacesUpdateResponse,
	SpacesRemoveResponse,
	SpaceOverlayPayload,
	SpacesChangedEvent,
	SpacesSetOverlayRequest,
	SpacesGetOverlayResponse,
	SpacesGetProviderSettingsResponse,
	SpacesSetProviderSettingsRequest,
	SpacesSetProviderSettingsResponse,
	SpacesSetOverlayResponse,
	OAuthCredentialTargetRequest,
	SpaceCredentialEntrySummary,
	SpaceCredentialStrategySummary,
	SpaceProviderCredentialSummary,
	SpaceCredentialsSummary,
	SpaceCredentialImportSkip,
	SpacesGetCredentialsResponse,
	SpacesSetCredentialRequest,
	SpacesSetCredentialResponse,
	SpacesSetCredentialPoolRequest,
	SpacesSetCredentialPoolResponse,
	SpacesClearCredentialRequest,
	SpacesClearCredentialResponse,
	SpacesImportCredentialsResponse,
	SessionMeta,
	SessionDetails,
	GetSessionsListResponse,
	ActivateSessionResponse,
	GetSessionMessagesResponse,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	UserMessageMarker,
	GetSessionUserMarkersResponse,
	GetSystemPromptSnapshotResponse,
	SystemPromptSkillSnapshot,
	SystemPromptSnapshot,
	SystemPromptToolSnapshot,
	AISettings,
	AppSettings,
	AIProvider,
	ProviderConfig,
	ModelCapabilityOverride,
	CustomProviderConfig,
	ProviderInfo,
	CodexProviderUsage,
	CodexUsageLimit,
	CodexUsageWindow,
	ProviderEnvStatus,
	GetProviderEnvStatusResponse,
	ProviderUsageResponse,
	ModelInfo,
	OpenRouterModel,
	ColorTheme,
	BaseTheme,
	MessageListDensity,
	TypographyDensity,
	KeyboardShortcut,
	ShortcutSettings,
	EditorSettings,
	ChatSettings,
	ProxySettings,
	NetworkSettings,
	GatewayStatus,
	MessageOrigin,
	ChannelUserLink,
	ChannelUserProfile,
	VoiceAudioChunkPayload,
	VoiceEndpointingMode,
	VoiceEvent,
	VoiceLatencyMilestone,
	VoiceLatencyMilestoneName,
	VoiceRuntimeCommand,
	VoiceRuntimeState,
	VoiceSettings,
	VoiceStartRequest,
	VoiceStopRequest,
	VoiceSubmitUtteranceRequest,
	VoiceSubmitTranscriptRequest,
	VoiceSynthesizeRequest,
	VoiceTestASRRequest,
	VoiceTestTTSRequest,
	VoiceGetStateResponse,
	VoiceSubmitUtteranceResponse,
	VoiceSynthesizeResponse,
	VoiceTTSModel,
	VoiceTTSModelsResponse,
	MusicEvent,
	MusicGetStateResponse,
	MusicSetupRequest,
	MusicSetupResponse,
	MusicNowPlaying,
	MusicCommand,
	MusicCommandRequest,
	MusicCommandResponse,
	MusicRadioState,
	MusicListProvidersResponse,
	MusicGetProgrammeResponse,
	MusicOpenRadioRequest,
	MusicSearchRequest,
	MusicSearchResponse,
	MusicSearchRecordDTO,
	MusicRequestSongRequest,
	MusicRequestSongResponse,
	MusicProgrammeActionRequest,
	MusicProgrammeEntryDTO,
	MusicProviderDescriptorDTO,
	MusicSetProviderRequest,
	MusicBaseResponse,
	MusicLyricLine,
	MusicLyrics,
	MusicDjSpeak,
	MusicRuntimeState,
	MusicPlayerBackend,
	MusicRadioSource,
	MusicEnvStatus,
	MusicSettings,
	MessageAttachment,
	AttachmentMediaType,
	MediaKind,
	MediaSource,
	MediaAsset,
	MediaAssetLink,
	MediaAssetMetadata,
	MediaQuery,
	MediaUsageTag,
	MediaIngestFileInput,
	MediaIngestFilesRequest,
	MediaIngestFilesResponse,
	MediaSaveAsRequest,
	MediaSaveAsResponse,
	MediaGalleryResponse,
	MediaRebuildResponse,
	MarkdownResolveAssetRequest,
	MarkdownResolveAssetResponse,
	MarkdownSaveAttachmentsRequest,
	MarkdownSaveAttachmentsResponse,
	ToolDefinition,
	ToolParameter,
	ToolCall,
	DiffHunk,
	DiffHunkLine,
	ToolResult,
	ToolPartialResult,
	ToolRenderKind,
	PermissionMode,
	ToolSettings,
	BashToolSettings,
	ContentPart,
	Step,
	StepType,
	// UIMessage types (AI SDK 6.x compatible)
	UIMessage,
	UIMessagePart,
	TextUIPart,
	ReasoningUIPart,
	ToolUIPart,
	ToolUIState,
	FileUIPart,
	StepUIPart,
	ErrorUIPart,
	MessageMetadata,
	UIMessageChunk,
	UIMessageStreamData,
	// MCP types
	MCPServerConfig,
	MCPServerState,
	MCPToolInfo,
	MCPResourceInfo,
	MCPPromptInfo,
	MCPSettings,
	MCPTransportType,
	MCPProbeServerResponse,
	ACPAgentConfig,
	ACPAgentState,
	ACPSettings,
	ACPGetAgentsResponse,
	ACPAddAgentResponse,
	ACPUpdateAgentResponse,
	ACPRemoveAgentResponse,
	ACPConnectAgentResponse,
	ACPDisconnectAgentResponse,
	ACPRefreshAgentResponse,
	ACPCancelSessionResponse,
	// Skills types (Official Claude Code Skills)
	SkillDefinition,
	SkillFile,
	SkillSource,
	SkillSettings,
	SkillDirectoryConfig,
	PluginCommandInfo,
	GetPluginCommandsResponse,
	ExecutePluginCommandResponse,
	AbortPluginRequestResult,
	PluginNotificationPayload,
	PluginRequestPayload,
	PluginRequestProgressPayload,
	PluginRequestResult,
	PluginConfigResponse,
	PickPluginFileRequest,
	PickPluginFileResponse,
	SetPluginConfigResponse,
	UninstallPluginResponse,
	InstallPluginRequest,
	InstallPluginResponse,
	UpdatePluginResponse,
	CheckPluginUpdatesResponse,
	GetPluginMarketRequest,
	GetPluginMarketResponse,
	PluginLifecycleInfoResponse,
	ReadPluginTarballResponse,
	PluginFootprintResponse,
	SchedulerSchedule,
	SchedulerRunDetailDTO,
	SchedulerTaskSnapshotDTO,
	SchedulerGetRequest,
	SchedulerGetResponse,
	SchedulerCreateTaskRequest,
	SchedulerUpdateTaskRequest,
	SchedulerDeleteTaskRequest,
	SchedulerWriteTaskResponse,
	SchedulerDeleteTaskResponse,
	SchedulerListRunsRequest,
	SchedulerListRunsResponse,
	SchedulerGetRunRequest,
	SchedulerGetRunResponse,
	SchedulerListResponse,
	SchedulerRunNowRequest,
	SchedulerRunNowResponse,
	SchedulerSetEnabledRequest,
	SchedulerSetEnabledResponse,
	// Permission types
	PermissionInfo,
	PermissionResponse,
	// Interaction types (agent 提问 → 用户应答)
	InteractionAnswer,
	InteractionGetPendingResponse,
	InteractionOption,
	InteractionOrigin,
	InteractionOutcome,
	InteractionQuestion,
	InteractionQuestionAnswer,
	InteractionRequest,
	InteractionRespondRequest,
	InteractionRespondResponse,
	// Theme types
	ThemeMeta,
	Theme,
	TodoPlanChangedPayload,
	TodoPlanCreateRequest,
	TodoPlanCreateResponse,
	TodoPlanDocument,
	TodoPlanGetRequest,
	TodoPlanGetResponse,
	TodoPlanRenameRequest,
	TodoPlanRenameResponse,
	TodoPlanDeleteRequest,
	TodoPlanDeleteResponse,
	TodoPlanSnapshot,
	TodoPlanUpdateResponse,
	TodoPlanUpdateRequest,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	SearchRequest,
	SearchResponse,
	ScratchpadChangedPayload,
	ScratchpadDocument,
	ScratchpadGetRequest,
	ScratchpadGetResponse,
	ScratchpadUpdateRequest,
	ScratchpadUpdateResponse,
	ScratchpadDeleteRequest,
	ScratchpadDeleteResponse,
	ScratchpadAdoptRequest,
	ScratchpadAdoptResponse,
};

// Gallery image type for image preview window
export interface GalleryImage {
	id: string;
	src: string; // Full image URL or data URL
	alt?: string; // Image description/title
	thumbnail?: string; // Optional thumbnail URL
}

// Browser (embedded WebContentsView) — renderer mirror of packages/shared/ipc/browser.ts
export interface BrowserTabInfo {
	id: string;
	url: string;
	title: string;
	favicon?: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	crashed?: boolean;
}

export interface BrowserTabsChangedEvent {
	patch: Array<Partial<BrowserTabInfo> & { id: string }>;
	removed?: string[];
	activeTabId?: string | null;
	order?: string[];
}

/** A web element captured in pick mode → structured composer attachment. */
export interface PickedWebElement {
	image: string;
	sourceUrl: string;
	sourceTitle: string;
	excerpt: string;
	clipped: boolean;
}

export interface BrowserPickResponse {
	success: boolean;
	/** Null when the user cancelled — a normal outcome, not an error. */
	element?: PickedWebElement | null;
	error?: string;
}

/** A browser profile — an isolated persistent partition (Chrome-style login). */
export interface BrowserProfile {
	id: string;
	name: string;
}

export interface BrowserProfilesResponse {
	success: boolean;
	profiles: BrowserProfile[];
	activeProfileId: string;
	error?: string;
}

/** Persisted omnibox search-engine selection (table lives in @shared/ipc browser.ts). */
export interface BrowserSearchEngineResponse {
	success: boolean;
	engineId: string;
	error?: string;
}

export interface ElectronAPI {
	/**
	 * Resolve the on-disk path of a dropped/picked File. Returns "" when the
	 * file has no local path (pasted content, web platform).
	 */
	getPathForFile: (file: File) => string;
	onSkillActivated: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			skillName: string;
		}) => void,
	) => () => void;
	onStepAdded: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			step: Step;
		}) => void,
	) => () => void;
	onStepUpdated: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			stepId: string;
			updates: Partial<Step>;
		}) => void,
	) => () => void;
	onImageGenerated: (
		callback: (data: {
			id: string;
			url?: string;
			base64?: string;
			prompt: string;
			revisedPrompt?: string;
			model: string;
			sessionId: string;
			messageId: string;
			createdAt: number;
		}) => void,
	) => () => void;
	// 聊天面(chat)—— 六条 invoke 已整只迁到通用 RPC 通道(P4c 第五批,
	// `@shared/ipc/chat.ts` 的 chatRouter + `@/platform/chat-client` 的 chatApi)。
	// 第七条「工具审批后恢复流」于 2026-08-22(#21)整条删除,壳面清零。
	// 会话域(sessions)—— 26 条 invoke 已整只迁到通用 RPC 通道(P4c 第五批,
	// `@shared/ipc/sessions.ts` 的 sessionsRouter + `@/platform/sessions-client`
	// 的 sessionsApi)。壳面上只剩这个域的**推送**(见 onSessionMessagesChanged /
	// onContextSizeUpdated)。
	// Collab(多 agent 协作房)—— 十五条 invoke 已整只迁到通用 RPC 通道(P4a,
	// `@shared/ipc/collab.ts` 的 collabRouter + `@/platform/collab-client` 的
	// collabApi)。这个域一条推送也没有,所以壳面上什么也不剩。
	// Evals(提示词评估 + 事故工作台)—— 二十五条 invoke 已整只迁到通用 RPC 通道
	// (P4c 第十批,`@shared/ipc/evals.ts` 的 evalsRouter +
	// `@shared/ipc/evals-workbench.ts` 的 evalsWorkbenchRouter;渲染侧从
	// `@/platform/evals-client` 的 evalsApi 与 `@/platform/evals-workbench-client`
	// 的 evalsWorkbenchApi 取)。**三条推送留在这里** —— router 没有推送面。
	onEvalsRunProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;
	onEvalsReplayProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;
	onEvalsDiagnoseProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;
	// Session goals:走通用 RPC(goalRouter),方法在 platformApi 上,不在这里。
	/**
	 * 通用 RPC 出口(主线 T0)。router 域(usage 起)全走这一条,不再逐域加方法;
	 * 对外方法名由 `platformApi` 上的 router client 提供。
	 */
	rpcInvoke: (request: RpcRequest) => Promise<RpcResponse>;
	/**
	 * 宿主壳路由出口(结构债 P4 终态批 A1-a)。与 `rpcInvoke` 同信封、同契约,
	 * 差别只在处理者住哪:数据面在装配层,窗口系在宿主(`apps/electron`)。
	 * 各域的方法从 `platform/<d>-client.ts` 上取,不再逐条挂在这个接口上。
	 */
	shellInvoke: (request: RpcRequest) => Promise<RpcResponse>;
	// Practice (kegel / pomodoro / exercise log) —— 十条 invoke 已整只迁到通用
	// RPC 通道(P4a,`@shared/ipc/practice.ts` 的 practiceRouter +
	// `@/platform/practice-client` 的 practiceApi)。壳面只剩推送订阅。
	onPracticeEvent: (callback: (payload: PracticeEventPayload) => void) => () => void;

	// 插件的十九条数据面已走通用 RPC 通道(pluginsRouter + `@/platform/plugins-client`
	// 的 `pluginsApi`,P4 终态批 C2)。壳面只剩下面**两条推送订阅**。
	onPluginRequestProgress: (
		callback: (payload: PluginRequestProgressPayload) => void,
	) => () => void;

	/**
	 * 插件通知(api.ui.notify + 熔断自动禁用告警 + 配置变更同步信号)。
	 * 仅 Electron 桌面宿主真会推 —— 插件只在桌面执行(设计文档 §6 方案 A)。
	 */
	onPluginNotification: (
		callback: (payload: PluginNotificationPayload) => void,
	) => () => void;

	/**
	 * onething:// 深链的确认门(H4)。仅 Electron 桌面宿主 —— 只有它注册了
	 * URL scheme(web 端连"外面点一条链接"这件事都不存在)。
	 *
	 * `deepLinkReady` 是**冷启动队列的放行信号**:app 被一条深链拉起时,URL 可能
	 * 在窗口建好之前就到,主进程先把它压在队列里,等渲染层说自己能画卡了才投递。
	 */
	// `deepLinkReady` / `respondDeepLink` 走宿主壳路由(deeplinkRouter,A1-a),
	// 渲染侧从 `platform/deeplink-client` 取;这里只剩推来的那张卡。
	onDeepLinkRequest: (
		callback: (request: DeepLinkConfirmRequest) => void,
	) => () => void;
	// Project directories:已走通用 RPC 通道(projectDirsRouter +
	// `@/platform/project-dirs-client`)。
	onSessionMessagesChanged: (
		callback: (data: {
			sessionId: string;
			action: "added" | "updated" | "deleted";
			messageId?: string;
		}) => void,
	) => () => void;
	onContextSizeUpdated: (
		callback: (data: { sessionId: string; contextSize: number }) => void,
	) => () => void;
	// P1(2026-08-14):onContextCompactStarted / onContextCompactCompleted 已删
	// (专用 IPC 通道 + web 端嗅探,零消费者)。压缩通知走 session:event。
	// `updateSessionMaxTokens` 于 A1-a 删除:桌面从来没有处理者、渲染层零调用点。
	// Settings —— 四条数据面(读 / 存 / 系统深浅色 / 代理自检)走通用 RPC
	// (settingsRouter),方法在 platform/settings-client.ts 上。留在壳上的是两件要
	// Electron 本体的事(开设置窗 / 原生对话框)与三条推送订阅。
	onSettingsNavigate: (callback: (payload: { tab: string }) => void) => () => void;
	onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void;
	/**
	 * 空间数据变更广播(批 B9-0)。凭证 / overlay 落盘之后主进程发给所有窗口,
	 * 渲染层 `spaceProviders` store 据此重拉当前空间那一侧 —— 跨窗口缓存过期的解药。
	 */
	onSpacesChanged: (callback: (event: SpacesChangedEvent) => void) => () => void;
	// gateway —— 八条已迁 `gatewayRouter`(P4c 第八批),渲染侧从
	// `platform/gateway-client` 的 `gatewayApi` 取;本域零推送,壳上不留。
	// Voice —— 十一条数据面走通用 RPC(voiceRouter),方法在
	// platform/voice-client.ts 上。这里留三条:两条推送(router 没有推送面)与
	// `voiceAudioChunk` 那条**单向上行**(高频 PCM 流,不带回执;拍板 #10)。
	voiceAudioChunk: (payload: VoiceAudioChunkPayload) => void;
	onVoiceEvent: (callback: (event: VoiceEvent) => void) => () => void;
	onVoiceRuntimeCommand: (
		callback: (command: VoiceRuntimeCommand) => void,
	) => () => void;
	// Music radio:十四条数据面走通用 RPC(musicRouter),方法在
	// platform/music-client.ts 上。**四条推送留在这里** —— router 没有推送面。
	onMusicEvent: (callback: (event: MusicEvent) => void) => () => void;
	onMusicLyrics: (
		callback: (lyrics: MusicLyrics) => void,
	) => () => void;
	onMusicNowPlaying: (
		callback: (nowPlaying: MusicNowPlaying | null) => void,
	) => () => void;
	onMusicDjSpeak: (callback: (speak: MusicDjSpeak) => void) => () => void;
	onSystemThemeChanged: (
		callback: (theme: "light" | "dark") => void,
	) => () => void;
	// Agent methods:走通用 RPC(agentsRouter),方法在 agents-client.ts 上。
		// User prompt methods:走通用 RPC(promptsRouter),方法在 platformApi 上。
	// Theme methods:走通用 RPC(themesRouter),方法在 platform/themes-client.ts 上。
	// Providers / model registry:走通用 RPC(providersRouter / modelsRouter),
	// 方法在 platform/{providers,models}-client.ts 上。
	// Tools:七条数据面走通用 RPC(toolsRouter),方法在 platform/tools-client.ts 上
	// (那一层保留旧的位置参数签名,调用点零改动)。
	// Permission(活询问):已走通用 RPC 通道(permissionRouter +
	// `@/platform/permission-client`)。应答仍走命令总线。

	// Interaction(agent 提问 → 用户应答):两条数据面走通用 RPC(interactionRouter),
	// 方法在 platform/interaction-client.ts 上。提问事件仍走 session:event 通道
	// ('interaction:requested' / 'interaction:settled')。

	// Dialog methods
	// Shell methods
	openPath: (filePath: string) => Promise<string>;
	openExternal: (url: string) => Promise<{ success: boolean }>;
	getDataPath: () => Promise<string>;

	// Clipboard methods
	writeClipboardText: (
		text: string,
	) =>
		| Promise<{ success: boolean; error?: string }>
		| { success: boolean; error?: string };
	/**
	 * Put the image at `filePath` on the clipboard. Optional: the web platform
	 * can only do this for formats the browser's async clipboard accepts, so
	 * callers must feature-check before offering the action.
	 */
	writeClipboardImage?: (
		filePath: string,
	) =>
		| Promise<{ success: boolean; error?: string }>
		| { success: boolean; error?: string };

	// Media —— 只剩「要宿主本体」的三条(P4c 第三批:十一条数据面走 `mediaRouter`,
	// 渲染侧从 `platform/media-client` 的 `mediaApi` 取,不再挂在壳上)。
	onImagePreviewUpdate: (
		callback: (data: {
			mode?: "single";
			previewId?: string;
			src?: string;
			alt?: string;
		}) => void,
	) => () => void;

	// OAuth 的六条数据面:走通用 RPC(oauthRouter),方法在 platform/oauth-client.ts 上。
	// **两条推送仍在这里** —— router 今天没有推送面。
	onOAuthTokenRefreshed: (
		callback: (data: { providerId: string }) => void,
	) => () => void;
	onOAuthTokenExpired: (
		callback: (data: { providerId: string; error?: string }) => void,
	) => () => void;

	// Window

	// Menu event listeners
	onMenuNewChat: (callback: () => void) => () => void;
	onMenuCloseChat: (callback: () => void) => () => void;
	onMenuNewBrowserTab: (callback: () => void) => () => void;

	// files —— 十四条已迁 `filesRouter`(P4c 第八批),渲染侧从
	// `platform/files-client` 的 `filesApi` 取(一律信封,不再是位置参数);
	// 壳上只剩这一条**推送**,router 今天没有推送面。
	onWorkspaceFileChanged: (
		callback: (data: { root: string; path: string; eventType: string }) => void,
	) => () => void;

	// Window methods
	setWindowButtonVisibility: (
		visible: boolean,
	) => Promise<{ success: boolean }>;

	// Unified event-driven channels (Phase 4)
	onSessionEvent: (
		callback: (envelope: SessionEventEnvelope) => void,
	) => () => void;
	onSessionStream: (
		callback: (payload: SessionStreamPayload) => void,
	) => () => void;
	// Terminal (real PTY) — 七条请求面已迁通用 RPC 通道(P4 终态批 D2,
	// `terminalRouter` + `@/platform/terminal-client`);这里只剩两条推送订阅。
	onTerminalData: (
		callback: (data: { terminalId: string; seq: number; data: string }) => void,
	) => () => void;
	onTerminalExit: (
		callback: (data: { terminalId: string; exitCode: number | null }) => void,
	) => () => void;

	/**
	 * 系统通知 + dock 徽标(wire contracts in packages/shared/ipc/notify.ts)。
	 *
	 * 只执行,不判定:"该不该弹"由 renderer 决定(焦点/可见性/水位/冷却窗全在
	 * store 里)。web 宿主是 no-op —— 那边降级为只剩未读墨点。
	 */
	// 两条执行面走宿主壳路由(notifyRouter,A1-a),渲染侧从 `platform/notify-client`
	// 取;这里只剩「用户点了通知」这条推送订阅。
	notify: {
		onActivate: (
			callback: (data: NotifyActivateEvent) => void,
		) => () => void;
	};

	// Browser (embedded WebContentsView; wire contracts in packages/shared/ipc/browser.ts)
	hydrateBrowser: () => Promise<{
		success: boolean;
		tabs: BrowserTabInfo[];
		activeTabId: string | null;
		error?: string;
	}>;
	createBrowserTab: (request?: {
		url?: string;
		background?: boolean;
	}) => Promise<{ success: boolean; tab?: BrowserTabInfo; error?: string }>;
	closeBrowserTab: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	selectBrowserTab: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	navigateBrowser: (tabId: string, url: string) => Promise<{ success: boolean; error?: string }>;
	browserGoBack: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	browserGoForward: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	reloadBrowser: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	stopBrowser: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	setBrowserBounds: (bounds: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => Promise<{ success: boolean; error?: string }>;
	setBrowserVisible: (visible: boolean) => Promise<{ success: boolean; error?: string }>;
	pickBrowserElement: (tabId: string) => Promise<BrowserPickResponse>;
	cancelBrowserPick: (tabId: string) => Promise<{ success: boolean; error?: string }>;
	getBrowserSearchEngine: () => Promise<BrowserSearchEngineResponse>;
	setBrowserSearchEngine: (engineId: string) => Promise<BrowserSearchEngineResponse>;
	listBrowserProfiles: () => Promise<BrowserProfilesResponse>;
	addBrowserProfile: (name: string) => Promise<BrowserProfilesResponse>;
	removeBrowserProfile: (profileId: string) => Promise<BrowserProfilesResponse>;
	switchBrowserProfile: (profileId: string) => Promise<BrowserProfilesResponse>;
	onBrowserTabsChanged: (callback: (event: BrowserTabsChangedEvent) => void) => () => void;


	// Plugin management:已走通用 RPC 通道(pluginsRouter + `@/platform/plugins-client`)。

	// App State:已走通用 RPC 通道(appStateRouter + `@/platform/app-state-client`)。

	// Search Everywhere
	// 四条动窗口的走宿主壳路由(searchWindowRouter,A1-a),渲染侧从
	// `platform/search-window-client` 取;`searchQuery` 是数据面,还没迁。
	onSearchWindowShown: (
		callback: (payload?: SearchWindowShownPayload | null) => void,
	) => () => void;
	onSearchWindowGuides: (
		callback: (state: SearchWindowGuideState) => void,
	) => () => void;
	searchQuery: (req: SearchRequest) => Promise<SearchResponse>;
	onSearchAction: (callback: (actionId: string) => void) => () => void;

	// Todo / Plan:数据面走通用 RPC(todoPlanRouter),七条窗口面走宿主壳路由
	// (todoPlanWindowRouter,A1-a),渲染侧从 `platform/todo-plan-window-client` 取。
	onTodoPlanChanged: (
		callback: (data: TodoPlanChangedPayload) => void,
	) => () => void;

	// Scratchpad(草稿纸):四条数据面已走通用 RPC 通道(scratchpadRouter +
	// `@/platform/scratchpad-client`)。壳面只剩下面那条推送订阅。
	onScratchpadChanged: (
		callback: (data: ScratchpadChangedPayload) => void,
	) => () => void;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}
