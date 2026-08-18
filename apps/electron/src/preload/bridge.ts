import {
	clipboard,
	contextBridge,
	ipcRenderer,
	nativeImage,
	webUtils,
} from "electron";
import type { IpcRendererEvent } from "electron";
import { IPC_CHANNELS } from "@shared/ipc.js";
import type {
	SessionCommand,
	SessionEventEnvelope,
	StreamChunk,
} from "@shared/events/index.js";
import type {
	DeepLinkConfirmRequest,
	DeepLinkRespondRequest,
} from "@shared/ipc/deeplink.js";
import type {
	CreateSessionOptions,
	CollabBoardAction,
	CollabRoomBudgetsPatch,
	CollabRoomUpdatePatch,
	GetSessionMessagesPageRequest,
	MediaIngestFilesRequest,
	MediaQuery,
	MediaSaveAsRequest,
	MediaSource,
	MediaUsageTag,
	MarkdownResolveAssetRequest,
	MarkdownSaveAttachmentsRequest,
	SchedulerCreateTaskRequest,
	SchedulerDeleteTaskRequest,
	SchedulerGetRunRequest,
	SchedulerListRunsRequest,
	SchedulerUpdateTaskRequest,
	SearchRequest,
	SearchWindowAnchor,
	SpacesChangedEvent,
	SpacesCreateRequest,
	SpacesClearCredentialRequest,
	SpacesSetCredentialPoolRequest,
	SpacesSetCredentialRequest,
	SpacesSetOverlayRequest,
	SpacesSetProviderSettingsRequest,
	SpacesUpdateRequest,
	SearchWindowGuideState,
	SearchWindowOpenOptions,
	SearchWindowShownPayload,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	PracticeConfigResponse,
	PracticeEventPayload,
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
	PermissionMode,
	InteractionRespondRequest,
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
	GetPluginMarketRequest,
	GetPluginMarketResponse,
	InstallPluginRequest,
	InstallPluginResponse,
	UpdatePluginResponse,
	CheckPluginUpdatesResponse,
	PluginLifecycleInfoResponse,
	ReadPluginTarballResponse,
	PluginFootprintResponse,
	RpcRequest,
	RpcResponse,
	AppSettings,
	SaveSettingsRequest,
	ProxySettings,
	ChatMessageMention,
	Step,
	BrowserTabsChangedEvent,
	GatewayStartRequest,
	GatewayWechatAddAccountRequest,
	GatewayWechatLogoutRequest,
	GatewayWechatRemoveAccountRequest,
	GatewayWechatRenameAccountRequest,
	GatewayWechatStopAccountRequest,
	VoiceAudioChunkPayload,
	VoiceEvent,
	VoiceRuntimeCommand,
	VoiceRuntimeEvent,
	VoiceStartRequest,
	VoiceStopRequest,
	VoiceSubmitTranscriptRequest,
	VoiceSubmitUtteranceRequest,
	VoiceSynthesizeRequest,
	VoiceTestASRRequest,
	VoiceTestTTSRequest,
	MusicCommandRequest,
	MusicDjSpeak,
	MusicEvent,
	MusicLyrics,
	MusicNowPlaying,
	MusicOpenRadioRequest,
	MusicProgrammeActionRequest,
	MusicRequestSongRequest,
	MusicSearchRequest,
	MusicSetProviderRequest,
	MusicSetupRequest,
	MCPServerConfig,
	ACPAgentConfig,
	TodoPlanChangedPayload,
	ScratchpadAdoptRequest,
	ScratchpadChangedPayload,
	ScratchpadDeleteRequest,
	ScratchpadGetRequest,
	ScratchpadUpdateRequest,
	EvalsDiagnoseProgressEvent,
	EvalsReplayProgressEvent,
	EvalsRunProgressEvent,
	OAuthCredentialTargetRequest,
} from "@shared/ipc.js";

/**
 * Second line of defense for W14a mentions (W7 血教训: a Vue reactive proxy
 * cannot survive structured clone and takes the whole component tree down with
 * it). The renderer already rebuilds them as literals when it constructs the
 * command; this rebuilds them again AT the boundary, because a caller has no
 * reliable way to know it is holding a proxy. Only the mentions array is
 * touched — everything else on the command travels exactly as before.
 *
 * 拍平必须搬走 `ChatMessageMention` 声明的**每一个**字段:少搬一个,这条通道就
 * 成了一个按传输方式分叉的静默丢字段点(web 走 HTTP 原样透传,桌面不)。字段形状
 * 与 runtime 的 `mergeCollabMentions` 保持同一套写法。
 */
function withPlainCommandMentions(command: SessionCommand): SessionCommand {
	const mentions = (command as { mentions?: unknown })?.mentions;
	if (!Array.isArray(mentions)) return command;
	return {
		...command,
		mentions: (mentions as Partial<ChatMessageMention>[]).map((mention) => ({
			agentId: String(mention?.agentId ?? ""),
			label: String(mention?.label ?? ""),
			// `kind` 缺省是 `'agent'`,那一条**不写这个键** —— 老转录里它本来就不
			// 存在,拍平不该给整仓凭空长出一批 `kind:'agent'`。用户那一条的
			// `agentId` 是空串(collab-handle-codec.md §2.3),身份全在 kind/句柄上:
			// 白名单掉它们,等于让 `@用户` 只在桌面这条通道上悄悄失效。
			...(mention?.kind === "user"
				? {
						kind: "user" as const,
						...(mention?.userHandle
							? { userHandle: String(mention.userHandle) }
							: {}),
					}
				: {}),
		})),
	} as SessionCommand;
}

const electronAPI = {
	/**
	 * 通用 RPC 出口(主线 T0)。所有 router 域共用这一条 —— 加域不再往本文件加暴露块。
	 * 不解包 `RpcResponse`:失败在渲染层的 `createRouterClient` 统一转成 throw,
	 * 桌面与 web 两侧的失败形状因此完全一致。
	 */
	rpcInvoke: (request: RpcRequest): Promise<RpcResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.RPC_INVOKE, request),

	onSkillActivated: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			skillName: string;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.SKILL_ACTIVATED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SKILL_ACTIVATED, listener);
	},

	onStepAdded: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			step: Step;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.STEP_ADDED, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.STEP_ADDED, listener);
	},

	onStepUpdated: (
		callback: (data: {
			sessionId: string;
			messageId: string;
			stepId: string;
			updates: Partial<Step>;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.STEP_UPDATED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.STEP_UPDATED, listener);
	},

	onImageGenerated: (
		callback: (data: {
			id: string;
			url: string;
			prompt: string;
			revisedPrompt?: string;
			model: string;
			sessionId: string;
			messageId: string;
			createdAt: number;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.IMAGE_GENERATED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.IMAGE_GENERATED, listener);
	},

	// ── Unified event-driven channels (Phase 4) ──────
	onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) => {
		const listener = (_event: IpcRendererEvent, envelope: SessionEventEnvelope) =>
			callback(envelope);
		ipcRenderer.on(IPC_CHANNELS.SESSION_EVENT, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SESSION_EVENT, listener);
	},

	onSessionStream: (
		// `messageId` 不在 StreamChunk 的契约里 —— 它是 SessionStreamCoalescer 在
		// 出口盖上去的,老的重放数据没有,所以是可选的。
		callback: (data: {
			sessionId: string;
			chunk: StreamChunk & { messageId?: string };
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.SESSION_STREAM, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SESSION_STREAM, listener);
	},

	emitCommand: (sessionId: string, command: SessionCommand) =>
		// 给main线程发送消息
		ipcRenderer.invoke(IPC_CHANNELS.SESSION_COMMAND, {
			sessionId,
			command: withPlainCommandMentions(command),
		}),

	// ── Terminal (real PTY) ──────
	createTerminal: (request: {
		cwd?: string;
		shell?: string;
		cols?: number;
		rows?: number;
		sessionId?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, request ?? {}),
	listTerminals: () => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_LIST),
	writeTerminal: (terminalId: string, data: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, { terminalId, data }),
	resizeTerminal: (terminalId: string, cols: number, rows: number) =>
		ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, { terminalId, cols, rows }),
	killTerminal: (terminalId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_KILL, { terminalId }),
	attachTerminal: (terminalId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_ATTACH, { terminalId }),
	// One-way send, not invoke: pure notification at flush cadence — a lost
	// ack only delays resume, and the attach generation resets the ledger.
	ackTerminal: (terminalId: string, bytes: number, generation: number) => {
		ipcRenderer.send(IPC_CHANNELS.TERMINAL_ACK, { terminalId, bytes, generation });
	},
	onTerminalData: (
		callback: (data: { terminalId: string; seq: number; data: string }) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.TERMINAL_DATA, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_DATA, listener);
	},
	onTerminalExit: (
		callback: (data: { terminalId: string; exitCode: number | null }) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.TERMINAL_EXIT, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_EXIT, listener);
	},

	// ── 系统通知 + dock 徽标(agent-dm-user.md §4.2)──────
	// 一个命名空间而不是三个平铺方法:这三件事只有一个调用方(主窗的通知链路),
	// 而 `notify.show` 在调用点读起来就是它在做的事。
	notify: {
		show: (request: { title: string; body: string; sessionId: string }) =>
			ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_SHOW, request),
		setBadge: (hasUnread: boolean) =>
			ipcRenderer.invoke(IPC_CHANNELS.NOTIFY_BADGE, { hasUnread }),
		onActivate: (callback: (data: { sessionId: string }) => void) => {
			const listener = (
				_event: IpcRendererEvent,
				data: Parameters<typeof callback>[0],
			) => callback(data);
			ipcRenderer.on(IPC_CHANNELS.NOTIFY_ACTIVATE, listener);
			return () =>
				ipcRenderer.removeListener(IPC_CHANNELS.NOTIFY_ACTIVATE, listener);
		},
	},

	// ── Browser (embedded WebContentsView) ──────
	hydrateBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HYDRATE),
	createBrowserTab: (request?: { url?: string; background?: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CREATE_TAB, request ?? {}),
	closeBrowserTab: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_CLOSE_TAB, { tabId }),
	selectBrowserTab: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SELECT_TAB, { tabId }),
	navigateBrowser: (tabId: string, url: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_NAVIGATE, { tabId, url }),
	browserGoBack: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_BACK, { tabId }),
	browserGoForward: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GO_FORWARD, { tabId }),
	reloadBrowser: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_RELOAD, { tabId }),
	stopBrowser: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_STOP, { tabId }),
	setBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_BOUNDS, { bounds }),
	setBrowserVisible: (visible: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_VISIBLE, { visible }),
	pickBrowserElement: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PICK_ELEMENT, { tabId }),
	cancelBrowserPick: (tabId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_PICK_CANCEL, { tabId }),
	getBrowserSearchEngine: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_GET_SEARCH_ENGINE),

	// Collab (multi-agent rooms)
	getCollabBoard: (roomSessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_BOARD_GET, { roomSessionId }),
	actCollabBoard: (roomSessionId: string, action: CollabBoardAction) =>
		// Snapshotted at the boundary rather than forwarded as-is: a Vue reactive
		// proxy cannot survive structured clone and takes the whole component tree
		// down with it (W7 血教训, same reason the reaction actor below is rebuilt).
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_BOARD_ACT, {
			roomSessionId,
			action: JSON.parse(JSON.stringify(action)) as CollabBoardAction,
		}),
	stopCollabTask: (roomSessionId: string, taskId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_TASK_STOP, { roomSessionId, taskId }),
	setCollabRoomFrozen: (roomSessionId: string, frozen: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_SET_FROZEN, { roomSessionId, frozen }),
	setCollabRoomBudgets: (roomSessionId: string, budgets: CollabRoomBudgetsPatch) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_SET_BUDGETS, { roomSessionId, ...budgets }),
	getCollabRoomSpend: (roomSessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_SPEND_GET, { roomSessionId }),
		// 人级停止(E5)。三个字段都是**地址**:哪间房、哪张牌、界面看见它时是第几代。
		revokeCollabRoomLease: (roomSessionId: string, leaseId: string, expectedEpoch: number) =>
			ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_REVOKE_LEASE, {
				roomSessionId,
				leaseId,
				expectedEpoch,
			}),
	getCollabCoordinator: (roomSessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_COORDINATOR_GET, { roomSessionId }),
	// Agent 活动快照的冷启动补水(D8 §3.1)。不带 agentIds = 此刻开着心智循环的
	// 全部同事;带上则逐个都有回答(没在跑的回一份空闲快照,不是被跳过)。
	// 数组在边界上重建成裸字符串:Vue 的响应式代理过不了 structured clone,
	// 而调用方没有可靠办法知道自己手里正握着一个(W7 血教训)。
	getCollabAgentActivity: (agentIds?: string[]) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.COLLAB_AGENT_ACTIVITY_GET,
			agentIds ? { agentIds: agentIds.map((id) => String(id)) } : {},
		),
	// 调度时间轴尾读(D8 §3.3)。只读:账由记账的那几个 actor 单点写,渲染层
	// 连一个写口都不该看得见。`types` 原样递过去(整体透传)。
	getCollabSchedulerLog: (
		roomSessionId: string,
		options?: { limit?: number; types?: string[] },
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_SCHEDULER_LOG_TAIL, {
			roomSessionId,
			...(typeof options?.limit === 'number' ? { limit: options.limit } : {}),
			...(options?.types?.length ? { types: options.types.map((type) => String(type)) } : {}),
		}),
	updateCollabRoom: (roomSessionId: string, update: CollabRoomUpdatePatch) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_UPDATE, { roomSessionId, ...update }),
	// 清空聊天记录(危险区):房间转录 + 每位成员的执行会话与已读游标 + 看板一起归零;
	// includeMemberDms 连带成员两两之间的私聊房(跨群共享,须显式勾选)。
	clearCollabRoomHistory: (roomSessionId: string, includeMemberDms?: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_CLEAR_HISTORY, {
			roomSessionId,
			...(includeMemberDms ? { includeMemberDms: true } : {}),
		}),
	// 群 folder 的只读列目录(agent-im-chat-ui.md §3.2「文件」块)。
	listCollabRoomFolder: (roomSessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_ROOM_FOLDER_LIST, { roomSessionId }),
	// 托管私聊房(agent-im-dm.md D1):幂等 get-or-create,联系人点开即调。
	ensureCollabDmRoom: (agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_DM_ROOM_ENSURE, { agentId: String(agentId) }),
	reactToCollabMessage: (
		roomSessionId: string,
		messageId: string,
		emoji: string,
		actor: { type: "user" | "agent"; agentId?: string },
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.COLLAB_MESSAGE_REACT, {
			roomSessionId,
			messageId,
			emoji,
			// Rebuilt from primitives AT the boundary: a Vue reactive proxy cannot
			// survive structured clone and takes the component tree down with it,
			// and a caller has no reliable way to know it is holding one (W7 血教训).
			actor: {
				type: String(actor?.type) as "user" | "agent",
				...(actor?.agentId ? { agentId: String(actor.agentId) } : {}),
			},
		}),
	setBrowserSearchEngine: (engineId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SET_SEARCH_ENGINE, { engineId }),
	listBrowserProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_LIST_PROFILES),
	addBrowserProfile: (name: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_ADD_PROFILE, { name }),
	removeBrowserProfile: (profileId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_REMOVE_PROFILE, { profileId }),
	switchBrowserProfile: (profileId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SWITCH_PROFILE, { profileId }),
	onBrowserTabsChanged: (callback: (event: BrowserTabsChangedEvent) => void) => {
		const listener = (_event: IpcRendererEvent, data: BrowserTabsChangedEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.BROWSER_TABS_CHANGED, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TABS_CHANGED, listener);
	},

	// ── Streaming methods ───────────────────────────
	abortStream: (sessionId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ABORT_STREAM, { sessionId }),

	getActiveStreams: () => ipcRenderer.invoke(IPC_CHANNELS.GET_ACTIVE_STREAMS),

	getChatHistory: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_CHAT_HISTORY, { sessionId }),

	generateTitle: (message: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GENERATE_TITLE, { message }),

	getSystemPromptSnapshot: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SYSTEM_PROMPT_SNAPSHOT, { sessionId }),

	resumeAfterToolConfirm: (sessionId: string, messageId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.RESUME_AFTER_TOOL_CONFIRM, {
			sessionId,
			messageId,
		}),

	// Session methods
	getSessions: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SESSIONS),

	createSession: (
		name: string,
		options?: CreateSessionOptions,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.CREATE_SESSION, {
			name,
			sessionId: options?.sessionId,
			workspaceId: options?.workspaceId,
			kind: options?.kind,
			room: options?.room,
		}),

	switchSession: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SWITCH_SESSION, { sessionId }),

	getSession: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION, { sessionId }),

	deleteSession: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.DELETE_SESSION, { sessionId }),

	renameSession: (sessionId: string, newName: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.RENAME_SESSION, { sessionId, newName }),

	createBranch: (parentSessionId: string, branchFromMessageId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.CREATE_BRANCH, {
			parentSessionId,
			branchFromMessageId,
		}),

	updateSessionPin: (sessionId: string, isPinned: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_PIN, {
			sessionId,
			isPinned,
		}),

	updateSessionModel: (sessionId: string, provider: string, model: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_MODEL, {
			sessionId,
			provider,
			model,
		}),

	updateSessionAgent: (sessionId: string, agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_AGENT, {
			sessionId,
			agentId,
		}),

	updateSessionPermissionMode: (sessionId: string, permissionMode: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_PERMISSION_MODE, {
			sessionId,
			permissionMode,
		}),

	updateSessionArchived: (
		sessionId: string,
		isArchived: boolean,
		archivedAt?: number | null,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_ARCHIVED, {
			sessionId,
			isArchived,
			archivedAt,
		}),

	updateSessionWorkingDirectory: (
		sessionId: string,
		workingDirectory: string | null,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SESSION_WORKING_DIRECTORY, {
			sessionId,
			workingDirectory,
		}),

	// ── Variables subsystem ─────────────────────────────────────
	// Live updates arrive through the existing session:variables-updated
	// event; these RPCs are for explicit fetches and writes.
	listVariables: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.VARIABLES_LIST, { sessionId }),

	setVariable: (
		sessionId: string,
		name: string,
		value: string,
		description?: string,
		scope?: "global" | "session" | "agent" | "project",
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.VARIABLES_SET, {
			sessionId,
			name,
			value,
			description,
			scope,
		}),

	deleteVariable: (sessionId: string, name: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.VARIABLES_DELETE, { sessionId, name }),

	// ── Session goals:三条 RPC 已走通用通道(goalRouter),本文件不再暴露。
	// 实时变化仍从 session:goal-updated 事件来。──────────────────

	// ── Practice (kegel / pomodoro / exercise log) ──────────────
	practiceStart: (request: PracticeStartRequest): Promise<PracticeStateResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_START, request),

	practicePause: (): Promise<PracticeStateResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_PAUSE),

	practiceResume: (): Promise<PracticeStateResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_RESUME),

	practiceStop: (request?: PracticeStopRequest): Promise<PracticeStateResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_STOP, request),

	practiceGetState: (): Promise<PracticeStateResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_GET_STATE),

	practiceLog: (request: PracticeLogRequest): Promise<PracticeLogResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_LOG, request),

	practiceSummary: (request: PracticeSummaryRequest): Promise<PracticeSummaryResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_SUMMARY, request),

	practiceRecent: (request: PracticeRecentRequest): Promise<PracticeRecentResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_RECENT, request),

	practiceGetConfig: (): Promise<PracticeConfigResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_GET_CONFIG),

	practiceSetConfig: (request: PracticeSetConfigRequest): Promise<PracticeConfigResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PRACTICE_SET_CONFIG, request),

	onPracticeEvent: (callback: (payload: PracticeEventPayload) => void) => {
		const listener = (_event: IpcRendererEvent, payload: PracticeEventPayload) => callback(payload);
		ipcRenderer.on(IPC_CHANNELS.PRACTICE_EVENT, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.PRACTICE_EVENT, listener);
	},

	// 统一请求通道(R2)。requestId 缺省由 core 生成并随结果回传;abort 与
	// progress 都按它寻址。形状走 @shared/ipc 的共享契约,不在这里手写。
	pluginRequest: (request: PluginRequestPayload): Promise<PluginRequestResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_REQUEST, request),

	abortPluginRequest: (requestId: string): Promise<AbortPluginRequestResult> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_REQUEST_ABORT, { requestId }),

	onPluginRequestProgress: (
		callback: (payload: PluginRequestProgressPayload) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			payload: PluginRequestProgressPayload,
		) => callback(payload);
		ipcRenderer.on(IPC_CHANNELS.PLUGINS_REQUEST_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.PLUGINS_REQUEST_PROGRESS, listener);
	},

	// 插件自有配置(R3)。不碰插件代码 —— 未启用的插件也能读写。
	getPluginConfig: (pluginId: string): Promise<PluginConfigResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_CONFIG_GET, { pluginId }),

	setPluginConfig: (
		pluginId: string,
		config: Record<string, unknown>,
	): Promise<SetPluginConfigResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_CONFIG_SET, { pluginId, config }),

	// 真卸载(R4):停用 → 归档数据 → 删源目录 → 清设置键。仅用户插件。
	uninstallPlugin: (pluginId: string): Promise<UninstallPluginResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_UNINSTALL, { pluginId }),

	// npm 生命周期(P1):装/更/查更新 + 能力面(无 npm 置灰,裁决 8)。
	installPlugin: (request: InstallPluginRequest): Promise<InstallPluginResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_INSTALL, request),

	updatePlugin: (pluginId: string): Promise<UpdatePluginResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_UPDATE, { pluginId }),

	checkPluginUpdates: (): Promise<CheckPluginUpdatesResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_CHECK_UPDATES),

	getPluginLifecycleInfo: (): Promise<PluginLifecycleInfoResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_LIFECYCLE_INFO),

	// 装前清单预读(file: 开发通道):选中 tarball 即可安装,包名不必手抄。
	readPluginTarball: (path: string): Promise<ReadPluginTarballResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_READ_TARBALL, { path }),

	// 市场(P3):索引视图主进程 join 好;断网回缓存并 stale 置位。
	getPluginMarket: (request?: GetPluginMarketRequest): Promise<GetPluginMarketResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_MARKET, request ?? {}),

	// 落盘足迹:卸载确认框据此展示"将被归档的东西"。
	getPluginFootprint: (pluginId: string): Promise<PluginFootprintResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_FOOTPRINT, { pluginId }),

	// file-pick 节点的宿主托管导入(B 期,用户壁纸):递声明,回一个
	// `storage:` 地址 —— 用户选的路径与文件字节都不过 renderer 的手。
	pickPluginFile: (request: PickPluginFileRequest): Promise<PickPluginFileResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_PICK_FILE, request),

	onPluginNotification: (
		callback: (payload: PluginNotificationPayload) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			payload: PluginNotificationPayload,
		) => callback(payload);
		ipcRenderer.on(IPC_CHANNELS.PLUGINS_NOTIFICATION, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.PLUGINS_NOTIFICATION, listener);
	},

	// onething:// 深链的确认门(H4)。三条,方向刚好一进两出:
	// ready 是渲染层给冷启动队列的放行信号,request 是推来的卡,respond 是那一按。
	deepLinkReady: () => ipcRenderer.invoke(IPC_CHANNELS.DEEPLINK_READY),

	onDeepLinkRequest: (callback: (request: DeepLinkConfirmRequest) => void) => {
		const listener = (_event: IpcRendererEvent, request: DeepLinkConfirmRequest) =>
			callback(request);
		ipcRenderer.on(IPC_CHANNELS.DEEPLINK_REQUEST, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.DEEPLINK_REQUEST, listener);
	},

	respondDeepLink: (request: DeepLinkRespondRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.DEEPLINK_RESPOND, request),

	// Project directories — independent module.
	// `workspaceId` 缺省 = default 空间(批 B4:名册 per-space)。
	projectDirsList: (workspaceId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DIRS_LIST, { workspaceId }),

	projectDirsGet: (path: string, workspaceId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DIRS_GET, { path, workspaceId }),

	projectDirsAdd: (
		path: string,
		description?: string,
		paths?: string[],
		workspaceId?: string,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DIRS_ADD, {
			path,
			description,
			paths,
			workspaceId,
		}),

	projectDirsUpdate: (
		path: string,
		patch: { description?: string; paths?: string[] },
		workspaceId?: string,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DIRS_UPDATE, { path, ...patch, workspaceId }),

	projectDirsRemove: (path: string, workspaceId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DIRS_REMOVE, { path, workspaceId }),

	// Spaces (workspaces) — independent module
	spacesList: () => ipcRenderer.invoke(IPC_CHANNELS.SPACES_LIST),

	spacesCreate: (request: SpacesCreateRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_CREATE, request),

	spacesUpdate: (request: SpacesUpdateRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_UPDATE, request),

	spacesRemove: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_REMOVE, { id }),

	spacesGetOverlay: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_GET_OVERLAY, { id }),

	spacesSetOverlay: (request: SpacesSetOverlayRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_SET_OVERLAY, request),

	// 整套 provider 设置(C2)—— `workspaces/<id>/providers.json`。
	spacesGetProviderSettings: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_GET_PROVIDER_SETTINGS, { id }),

	spacesSetProviderSettings: (request: SpacesSetProviderSettingsRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_SET_PROVIDER_SETTINGS, request),

	spacesGetCredentials: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_GET_CREDENTIALS, { id }),

	spacesSetCredential: (request: SpacesSetCredentialRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_SET_CREDENTIAL, request),

	spacesSetCredentialPool: (request: SpacesSetCredentialPoolRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_SET_CREDENTIAL_POOL, request),
	spacesClearCredential: (request: SpacesClearCredentialRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_CLEAR_CREDENTIAL, request),

	spacesImportCredentials: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SPACES_IMPORT_CREDENTIALS, { id }),

	getSessionTokenUsage: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_TOKEN_USAGE, sessionId),

	onContextSizeUpdated: (
		callback: (data: { sessionId: string; contextSize: number }) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.CONTEXT_SIZE_UPDATED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.CONTEXT_SIZE_UPDATED, listener);
	},

	// P1(2026-08-14):onContextCompactStarted / onContextCompactCompleted 已删。
	// 它们订阅的是两条主进程从来没发过的通道;真正的通知走 session:event。

	updateSessionMaxTokens: (sessionId: string, maxTokens: number) =>
		ipcRenderer.invoke(
			IPC_CHANNELS.UPDATE_SESSION_MAX_TOKENS,
			sessionId,
			maxTokens,
		),

	// ============================================================================
	// Optimized Session Loading (Phase 4: Metadata Separation)
	// ============================================================================

	// Get sessions list (metadata only, no messages) - for fast startup
	getSessionsList: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SESSIONS_LIST),

	// Activate session (returns details, no messages) - for session switching
	activateSession: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACTIVATE_SESSION, { sessionId }),

	// Get session messages (on-demand loading) - only when messages need to be displayed
	getSessionMessages: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_MESSAGES, { sessionId }),

	// Get a cursor-addressed page of session messages
	getSessionMessagesPage: (request: GetSessionMessagesPageRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_MESSAGES_PAGE, request),

	// Get lightweight user-message markers for navigation
	getSessionUserMarkers: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_USER_MARKERS, { sessionId }),

	// Get the session's table-of-contents segments
	getSessionSegments: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_SEGMENTS, { sessionId }),

	// Listen for messages changed event (for real-time sync)
	onSessionMessagesChanged: (
		callback: (data: {
			sessionId: string;
			action: "added" | "updated" | "deleted";
			messageId?: string;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.SESSION_MESSAGES_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(
				IPC_CHANNELS.SESSION_MESSAGES_CHANGED,
				listener,
			);
	},

	// In-memory session LRU cache (main process): stats + eviction on tab close
	getSessionCacheStats: () =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_SESSION_CACHE_STATS),
	evictSessionCache: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVICT_SESSION_CACHE, { sessionId }),

	// System message methods (for /files command persistence)
	addSystemMessage: (
		sessionId: string,
		message: { id: string; role: string; content: string; timestamp: number },
	) => ipcRenderer.invoke("add-system-message", { sessionId, message }),

	removeFilesChangedMessage: (sessionId: string) =>
		ipcRenderer.invoke("remove-files-changed-message", { sessionId }),

	removeGitStatusMessage: (sessionId: string) =>
		ipcRenderer.invoke("remove-git-status-message", { sessionId }),

	// Generic remove message by ID (for close button functionality)
	removeMessage: (sessionId: string, messageId: string) =>
		ipcRenderer.invoke("remove-message", { sessionId, messageId }),

	// Settings methods
	getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS),

	saveSettings: (settings: SaveSettingsRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SAVE_SETTINGS, settings),

	openSettingsWindow: (options?: { tab?: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.OPEN_SETTINGS_WINDOW, options),

	onSettingsNavigate: (callback: (payload: { tab: string }) => void) => {
		const listener = (_event: IpcRendererEvent, payload: { tab: string }) => callback(payload);
		ipcRenderer.on(IPC_CHANNELS.SETTINGS_NAVIGATE, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_NAVIGATE, listener);
	},

	onSettingsChanged: (callback: (settings: AppSettings) => void) => {
		const listener = (_event: IpcRendererEvent, settings: AppSettings) =>
			callback(settings);
		ipcRenderer.on(IPC_CHANNELS.SETTINGS_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SETTINGS_CHANGED, listener);
	},

	/**
	 * 空间数据变更(批 B9-0)。设置窗写完 key / 登录完 OAuth,主窗那份
	 * `spaceProviders` 缓存要靠这一声才知道该重拉 —— 否则模型选择器一直藏着
	 * 那个 provider,直到切走再切回空间。
	 */
	onSpacesChanged: (callback: (event: SpacesChangedEvent) => void) => {
		const listener = (_event: IpcRendererEvent, payload: SpacesChangedEvent) =>
			callback(payload);
		ipcRenderer.on(IPC_CHANNELS.SPACES_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SPACES_CHANGED, listener);
	},

	// Gateway / IM channel methods
	gatewayGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_STATUS),

	gatewayStart: (request?: GatewayStartRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_START, request || {}),

	gatewayStop: () => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_STOP),

	gatewayWechatLogout: (request?: GatewayWechatLogoutRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_WECHAT_LOGOUT, request || {}),

	gatewayWechatAddAccount: (request?: GatewayWechatAddAccountRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_WECHAT_ADD_ACCOUNT, request || {}),

	gatewayWechatStopAccount: (request: GatewayWechatStopAccountRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_WECHAT_STOP_ACCOUNT, request),

	gatewayWechatRemoveAccount: (request: GatewayWechatRemoveAccountRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_WECHAT_REMOVE_ACCOUNT, request),

	gatewayWechatRenameAccount: (request: GatewayWechatRenameAccountRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_WECHAT_RENAME_ACCOUNT, request),

	// Voice methods
	voiceGetState: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_STATE),

	voiceStart: (request?: VoiceStartRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_START, request || {}),

	voiceStop: (request?: VoiceStopRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_STOP, request || {}),

	voiceSubmitUtterance: (request: VoiceSubmitUtteranceRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBMIT_UTTERANCE, request),

	voiceSubmitTranscript: (request: VoiceSubmitTranscriptRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_SUBMIT_TRANSCRIPT, request),

	voiceSynthesize: (request: VoiceSynthesizeRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_SYNTHESIZE, request),

	voiceTestASR: (request: VoiceTestASRRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_ASR, request),

	voiceTestTTS: (request: VoiceTestTTSRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_TTS, request),

	voiceGetTTSModels: (request?: { force?: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_TTS_MODELS, request || {}),

	onVoiceEvent: (callback: (event: VoiceEvent) => void) => {
		const listener = (_event: IpcRendererEvent, event: VoiceEvent) =>
			callback(event);
		ipcRenderer.on(IPC_CHANNELS.VOICE_EVENT, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_EVENT, listener);
	},

	voiceRuntimeReady: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_RUNTIME_READY),

	voiceRuntimeEvent: (event: VoiceRuntimeEvent) =>
		ipcRenderer.invoke(IPC_CHANNELS.VOICE_RUNTIME_EVENT, event),

	voiceAudioChunk: (payload: VoiceAudioChunkPayload) =>
		ipcRenderer.send(IPC_CHANNELS.VOICE_AUDIO_CHUNK, payload),

	onVoiceRuntimeCommand: (callback: (command: VoiceRuntimeCommand) => void) => {
		const listener = (_event: IpcRendererEvent, command: VoiceRuntimeCommand) =>
			callback(command);
		ipcRenderer.on(IPC_CHANNELS.VOICE_RUNTIME_COMMAND, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RUNTIME_COMMAND, listener);
	},

	// Music radio methods
	musicGetState: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_GET_STATE),

	musicSetup: (request: MusicSetupRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_SETUP, request),

	onMusicEvent: (callback: (event: MusicEvent) => void) => {
		const listener = (_event: IpcRendererEvent, event: MusicEvent) =>
			callback(event);
		ipcRenderer.on(IPC_CHANNELS.MUSIC_EVENT, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC_EVENT, listener);
	},

	musicCommand: (request: MusicCommandRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_COMMAND, request),

	musicGetNowPlaying: () =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_GET_NOW_PLAYING),

	musicGetRadio: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_GET_RADIO),

	musicOpenRadio: (request: MusicOpenRadioRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_OPEN_RADIO, request),

	musicSearch: (request: MusicSearchRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_SEARCH, request),

	musicRequestSong: (request: MusicRequestSongRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_REQUEST_SONG, request),

	musicGetProgramme: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_GET_PROGRAMME),

	musicProgrammeAction: (request: MusicProgrammeActionRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_PROGRAMME_ACTION, request),

	musicListProviders: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_LIST_PROVIDERS),

	musicSetProvider: (request: MusicSetProviderRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_SET_PROVIDER, request),

	musicGetLyrics: () => ipcRenderer.invoke(IPC_CHANNELS.MUSIC_GET_LYRICS),

	onMusicLyrics: (callback: (lyrics: MusicLyrics) => void) => {
		const listener = (_event: IpcRendererEvent, lyrics: MusicLyrics) =>
			callback(lyrics);
		ipcRenderer.on(IPC_CHANNELS.MUSIC_LYRICS, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC_LYRICS, listener);
	},

	// 主进程在没有播放器时广播 null(nudgeMusicClients),所以这一路是可空的。
	onMusicNowPlaying: (callback: (nowPlaying: MusicNowPlaying | null) => void) => {
		const listener = (
			_event: IpcRendererEvent,
			nowPlaying: MusicNowPlaying | null,
		) => callback(nowPlaying);
		ipcRenderer.on(IPC_CHANNELS.MUSIC_NOW_PLAYING, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.MUSIC_NOW_PLAYING, listener);
	},

	onMusicDjSpeak: (callback: (speak: MusicDjSpeak) => void) => {
		const listener = (_event: IpcRendererEvent, speak: MusicDjSpeak) =>
			callback(speak);
		ipcRenderer.on(IPC_CHANNELS.MUSIC_DJ_SPEAK, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC_DJ_SPEAK, listener);
	},

	musicDjSpeakDone: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MUSIC_DJ_SPEAK_DONE, { id }),

	getSystemTheme: () => ipcRenderer.invoke(IPC_CHANNELS.GET_SYSTEM_THEME),

	testProxy: (proxy: ProxySettings) =>
		ipcRenderer.invoke(IPC_CHANNELS.TEST_PROXY, {
			proxy: JSON.parse(JSON.stringify(proxy)),
		}),

	onSystemThemeChanged: (callback: (theme: "light" | "dark") => void) => {
		const listener = (_event: IpcRendererEvent, theme: "light" | "dark") => callback(theme);
		ipcRenderer.on(IPC_CHANNELS.SYSTEM_THEME_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_THEME_CHANGED, listener);
	},

	// Agent 档案 CRUD 已迁到通用 RPC 通道(agentsRouter),渲染侧客户端在
	// packages/renderer/platform/agents-client.ts —— 这里不再有它的出口。

	// Theme methods
	getThemes: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_GET_ALL),

	getTheme: (themeId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.THEME_GET, themeId),

	applyTheme: (themeId: string, mode: "dark" | "light") =>
		ipcRenderer.invoke(IPC_CHANNELS.THEME_APPLY, themeId, mode),

	refreshThemes: (projectPath?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.THEME_REFRESH, projectPath),

	openThemesFolder: () => ipcRenderer.invoke(IPC_CHANNELS.THEME_OPEN_FOLDER),

	// Model registry 与 Providers 已迁到通用 RPC 通道(modelsRouter /
	// providersRouter);渲染侧客户端在 platform/{models,providers}-client.ts。

	// Tools methods
	getTools: () => ipcRenderer.invoke(IPC_CHANNELS.GET_TOOLS),

	executeTool: (
		toolId: string,
		args: Record<string, unknown>,
		messageId: string,
		sessionId: string,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.EXECUTE_TOOL, {
			toolId,
			arguments: args,
			messageId,
			sessionId,
		}),

	cancelTool: (toolCallId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.CANCEL_TOOL, { toolCallId }),

	listBackgroundJobs: (options?: { includeInactive?: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_JOBS_LIST, options || {}),

	stopBackgroundJob: (jobId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.BACKGROUND_JOBS_STOP, { jobId }),

	updateToolCall: (
		sessionId: string,
		messageId: string,
		toolCallId: string,
		updates: Record<string, unknown>,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_TOOL_CALL, {
			sessionId,
			messageId,
			toolCallId,
			updates,
		}),

	// MCP methods
	mcpGetServers: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVERS),

	mcpAddServer: (config: MCPServerConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, { config }),

	mcpUpdateServer: (config: MCPServerConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, { config }),

	mcpRemoveServer: (serverId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, { serverId }),

	mcpConnectServer: (serverId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT_SERVER, { serverId }),

	mcpDisconnectServer: (serverId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT_SERVER, { serverId }),

	mcpLogoutServer: (serverId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_LOGOUT_SERVER, { serverId }),

	mcpProbeServer: (config: MCPServerConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_PROBE_SERVER, { config }),

	mcpRefreshServer: (serverId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_REFRESH_SERVER, { serverId }),

	mcpGetTools: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_TOOLS),

	mcpCallTool: (
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_CALL_TOOL, {
			serverId,
			toolName,
			arguments: args,
		}),

	mcpGetResources: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_RESOURCES),

	mcpReadResource: (serverId: string, uri: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_READ_RESOURCE, { serverId, uri }),

	mcpGetPrompts: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_PROMPTS),

	mcpGetPrompt: (
		serverId: string,
		name: string,
		args?: Record<string, string>,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_PROMPT, {
			serverId,
			name,
			arguments: args,
		}),

	mcpReadConfigFile: (filePath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.MCP_READ_CONFIG_FILE, { filePath }),

	// ACP methods
	acpGetAgents: () => ipcRenderer.invoke(IPC_CHANNELS.ACP_GET_AGENTS),

	acpAddAgent: (config: ACPAgentConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_ADD_AGENT, { config }),

	acpUpdateAgent: (config: ACPAgentConfig) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_UPDATE_AGENT, { config }),

	acpRemoveAgent: (agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_REMOVE_AGENT, { agentId }),

	acpConnectAgent: (agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_CONNECT_AGENT, { agentId }),

	acpDisconnectAgent: (agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_DISCONNECT_AGENT, { agentId }),

	acpRefreshAgent: (agentId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_REFRESH_AGENT, { agentId }),

	acpCancelSession: (sessionId: string, agentId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.ACP_CANCEL_SESSION, { sessionId, agentId }),

	// Skills methods (Official Claude Code Skills)
	getSkills: (workingDirectory?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_GET_ALL, { workingDirectory }),

	refreshSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REFRESH),

	readSkillFile: (skillId: string, fileName: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_READ_FILE, { skillId, fileName }),

	openSkillDirectory: (skillId?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_OPEN_DIRECTORY, { skillId }),

	createSkill: (
		name: string,
		description: string,
		instructions: string,
		source: "user" | "project",
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_CREATE, {
			name,
			description,
			instructions,
			source,
		}),

	deleteSkill: (skillId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_DELETE, { skillId }),

	toggleSkillEnabled: (skillId: string, enabled: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_TOGGLE_ENABLED, {
			skillId,
			enabled,
		}),

	listSkillDirectories: () =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_LIST_DIRECTORIES),

	addSkillDirectory: (request: {
		path: string;
		label?: string;
		agentId?: string | null;
	}) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_ADD_DIRECTORY, request),

	updateSkillDirectory: (request: {
		id: string;
		enabled?: boolean;
		label?: string;
		agentId?: string | null;
	}) => ipcRenderer.invoke(IPC_CHANNELS.SKILLS_UPDATE_DIRECTORY, request),

	removeSkillDirectory: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_REMOVE_DIRECTORY, { id }),

	setSkillAgent: (skillId: string, agentId: string | null) =>
		ipcRenderer.invoke(IPC_CHANNELS.SKILLS_SET_AGENT, { skillId, agentId }),

	// Message update methods
	updateMessageThinkingTime: (
		sessionId: string,
		messageId: string,
		thinkingTime: number,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.UPDATE_MESSAGE_THINKING_TIME, {
			sessionId,
			messageId,
			thinkingTime,
		}),

	// Dialog methods
	showOpenDialog: (options: {
		properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
		title?: string;
		defaultPath?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.SHOW_OPEN_DIALOG, options),

	// Shell methods
	openPath: (filePath: string) =>
		ipcRenderer.invoke("shell:open-path", filePath),

	openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),

	getDataPath: () => ipcRenderer.invoke("app:get-data-path"),

	// Window methods
	setWindowButtonVisibility: (visible: boolean) =>
		ipcRenderer.invoke("window:set-button-visibility", visible),

	// File methods
	// Resolves the on-disk path of a dropped/picked File so attachments can
	// carry it to the model (pasted files have no path and yield "").
	getPathForFile: (file: File) => {
		try {
			return webUtils.getPathForFile(file);
		} catch {
			return "";
		}
	},

	// Clipboard methods
	writeClipboardText: (text: string) => {
		try {
			clipboard.writeText(String(text ?? ""));
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	/**
	 * Put an image on the clipboard. Deliberately NOT an IPC channel: it is the
	 * exact sibling of `writeClipboardText` above, and `nativeImage` is available
	 * in this process — a round trip to main would buy nothing but a channel to
	 * maintain. `createFromPath` does the disk read itself, so preload never
	 * touches `fs`.
	 */
	writeClipboardImage: (filePath: string) => {
		try {
			const image = nativeImage.createFromPath(String(filePath ?? ""));
			if (image.isEmpty()) {
				return { success: false, error: "Not a readable image file." };
			}
			clipboard.writeImage(image);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	// Media methods
	saveImage: (data: {
		url?: string;
		base64?: string;
		prompt: string;
		revisedPrompt?: string;
		model: string;
		sessionId: string;
		messageId: string;
		source?: MediaSource;
		usageTags?: MediaUsageTag[];
	}) => ipcRenderer.invoke("media:save-image", data),

	loadAllMedia: () => ipcRenderer.invoke("media:load-all"),

	deleteMedia: (id: string) => ipcRenderer.invoke("media:delete", id),

	clearAllMedia: () => ipcRenderer.invoke("media:clear-all"),

	readImageBase64: (filePath: string) =>
		ipcRenderer.invoke("media:read-image-base64", filePath),

	listMediaAssets: (query?: MediaQuery) =>
		ipcRenderer.invoke(IPC_CHANNELS.LIST_MEDIA_ASSETS, query),

	ingestMediaFiles: (request: MediaIngestFilesRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.INGEST_MEDIA_FILES, request),

	saveMediaAs: (request: MediaSaveAsRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SAVE_MEDIA_AS, request),

	hideMediaAsset: (id: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.HIDE_MEDIA_ASSET, id),

	rebuildMediaLibrary: () =>
		ipcRenderer.invoke(IPC_CHANNELS.REBUILD_MEDIA_LIBRARY),

	getMediaGallery: (assetId: string, query?: MediaQuery) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_MEDIA_GALLERY, { assetId, query }),

	// Image preview methods
	openImagePreview: (src: string, alt?: string) => {
		console.log("[Preload] openImagePreview called:", {
			src: src.substring(0, 50),
			alt,
		});
		return ipcRenderer.invoke(IPC_CHANNELS.OPEN_IMAGE_PREVIEW, { src, alt });
	},

	getImagePreview: (previewId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.GET_IMAGE_PREVIEW, previewId),

	onImagePreviewUpdate: (
		callback: (data: {
			mode: "single";
			previewId?: string;
			src?: string;
			alt?: string;
		}) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: { mode: "single"; previewId?: string; src?: string; alt?: string },
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.IMAGE_PREVIEW_UPDATE, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.IMAGE_PREVIEW_UPDATE, listener);
	},

	// Image gallery methods (now uses mediaId - gallery loads its own data)
	openImageGallery: (mediaId: string) => {
		console.log("[Preload] openImageGallery called:", { mediaId });
		return ipcRenderer.invoke(IPC_CHANNELS.OPEN_IMAGE_GALLERY, { mediaId });
	},

	// Permission methods. Responses go through emitCommand() with
	// type: 'command:permission-respond' (EventBus channel affinity validation).
	// Permission requests arrive via session:event channel as 'permission:request'.
	getPendingPermissions: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_GET_PENDING, sessionId),

	clearSessionPermissions: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_CLEAR_SESSION, sessionId),

	// Interaction methods (agent 提问 → 用户应答). 请求整体透传,不逐字段手抄。
	// 提问事件从 session:event 通道以 'interaction:requested' 到达;
	// 结算(含到点自结算)以 'interaction:settled' 到达。
	getPendingInteractions: (sessionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_GET_PENDING, sessionId),

	respondInteraction: (request: InteractionRespondRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_RESPOND, request),

	// OAuth methods。末位 `target` 是凭证写回目标(批 B6):缺席 = 默认空间,
	// 带 spaceId = 落进那个空间的凭证池(entryId 缺席 = 登一个新账号)。
	oauthStart: (providerId: string, target?: OAuthCredentialTargetRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_START, { providerId, ...target }),

	oauthLogout: (providerId: string, target?: OAuthCredentialTargetRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_LOGOUT, { providerId, ...target }),

	oauthGetStatus: (providerId: string, target?: OAuthCredentialTargetRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_STATUS, { providerId, ...target }),

	oauthDevicePoll: (
		providerId: string,
		flowId?: string,
		target?: OAuthCredentialTargetRequest,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_DEVICE_POLL, {
			providerId,
			flowId,
			...target,
		}),

	oauthRefresh: (providerId: string, target?: OAuthCredentialTargetRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_REFRESH, { providerId, ...target }),

	oauthCallback: (
		providerId: string,
		code: string,
		state: string,
		target?: OAuthCredentialTargetRequest,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.OAUTH_CALLBACK, {
			providerId,
			code,
			state,
			...target,
		}),

	// OAuth event listeners
	onOAuthTokenRefreshed: (callback: (data: { providerId: string }) => void) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.OAUTH_TOKEN_REFRESHED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_TOKEN_REFRESHED, listener);
	},

	onOAuthTokenExpired: (
		callback: (data: { providerId: string; error?: string }) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.OAUTH_TOKEN_EXPIRED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.OAUTH_TOKEN_EXPIRED, listener);
	},

	// Window
	closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),

	// Menu event listeners
	onMenuNewChat: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu:new-chat", listener);
		return () => ipcRenderer.removeListener("menu:new-chat", listener);
	},

	onMenuCloseChat: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu:close-chat", listener);
		return () => ipcRenderer.removeListener("menu:close-chat", listener);
	},

	// ⌘T — only sent when the embedded PAGE does not have focus; the renderer
	// still has to check whether its own browser panel is the focused surface.
	onMenuNewBrowserTab: (callback: () => void) => {
		const listener = () => callback();
		ipcRenderer.on("menu:new-browser-tab", listener);
		return () => ipcRenderer.removeListener("menu:new-browser-tab", listener);
	},

	// Files methods (for @ file search)
	listFiles: (options: { cwd?: string; query?: string; limit?: number }) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILES_LIST, options),

	// File rollback (prefer auditPath for hash-revalidated rollback)
	rollbackFile: (options: {
		auditPath?: string;
		filePath?: string;
		originalContent?: string;
		isNew?: boolean;
	}) => ipcRenderer.invoke(IPC_CHANNELS.FILE_ROLLBACK, options),

	// Directories listing (for /cd path completion)
	listDirs: (options: { basePath: string; query?: string; limit?: number }) =>
		ipcRenderer.invoke(IPC_CHANNELS.DIRS_LIST, options),

	// File content reading/writing (for file preview panel)
	readFileContent: (filePath: string, maxSize?: number) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_CONTENT, {
			path: filePath,
			maxSize,
		}),
	saveFileContent: (
		filePath: string,
		content: string,
		expectedMtimeMs?: number,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_SAVE_CONTENT, {
			path: filePath,
			content,
			expectedMtimeMs,
		}),
	listDirectory: (dirPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIRECTORY, { path: dirPath }),
	createFile: (filePath: string, content?: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE, { path: filePath, content }),
	createDirectory: (dirPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_CREATE_DIRECTORY, { path: dirPath }),
	renamePath: (oldPath: string, newPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_RENAME, { oldPath, newPath }),
	deletePath: (targetPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_DELETE, { path: targetPath }),
	statPath: (targetPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_STAT, { path: targetPath }),
	revealPath: (targetPath: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_REVEAL, { path: targetPath }),
	watchWorkspace: (root: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_WATCH_START, { root }),
	unwatchWorkspace: (root: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.FILE_WATCH_STOP, { root }),
	onWorkspaceFileChanged: (
		callback: (data: { root: string; path: string; eventType: string }) => void,
	) => {
		const listener = (
			_event: IpcRendererEvent,
			data: Parameters<typeof callback>[0],
		) => callback(data);
		ipcRenderer.on(IPC_CHANNELS.FILE_WATCH_EVENT, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.FILE_WATCH_EVENT, listener);
	},

	// ── Plugin management ───────────────────────────
	getPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_LIST),

	enablePlugin: (pluginId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_ENABLE, { pluginId }),

	disablePlugin: (pluginId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_DISABLE, { pluginId }),

	refreshPlugins: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_REFRESH),

	getPluginCommands: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_COMMANDS),

	executePluginCommand: (
		commandName: string,
		args: string,
		sessionId: string,
	) =>
		ipcRenderer.invoke(IPC_CHANNELS.PLUGINS_EXECUTE_COMMAND, {
			commandName,
			args,
			sessionId,
		}),

	listSchedulerTasks: () => ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_LIST),

	getSchedulerTask: (request: { id: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_GET, request),

	runSchedulerTaskNow: (request: { id: string; force?: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_RUN_NOW, request),

	setSchedulerTaskEnabled: (request: { id: string; enabled: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_SET_ENABLED, request),

	createSchedulerTask: (request: SchedulerCreateTaskRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_CREATE_TASK, request),

	updateSchedulerTask: (request: SchedulerUpdateTaskRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_UPDATE_TASK, request),

	deleteSchedulerTask: (request: SchedulerDeleteTaskRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_DELETE_TASK, request),

	listSchedulerRuns: (request: SchedulerListRunsRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_LIST_RUNS, request),

	getSchedulerRun: (request: SchedulerGetRunRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCHEDULER_GET_RUN, request),

	// ── User Prompts:已走通用 RPC 通道(promptsRouter),本文件不再暴露。──

	// ── App State (restore on startup) ─────────────
	getAppState: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_STATE),

	saveUIState: (uiState: {
		openTabs?: Array<{
			type: string;
			sessionId?: string;
			filePath?: string;
			title?: string;
		}>;
		activeTabIndex?: number;
		sidebarCollapsed?: boolean;
	}) => ipcRenderer.invoke(IPC_CHANNELS.SAVE_UI_STATE, uiState),

	// ── Search Everywhere ──────────────────────────
	toggleSearchWindow: (options?: SearchWindowOpenOptions) =>
		ipcRenderer.invoke(IPC_CHANNELS.SEARCH_WINDOW_TOGGLE, options),

	closeSearchWindow: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_WINDOW_CLOSE),

	setSearchWindowAnchor: (anchor: SearchWindowAnchor | null) =>
		ipcRenderer.invoke(IPC_CHANNELS.SEARCH_WINDOW_SET_ANCHOR, anchor),

	onSearchWindowShown: (
		callback: (payload?: SearchWindowShownPayload | null) => void,
	) => {
		const listener = (_event: IpcRendererEvent, payload?: SearchWindowShownPayload | null) =>
			callback(payload);
		ipcRenderer.on(IPC_CHANNELS.SEARCH_WINDOW_SHOWN, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_WINDOW_SHOWN, listener);
	},

	onSearchWindowGuides: (callback: (state: SearchWindowGuideState) => void) => {
		const listener = (_event: IpcRendererEvent, state: SearchWindowGuideState) =>
			callback(state);
		ipcRenderer.on(IPC_CHANNELS.SEARCH_WINDOW_GUIDES, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_WINDOW_GUIDES, listener);
	},

	searchQuery: (req: SearchRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SEARCH_QUERY, req),

	searchExecuteAction: (actionId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.SEARCH_EXECUTE_ACTION, actionId),

	onSearchAction: (callback: (actionId: string) => void) => {
		const listener = (_event: IpcRendererEvent, actionId: string) => callback(actionId);
		ipcRenderer.on(IPC_CHANNELS.SEARCH_ACTION, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_ACTION, listener);
	},

	// Todo / Plan:数据面已走通用通道(todoPlanRouter);下面只剩窗口面。
	openTodoPlanWindow: (request?: TodoPlanWindowActionRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_OPEN_WINDOW, request),

	hideTodoPlanWindow: (request?: TodoPlanWindowActionRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_HIDE_WINDOW, request),

	toggleTodoPlanWindow: (request?: TodoPlanWindowActionRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_TOGGLE_WINDOW, request),

	setTodoPlanWindowPinned: (pinned: boolean) =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_SET_WINDOW_PINNED, { pinned }),

	// 独立窗自绘红绿灯 / 手动拖窗。拖窗是拖拽期间每帧一条,不走通用 RPC 的重封装。
	minimizeTodoPlanWindow: () =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_MINIMIZE_WINDOW),

	zoomTodoPlanWindow: () =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_ZOOM_WINDOW),

	dragTodoPlanWindow: (request: TodoPlanWindowDragRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.TODO_PLAN_DRAG_WINDOW, request),

	onTodoPlanChanged: (callback: (data: TodoPlanChangedPayload) => void) => {
		const listener = (_event: IpcRendererEvent, data: TodoPlanChangedPayload) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.TODO_PLAN_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.TODO_PLAN_CHANGED, listener);
	},

	// Scratchpad (per-session draft paper)
	getScratchpad: (request: ScratchpadGetRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCRATCHPAD_GET, request),

	updateScratchpad: (request: ScratchpadUpdateRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCRATCHPAD_UPDATE, request),

	deleteScratchpad: (request: ScratchpadDeleteRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCRATCHPAD_DELETE, request),

	adoptScratchpad: (request: ScratchpadAdoptRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SCRATCHPAD_ADOPT, request),

	onScratchpadChanged: (callback: (data: ScratchpadChangedPayload) => void) => {
		const listener = (_event: IpcRendererEvent, data: ScratchpadChangedPayload) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.SCRATCHPAD_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SCRATCHPAD_CHANGED, listener);
	},

	// Evals (prompt evaluation) — 👎 downvote + Review + Run + Actions
	recordEvalsDownvote: (request: {
		sessionId: string;
		turnId: string;
		userMessage: string;
		note?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_RECORD_DOWNVOTE, request),

	// Phase 1: Review (read-only)
	evalsListRecords: (request: {
		negativeOnly?: boolean;
		category?: string;
		sinceTs?: string;
		limit?: number;
		offset?: number;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_LIST_RECORDS, request),

	evalsListFixtures: () => ipcRenderer.invoke(IPC_CHANNELS.EVALS_LIST_FIXTURES),

	evalsReadFixture: (request: { fixturePath: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_READ_FIXTURE, request),

	evalsListResults: () => ipcRenderer.invoke(IPC_CHANNELS.EVALS_LIST_RESULTS),

	evalsListCases: () => ipcRenderer.invoke(IPC_CHANNELS.EVALS_LIST_CASES),

	evalsGetCase: (request: { caseId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_GET_CASE, request),

	// Phase 2: Run
	evalsRunStart: (request: {
		caseIds?: string[];
		runs: number;
		disabledSections?: string[];
		providerId: string;
		model: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_RUN_START, request),

	evalsRunCancel: () => ipcRenderer.invoke(IPC_CHANNELS.EVALS_RUN_CANCEL),

	// `detail` 在主进程发送前被剥掉(太大),所以到手的是它可选的那一半。
	onEvalsRunProgress: (callback: (event: EvalsRunProgressEvent) => void) => {
		const listener = (_event: IpcRendererEvent, data: EvalsRunProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.EVALS_RUN_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.EVALS_RUN_PROGRESS, listener);
	},

	// Phase 3: Actions
	evalsPromoteFixture: (request: {
		fixturePath: string;
		caseId: string;
		description: string;
		expect: {
			firstToolCall?: string;
			contains?: string;
			notContains?: string;
		};
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_PROMOTE_FIXTURE, request),

	evalsRetireCase: (request: { caseId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_RETIRE_CASE, request),

	evalsGenerateTriage: (request?: { weeks?: number }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_GENERATE_TRIAGE, request || {}),

	evalsReadRunDetail: (request: { detailPath: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_READ_RUN_DETAIL, request),

	// Evals Workbench (incident-centric)
	evalsIncidentList: () =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_LIST),

	evalsIncidentGet: (request: { incidentId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_GET, request),

	evalsIncidentUpdate: (request: {
		incidentId: string;
		patch: { status?: string; note?: string; rubric?: string; title?: string };
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_UPDATE, request),

	evalsIncidentReadFile: (request: {
		incidentId: string;
		relativePath: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_READ_FILE, request),

	evalsReplayStart: (request: {
		incidentId: string;
		runs?: number;
		disabledSections?: string[];
		judge?: boolean;
		useCapturedPrompt?: boolean;
		providerId?: string;
		model?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_REPLAY_START, request),

	evalsReplayCancel: (request: { incidentId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_REPLAY_CANCEL, request),

	onEvalsReplayProgress: (callback: (event: EvalsReplayProgressEvent) => void) => {
		const listener = (_event: IpcRendererEvent, data: EvalsReplayProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, listener);
	},

	evalsIncidentAnalyze: (request: { incidentId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_ANALYZE, request),

	evalsIncidentPromote: (request: {
		incidentId: string;
		caseId: string;
		description?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_INCIDENT_PROMOTE, request),

	evalsDiagnoseStart: (request: { incidentId: string; quick?: boolean }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_DIAGNOSE_START, request),

	onEvalsDiagnoseProgress: (
		callback: (event: EvalsDiagnoseProgressEvent) => void,
	) => {
		const listener = (_event: IpcRendererEvent, data: EvalsDiagnoseProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.EVALS_DIAGNOSE_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(
				IPC_CHANNELS.EVALS_DIAGNOSE_PROGRESS,
				listener,
			);
	},

	evalsRoundList: (request: { incidentId: string }) =>
		ipcRenderer.invoke(IPC_CHANNELS.EVALS_ROUND_LIST, request),

	evalsRoundReplay: (request: {
		incidentId: string;
		round: number;
		runs?: number;
		editedMessages?: unknown[];
		providerId?: string;
		model?: string;
	}) => ipcRenderer.invoke(IPC_CHANNELS.EVALS_ROUND_REPLAY, request),
};

export function installOnethingPreloadBridge(): void {
	contextBridge.exposeInMainWorld("electronAPI", electronAPI);
}
