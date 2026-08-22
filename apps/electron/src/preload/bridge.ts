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
	Step,
	BrowserTabsChangedEvent,
	VoiceAudioChunkPayload,
	VoiceEvent,
	VoiceRuntimeCommand,
	MusicDjSpeak,
	MusicEvent,
	MusicLyrics,
	MusicNowPlaying,
	TodoPlanChangedPayload,
	ScratchpadChangedPayload,
	EvalsDiagnoseProgressEvent,
	EvalsReplayProgressEvent,
	EvalsRunProgressEvent,
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
	//    第七条「工具审批后恢复流」于 2026-08-22(#21)整条删除,本域清零。──

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

	// Settings —— 四条数据面(读 / 存 / 系统深浅色 / 代理自检)已迁到通用 RPC
	// 通道(settingsRouter,P4c 第十一批);渲染侧客户端在 platform/settings-client.ts。
	// 留在这里的是两件要 Electron 本体的事(开设置窗 / 原生对话框)与两条推送。
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

	// gateway —— 八条数据面已迁 `gatewayRouter`(P4c 第八批),本域零推送,壳上不留。

	// Voice —— 十一条数据面已迁到通用 RPC 通道(voiceRouter,P4c 第十一批);
	// 渲染侧客户端在 platform/voice-client.ts。这里留三条:两条推送订阅
	// (`VOICE_EVENT` / `VOICE_RUNTIME_COMMAND`,router 没有推送面)与一条
	// **单向上行** —— 高频 PCM 流不带回执,归流式单向残留集(拍板 #10)。
	voiceAudioChunk: (payload: VoiceAudioChunkPayload) =>
		ipcRenderer.send(IPC_CHANNELS.VOICE_AUDIO_CHUNK, payload),

	onVoiceEvent: (callback: (event: VoiceEvent) => void) => {
		const listener = (_event: IpcRendererEvent, event: VoiceEvent) =>
			callback(event);
		ipcRenderer.on(IPC_CHANNELS.VOICE_EVENT, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_EVENT, listener);
	},

	onVoiceRuntimeCommand: (callback: (command: VoiceRuntimeCommand) => void) => {
		const listener = (_event: IpcRendererEvent, command: VoiceRuntimeCommand) =>
			callback(command);
		ipcRenderer.on(IPC_CHANNELS.VOICE_RUNTIME_COMMAND, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.VOICE_RUNTIME_COMMAND, listener);
	},

	// Music radio —— 十四条数据面已迁到通用 RPC 通道(musicRouter,P4c 第九批);
	// 渲染侧客户端在 platform/music-client.ts。**四条推送留在这里**:router 今天
	// 没有推送面,而它们早就走 `broadcastVoiceHostMessage` 端口从主进程发出。
	onMusicEvent: (callback: (event: MusicEvent) => void) => {
		const listener = (_event: IpcRendererEvent, event: MusicEvent) =>
			callback(event);
		ipcRenderer.on(IPC_CHANNELS.MUSIC_EVENT, listener);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.MUSIC_EVENT, listener);
	},

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

	onSystemThemeChanged: (callback: (theme: "light" | "dark") => void) => {
		const listener = (_event: IpcRendererEvent, theme: "light" | "dark") => callback(theme);
		ipcRenderer.on(IPC_CHANNELS.SYSTEM_THEME_CHANGED, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SYSTEM_THEME_CHANGED, listener);
	},

	// Agent 档案 CRUD 已迁到通用 RPC 通道(agentsRouter),渲染侧客户端在
	// packages/renderer/platform/agents-client.ts —— 这里不再有它的出口。

	// Theme methods 已迁到通用 RPC 通道(themesRouter),渲染侧客户端在
	// packages/renderer/platform/themes-client.ts —— 这里不再有它的出口。

	// Model registry 与 Providers 已迁到通用 RPC 通道(modelsRouter /
	// providersRouter);渲染侧客户端在 platform/{models,providers}-client.ts。

	// Tools —— 七条数据面已迁到通用 RPC 通道(toolsRouter,P4c 第九批);渲染侧
	// 客户端在 platform/tools-client.ts。本域零推送,这里不再有任何一条。

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

	// Interaction(agent 提问 → 用户应答)的两条数据面已迁到通用 RPC 通道
	// (interactionRouter,P4c 第九批);渲染侧客户端在 platform/interaction-client.ts。
	// 提问事件仍从 session:event 通道以 'interaction:requested' 到达;
	// 结算(含到点自结算)以 'interaction:settled' 到达。

	// OAuth 的六条数据面已迁到通用 RPC 通道(oauthRouter),渲染侧客户端在
	// packages/renderer/platform/oauth-client.ts —— 凭证写回目标(批 B6)如今
	// 是信封里的三个字段,不再由这里现拼。**两条推送留在下面**:router 没有推送面。

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

	// files —— 十四条数据面已迁 `filesRouter`(P4c 第八批);壳上只剩这一条**推送**,
	// router 今天没有推送面。
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

	// ── Evals(提示词评估 + 事故工作台)——————————————————————
	// P4c 第十批:二十五条 invoke 通道已整只迁到通用 RPC 通道
	// (`@shared/ipc/evals.ts` 的 `evalsRouter` + `@shared/ipc/evals-workbench.ts`
	// 的 `evalsWorkbenchRouter`),桌面和 web 走同一条 dispatch。
	// 壳面只剩三条推送订阅 —— router 今天没有推送面。
	//
	// `detail` 在主进程发送前被剥掉(太大),所以到手的是它可选的那一半。
	onEvalsRunProgress: (callback: (event: EvalsRunProgressEvent) => void) => {
		const listener = (_event: IpcRendererEvent, data: EvalsRunProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.EVALS_RUN_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.EVALS_RUN_PROGRESS, listener);
	},

	onEvalsReplayProgress: (callback: (event: EvalsReplayProgressEvent) => void) => {
		const listener = (_event: IpcRendererEvent, data: EvalsReplayProgressEvent) =>
			callback(data);
		ipcRenderer.on(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.EVALS_REPLAY_PROGRESS, listener);
	},

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
};

export function installOnethingPreloadBridge(): void {
	contextBridge.exposeInMainWorld("electronAPI", electronAPI);
}
