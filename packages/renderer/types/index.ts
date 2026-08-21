import type {
	NotifyActivateEvent,
	ShowNotificationRequest,
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
	GatewayGetStatusResponse,
	GatewayStartRequest,
	GatewayStartResponse,
	GatewayStopResponse,
	GatewayWechatAddAccountRequest,
	GatewayWechatAddAccountResponse,
	GatewayWechatStopAccountRequest,
	GatewayWechatStopAccountResponse,
	GatewayWechatRemoveAccountRequest,
	GatewayWechatRemoveAccountResponse,
	GatewayWechatRenameAccountRequest,
	GatewayWechatRenameAccountResponse,
	GatewayWechatLogoutRequest,
	GatewayWechatLogoutResponse,
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
	GetChatHistoryResponse,
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
	GenerateTitleResponse,
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
	GetSkillsResponse,
	RefreshSkillsResponse,
	ReadSkillFileResponse,
	OpenSkillDirectoryResponse,
	CreateSkillResponse,
	SkillDirectoryConfig,
	ListSkillDirectoriesResponse,
	AddSkillDirectoryRequest,
	AddSkillDirectoryResponse,
	UpdateSkillDirectoryRequest,
	UpdateSkillDirectoryResponse,
	RemoveSkillDirectoryResponse,
	SetSkillAgentResponse,
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
	SearchWindowAnchor,
	SearchWindowGuideState,
	SearchWindowOpenOptions,
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
import type {
	DeepLinkConfirmRequest,
	DeepLinkRespondRequest,
	DeepLinkRespondResponse,
} from "@shared/ipc/deeplink";
import type {
	SessionCommand,
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
	GatewayGetStatusResponse,
	GatewayStartRequest,
	GatewayStartResponse,
	GatewayStopResponse,
	GatewayWechatAddAccountRequest,
	GatewayWechatStopAccountRequest,
	GatewayWechatRemoveAccountRequest,
	GatewayWechatRenameAccountRequest,
	GatewayWechatLogoutRequest,
	GatewayWechatLogoutResponse,
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

// Terminal (real PTY) — renderer mirror of packages/shared/ipc/terminal.ts
export interface TerminalInfo {
	id: string;
	title: string;
	cwd: string;
	shell: string;
	cols: number;
	rows: number;
	createdAt: number;
	exited?: { code: number | null };
}

export interface TerminalAttachResult {
	success: boolean;
	info?: TerminalInfo;
	chunks?: Array<{ seq: number; data: string }>;
	lastSeq?: number;
	/** Ring buffer wrapped: write a full reset (\x1bc) before replaying. */
	truncated?: boolean;
	/** Flow-control generation; every ack must carry it. */
	generation?: number;
	error?: string;
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
	getChatHistory: (sessionId: string) => Promise<GetChatHistoryResponse>;
	generateTitle: (message: string) => Promise<GenerateTitleResponse>;
	getSystemPromptSnapshot: (
		sessionId: string,
	) => Promise<GetSystemPromptSnapshotResponse>;
	getSessions: () => Promise<GetSessionsResponse>;
	createSession: (
		name: string,
		options?: CreateSessionOptions,
	) => Promise<CreateSessionResponse>;
	getCollabBoard: (
		roomSessionId: string,
	) => Promise<import("@shared/ipc.js").CollabBoardGetResponse>;
	/** User board mutation (W16): the action rides to the reducer untouched. */
	actCollabBoard: (
		roomSessionId: string,
		action: import("@shared/ipc.js").CollabBoardAction,
	) => Promise<import("@shared/ipc.js").CollabBoardActResponse>;
	/** 停止一张卡正在跑的执行(collab-team-v2 §5.1 入口②)。 */
	stopCollabTask: (
		roomSessionId: string,
		taskId: string,
	) => Promise<import("@shared/ipc.js").CollabTaskStopResponse>;
	setCollabRoomFrozen: (
		roomSessionId: string,
		frozen: boolean,
	) => Promise<import("@shared/ipc.js").CollabRoomFrozenResponse>;
	setCollabRoomBudgets: (
		roomSessionId: string,
		budgets: import("@shared/ipc.js").CollabRoomBudgetsPatch,
	) => Promise<import("@shared/ipc.js").CollabRoomBudgetsResponse>;
	/** Room spend today (W13.5): read-only, one shot when the panel opens. */
	getCollabRoomSpend: (
		roomSessionId: string,
	) => Promise<import("@shared/ipc.js").CollabRoomSpendResponse>;
	/**
	 * 人级停止(E5):点名收回某一张在外的牌 —— 三级停止的第三级。
	 *
	 * `expectedEpoch` 是乐观并发的前置条件(仿看板的 `expectedRev`):界面看见这张
	 * 牌时房间是第几代,取自协调器快照的 `floorEpoch`。对不上就拒绝并回报当前代数。
	 */
	revokeCollabRoomLease: (
		roomSessionId: string,
		leaseId: string,
		expectedEpoch: number,
	) => Promise<import("@shared/ipc.js").CollabRoomRevokeLeaseResponse>;
	/** 协调器状态条的冷启动读取;实时更新走 'collab:coordinator-changed' 会话事件。 */
	getCollabCoordinator: (
		roomSessionId: string,
	) => Promise<import("@shared/ipc.js").CollabCoordinatorGetResponse>;
	/**
	 * Agent 活动快照的冷启动补水(D8 观测体系 §3.1);实时更新走
	 * 'collab:agent-changed' 会话事件。`agentIds` 缺席 = 此刻开着心智循环的全部。
	 * desktop-only。
	 */
	getCollabAgentActivity: (
		agentIds?: string[],
	) => Promise<import("@shared/ipc.js").CollabAgentActivityGetResponse>;
	/**
	 * 调度时间轴的尾读(D8 观测体系 §3.3)——「刚才为什么是那样」的读口。
	 * **只读**,新在前;读的是账文件,不经运行时。desktop-only。
	 */
	getCollabSchedulerLog: (
		roomSessionId: string,
		options?: { limit?: number; types?: string[] },
	) => Promise<import("@shared/ipc.js").CollabSchedulerLogTailResponse>;
	/** Team settings (W6): only provided fields change; pmAgentId null clears. */
	updateCollabRoom: (
		roomSessionId: string,
		update: import("@shared/ipc.js").CollabRoomUpdatePatch,
	) => Promise<import("@shared/ipc.js").CollabRoomUpdateResponse>;
	/** 清空这间房的对话记忆(含每位成员的执行会话与已读游标、看板卡片)。不可恢复。
	 *  includeMemberDms 连带成员两两之间的私聊房(跨群共享,须显式勾选)。 */
	clearCollabRoomHistory: (
		roomSessionId: string,
		includeMemberDms?: boolean,
	) => Promise<import("@shared/ipc.js").CollabRoomClearHistoryResponse>;
	/**
	 * 群 folder 的只读列目录(agent-im-chat-ui.md §3.2「文件」块)。folder 的位置
	 * 只有主进程算得出,所以按房间 id 问。desktop-only。
	 */
	listCollabRoomFolder: (
		roomSessionId: string,
	) => Promise<import("@shared/ipc.js").CollabRoomFolderListResponse>;
	/**
	 * 托管私聊房的 get-or-create(agent-im-dm.md D1)。幂等——同一个 agent 永远同一
	 * 间房,所以"打开"与"创建"是同一个调用。失败 = 这个 agent 不该有私聊
	 * (退休 / service / 查无此人)。desktop-only。
	 */
	ensureCollabDmRoom: (
		agentId: string,
	) => Promise<import("@shared/ipc.js").CollabDmRoomEnsureResponse>;
	/** IM emoji reaction (W8): toggle semantics, palette-validated in the app layer. */
	reactToCollabMessage: (
		roomSessionId: string,
		messageId: string,
		emoji: string,
		actor: import("@shared/ipc.js").ChatMessageReactionActor,
	) => Promise<import("@shared/ipc.js").CollabMessageReactResponse>;
	switchSession: (sessionId: string) => Promise<SwitchSessionResponse>;
	getSession: (sessionId: string) => Promise<SwitchSessionResponse>;
	deleteSession: (sessionId: string) => Promise<DeleteSessionResponse>;
	renameSession: (
		sessionId: string,
		newName: string,
	) => Promise<RenameSessionResponse>;
	createBranch: (
		parentSessionId: string,
		branchFromMessageId: string,
	) => Promise<CreateBranchResponse>;
	updateSessionPin: (
		sessionId: string,
		isPinned: boolean,
	) => Promise<UpdateSessionPinResponse>;
	updateSessionModel: (
		sessionId: string,
		provider: string,
		model: string,
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionAgent: (
		sessionId: string,
		agentId: string,
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionPermissionMode: (
		sessionId: string,
		permissionMode: PermissionMode,
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionArchived: (
		sessionId: string,
		isArchived: boolean,
		archivedAt?: number | null,
	) => Promise<{ success: boolean; error?: string }>;
	updateSessionWorkingDirectory: (
		sessionId: string,
		workingDirectory: string | null,
	) => Promise<{ success: boolean; error?: string }>;
	// Evals (prompt evaluation) — 👎 downvote + Review + Run + Actions
	recordEvalsDownvote: (request: {
		sessionId: string;
		turnId: string;
		userMessage: string;
		note?: string;
	}) => Promise<{
		success: boolean;
		fixturePath?: string;
		incidentId?: string;
		error?: string;
	}>;

	// Phase 1: Review
	evalsListRecords: (request: {
		negativeOnly?: boolean;
		category?: string;
		sinceTs?: string;
		limit?: number;
		offset?: number;
	}) => Promise<{
		success: boolean;
		records?: Array<Record<string, unknown>>;
		total?: number;
		error?: string;
	}>;
	evalsListFixtures: () => Promise<{
		success: boolean;
		fixtures?: Array<{
			path: string;
			capturedAt: string;
			provider: string;
			model: string;
			sessionId: string;
			turnId: string;
			userMessagePreview: string;
			hasNegative: boolean;
		}>;
		error?: string;
	}>;
	evalsReadFixture: (request: { fixturePath: string }) => Promise<{
		success: boolean;
		fixture?: Record<string, unknown>;
		error?: string;
	}>;
	evalsListResults: () => Promise<{
		success: boolean;
		entries?: Array<{
			ts: string;
			promptVersion: string;
			provider: string;
			runs: number;
			evalSetSize: number;
			scores: Record<string, number>;
			mean: number;
			disabled?: string[];
			cost?: string;
			sentinelScores?: Record<string, number>;
		}>;
		error?: string;
	}>;
	evalsListCases: () => Promise<{
		success: boolean;
		cases?: Array<{
			id: string;
			file: string;
			dir: string;
			description: string;
			fixture: string;
			userMessage: string;
			isSentinel: boolean;
			expect: Record<string, unknown>;
		}>;
		error?: string;
	}>;
	evalsGetCase: (request: { caseId: string }) => Promise<{
		success: boolean;
		case_?: Record<string, unknown>;
		error?: string;
	}>;

	// Phase 2: Run
	evalsRunStart: (request: {
		caseIds?: string[];
		runs: number;
		disabledSections?: string[];
		providerId: string;
		model: string;
	}) => Promise<{ success: boolean; error?: string }>;
	evalsRunCancel: () => Promise<{ success: boolean; error?: string }>;
	onEvalsRunProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;

	// Phase 3: Actions
	evalsPromoteFixture: (request: {
		fixturePath: string;
		caseId: string;
		description: string;
		expect: { firstToolCall?: string; contains?: string; notContains?: string };
	}) => Promise<{ success: boolean; casePath?: string; error?: string }>;
	evalsRetireCase: (request: {
		caseId: string;
	}) => Promise<{ success: boolean; newPath?: string; error?: string }>;
	evalsGenerateTriage: (request?: { weeks?: number }) => Promise<{
		success: boolean;
		report?: string;
		triagePath?: string;
		error?: string;
	}>;
	evalsReadRunDetail: (request: { detailPath: string }) => Promise<{
		success: boolean;
		detail?: Record<string, unknown>;
		error?: string;
	}>;
	// Evals Workbench (incident-centric)
	evalsIncidentList: () => Promise<{
		success: boolean;
		incidents?: Array<Record<string, unknown>>;
		error?: string;
	}>;
	evalsIncidentGet: (request: { incidentId: string }) => Promise<{
		success: boolean;
		incident?: Record<string, unknown>;
		markdown?: string;
		runs?: Array<Record<string, unknown>>;
		error?: string;
	}>;
	evalsIncidentUpdate: (request: {
		incidentId: string;
		patch: { status?: string; note?: string; rubric?: string; title?: string };
	}) => Promise<{
		success: boolean;
		incident?: Record<string, unknown>;
		error?: string;
	}>;
	evalsIncidentReadFile: (request: {
		incidentId: string;
		relativePath: string;
	}) => Promise<{ success: boolean; content?: string; error?: string }>;
	evalsReplayStart: (request: {
		incidentId: string;
		runs?: number;
		disabledSections?: string[];
		judge?: boolean;
		useCapturedPrompt?: boolean;
		providerId?: string;
		model?: string;
	}) => Promise<{ success: boolean; runId?: string; error?: string }>;
	evalsReplayCancel: (request: {
		incidentId: string;
	}) => Promise<{ success: boolean; error?: string }>;
	onEvalsReplayProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;
	evalsIncidentAnalyze: (request: { incidentId: string }) => Promise<{
		success: boolean;
		incident?: Record<string, unknown>;
		error?: string;
	}>;
	evalsIncidentPromote: (request: {
		incidentId: string;
		caseId: string;
		description?: string;
	}) => Promise<{ success: boolean; casePath?: string; error?: string }>;
	evalsDiagnoseStart: (request: {
		incidentId: string;
		quick?: boolean;
	}) => Promise<{ success: boolean; error?: string }>;
	onEvalsDiagnoseProgress: (
		callback: (event: Record<string, unknown>) => void,
	) => () => void;
	evalsRoundList: (request: { incidentId: string }) => Promise<{
		success: boolean;
		rounds?: Array<Record<string, unknown>>;
		error?: string;
	}>;
	evalsRoundReplay: (request: {
		incidentId: string;
		round: number;
		runs?: number;
		editedMessages?: unknown[];
		providerId?: string;
		model?: string;
	}) => Promise<{
		success: boolean;
		attempts?: Array<{
			content: string;
			toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
			finishReason: string;
		}>;
		edited?: boolean;
		error?: string;
	}>;
	// Variables subsystem (scalar variables)
	listVariables: (sessionId: string) => Promise<VariablesListResponse>;
	setVariable: (
		sessionId: string,
		name: string,
		value: string,
		description?: string,
		scope?: "global" | "session" | "agent" | "project",
	) => Promise<VariablesSetResponse>;
	deleteVariable: (
		sessionId: string,
		name: string,
	) => Promise<VariablesDeleteResponse>;
	// Session goals:走通用 RPC(goalRouter),方法在 platformApi 上,不在这里。
	/**
	 * 通用 RPC 出口(主线 T0)。router 域(usage 起)全走这一条,不再逐域加方法;
	 * 对外方法名由 `platformApi` 上的 router client 提供。
	 */
	rpcInvoke: (request: RpcRequest) => Promise<RpcResponse>;
	// Practice (kegel / pomodoro / exercise log)
	practiceStart: (request: PracticeStartRequest) => Promise<PracticeStateResponse>;
	practicePause: () => Promise<PracticeStateResponse>;
	practiceResume: () => Promise<PracticeStateResponse>;
	practiceStop: (request?: PracticeStopRequest) => Promise<PracticeStateResponse>;
	practiceGetState: () => Promise<PracticeStateResponse>;
	practiceLog: (request: PracticeLogRequest) => Promise<PracticeLogResponse>;
	practiceSummary: (request: PracticeSummaryRequest) => Promise<PracticeSummaryResult>;
	practiceRecent: (request: PracticeRecentRequest) => Promise<PracticeRecentResponse>;
	practiceGetConfig: () => Promise<PracticeConfigResponse>;
	practiceSetConfig: (request: PracticeSetConfigRequest) => Promise<PracticeConfigResponse>;
	onPracticeEvent: (callback: (payload: PracticeEventPayload) => void) => () => void;

	/**
	 * 统一插件请求通道(R2)。payload / result 必须 JSON-可序列化。
	 * server 端按方案 A 返回 501:插件只在 Electron 桌面宿主执行。
	 */
	pluginRequest: (request: PluginRequestPayload) => Promise<PluginRequestResult>;

	abortPluginRequest: (requestId: string) => Promise<AbortPluginRequestResult>;

	onPluginRequestProgress: (
		callback: (payload: PluginRequestProgressPayload) => void,
	) => () => void;

	/**
	 * 插件自有配置(R3)。schema 单源在 manifest,存储与校验全在宿主,
	 * 所以未启用的插件也能配。web 端只读(方案 A)。
	 */
	getPluginConfig: (pluginId: string) => Promise<PluginConfigResponse>;

	setPluginConfig: (
		pluginId: string,
		config: Record<string, unknown>,
	) => Promise<SetPluginConfigResponse>;

	/**
	 * 真卸载(R4)。数据被归档而不是删除;仅用户插件,web 端不提供。
	 */
	uninstallPlugin: (pluginId: string) => Promise<UninstallPluginResponse>;

	/**
	 * npm 生命周期(P1):装/更/查更新。v1 面向开发者市场,依赖本机 npm
	 * (裁决 8);web 端不提供 —— 插件只在桌面执行。
	 */
	installPlugin: (request: InstallPluginRequest) => Promise<InstallPluginResponse>;

	updatePlugin: (pluginId: string) => Promise<UpdatePluginResponse>;

	/** "有更新"徽标的数据源;无市场索引/无 npm 时返回空 offers。 */
	checkPluginUpdates: () => Promise<CheckPluginUpdatesResponse>;

	/** 生命周期能力面:无 npm 时设置页把 Install/Update 置灰并说明。 */
	getPluginLifecycleInfo: () => Promise<PluginLifecycleInfoResponse>;

	/**
	 * 装前清单预读(file: 开发通道):选中 .tgz 即拿到包名、版本与声明,
	 * 用户不必再手抄包名。预读只喂 UI —— 安装闸一条不松。
	 */
	readPluginTarball: (path: string) => Promise<ReadPluginTarballResponse>;

	/** 市场(P3):索引视图;断网回缓存并 stale 置位。 */
	getPluginMarket: (request?: GetPluginMarketRequest) => Promise<GetPluginMarketResponse>;

	/** 落盘足迹(R4 枚举 + R5 出口):卸载确认框展示"将被归档的东西"。 */
	getPluginFootprint: (pluginId: string) => Promise<PluginFootprintResponse>;

	/**
	 * `file-pick` 节点的宿主托管导入(B 期,用户壁纸)。
	 *
	 * 递的是节点上的声明,回的是一个 `storage:` 地址 —— 用户选中的路径与
	 * 文件字节**都不过 renderer 的手**,更不过插件的手。取消 = `canceled`。
	 */
	pickPluginFile: (request: PickPluginFileRequest) => Promise<PickPluginFileResponse>;

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
	deepLinkReady: () => Promise<{ success: boolean }>;
	onDeepLinkRequest: (
		callback: (request: DeepLinkConfirmRequest) => void,
	) => () => void;
	respondDeepLink: (
		request: DeepLinkRespondRequest,
	) => Promise<DeepLinkRespondResponse>;
	// Project directories — independent module.
	// 末位 `workspaceId` 缺省 = default 空间(批 B4:名册 per-space)。
	projectDirsList: (workspaceId?: string) => Promise<ProjectDirsListResponse>;
	projectDirsGet: (
		path: string,
		workspaceId?: string,
	) => Promise<ProjectDirsGetResponse>;
	projectDirsAdd: (
		path: string,
		description?: string,
		paths?: string[],
		workspaceId?: string,
	) => Promise<ProjectDirsAddResponse>;
	projectDirsUpdate: (
		path: string,
		patch: { description?: string; paths?: string[] },
		workspaceId?: string,
	) => Promise<ProjectDirsUpdateResponse>;
	projectDirsRemove: (
		path: string,
		workspaceId?: string,
	) => Promise<ProjectDirsRemoveResponse>;
	getSessionTokenUsage: (sessionId: string) => Promise<{
		success: boolean;
		usage?: {
			totalInputTokens: number;
			totalOutputTokens: number;
			totalTokens: number;
			maxTokens: number;
			lastInputTokens: number;
			contextSize: number;
		};
		error?: string;
	}>;
	// Optimized session loading (Phase 4: Metadata Separation)
	getSessionsList: () => Promise<GetSessionsListResponse>;
	activateSession: (sessionId: string) => Promise<ActivateSessionResponse>;
	getSessionMessages: (
		sessionId: string,
	) => Promise<GetSessionMessagesResponse>;
	getSessionMessagesPage: (
		request: GetSessionMessagesPageRequest,
	) => Promise<GetSessionMessagesPageResponse>;
	getSessionUserMarkers: (
		sessionId: string,
	) => Promise<GetSessionUserMarkersResponse>;
	getSessionSegments: (
		sessionId: string,
	) => Promise<{ success: boolean; segments: SessionSegment[] }>;
	onSessionMessagesChanged: (
		callback: (data: {
			sessionId: string;
			action: "added" | "updated" | "deleted";
			messageId?: string;
		}) => void,
	) => () => void;
	getSessionCacheStats: () => Promise<{
		size: number;
		maxSize: number;
		cachedSessionIds: string[];
	}>;
	evictSessionCache: (sessionId: string) => Promise<{ success: boolean }>;
	// System message methods (for /files command persistence)
	addSystemMessage: (
		sessionId: string,
		message: { id: string; role: string; content: string; timestamp: number },
	) => Promise<{ success: boolean; error?: string }>;
	removeFilesChangedMessage: (
		sessionId: string,
	) => Promise<{ success: boolean; removedId?: string | null; error?: string }>;
	removeGitStatusMessage: (
		sessionId: string,
	) => Promise<{ success: boolean; removedId?: string | null; error?: string }>;
	// Generic remove message by ID (for close button functionality)
	removeMessage: (
		sessionId: string,
		messageId: string,
	) => Promise<{ success: boolean; error?: string }>;
	onContextSizeUpdated: (
		callback: (data: { sessionId: string; contextSize: number }) => void,
	) => () => void;
	// P1(2026-08-14):onContextCompactStarted / onContextCompactCompleted 已删
	// (专用 IPC 通道 + web 端嗅探,零消费者)。压缩通知走 session:event。
	updateSessionMaxTokens: (
		sessionId: string,
		maxTokens: number,
	) => Promise<{ success: boolean; error?: string }>;
	getSettings: () => Promise<GetSettingsResponse>;
	saveSettings: (settings: AppSettings) => Promise<SaveSettingsResponse>;
	openSettingsWindow: (options?: { tab?: string }) => Promise<{ success: boolean }>;
	onSettingsNavigate: (callback: (payload: { tab: string }) => void) => () => void;
	onSettingsChanged: (callback: (settings: AppSettings) => void) => () => void;
	/**
	 * 空间数据变更广播(批 B9-0)。凭证 / overlay 落盘之后主进程发给所有窗口,
	 * 渲染层 `spaceProviders` store 据此重拉当前空间那一侧 —— 跨窗口缓存过期的解药。
	 */
	onSpacesChanged: (callback: (event: SpacesChangedEvent) => void) => () => void;
	gatewayGetStatus: () => Promise<GatewayGetStatusResponse>;
	gatewayStart: (
		request?: GatewayStartRequest,
	) => Promise<GatewayStartResponse>;
	gatewayStop: () => Promise<GatewayStopResponse>;
	gatewayWechatLogout: (
		request?: GatewayWechatLogoutRequest,
	) => Promise<GatewayWechatLogoutResponse>;
	gatewayWechatAddAccount: (
		request?: GatewayWechatAddAccountRequest,
	) => Promise<GatewayWechatAddAccountResponse>;
	gatewayWechatStopAccount: (
		request: GatewayWechatStopAccountRequest,
	) => Promise<GatewayWechatStopAccountResponse>;
	gatewayWechatRemoveAccount: (
		request: GatewayWechatRemoveAccountRequest,
	) => Promise<GatewayWechatRemoveAccountResponse>;
	gatewayWechatRenameAccount: (
		request: GatewayWechatRenameAccountRequest,
	) => Promise<GatewayWechatRenameAccountResponse>;
	voiceGetState: () => Promise<VoiceGetStateResponse>;
	voiceStart: (
		request?: VoiceStartRequest,
	) => Promise<{ success: boolean; error?: string }>;
	voiceStop: (
		request?: VoiceStopRequest,
	) => Promise<{ success: boolean; error?: string }>;
	voiceSubmitUtterance: (
		request: VoiceSubmitUtteranceRequest,
	) => Promise<VoiceSubmitUtteranceResponse>;
	voiceSubmitTranscript: (
		request: VoiceSubmitTranscriptRequest,
	) => Promise<VoiceSubmitUtteranceResponse>;
	voiceSynthesize: (
		request: VoiceSynthesizeRequest,
	) => Promise<VoiceSynthesizeResponse>;
	voiceTestASR: (
		request: VoiceTestASRRequest,
	) => Promise<VoiceSubmitUtteranceResponse>;
	voiceTestTTS: (
		request: VoiceTestTTSRequest,
	) => Promise<{ success: boolean; error?: string; mimeType?: string }>;
	voiceGetTTSModels: (request?: {
		force?: boolean;
	}) => Promise<VoiceTTSModelsResponse>;
	onVoiceEvent: (callback: (event: VoiceEvent) => void) => () => void;
	voiceRuntimeReady: () => Promise<{ success: boolean }>;
	voiceRuntimeEvent: (event: VoiceEvent) => Promise<{ success: boolean }>;
	voiceAudioChunk: (payload: VoiceAudioChunkPayload) => void;
	onVoiceRuntimeCommand: (
		callback: (command: VoiceRuntimeCommand) => void,
	) => () => void;
	musicGetState: () => Promise<MusicGetStateResponse>;
	musicSetup: (request: MusicSetupRequest) => Promise<MusicSetupResponse>;
	onMusicEvent: (callback: (event: MusicEvent) => void) => () => void;
	musicCommand: (request: MusicCommandRequest) => Promise<MusicCommandResponse>;
	musicGetNowPlaying: () => Promise<MusicNowPlaying | null>;
	musicGetRadio: () => Promise<MusicRadioState>;
	musicOpenRadio: (request: MusicOpenRadioRequest) => Promise<MusicBaseResponse>;
	musicSearch: (request: MusicSearchRequest) => Promise<MusicSearchResponse>;
	musicRequestSong: (request: MusicRequestSongRequest) => Promise<MusicRequestSongResponse>;
	musicGetProgramme: () => Promise<MusicGetProgrammeResponse>;
	musicProgrammeAction: (request: MusicProgrammeActionRequest) => Promise<MusicBaseResponse>;
	musicListProviders: () => Promise<MusicListProvidersResponse>;
	musicSetProvider: (request: MusicSetProviderRequest) => Promise<MusicBaseResponse>;
	musicGetLyrics: () => Promise<MusicLyrics | null>;
	onMusicLyrics: (
		callback: (lyrics: MusicLyrics) => void,
	) => () => void;
	onMusicNowPlaying: (
		callback: (nowPlaying: MusicNowPlaying | null) => void,
	) => () => void;
	onMusicDjSpeak: (callback: (speak: MusicDjSpeak) => void) => () => void;
	musicDjSpeakDone: (id: string) => Promise<void>;
	getSystemTheme: () => Promise<{ success: boolean; theme?: "light" | "dark" }>;
	testProxy: (
		proxy: ProxySettings,
	) => Promise<{ success: boolean; error?: string; status?: number }>;
	onSystemThemeChanged: (
		callback: (theme: "light" | "dark") => void,
	) => () => void;
	// Agent methods:走通用 RPC(agentsRouter),方法在 agents-client.ts 上。
		// User prompt methods:走通用 RPC(promptsRouter),方法在 platformApi 上。
	// Theme methods
	getThemes: () => Promise<GetThemesResponse>;
	getTheme: (themeId: string) => Promise<GetThemeResponse>;
	applyTheme: (
		themeId: string,
		mode: "dark" | "light",
	) => Promise<ApplyThemeResponse>;
	refreshThemes: (projectPath?: string) => Promise<RefreshThemesResponse>;
	openThemesFolder: () => Promise<{ success: boolean; error?: string }>;
	// Providers / model registry:走通用 RPC(providersRouter / modelsRouter),
	// 方法在 platform/{providers,models}-client.ts 上。
	// Tools methods
	getTools: () => Promise<GetToolsResponse>;
	executeTool: (
		toolId: string,
		args: Record<string, any>,
		messageId: string,
		sessionId: string,
	) => Promise<ExecuteToolResponse>;
	cancelTool: (toolCallId: string) => Promise<{ success: boolean }>;
	listBackgroundJobs: (options?: { includeInactive?: boolean }) => Promise<{
		success: boolean;
		jobs?: Array<Record<string, any>>;
		error?: string;
	}>;
	stopBackgroundJob: (
		jobId: string,
	) => Promise<{ success: boolean; error?: string }>;
	updateToolCall: (
		sessionId: string,
		messageId: string,
		toolCallId: string,
		updates: Partial<ToolCall>,
	) => Promise<{ success: boolean }>;
	abortStream: (sessionId?: string) => Promise<{ success: boolean }>;
	/**
	 * 两个宿主对同一件事**用了不同的字段名**,类型如实记两个:
	 * desktop 走 `listOnethingActiveStreamsForIpc` 回 `sessionIds`,
	 * server 的 `/api/streams/active` 回 `streams`。消费者两边都读
	 * (`response.sessionIds ?? response.streams`),别只认一个。
	 */
	getActiveStreams: () => Promise<{
		success: boolean;
		streams?: string[];
		sessionIds?: string[];
	}>;
	resumeAfterToolConfirm: (
		sessionId: string,
		messageId: string,
	) => Promise<{ success: boolean; error?: string }>;

	// Permission methods
	clearSessionPermissions: (
		sessionId: string,
	) => Promise<{ success: boolean; error?: string }>;
	getPendingPermissions: (sessionId: string) => Promise<{
		success: boolean;
		pending?: PermissionInfo[];
		error?: string;
	}>;

	// Interaction methods (agent 提问 → 用户应答). 提问事件走 session:event 通道
	// ('interaction:requested' / 'interaction:settled'),这两条只管补水和写回。
	getPendingInteractions: (
		sessionId: string,
	) => Promise<InteractionGetPendingResponse>;
	respondInteraction: (
		request: InteractionRespondRequest,
	) => Promise<InteractionRespondResponse>;

	// MCP methods
	mcpGetServers: () => Promise<MCPGetServersResponse>;
	mcpAddServer: (config: MCPServerConfig) => Promise<MCPAddServerResponse>;
	mcpUpdateServer: (
		config: MCPServerConfig,
	) => Promise<MCPUpdateServerResponse>;
	mcpRemoveServer: (serverId: string) => Promise<MCPRemoveServerResponse>;
	mcpConnectServer: (serverId: string) => Promise<MCPConnectServerResponse>;
	mcpDisconnectServer: (
		serverId: string,
	) => Promise<MCPDisconnectServerResponse>;
	mcpLogoutServer: (
		serverId: string,
	) => Promise<MCPLogoutServerResponse>;
	mcpProbeServer: (
		config: MCPServerConfig,
	) => Promise<MCPProbeServerResponse>;
	mcpRefreshServer: (serverId: string) => Promise<MCPRefreshServerResponse>;
	mcpGetTools: () => Promise<MCPGetToolsResponse>;
	mcpCallTool: (
		serverId: string,
		toolName: string,
		args: Record<string, any>,
	) => Promise<MCPCallToolResponse>;
	mcpGetResources: () => Promise<MCPGetResourcesResponse>;
	mcpReadResource: (
		serverId: string,
		uri: string,
	) => Promise<MCPReadResourceResponse>;
	mcpGetPrompts: () => Promise<MCPGetPromptsResponse>;
	mcpGetPrompt: (
		serverId: string,
		name: string,
		args?: Record<string, string>,
	) => Promise<MCPGetPromptResponse>;
	mcpReadConfigFile: (filePath: string) => Promise<MCPReadConfigFileResponse>;

	// ACP methods
	acpGetAgents: () => Promise<ACPGetAgentsResponse>;
	acpAddAgent: (config: ACPAgentConfig) => Promise<ACPAddAgentResponse>;
	acpUpdateAgent: (config: ACPAgentConfig) => Promise<ACPUpdateAgentResponse>;
	acpRemoveAgent: (agentId: string) => Promise<ACPRemoveAgentResponse>;
	acpConnectAgent: (agentId: string) => Promise<ACPConnectAgentResponse>;
	acpDisconnectAgent: (agentId: string) => Promise<ACPDisconnectAgentResponse>;
	acpRefreshAgent: (agentId: string) => Promise<ACPRefreshAgentResponse>;
	acpCancelSession: (
		sessionId: string,
		agentId?: string,
	) => Promise<ACPCancelSessionResponse>;

	// Skills methods (Official Claude Code Skills)
	getSkills: (workingDirectory?: string) => Promise<GetSkillsResponse>;
	refreshSkills: () => Promise<RefreshSkillsResponse>;
	readSkillFile: (
		skillId: string,
		fileName: string,
	) => Promise<ReadSkillFileResponse>;
	openSkillDirectory: (skillId?: string) => Promise<OpenSkillDirectoryResponse>;
	createSkill: (
		name: string,
		description: string,
		instructions: string,
		source: SkillSource,
	) => Promise<CreateSkillResponse>;
	deleteSkill: (
		skillId: string,
	) => Promise<{ success: boolean; error?: string }>;
	toggleSkillEnabled: (
		skillId: string,
		enabled: boolean,
	) => Promise<{ success: boolean; error?: string }>;
	listSkillDirectories: () => Promise<ListSkillDirectoriesResponse>;
	addSkillDirectory: (request: AddSkillDirectoryRequest) =>
		Promise<AddSkillDirectoryResponse>;
	updateSkillDirectory: (request: UpdateSkillDirectoryRequest) =>
		Promise<UpdateSkillDirectoryResponse>;
	removeSkillDirectory: (id: string) => Promise<RemoveSkillDirectoryResponse>;
	setSkillAgent: (
		skillId: string,
		agentId: string | null,
	) => Promise<SetSkillAgentResponse>;

	// Message update methods
	updateMessageThinkingTime: (
		sessionId: string,
		messageId: string,
		thinkingTime: number,
	) => Promise<{ success: boolean }>;

	// Dialog methods
	showOpenDialog: (options: {
		properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
		title?: string;
		defaultPath?: string;
		filters?: Array<{ name: string; extensions: string[] }>;
	}) => Promise<{ canceled: boolean; filePaths: string[] }>;

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

	// Media methods
	saveImage: (data: {
		url?: string;
		base64?: string;
		prompt: string;
		revisedPrompt?: string;
		model: string;
		sessionId: string;
		messageId: string;
		/** Where the bytes came from. Defaults to 'ai-generated'. */
		source?: MediaSource;
		/** What the image is for, e.g. 'persona-avatar'. */
		usageTags?: MediaUsageTag[];
	}) => Promise<{
		id: string;
		type: "image";
		filePath: string;
		prompt: string;
		revisedPrompt?: string;
		model: string;
		createdAt: number;
		sessionId: string;
		messageId: string;
	}>;
	loadAllMedia: () => Promise<
		{
			id: string;
			type: "image";
			filePath: string;
			prompt: string;
			revisedPrompt?: string;
			model: string;
			createdAt: number;
			sessionId: string;
			messageId: string;
		}[]
	>;
	deleteMedia: (id: string) => Promise<boolean>;
	clearAllMedia: () => Promise<void>;
	readImageBase64: (filePath: string) => Promise<string>;
	listMediaAssets: (query?: MediaQuery) => Promise<MediaAsset[]>;
	/** Put arbitrary files in the library (drop / picker / web upload). */
	ingestMediaFiles: (
		request: MediaIngestFilesRequest,
	) => Promise<MediaIngestFilesResponse>;
	saveMediaAs: (request: MediaSaveAsRequest) => Promise<MediaSaveAsResponse>;
	hideMediaAsset: (id: string) => Promise<{ success: boolean }>;
	rebuildMediaLibrary: () => Promise<MediaRebuildResponse>;
	getMediaGallery: (
		assetId: string,
		query?: MediaQuery,
	) => Promise<MediaGalleryResponse>;

	// Image preview methods
	openImagePreview: (
		src: string,
		alt?: string,
	) => Promise<{ success: boolean }>;
	getImagePreview: (previewId: string) => Promise<{
		success: boolean;
		src?: string;
		alt?: string;
		error?: string;
	}>;
	openImageGallery: (mediaId: string) => Promise<{ success: boolean }>;
	onImagePreviewUpdate: (
		callback: (data: {
			mode?: "single";
			previewId?: string;
			src?: string;
			alt?: string;
		}) => void,
	) => () => void;

	// OAuth methods。末位 `target` 是凭证写回目标(批 B6):缺席 = 默认空间,
	// 带 spaceId = 落进那个空间的凭证池(entryId 缺席 = 登一个新账号)。
	oauthStart: (
		providerId: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{
		success: boolean;
		error?: string;
		flowId?: string;
		flowKind?: "pkce-callback" | "manual-pkce" | "device-code";
		pollIntervalMs?: number;
		expiresAt?: number;
		statusMessage?: string;
		// For device flow (GitHub Copilot)
		userCode?: string;
		verificationUri?: string;
		// For manual code entry flow (Claude Code)
		requiresCodeEntry?: boolean;
		state?: string;
		instructions?: string;
	}>;
	oauthCallback: (
		providerId: string,
		code: string,
		state: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{
		success: boolean;
		error?: string;
	}>;
	oauthLogout: (
		providerId: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{ success: boolean; error?: string }>;
	oauthGetStatus: (
		providerId: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{
		success: boolean;
		providerId?: string;
		isLoggedIn: boolean;
		isExpired?: boolean;
		canRefresh?: boolean;
		expiresAt?: number;
		account?: {
			id?: string;
			email?: string;
			planType?: string;
			isFedramp?: boolean;
		};
		lastError?: string;
		error?: string;
	}>;
	oauthDevicePoll: (
		providerId: string,
		flowId?: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{
		success: boolean;
		completed?: boolean;
		error?: string;
		pollStatus?: string;
	}>;
	oauthRefresh: (
		providerId: string,
		target?: OAuthCredentialTargetRequest,
	) => Promise<{ success: boolean; error?: string }>;
	onOAuthTokenRefreshed: (
		callback: (data: { providerId: string }) => void,
	) => () => void;
	onOAuthTokenExpired: (
		callback: (data: { providerId: string; error?: string }) => void,
	) => () => void;

	// Window
	closeWindow: () => Promise<{ success: boolean }>;

	// Menu event listeners
	onMenuNewChat: (callback: () => void) => () => void;
	onMenuCloseChat: (callback: () => void) => () => void;
	onMenuNewBrowserTab: (callback: () => void) => () => void;

	// Files methods (for @ file search)
	listFiles: (options: {
		cwd?: string;
		query?: string;
		limit?: number;
		/** 发起补全的会话 —— 接入目录 per-space,按会话归属解析(批 B2)。 */
		sessionId?: string;
	}) => Promise<{
		success: boolean;
		files: string[];
		entries?: Array<{
			path: string;
			type: "file" | "directory";
			source?: "workdir" | "downloads" | "note";
			label?: string;
		}>;
		error?: string;
	}>;

	// File rollback (for /files command)
	rollbackFile: (options: {
		auditPath?: string;
		filePath?: string;
		originalContent?: string;
		isNew?: boolean;
	}) => Promise<{
		success: boolean;
		error?: string;
		auditId?: string;
		filePath?: string;
		restoredExists?: boolean;
	}>;

	// Directories listing (for /cd path completion)
	listDirs: (options: {
		basePath: string;
		query?: string;
		limit?: number;
	}) => Promise<{
		success: boolean;
		dirs: string[];
		basePath: string;
		error?: string;
	}>;

	// File content reading/writing (for file preview panel)
	readFileContent: (
		filePath: string,
		maxSize?: number,
	) => Promise<{
		success: boolean;
		content?: string;
		encoding?: string;
		size?: number;
		mtimeMs?: number;
		isBinary?: boolean;
		error?: string;
	}>;
	saveFileContent: (
		filePath: string,
		content: string,
		expectedMtimeMs?: number,
	) => Promise<{
		success: boolean;
		mtimeMs?: number;
		conflict?: boolean;
		error?: string;
	}>;
	listDirectory: (dirPath: string) => Promise<{
		success: boolean;
		entries?: Array<{
			name: string;
			path: string;
			type: "file" | "directory";
			size?: number;
			mtimeMs?: number;
		}>;
		error?: string;
	}>;
	createFile: (
		filePath: string,
		content?: string,
	) => Promise<{ success: boolean; error?: string }>;
	createDirectory: (
		dirPath: string,
	) => Promise<{ success: boolean; error?: string }>;
	renamePath: (
		oldPath: string,
		newPath: string,
	) => Promise<{ success: boolean; error?: string }>;
	deletePath: (
		targetPath: string,
	) => Promise<{ success: boolean; error?: string }>;
	statPath: (targetPath: string) => Promise<{
		success: boolean;
		type?: "file" | "directory";
		size?: number;
		mtimeMs?: number;
		/** 实际 stat 的绝对路径(`~` 已由主进程展开)。 */
		path?: string;
		error?: string;
	}>;
	revealPath: (
		targetPath: string,
	) => Promise<{ success: boolean; error?: string }>;
	watchWorkspace: (
		root: string,
	) => Promise<{ success: boolean; error?: string }>;
	unwatchWorkspace: (root: string) => Promise<{ success: boolean }>;
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
	emitCommand: (
		sessionId: string,
		command: SessionCommand,
	) => Promise<{ success: boolean; error?: string; result?: unknown }>;

	// Terminal (real PTY; wire contracts in packages/shared/ipc/terminal.ts)
	createTerminal: (request: {
		cwd?: string;
		shell?: string;
		cols?: number;
		rows?: number;
		sessionId?: string;
	}) => Promise<{ success: boolean; terminal?: TerminalInfo; error?: string }>;
	listTerminals: () => Promise<{
		success: boolean;
		terminals: TerminalInfo[];
		error?: string;
	}>;
	writeTerminal: (
		terminalId: string,
		data: string,
	) => Promise<{ success: boolean; error?: string }>;
	resizeTerminal: (
		terminalId: string,
		cols: number,
		rows: number,
	) => Promise<{ success: boolean; error?: string }>;
	killTerminal: (
		terminalId: string,
	) => Promise<{ success: boolean; error?: string }>;
	attachTerminal: (terminalId: string) => Promise<TerminalAttachResult>;
	/** One-way flow-control ack (no response). bytes = JS string length units. */
	ackTerminal: (terminalId: string, bytes: number, generation: number) => void;
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
	notify: {
		show: (
			request: ShowNotificationRequest,
		) => Promise<{ success: boolean; error?: string }>;
		setBadge: (
			hasUnread: boolean,
		) => Promise<{ success: boolean; error?: string }>;
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

	// Skill execution
	executeSkill: (
		skillId: string,
		options: { sessionId: string; input: string },
	) => Promise<{
		success: boolean;
		result?: { output: string };
		error?: string;
	}>;

	// Plugin management
	getPlugins: () => Promise<{
		success: boolean;
		plugins?: Array<{
			id: string;
			name: string;
			version: string;
			description: string;
			author: string;
			loaded: boolean;
			enabled: boolean;
			commands: string[];
			error: string;
			dirPath: string;
		}>;
		error?: string;
	}>;
	enablePlugin: (
		pluginId: string,
	) => Promise<{ success: boolean; error?: string }>;
	disablePlugin: (
		pluginId: string,
	) => Promise<{ success: boolean; error?: string }>;
	refreshPlugins: () => Promise<{ success: boolean; error?: string }>;
	getPluginCommands: () => Promise<GetPluginCommandsResponse>;
	executePluginCommand: (
		commandName: string,
		args: string,
		sessionId: string,
	) => Promise<ExecutePluginCommandResponse>;

	listSchedulerTasks: () => Promise<SchedulerListResponse>;
	getSchedulerTask: (
		request: SchedulerGetRequest,
	) => Promise<SchedulerGetResponse>;
	runSchedulerTaskNow: (
		request: SchedulerRunNowRequest,
	) => Promise<SchedulerRunNowResponse>;
	setSchedulerTaskEnabled: (
		request: SchedulerSetEnabledRequest,
	) => Promise<SchedulerSetEnabledResponse>;
	createSchedulerTask: (
		request: SchedulerCreateTaskRequest,
	) => Promise<SchedulerWriteTaskResponse>;
	updateSchedulerTask: (
		request: SchedulerUpdateTaskRequest,
	) => Promise<SchedulerWriteTaskResponse>;
	deleteSchedulerTask: (
		request: SchedulerDeleteTaskRequest,
	) => Promise<SchedulerDeleteTaskResponse>;
	listSchedulerRuns: (
		request: SchedulerListRunsRequest,
	) => Promise<SchedulerListRunsResponse>;
	getSchedulerRun: (
		request: SchedulerGetRunRequest,
	) => Promise<SchedulerGetRunResponse>;

	// App State
	// `openTabs`/`activeTabIndex` are the legacy (v1) flat tab list, read-only
	// for migration; `workspace` is the v2 whole-tree format written by the
	// workspace store.
	getAppState: () => Promise<{
		currentSessionId: string;
		currentWorkspaceId: string | null;
		openTabs?: Array<{
			type: string;
			sessionId?: string;
			filePath?: string;
			initialFilePath?: string;
			activeFilePath?: string;
			workspaceRoot?: string;
			title?: string;
		}>;
		activeTabIndex?: number;
		workspace?: import("@/stores/workspace-persistence").PersistedWorkspace;
		sidebarCollapsed?: boolean;
		sessionReadMarks?: import("@/stores/session-read-marks").PersistedSessionReadMarks;
	}>;
	saveUIState: (uiState: {
		workspace?: import("@/stores/workspace-persistence").PersistedWorkspace;
		sidebarCollapsed?: boolean;
		sessionReadMarks?: import("@/stores/session-read-marks").PersistedSessionReadMarks;
	}) => Promise<{ success: boolean }>;

	// Search Everywhere
	toggleSearchWindow: (
		options?: SearchWindowOpenOptions,
	) => Promise<{ success: boolean }>;
	closeSearchWindow: () => Promise<{ success: boolean }>;
	setSearchWindowAnchor: (
		anchor: SearchWindowAnchor | null,
	) => Promise<{ success: boolean }>;
	onSearchWindowShown: (
		callback: (payload?: SearchWindowShownPayload | null) => void,
	) => () => void;
	onSearchWindowGuides: (
		callback: (state: SearchWindowGuideState) => void,
	) => () => void;
	searchQuery: (req: SearchRequest) => Promise<SearchResponse>;
	searchExecuteAction: (actionId: string) => Promise<{ success: boolean }>;
	onSearchAction: (callback: (actionId: string) => void) => () => void;

	// Todo / Plan:数据面走通用 RPC(todoPlanRouter),下面只剩窗口面。
	openTodoPlanWindow: (
		request?: TodoPlanWindowActionRequest,
	) => Promise<{ success: boolean }>;
	hideTodoPlanWindow: (
		request?: TodoPlanWindowActionRequest,
	) => Promise<{ success: boolean }>;
	toggleTodoPlanWindow: (
		request?: TodoPlanWindowActionRequest,
	) => Promise<{ success: boolean }>;
	setTodoPlanWindowPinned: (
		pinned: boolean,
	) => Promise<{ success: boolean; pinned: boolean }>;
	// 独立窗自绘红绿灯(黄 / 绿)与手动拖窗。红点复用 hideTodoPlanWindow。
	minimizeTodoPlanWindow: () => Promise<{ success: boolean }>;
	zoomTodoPlanWindow: () => Promise<{ success: boolean }>;
	dragTodoPlanWindow: (
		request: TodoPlanWindowDragRequest,
	) => Promise<{ success: boolean }>;
	onTodoPlanChanged: (
		callback: (data: TodoPlanChangedPayload) => void,
	) => () => void;

	// Scratchpad (per-session draft paper)
	getScratchpad: (
		request: ScratchpadGetRequest,
	) => Promise<ScratchpadGetResponse>;
	updateScratchpad: (
		request: ScratchpadUpdateRequest,
	) => Promise<ScratchpadUpdateResponse>;
	deleteScratchpad: (
		request: ScratchpadDeleteRequest,
	) => Promise<ScratchpadDeleteResponse>;
	adoptScratchpad: (
		request: ScratchpadAdoptRequest,
	) => Promise<ScratchpadAdoptResponse>;
	onScratchpadChanged: (
		callback: (data: ScratchpadChangedPayload) => void,
	) => () => void;
}

declare global {
	interface Window {
		electronAPI: ElectronAPI;
	}
}
