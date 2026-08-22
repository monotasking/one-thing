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
import type { DeepLinkConfirmRequest } from "@shared/ipc/deeplink.js";
import type {
	MarkdownResolveAssetRequest,
	MarkdownSaveAttachmentsRequest,
	SearchRequest,
	SpacesChangedEvent,
	SearchWindowGuideState,
	SearchWindowShownPayload,
	PracticeEventPayload,
	PluginNotificationPayload,
	PluginRequestProgressPayload,
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

	/**
	 * 宿主壳路由出口(结构债 P4 终态批 A1-a)。和 `rpcInvoke` 并排、同一个信封,
	 * 差别只在处理者住哪:`rpc:invoke` 的在装配层,`shell:invoke` 的在宿主
	 * (开设置窗 / 关窗 / 原生对话框 / 系统通知 / 深链应答 / todo 窗 / 搜索窗)。
	 * 窗口域从此也不往本文件加暴露块。
	 */
	shellInvoke: (request: RpcRequest): Promise<RpcResponse> =>
		ipcRenderer.invoke(IPC_CHANNELS.SHELL_INVOKE, request),

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
	// 七条请求面(create/list/write/resize/kill/attach/ack)已整只迁到通用 RPC
	// 通道(P4 终态批 D2,`terminalRouter` + `@/platform/terminal-client`);
	// 这里只剩两条**推送**订阅 —— router 没有推送面,主进程那侧是
	// `configureTerminalBroadcaster` 注入端口。
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
	// 两条执行面(弹通知 / 画墨点)已走宿主壳路由(notifyRouter,A1-a);
	// 留在这里的只有「用户点了通知」这条推送订阅。
	notify: {
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

	// 插件的十九条数据面已随 `pluginsRouter` 迁到通用 RPC 通道(P4 终态批 C2);
	// 本文件只剩**两条推送订阅** —— router 今天没有推送面。
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

	// onething:// 深链的确认门(H4)。两条请求面(ready / respond)已走宿主壳路由
	// (deeplinkRouter,A1-a);这里只剩推来的那张卡。
	onDeepLinkRequest: (callback: (request: DeepLinkConfirmRequest) => void) => {
		const listener = (_event: IpcRendererEvent, request: DeepLinkConfirmRequest) =>
			callback(request);
		ipcRenderer.on(IPC_CHANNELS.DEEPLINK_REQUEST, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.DEEPLINK_REQUEST, listener);
	},


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

	// `updateSessionMaxTokens` 于 A1-a 删除:桌面从来没有处理者、渲染层零调用点。
	// server 的 `POST /api/sessions/:id/max-tokens` 路由原样留着。

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

	// Settings —— 四条数据面走通用 RPC 通道(settingsRouter,P4c 第十一批);
	// 两件要 Electron 本体的事(开设置窗 / 原生对话框)走宿主壳路由
	// (settingsWindowRouter / dialogRouter,A1-a)。这里只剩推送订阅。

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

	// Dialog —— 原生「打开」对话框走宿主壳路由(dialogRouter,A1-a)。

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

	// Media —— 十一条数据面走 `mediaRouter`(P4c 第三批),「要宿主本体」的三条
	// (另存为对话框 + 两个 BrowserWindow)走宿主壳路由(mediaWindowRouter,A1-a)。
	// 这里只剩两条推送订阅。
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

	// Window —— 「关掉发起窗」走宿主壳路由(windowRouter,A1-a):要关哪扇由宿主
	// 从 callerId 认,不从请求体里读。

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

	// ── Plugin management:已走通用 RPC 通道(pluginsRouter),本文件不再暴露。──

	// ── Scheduler:已走通用 RPC 通道(schedulerRouter),本文件不再暴露。──

	// ── User Prompts:已走通用 RPC 通道(promptsRouter),本文件不再暴露。──

	// ── App State (restore on startup) ─────────────
	// ── App State:已走通用 RPC 通道(appStateRouter),本文件不再暴露。──

	// ── Search Everywhere ──────────────────────────
	// 四条动窗口的(toggle / close / set-anchor / execute-action)走宿主壳路由
	// (searchWindowRouter,A1-a);`searchQuery` 是数据面,还没迁(见 channels.ts)。
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

	onSearchAction: (callback: (actionId: string) => void) => {
		const listener = (_event: IpcRendererEvent, actionId: string) => callback(actionId);
		ipcRenderer.on(IPC_CHANNELS.SEARCH_ACTION, listener);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.SEARCH_ACTION, listener);
	},

	// Todo / Plan:数据面走通用通道(todoPlanRouter),七条窗口面走宿主壳路由
	// (todoPlanWindowRouter,A1-a)。这里只剩变更推送。
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
