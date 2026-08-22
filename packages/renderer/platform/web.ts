import type {
	AppSettings,
	ProxySettings,
	ScratchpadChangedPayload,
	SearchRequest,
	Step,
	TodoPlanChangedPayload,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	VoiceAudioChunkPayload,
	VoiceEvent,
	VoiceRuntimeCommand,
	VoiceStartRequest,
	VoiceStopRequest,
	VoiceSubmitTranscriptRequest,
	VoiceSubmitUtteranceRequest,
	VoiceSynthesizeRequest,
	VoiceTestASRRequest,
	VoiceTestTTSRequest,
} from "@/types";
import type { SessionEventEnvelope } from "@shared/events";
import type {
	AbortPluginRequestResult,
	PluginConfigResponse,
	PluginRequestPayload,
	PluginRequestResult,
	SetPluginConfigResponse,
	PluginFootprintResponse,
	UninstallPluginResponse,
	InstallPluginResponse,
	UpdatePluginResponse,
	CheckPluginUpdatesResponse,
	GetPluginMarketResponse,
	PluginLifecycleInfoResponse,
	PickPluginFileResponse,
	ReadPluginTarballResponse,
} from "@shared/ipc/plugins.js";
import type { RpcResponse } from "@shared/ipc/rpc.js";
import { goalRouter } from "@shared/ipc/goal.js";
import { promptsRouter } from "@shared/ipc/prompts.js";
import { sessionCommandRouter } from "@shared/ipc/session-command.js";
import { todoPlanRouter } from "@shared/ipc/todo-plan.js";
import { usageRouter } from "@shared/ipc/usage.js";
import { createRouterClient, type RpcInvoke } from "./router-client";
import type {
	PlatformApi,
	PlatformCapabilities,
	SessionStreamPayload,
} from "./types";

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from "@shared/events/index.js";
import { getLogger } from "@/services/log";

const log = getLogger("renderer.platform-web");

function browserClipboardWriteCapability(): boolean {
	return (
		typeof navigator !== "undefined" && Boolean(navigator.clipboard?.writeText)
	);
}

const webCapabilities: PlatformCapabilities = {
	localFileSystem: false,
	workspaceFileSystem: false,
	nativeWindowControls: false,
	shellTools: false,
	terminal: false,
	embeddedBrowser: false,
	collabRooms: false,
	// P4c 第九批(#13 / #17):两条数据面都已迁到通用 RPC 通道,通道是通的 ——
	// 挡在前面的是**能力位**。music:电台驱动的是宿主机器上的 ncm-cli / mpv;
	// interactionRespond:让浏览器替桌面答提问是一次独立的拍板。放开各改这一行。
	music: false,
	interactionRespond: false,
	// P4c 第十批(#15):evals / evalsWorkbench 二十五条已迁通用 RPC,通道是通的。
	// 评估面读写宿主机器上的 evals 仓,跑批还会拿 API key 直接打 provider ——
	// 放开是一次独立的拍板。改这一行。
	evals: false,
	clipboardWrite: browserClipboardWriteCapability(),
	desktopWindows: false,
	globalMenuEvents: false,
};

type Unsubscribe = () => void;
type SearchActionHandler = (actionId: string) => void;
type TodoPlanWebWindowAction = "open" | "hide" | "toggle" | "pin";
type ImagePreviewUpdatePayload = {
	mode: "single";
	previewId?: string;
	src?: string;
	alt?: string;
};

const searchActionHandlers = new Set<SearchActionHandler>();
const imagePreviewUpdateHandlers = new Set<
	(payload: ImagePreviewUpdatePayload) => void
>();
const TODO_PLAN_WEB_WINDOW_EVENT = "todo-plan:web-window-action";
const sharedEventSources = new Map<
	string,
	{
		refCount: number;
		source: EventSource;
	}
>();

function emitSearchAction(actionId: string): void {
	for (const handler of searchActionHandlers) handler(actionId);
}

function subscribeSearchAction(callback: SearchActionHandler): Unsubscribe {
	searchActionHandlers.add(callback);
	return () => searchActionHandlers.delete(callback);
}

function emitImagePreviewUpdate(payload: ImagePreviewUpdatePayload): void {
	for (const handler of imagePreviewUpdateHandlers) handler(payload);
}

function subscribeImagePreviewUpdate(
	callback: (payload: ImagePreviewUpdatePayload) => void,
): Unsubscribe {
	imagePreviewUpdateHandlers.add(callback);
	return () => imagePreviewUpdateHandlers.delete(callback);
}

function dispatchTodoPlanWindowAction(
	action: TodoPlanWebWindowAction,
	detail: { request?: TodoPlanWindowActionRequest; pinned?: boolean } = {},
): void {
	const target = typeof window === "undefined" ? undefined : window;
	if (!target?.dispatchEvent) return;
	const payload = { action, ...detail };
	const event =
		typeof CustomEvent === "function"
			? new CustomEvent(TODO_PLAN_WEB_WINDOW_EVENT, { detail: payload })
			: ({
					type: TODO_PLAN_WEB_WINDOW_EVENT,
					detail: payload,
				} as unknown as Event);
	target.dispatchEvent(event);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: {
			...(init?.body ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
	});

	if (!response.ok) {
		throw new Error(
			`Request failed: ${response.status} ${response.statusText}`,
		);
	}

	return response.json() as Promise<T>;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
	return requestJson<T>(path, {
		method: "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/**
 * 通用 RPC 传输面(主线 T0):所有 router 域共用这一条路由。
 * 每个域在下面的 webApi 里各占一行 —— 加域不再往本文件加 fetch 包装。
 */
const rpcInvoke: RpcInvoke = request => postJson<RpcResponse>("/api/rpc", request);
const usageApi = createRouterClient(usageRouter, rpcInvoke);
const promptsApi = createRouterClient(promptsRouter, rpcInvoke);
const goalApi = createRouterClient(goalRouter, rpcInvoke);
const todoPlanApi = createRouterClient(todoPlanRouter, rpcInvoke);
const sessionCommandApi = createRouterClient(sessionCommandRouter, rpcInvoke);

function booleanProperty(
	value: unknown,
	key: keyof PlatformCapabilities,
	fallback: boolean,
): boolean {
	if (!value || typeof value !== "object") return fallback;
	const candidate = (
		value as Partial<Record<keyof PlatformCapabilities, unknown>>
	)[key];
	return typeof candidate === "boolean" ? candidate : fallback;
}

function normalizeServerCapabilities(value: unknown): PlatformCapabilities {
	return {
		localFileSystem: booleanProperty(value, "localFileSystem", false),
		workspaceFileSystem: booleanProperty(value, "workspaceFileSystem", false),
		nativeWindowControls: booleanProperty(value, "nativeWindowControls", false),
		shellTools: booleanProperty(value, "shellTools", false),
		// P4 (web terminal) is frozen: stays false until the server advertises it.
		terminal: booleanProperty(value, "terminal", false),
		// Embedded WebContentsView browser is Electron-only; web falls back to iframe.
		embeddedBrowser: booleanProperty(value, "embeddedBrowser", false),
		// Rooms need the in-process RoomCoordinator; the server neither runs one
		// nor accepts kind='room' creates (P0 desktop-only).
		collabRooms: booleanProperty(value, "collabRooms", false),
		// 电台要宿主机器上的播放器;提问应答要主进程的 InteractionRegistry。
		// 两颗都默认关,服务器没有宣告就是关(P4c 第九批,#13 / #17)。
		music: booleanProperty(value, "music", false),
		interactionRespond: booleanProperty(value, "interactionRespond", false),
		// 评估面要宿主机器上的 evals 仓与 API key(P4c 第十批,#15)。
		evals: booleanProperty(value, "evals", false),
		clipboardWrite: browserClipboardWriteCapability(),
		desktopWindows: booleanProperty(value, "desktopWindows", false),
		globalMenuEvents: booleanProperty(value, "globalMenuEvents", false),
	};
}

async function refreshWebCapabilities(): Promise<PlatformCapabilities> {
	const capabilities = normalizeServerCapabilities(
		await requestJson("/api/capabilities"),
	);
	Object.assign(webCapabilities, capabilities);
	return webCapabilities;
}

function getPreferredColorScheme(): "light" | "dark" {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia?.("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

function createEventSourceSubscription<T>(
	path: string,
	eventName: string,
	callback: (payload: T) => void,
): Unsubscribe {
	if (typeof EventSource === "undefined") return () => {};

	let entry = sharedEventSources.get(path);
	if (!entry) {
		entry = {
			refCount: 0,
			source: new EventSource(path),
		};
		sharedEventSources.set(path, entry);
	}
	entry.refCount += 1;

	const listener = (event: MessageEvent<string>) => {
		try {
			callback(JSON.parse(event.data) as T);
		} catch (error) {
			log.warn("ignored malformed sse event", { eventName }, error);
		}
	};

	entry.source.addEventListener(eventName, listener);
	return () => {
		const current = sharedEventSources.get(path);
		if (!current) return;
		current.source.removeEventListener(eventName, listener);
		current.refCount -= 1;
		if (current.refCount <= 0) {
			current.source.close();
			sharedEventSources.delete(path);
		}
	};
}

function createSessionMessagesChangedSubscription(
	callback: (data: {
		sessionId: string;
		action: "added" | "updated" | "deleted";
		messageId?: string;
	}) => void,
): Unsubscribe {
	return createEventSourceSubscription<SessionEventEnvelope>(
		"/api/events",
		"session:event",
		(envelope) => {
			// `envelope.event` 已经是 `SessionBusMessage` 判别联合 —— 按 `type` 收窄即可,
			// 不再用结构断言把共享契约打回匿名对象。
			const event = envelope.event;
			if (!event?.type) return;

			if (
				event.type === SESSION_EVENT_TYPES.MESSAGE_USER_CREATED ||
				event.type === SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED ||
				event.type === SESSION_EVENT_TYPES.MESSAGE_CREATED
			) {
				callback({
					sessionId: envelope.sessionId,
					action: "added",
					messageId: event.message?.id,
				});
				return;
			}

			if (
				event.type === SESSION_EVENT_TYPES.MESSAGE_UPDATED ||
				event.type === SESSION_EVENT_TYPES.MESSAGES_REPLACED
			) {
				callback({
					sessionId: envelope.sessionId,
					action: "updated",
					// `messages:replaced` 契约上没有 messageId(整段换掉,没有单条地址),
					// 与从前读它读到 undefined 是同一件事。
					messageId:
						event.type === SESSION_EVENT_TYPES.MESSAGE_UPDATED ? event.messageId : undefined,
				});
				return;
			}

			if (event.type === SESSION_EVENT_TYPES.MESSAGE_DELETED) {
				callback({
					sessionId: envelope.sessionId,
					action: "deleted",
					messageId: event.messageId,
				});
			}
		},
	);
}

function createStepAddedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		step: Step;
	}) => void,
): Unsubscribe {
	return createEventSourceSubscription<SessionEventEnvelope>(
		"/api/events",
		"session:event",
		(envelope) => {
			const event = envelope.event;
			if (event?.type !== SESSION_EVENT_TYPES.STEP_ADDED) return;
			// 归属的 messageId 一直是从 step 里读的,而 `Step` 契约上没有这个字段
			// (事件自身的 `messageId` 才是契约位置)—— 保留原读法,按 unknown 取。
			const stepMessageId = (event.step as { messageId?: unknown } | undefined)
				?.messageId;
			callback({
				sessionId: envelope.sessionId,
				messageId: typeof stepMessageId === "string" ? stepMessageId : "",
				step: event.step,
			});
		},
	);
}

function createStepUpdatedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		stepId: string;
		updates: Partial<Step>;
	}) => void,
): Unsubscribe {
	return createEventSourceSubscription<SessionEventEnvelope>(
		"/api/events",
		"session:event",
		(envelope) => {
			const event = envelope.event;
			if (event?.type !== SESSION_EVENT_TYPES.STEP_UPDATED || typeof event.stepId !== "string")
				return;
			callback({
				sessionId: envelope.sessionId,
				messageId: "",
				stepId: event.stepId,
				updates: event.updates,
			});
		},
	);
}

function createSkillActivatedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		skillName: string;
	}) => void,
): Unsubscribe {
	return createEventSourceSubscription<SessionEventEnvelope>(
		"/api/events",
		"session:event",
		(envelope) => {
			const event = envelope.event;
			if (
				event?.type !== SESSION_EVENT_TYPES.SKILL_ACTIVATED ||
				typeof event.skillName !== "string"
			)
				return;
			callback({
				sessionId: envelope.sessionId,
				messageId: "",
				skillName: event.skillName,
			});
		},
	);
}

function createContextSizeUpdatedSubscription(
	callback: (data: { sessionId: string; contextSize: number }) => void,
): Unsubscribe {
	return createEventSourceSubscription<SessionEventEnvelope>(
		"/api/events",
		"session:event",
		(envelope) => {
			const event = envelope.event;
			if (
				event?.type !== SESSION_EVENT_TYPES.CONTEXT_SIZE_UPDATED ||
				typeof event.contextSize !== "number"
			)
				return;
			callback({
				sessionId: envelope.sessionId,
				contextSize: event.contextSize,
			});
		},
	);
}

// P1(2026-08-14):createContextCompactStartedSubscription /
// createContextCompactCompletedSubscription / isContextCompactStartedMessage
// 已删。前者先查一个后端从不 emit 的幻影事件,再退回逐条 JSON.parse 嗅探消息
// 内容(与序列化格式硬耦合);renderer 里零消费者。压缩通知现在走
// session:event 的 context:compact-started / -progress / -completed,由
// ipc-hub 消费(progress 是 C6 加的分块进度,同一条信封,零新通道)。

function unsupported(method: string) {
	return async () => ({
		success: false,
		error: `Platform method "${method}" is not available in the web host yet.`,
	});
}

function unsupportedSubscription(_method: string) {
	return () => () => {};
}

function isSubscriptionMethod(method: string): boolean {
	return /^on[A-Z]/.test(method);
}

export const WEB_DESKTOP_ONLY_PLATFORM_METHODS = [
	// collab 域的十五条已整只迁到通用 RPC 通道(P4a,`@shared/ipc/collab.ts` 的
	// collabRouter + `@/platform/collab-client` 的 collabApi),所以这份名单里
	// 不再有它们 —— web 走的是同一条 `POST /api/rpc`。
	//
	// **能力位没动**:`collabRooms` 在 web 上仍然是 false(见上方 capabilities),
	// 协作 UI 照旧关着。放开它是独立的一次拍板,不搭这次搬家的便车。
	// Interaction(agent 提问 → 用户应答,E1)的两条已整只迁到通用 RPC 通道
	// (P4c 第九批,`interactionRouter` + `@/platform/interaction-client`),所以
	// 这份名单里不再有它们。**挡在前面的换成了能力位** `interactionRespond`
	// (web 上 false,见上方 capabilities):客户端在它为 false 时返回与这里的
	// `unsupported(method)` 逐字同形的失败信封,可感知结果一字不变 ——
	// 卡片不出现,提问照旧由内核到点自结算,不会挂住。
	// Terminal (P4 web parity is frozen; capability gate hides the UI on web)
	"createTerminal",
	"listTerminals",
	"writeTerminal",
	"resizeTerminal",
	"killTerminal",
	"attachTerminal",
	"ackTerminal",
	"onTerminalData",
	"onTerminalExit",
	// Browser (embedded WebContentsView is Electron-only; web uses iframe fallback)
	"hydrateBrowser",
	"createBrowserTab",
	"closeBrowserTab",
	"selectBrowserTab",
	"navigateBrowser",
	"browserGoBack",
	"browserGoForward",
	"reloadBrowser",
	"stopBrowser",
	"setBrowserBounds",
	"setBrowserVisible",
	"pickBrowserElement",
	"cancelBrowserPick",
	"getBrowserSearchEngine",
	"setBrowserSearchEngine",
	"listBrowserProfiles",
	"addBrowserProfile",
	"removeBrowserProfile",
	"switchBrowserProfile",
	"onBrowserTabsChanged",
	"setWindowButtonVisibility",
	"toggleSearchWindow",
	"closeSearchWindow",
	"setSearchWindowAnchor",
	"openPath",
	"getDataPath",
	"closeWindow",
	"onMenuNewChat",
	"onMenuCloseChat",
	"onMenuNewBrowserTab",
	"onSearchWindowShown",
	"onSearchWindowGuides",
] as const;

export const WEB_DEFERRED_PLATFORM_METHODS = [] as const;

export const WEB_UNSUPPORTED_PLATFORM_METHODS = [
	...WEB_DESKTOP_ONLY_PLATFORM_METHODS,
	...WEB_DEFERRED_PLATFORM_METHODS,
] as const;

type WebUnsupportedPlatformMethod =
	(typeof WEB_UNSUPPORTED_PLATFORM_METHODS)[number];

const webUnsupportedApi = Object.fromEntries(
	WEB_UNSUPPORTED_PLATFORM_METHODS.map((method) => [
		method,
		isSubscriptionMethod(method)
			? unsupportedSubscription(method)
			: unsupported(method),
	]),
) as Record<WebUnsupportedPlatformMethod, (...args: never[]) => unknown>;

const webApi = {
	...webUnsupportedApi,
	environment: "web" as const,
	capabilities: webCapabilities,
	getCapabilities: refreshWebCapabilities,


	getSettings: () => requestJson("/api/settings"),
	saveSettings: (settings: AppSettings) => postJson("/api/settings", settings),
	openSettingsWindow: async (options?: { tab?: string }) => {
		window.location.hash = options?.tab
			? `#/settings?tab=${encodeURIComponent(options.tab)}`
			: "#/settings";
		return { success: true };
	},
	onSettingsNavigate: () => () => {},
	testProxy: (proxy: ProxySettings) =>
		postJson("/api/network/test-proxy", { proxy }),
	onSettingsChanged: () => () => {},
	// web 端没有第二个窗口,也没有这条广播(批 B9-0):noop 退订即可。
	onSpacesChanged: () => () => {},
	searchQuery: (request: SearchRequest) =>
		postJson("/api/search/query", request),
	searchExecuteAction: async (actionId: string) => {
		const response = await postJson<{
			success: boolean;
			actionId?: string;
			error?: string;
		}>("/api/search/actions", { actionId });
		if (response.success) emitSearchAction(response.actionId || actionId);
		return response;
	},

	// Themes 走通用 RPC(themesRouter,P4c 第七批):浏览器从此拿到的是与桌面
	// 逐字相同的一份主题 —— 插件覆盖的合成也在同一个域处理者里做。

	// System prompt snapshot 与另外五条聊天面走通用 RPC(chatRouter,P4c 第五批);
	// User prompt snippets 走 promptsRouter。两者都见文件末尾的域客户端一行区。

	getPlugins: () => requestJson("/api/plugins"),
	enablePlugin: (pluginId: string) =>
		postJson("/api/plugins/enable", { pluginId }),
	disablePlugin: (pluginId: string) =>
		postJson("/api/plugins/disable", { pluginId }),
	refreshPlugins: () => postJson("/api/plugins/refresh"),
	getPluginCommands: () => requestJson("/api/plugins/commands"),
	executePluginCommand: (
		commandName: string,
		args: string,
		sessionId: string,
	) =>
		postJson("/api/plugins/execute-command", { commandName, args, sessionId }),
	// OAuth 的六条数据面走通用 RPC(oauthRouter,P4c 第七批)。顺带修掉一处说谎:
	// 从前 web 壳把凭证写回目标(批 B6 的 spaceId/entryId/label)**收下即丢**,
	// 浏览器里往空间凭证池登录等于没登;走 router 之后它真的传到 authService 了
	// —— 两个宿主吃的也是同一台 authService、同一本令牌账。
	// **两条推送仍走 SSE**:router 今天没有推送面。
	onOAuthTokenRefreshed: (callback: (data: { providerId: string }) => void) =>
		createEventSourceSubscription<{ providerId: string }>(
			"/api/oauth/events",
			"oauth:token-refreshed",
			callback,
		),
	onOAuthTokenExpired: (
		callback: (data: { providerId: string; error?: string }) => void,
	) =>
		createEventSourceSubscription<{ providerId: string; error?: string }>(
			"/api/oauth/events",
			"oauth:token-expired",
			callback,
		),
	// gateway —— 八条 REST 镜像已随 `gatewayRouter` 迁走(P4c 第八批),本域零推送。
	voiceGetState: () => requestJson("/api/voice/state"),
	voiceStart: (request?: VoiceStartRequest) =>
		postJson("/api/voice/start", request),
	voiceStop: (request?: VoiceStopRequest) =>
		postJson("/api/voice/stop", request),
	voiceSubmitUtterance: (request: VoiceSubmitUtteranceRequest) =>
		postJson("/api/voice/submit-utterance", request),
	voiceSubmitTranscript: (request: VoiceSubmitTranscriptRequest) =>
		postJson("/api/voice/submit-transcript", request),
	voiceSynthesize: (request: VoiceSynthesizeRequest) =>
		postJson("/api/voice/synthesize", request),
	voiceTestASR: (request: VoiceTestASRRequest) =>
		postJson("/api/voice/test-asr", request),
	voiceTestTTS: (request: VoiceTestTTSRequest) =>
		postJson("/api/voice/test-tts", request),
	voiceGetTTSModels: (request?: { force?: boolean }) =>
		postJson("/api/voice/tts-models", request),
	onVoiceEvent: (callback: (event: VoiceEvent) => void) =>
		createEventSourceSubscription<VoiceEvent>(
			"/api/voice/events",
			"voice:event",
			callback,
		),
	voiceRuntimeReady: () => postJson("/api/voice/runtime-ready"),
	voiceRuntimeEvent: (event: VoiceEvent) =>
		postJson("/api/voice/runtime-event", event),
	voiceAudioChunk: (payload: VoiceAudioChunkPayload) => {
		void postJson("/api/voice/audio-chunk", payload).catch(() => {
			// Fire-and-forget PCM uplink; drops are tolerated on the web build.
		});
	},
	onVoiceRuntimeCommand: (callback: (command: VoiceRuntimeCommand) => void) =>
		createEventSourceSubscription<VoiceRuntimeCommand>(
			"/api/voice/runtime-commands",
			"voice:runtime-command",
			callback,
		),
	// Todo / plan 数据面走通用 RPC(todoPlanRouter);窗口面在 web 是本地 DOM 事件。
	openTodoPlanWindow: (request?: TodoPlanWindowActionRequest) => {
		dispatchTodoPlanWindowAction("open", { request });
		return Promise.resolve({ success: true });
	},
	hideTodoPlanWindow: (request?: TodoPlanWindowActionRequest) => {
		dispatchTodoPlanWindowAction("hide", { request });
		return Promise.resolve({ success: true });
	},
	toggleTodoPlanWindow: (request?: TodoPlanWindowActionRequest) => {
		dispatchTodoPlanWindowAction("toggle", { request });
		return Promise.resolve({ success: true });
	},
	setTodoPlanWindowPinned: (pinned: boolean) => {
		dispatchTodoPlanWindowAction("pin", { pinned });
		return Promise.resolve({ success: true, pinned });
	},
	// 自绘红绿灯与手动拖窗是**桌面窗**的事。浏览器里没有窗可挪,也没有系统交通灯
	// 要替代 —— 面板在 web 端始终是嵌在页面里的一块,所以这三条老实地报 false,
	// 而不是派一个假的本地事件出去骗调用点。
	minimizeTodoPlanWindow: () => Promise.resolve({ success: false }),
	zoomTodoPlanWindow: () => Promise.resolve({ success: false }),
	dragTodoPlanWindow: (_request: TodoPlanWindowDragRequest) =>
		Promise.resolve({ success: false }),

	// music —— 十四条数据面已随 `musicRouter` 迁走(P4c 第九批);web 上挡在前面的
	// 不再是这些桩,而是能力位 `music`(见上方 capabilities)与
	// `platform/music-client.ts` 里那份逐字相同的降级答案。
	// 只剩这四条**推送**订阅,router 今天没有推送面 —— 浏览器里没有主进程往这四条
	// 通道发消息,所以照旧是空订阅。
	onMusicEvent: () => () => {},
	onMusicLyrics: () => () => {},
	onMusicNowPlaying: () => () => {},
	onMusicDjSpeak: () => () => {},

	// tools —— 六条 REST 镜像已随 `toolsRouter` 迁走(P4c 第九批)。护栏跟着走:
	// 域处理者按 `context.transport` 逐方法保留旧 server 路由的语义
	// (执行面白名单 / 会话沙箱夹紧 / 后台任务与回写工具调用的拒绝文案)。

	// files —— 十四条 REST 镜像已随 `filesRouter` 迁走(P4c 第八批);
	// 只剩这一条**推送**的 SSE 订阅,router 今天没有推送面。
	onWorkspaceFileChanged: (
		callback: (payload: {
			root: string;
			path: string;
			eventType: string;
		}) => void,
	) =>
		createEventSourceSubscription(
			"/api/files/watch/events",
			"workspace:file-changed",
			callback,
		),
	// ── Evals(提示词评估 + 事故工作台)——————————————————————
	// P4c 第十批:二十五条数据面已整只迁到通用 RPC 通道(`evalsRouter` /
	// `evalsWorkbenchRouter`),这份名单里不再有它们。**挡在前面的换成了能力位**
	// `evals`(上面 `webCapabilities` 里默认 false):关着时
	// `platform/evals-client.ts` / `platform/evals-workbench-client.ts` 根本不发
	// 请求,就地返回与从前这批硬桩**逐字相同**的答案。
	// 留在这里的只有三条推送订阅 —— router 没有推送面,web 上也没有对应的 SSE。
	onEvalsRunProgress: () => () => {},
	onEvalsReplayProgress: () => () => {},
	onEvalsDiagnoseProgress: () => () => {},

	// ── Generic RPC(主线 T0)。域客户端各占一行,传输面只有这一条。──
	rpcInvoke,
	getUsageSummary: usageApi.getSummary,
	getSessionUsage: usageApi.getSession,
	listPrompts: () => promptsApi.list({}),
	getPrompt: promptsApi.get,
	createPrompt: promptsApi.create,
	updatePrompt: promptsApi.update,
	deletePrompt: promptsApi.delete,
	// 目标以前在 web 是三个写死的错误桩;走通用通道之后是真实现。
	goalGet: (sessionId: string) => goalApi.get({ sessionId }),
	goalSet: goalApi.set,
	goalDiffs: (sessionId: string) => goalApi.diffs({ sessionId }),
	getTodoPlan: (request?: Parameters<typeof todoPlanApi.get>[0]) =>
		todoPlanApi.get(request ?? {}),
	createTodoPlanNote: todoPlanApi.create,
	updateTodoPlan: todoPlanApi.update,
	renameTodoPlanNote: todoPlanApi.rename,
	deleteTodoPlanNote: todoPlanApi.delete,
	revealTodoPlanDirectory: () => todoPlanApi.revealDirectory({}),

	// practice 域已整只迁到通用 RPC 通道（P4a）—— 从前这里是一排**说谎的桩**
	// （永远 idle 的 snapshot、直接 throw 的 log、空桶的 summary），web 端现在经
	// `POST /api/rpc` 拿的是真实引擎状态。`onPracticeEvent` 留在下面的推送面：
	// router 没有推送面，web 壳也确实收不到 PRACTICE_EVENT。
	onPracticeEvent: () => () => {},

	// 插件仅在 Electron 桌面宿主执行(设计文档 §6 已拍板的方案 A):apps/server
	// 的插件目录是只读镜像,noopEntry 从不执行插件代码,因此 web 端永远收不到
	// plugin:notification。这是有意降级,不是漏接。
	onPluginNotification: () => () => {},

	// onething:// 深链只有桌面宿主接得到 —— 注册 URL scheme 是操作系统级的事,
	// 浏览器里没有"外面点一条链接回到这个标签页"这种东西。三条都是诚实的空实现:
	// ready 说成功(队列本来就不存在),没有卡会推来,respond 说得清地失败
	// (而不是回一个假的成功,让调用方以为投递过了)。
	deepLinkReady: async () => ({ success: true }),
	onDeepLinkRequest: () => () => {},
	respondDeepLink: async () => ({
		success: false,
		error: "deep links are desktop-only",
	}),

	/**
	 * 统一请求通道的 web 实现。
	 *
	 * 打的是真路由(`/api/plugins/:id/:action`),server 按方案 A 回 501 ——
	 * **不是静默无应答**:调用方拿到的是一条能读懂的错误,而不是一个永远
	 * pending 的 promise。将来 server 真跑插件时,这一侧一行都不用改。
	 */
	pluginRequest: async (
		request: PluginRequestPayload,
	): Promise<PluginRequestResult> => {
		// 随机分量不是装饰:纯时间戳在同毫秒并发下会撞号,而 requestId 是 abort
		// 的唯一地址。桌面侧由 core 统一生成(带序列号),web 这边没有那个 registry,
		// 所以自己保证唯一。
		const requestId =
			request.requestId ||
			`web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		// 直接 fetch 而不是 requestJson:后者对 !ok 只抛
		// "Request failed: 501 Not Implemented",把服务端写好的解释丢了 ——
		// 而这条错误的全部价值就在那句解释里。
		try {
			const response = await fetch(
				`/api/plugins/${encodeURIComponent(request.pluginId)}/${encodeURIComponent(request.action)}`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ payload: request.payload, requestId }),
				},
			);
			const body = (await response
				.json()
				.catch(() => null)) as Partial<PluginRequestResult> | null;
			if (!response.ok) {
				return {
					success: false,
					requestId,
					error:
						body?.error ||
						`Request failed: ${response.status} ${response.statusText}`,
				};
			}
			// 200 但没有可解析的正文不是成功:`success: body?.success !== false`
			// 会把一个空体误判成 success 并把 result 当成 undefined 递给调用方。
			if (!body) {
				return {
					success: false,
					requestId,
					error: "Plugin request returned an empty response body",
				};
			}
			return {
				success: body.success !== false,
				requestId: body.requestId || requestId,
				result: body.result,
				error: body.error,
				aborted: body.aborted,
				timedOut: body.timedOut,
			};
		} catch (error) {
			return {
				success: false,
				requestId,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	/**
	 * 配置读取:方案 A 下 web 端是**只读**的。
	 *
	 * 值与字段表都从 `/api/plugins` 的列表投影里取(schema 单源在 manifest,
	 * 归约在产品层)——不新开路由,也不假装 server 上有一份可写的配置:
	 * server 写 plugin-settings 会与桌面那份文件分叉,那是比"不能编辑"糟糕得多的
	 * 结果。
	 */
	getPluginConfig: async (pluginId: string): Promise<PluginConfigResponse> => {
		try {
			const listed = (await requestJson("/api/plugins")) as {
				success?: boolean;
				plugins?: Array<Record<string, unknown>>;
			};
			const plugin = listed?.plugins?.find((item) => item.id === pluginId);
			if (!plugin) {
				return { success: false, error: `Unknown plugin "${pluginId}"` };
			}
			const fields = (plugin.configFields ??
				[]) as PluginConfigResponse["fields"];
			return {
				success: true,
				declared: Boolean(fields?.length) ||
					Boolean((plugin.configUnsupportedReasons as string[])?.length),
				fields,
				title: (plugin.configTitle as string) || undefined,
				config: (plugin.configValues as Record<string, unknown>) ?? {},
				unsupportedReasons:
					(plugin.configUnsupportedReasons as string[]) ?? [],
				editable: false,
				readOnlyReason:
					"Plugin configuration is editable on the desktop host only.",
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},

	// 方案 A:插件只在桌面执行,卸载(删源目录 + 归档数据)自然也只在桌面。
	getPluginFootprint: async (): Promise<PluginFootprintResponse> => ({
		success: false,
		error: "Plugin data lives on the desktop host only.",
	}),

	// file-pick 要的是原生文件对话框与插件数据目录 —— 浏览器里两样都没有。
	// 说出来而不是静默:按钮点下去毫无反应是最难解释的那种失败。
	pickPluginFile: async (): Promise<PickPluginFileResponse> => ({
		error: "Importing files into a plugin works on the desktop app only.",
	}),

	uninstallPlugin: async (): Promise<UninstallPluginResponse> => ({
		success: false,
		error:
			"Plugins are installed and uninstalled on the desktop host only; this server mirrors the plugin catalog read-only.",
	}),

	// P1:npm 生命周期同样只在桌面(web 只投影目录,不执行插件)。
	installPlugin: async (): Promise<InstallPluginResponse> => ({
		success: false,
		error: "Plugins are installed on the desktop host only.",
	}),

	updatePlugin: async (): Promise<UpdatePluginResponse> => ({
		success: false,
		pluginId: "",
		error: "Plugins are updated on the desktop host only.",
	}),

	// 预读要读本机文件系统上的 tarball —— 浏览器里没有那个文件,也没有安装能力。
	readPluginTarball: async (): Promise<ReadPluginTarballResponse> => ({
		success: false,
		errorCode: "not-supported",
		error: "Plugin tarballs are inspected on the desktop host only.",
	}),

	getPluginMarket: async (): Promise<GetPluginMarketResponse> => ({
		success: false,
		entries: [],
		fetchedAt: null,
		stale: false,
		error: 'Plugin market is unavailable in the web host',
	}),
	checkPluginUpdates: async (): Promise<CheckPluginUpdatesResponse> => ({
		success: true,
		offers: [],
	}),

	getPluginLifecycleInfo: async (): Promise<PluginLifecycleInfoResponse> => ({
		success: true,
		npmAvailable: false,
	}),

	setPluginConfig: async (): Promise<SetPluginConfigResponse> => ({
		success: false,
		error:
			"Plugin configuration is editable on the desktop host only; this server mirrors the plugin catalog read-only.",
	}),

	// abort/progress 需要一条活的双向通道;方案 A 下 web 端根本没有执行面,
	// 所以这两个是诚实的空实现,而不是假装能取消。
	abortPluginRequest: async (): Promise<AbortPluginRequestResult> => ({
		success: false,
		aborted: false,
		error: "Plugins execute on the desktop host only",
	}),
	onPluginRequestProgress: () => () => {},


	/**
	 * 「另存为」在浏览器里不是一次宿主对话框,而是一次下载 —— 沙箱里页面自发的
	 * 下载会被拦,所以这里只**承认做不到**并让调用方退回 `<a download>`。
	 */
	saveMediaAs: async () => ({
		success: false,
		error: "Saving a copy is not available in the browser.",
	}),
	onImageGenerated: (
		callback: (payload: {
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
	) =>
		createEventSourceSubscription(
			"/api/media/events",
			"media:image-generated",
			callback,
		),
	/**
	 * 浏览器里「开预览」不是开一个宿主窗口,而是**就地**把这张图交给页内的
	 * `ImagePreviewWindow`。P4c 第三批之前它先 POST 一次 `/api/media/preview/open`
	 * 把 src 存进 server 的登记簿、再把同一个 src 原样广播出去 —— 那趟往返
	 * 从来没有人读(页内订阅拿到的就是 src 本身,`getImagePreview` 在 web 上零调用),
	 * 所以这里只留广播。用户看到的东西一格没变。
	 */
	openImagePreview: async (src: string, alt?: string) => {
		emitImagePreviewUpdate({ mode: "single", src, alt });
		return { success: true };
	},
	onImagePreviewUpdate: subscribeImagePreviewUpdate,
	/**
	 * 「开画廊窗」同样要宿主(桌面开的是第二个 BrowserWindow)。旧的 web 桩 POST
	 * 一次 `/api/media/gallery/open`,而那条路由的实现就是 `return { success: true }` ——
	 * 一次不改变任何东西的往返。这里如实地在本地承认同一件事。
	 */
	openImageGallery: async () => ({ success: true }),

	// ── Sessions:26 条数据面已走通用 RPC 通道(sessionsRouter over POST /api/rpc),
	//    本文件不再镜像一份 REST。剩下的两条与那个域无关:`updateSessionMaxTokens`
	//    桌面从来没有处理者(只有 server 这一条 REST 路由),推送则走 SSE。──
	updateSessionMaxTokens: (sessionId: string, maxTokens: number) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/max-tokens`, {
			maxTokens,
		}),
	onSessionMessagesChanged: createSessionMessagesChangedSubscription,
	// ── Chat:六条数据面已走通用 RPC 通道(chatRouter over POST /api/rpc),
	//    本文件不再镜像一份 REST。留下的只有第七条 —— 它在 web 上从来就不是
	//    一次 invoke,而是命令总线上的一条命令。──
	// 命令总线整只迁到 `session-command` RPC 域(结构债 P4c 第四批),web 壳上不再有
	// `emitCommand`;这一条打的是同一条命令、同一个订阅者,只是换了信封。
	resumeAfterToolConfirm: (sessionId: string, messageId: string) =>
		sessionCommandApi.emit({
			sessionId,
			command: { type: SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM, messageId },
		}),
	getSystemTheme: async () => ({
		success: true,
		theme: getPreferredColorScheme(),
	}),
	onContextSizeUpdated: createContextSizeUpdatedSubscription,
	onSystemThemeChanged: (callback: (theme: "light" | "dark") => void) => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		if (!media) return () => {};
		const listener = () => callback(getPreferredColorScheme());
		media.addEventListener("change", listener);
		return () => media.removeEventListener("change", listener);
	},

	writeClipboardText: async (text: string) => {
		if (!navigator.clipboard?.writeText) {
			return {
				success: false,
				error: "Clipboard write is not available in this browser.",
			};
		}
		await navigator.clipboard.writeText(text);
		return { success: true };
	},
	/**
	 * 浏览器端的「复制图片」。`filePath` 在 server 上是 `/api/media/file/…`,
	 * 所以取字节就是一次同源 fetch。异步剪贴板**只**接 image/png(规范如此,
	 * 不是实现缺陷),其余格式老实说做不到,由调用方决定禁用还是隐藏。
	 */
	writeClipboardImage: async (filePath: string) => {
		const ClipboardItemCtor = (
			window as unknown as { ClipboardItem?: typeof ClipboardItem }
		).ClipboardItem;
		if (!navigator.clipboard?.write || !ClipboardItemCtor) {
			return {
				success: false,
				error: "Clipboard image write is not available in this browser.",
			};
		}
		try {
			const response = await fetch(filePath);
			const blob = await response.blob();
			if (blob.type !== "image/png") {
				return {
					success: false,
					error: "This browser can only copy PNG images to the clipboard.",
				};
			}
			await navigator.clipboard.write([
				new ClipboardItemCtor({ [blob.type]: blob }),
			]);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	},
	openExternal: async (url: string) => {
		if (typeof window === "undefined" || typeof window.open !== "function") {
			return {
				success: false,
				error: "Opening external URLs is not available in this browser.",
			};
		}
		window.open(url, "_blank", "noopener,noreferrer");
		return { success: true };
	},
	showOpenDialog: async () => ({
		canceled: true,
		filePaths: [],
	}),

	onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) =>
		createEventSourceSubscription("/api/events", "session:event", callback),
	onSessionStream: (callback: (payload: SessionStreamPayload) => void) =>
		createEventSourceSubscription("/api/events", "session:stream", callback),
	onStepAdded: createStepAddedSubscription,
	onStepUpdated: createStepUpdatedSubscription,
	onSkillActivated: createSkillActivatedSubscription,
	onTodoPlanChanged: (callback: (payload: TodoPlanChangedPayload) => void) =>
		createEventSourceSubscription<TodoPlanChangedPayload>(
			"/api/todo-plan/events",
			"todo-plan:changed",
			callback,
		),
	onScratchpadChanged: (callback: (payload: ScratchpadChangedPayload) => void) =>
		createEventSourceSubscription<ScratchpadChangedPayload>(
			"/api/scratchpad/events",
			"scratchpad:changed",
			callback,
		),

	// Browsers never expose local file paths.
	getPathForFile: () => "",

	// A browser tab has no window of ours to close.
	closeWindow: async () => ({ success: false }),

	onMenuNewChat: () => () => {},
	onMenuCloseChat: () => () => {},
	onMenuNewBrowserTab: () => () => {},
	onSearchAction: subscribeSearchAction,

	/**
	 * 系统通知(agent-dm-user.md §4.2)在 web 端降级为**只剩未读墨点**。
	 *
	 * 不是"还没做"而是刻意留白:浏览器的 Notification 要先问权限,而一个页面
	 * 在用户没要求的情况下弹权限框是骚扰。真要做,入口该是设置里的一次显式授权,
	 * 不是这里悄悄申请。
	 */
	notify: {
		show: async () => ({ success: true }),
		setBadge: async () => ({ success: true }),
		onActivate: () => () => {},
	},
};

export function createWebPlatformApi(): PlatformApi {
	refreshWebCapabilities().catch(() => {
		// Keep the conservative startup defaults when the server is unreachable.
	});
	return new Proxy(webApi, {
		get(target, property: string | symbol) {
			if (property in target) return target[property as keyof typeof target];
			if (typeof property === "string") {
				return isSubscriptionMethod(property)
					? unsupportedSubscription(property)
					: unsupported(property);
			}
			return undefined;
		},
	}) as unknown as PlatformApi;
}
