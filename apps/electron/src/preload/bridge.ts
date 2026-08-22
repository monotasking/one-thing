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
	SessionEventEnvelope,
	StreamChunk,
} from "@shared/events/index.js";
import type {
	DeepLinkConfirmRequest,
	DeepLinkRespondRequest,
} from "@shared/ipc/deeplink.js";
import type {
	MediaSaveAsRequest,
	MarkdownResolveAssetRequest,
	MarkdownSaveAttachmentsRequest,
	SearchRequest,
	SearchWindowAnchor,
	SpacesChangedEvent,
	SearchWindowGuideState,
	SearchWindowOpenOptions,
	SearchWindowShownPayload,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	PracticeEventPayload,
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
	ScratchpadChangedPayload,
	EvalsDiagnoseProgressEvent,
	EvalsReplayProgressEvent,
	EvalsRunProgressEvent,
	OAuthCredentialTargetRequest,
} from "@shared/ipc.js";

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

	// collab(多 agent 协作房)的十五条 invoke 已整只迁到通用 RPC 通道(P4a,
	// `@shared/ipc/collab.ts` 的 collabRouter + `@/platform/collab-client` 的 collabApi)。
	// 这个域一条推送也没有(看板/协调器/agent 的实时更新走会话事件),所以壳面
	// 上什么也不剩 —— 与 spaces / practice 各留一条广播不同。
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

	// ── Chat:六条 invoke 已走通用 RPC 通道(chatRouter),本文件不再暴露。
	//    留在这里的只有第七条 —— 它往引擎递 `event.sender`,而 router 的信封里
	//    没有「谁在问」这一格(拍板 #21)。──
	resumeAfterToolConfirm: (sessionId: string, messageId: string) =>
		ipcRenderer.invoke(IPC_CHANNELS.RESUME_AFTER_TOOL_CONFIRM, {
			sessionId,
			messageId,
		}),

	// ── Sessions:26 条 invoke 已走通用 RPC 通道(sessionsRouter),本文件不再暴露。
	//    留在这里的只有这个域的**推送**(onSessionMessagesChanged /
	//    onContextSizeUpdated)—— router 没有推送面。──

	// ── Variables subsystem ─────────────────────────────────────
	// Live updates arrive through the existing session:variables-updated
	// event; these RPCs are for explicit fetches and writes.
	// ── Variables:已走通用 RPC 通道(variablesRouter),本文件不再暴露。──

	// ── Session goals:三条 RPC 已走通用通道(goalRouter),本文件不再暴露。
	// 实时变化仍从 session:goal-updated 事件来。──────────────────

	// ── Practice (kegel / pomodoro / exercise log) ──────────────
	// 十条 invoke 已整只迁到通用 RPC 通道（P4a，`practiceRouter`）。留在这里的
	// 只有推送面：router 没有推送面，PRACTICE_EVENT 仍走这条订阅。
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
	// ── Project Dirs:已走通用 RPC 通道(projectDirsRouter),本文件不再暴露。──

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

	// Media —— 只剩「要宿主本体」的三条:一次原生保存对话框 + 两个 BrowserWindow
	// (P4c 第三批:十一条数据面走 `mediaRouter`,渲染侧从 platform/media-client 取)。
	saveMediaAs: (request: MediaSaveAsRequest) =>
		ipcRenderer.invoke(IPC_CHANNELS.SAVE_MEDIA_AS, request),

	openImagePreview: (src: string, alt?: string) => {
		return ipcRenderer.invoke(IPC_CHANNELS.OPEN_IMAGE_PREVIEW, { src, alt });
	},

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
		return ipcRenderer.invoke(IPC_CHANNELS.OPEN_IMAGE_GALLERY, { mediaId });
	},

	// Permission methods. Responses go through the session-command RPC domain with
	// type: 'command:permission-respond' (EventBus channel affinity validation).
	// Permission requests arrive via session:event channel as 'permission:request'.
	// ── Permission(活询问):已走通用 RPC 通道(permissionRouter),本文件不再暴露。──

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

	// ── Scheduler:已走通用 RPC 通道(schedulerRouter),本文件不再暴露。──

	// ── User Prompts:已走通用 RPC 通道(promptsRouter),本文件不再暴露。──

	// ── App State (restore on startup) ─────────────
	// ── App State:已走通用 RPC 通道(appStateRouter),本文件不再暴露。──

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

	// Scratchpad(草稿纸):四条数据面已走通用 RPC 通道(scratchpadRouter),
	// 本文件只剩下面那条 SCRATCHPAD_CHANGED 推送订阅。
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
