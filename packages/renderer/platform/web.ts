import type {
	CreateSessionOptions,
	AppSettings,
	PracticeConfigResponse,
	PracticeSummaryRequest,
	SpacesCreateRequest,
	SpacesClearCredentialRequest,
	SpacesSetCredentialPoolRequest,
	SpacesSetCredentialRequest,
	SpacesSetOverlayRequest,
	SpacesSetProviderSettingsRequest,
	SpacesUpdateRequest,
	ACPAgentConfig,
	GatewayStartRequest,
	GatewayWechatAddAccountRequest,
	GatewayWechatLogoutRequest,
	GatewayWechatRemoveAccountRequest,
	GatewayWechatRenameAccountRequest,
	GatewayWechatStopAccountRequest,
	GetSessionMessagesPageRequest,
	MCPServerConfig,
	MediaIngestFilesRequest,
	MediaQuery,
	MediaSource,
	MediaUsageTag,
	PermissionMode,
	ProxySettings,
	SchedulerCreateTaskRequest,
	SchedulerDeleteTaskRequest,
	SchedulerGetRequest,
	SchedulerGetRunRequest,
	SchedulerListRunsRequest,
	SchedulerRunNowRequest,
	SchedulerSetEnabledRequest,
	SchedulerUpdateTaskRequest,
	ScratchpadAdoptRequest,
	ScratchpadChangedPayload,
	ScratchpadDeleteRequest,
	ScratchpadGetRequest,
	ScratchpadUpdateRequest,
	SearchRequest,
	Step,
	TodoPlanChangedPayload,
	TodoPlanWindowActionRequest,
	TodoPlanWindowDragRequest,
	ToolCall,
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
	OAuthCredentialTargetRequest,
} from "@/types";
import type { SessionCommand, SessionEventEnvelope } from "@shared/events";
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
const MUSIC_UNSUPPORTED = "音乐电台仅在桌面端可用";
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

/**
 * 请求失败不抛,回一份结构化的 `{ success:false }`(可带补充字段)。
 *
 * 给「server 还没有这条路由,但渲染层必须活下去」的能力用 —— spaces(批 B1)
 * 就是这一档:web 端拿不到空间列表就退成只有 default,而不是把左栏整片带塌。
 */
async function softJson<T extends object>(
	path: string,
	fallbackPayload?: object,
	init?: { method?: string; body?: unknown },
): Promise<T> {
	try {
		const value = await requestJson<T>(path, {
			method: init?.method,
			body: init?.body === undefined ? undefined : JSON.stringify(init.body),
		});
		return value;
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Request failed",
			code: "UNAVAILABLE",
			...fallbackPayload,
		} as unknown as T;
	}
}

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
	// Collab rooms (P0-P2 desktop-only; collabRooms capability gates the UI)
	"getCollabBoard",
	"actCollabBoard",
	"stopCollabTask",
	"setCollabRoomFrozen",
	"setCollabRoomBudgets",
	"getCollabRoomSpend",
	"getCollabCoordinator",
	// 人级停止(E5):撤牌的落点在主进程的 v3 房账里,与协调器同一条边界
	"revokeCollabRoomLease",
	// Agent 活动快照(D8 §3.1):供数在主进程的 v3 运行时里,与协调器同一条边界
	"getCollabAgentActivity",
	// 调度时间轴(D8 §3.3):账文件在主进程的 store 里,与 room folder 同一条理由
	"getCollabSchedulerLog",
	"updateCollabRoom",
	"clearCollabRoomHistory",
	"reactToCollabMessage",
	// 托管私聊房也是 room(agent-im-dm.md §7 开放问题:rooms 上服务器是独立议题)
	"ensureCollabDmRoom",
	// 群 folder 列目录同理:folder 是主进程 store 里的路径
	"listCollabRoomFolder",
	// Interaction(agent 提问 → 用户应答,E1)。内核在主进程的 InteractionRegistry
	// 里,web 侧要接得起来得先有 /api/interactions/* 两条路由 —— 那是 apps/server
	// 的活,不在 E1 范围。**桩掉不会把提问挂住**:deadline 由内核自结算,web 端
	// 不应答的后果是到点 timeout,而不是像 F3 那样永远等下去。
	"getPendingInteractions",
	"respondInteraction",
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

	getAppState: () => requestJson("/api/app-state"),
	saveUIState: (uiState: {
		workspace?: import("@/stores/workspace-persistence").PersistedWorkspace;
		sidebarCollapsed?: boolean;
		sessionReadMarks?: import("@/stores/session-read-marks").PersistedSessionReadMarks;
	}) => postJson("/api/app-state/ui", uiState),

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

	getThemes: () => requestJson("/api/themes"),
	getTheme: (themeId: string) =>
		requestJson(`/api/themes/${encodeURIComponent(themeId)}`),
	applyTheme: (themeId: string, mode: "dark" | "light") =>
		postJson(`/api/themes/${encodeURIComponent(themeId)}/apply`, { mode }),
	refreshThemes: (projectPath?: string) =>
		postJson("/api/themes/refresh", { projectPath }),
	openThemesFolder: () => postJson("/api/themes/open-folder"),

	getSystemPromptSnapshot: (sessionId: string) =>
		requestJson(
			`/api/sessions/${encodeURIComponent(sessionId)}/system-prompt-snapshot`,
		),
	// User prompt snippets 走通用 RPC(promptsRouter),见文件末尾的域客户端一行区。

	getSkills: (workingDirectory?: string) => {
		const query = workingDirectory
			? `?workingDirectory=${encodeURIComponent(workingDirectory)}`
			: "";
		return requestJson(`/api/skills${query}`);
	},
	refreshSkills: () => postJson("/api/skills/refresh"),
	readSkillFile: (skillId: string, fileName: string) =>
		postJson("/api/skills/read-file", { skillId, fileName }),
	openSkillDirectory: (skillId?: string) =>
		postJson("/api/skills/open-directory", { skillId }),
	createSkill: (
		name: string,
		description: string,
		instructions: string,
		source: string,
	) => postJson("/api/skills", { name, description, instructions, source }),
	deleteSkill: (skillId: string) =>
		requestJson(`/api/skills/${encodeURIComponent(skillId)}`, {
			method: "DELETE",
		}),
	toggleSkillEnabled: (skillId: string, enabled: boolean) =>
		postJson(`/api/skills/${encodeURIComponent(skillId)}/toggle`, { enabled }),
	listSkillDirectories: () => requestJson("/api/skills/directories"),
	addSkillDirectory: (request: {
		path: string;
		label?: string;
		agentId?: string | null;
	}) => postJson("/api/skills/directories", request),
	updateSkillDirectory: (request: { id: string }) =>
		postJson(
			`/api/skills/directories/${encodeURIComponent(request.id)}/update`,
			request,
		),
	removeSkillDirectory: (id: string) =>
		requestJson(`/api/skills/directories/${encodeURIComponent(id)}`, {
			method: "DELETE",
		}),
	setSkillAgent: (skillId: string, agentId: string | null) =>
		postJson(`/api/skills/${encodeURIComponent(skillId)}/agent`, { agentId }),
	executeSkill: (
		skillId: string,
		options: { sessionId: string; input: string },
	) => postJson("/api/skills/execute", { skillId, options }),

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
	// 末位 `_target` 是 per-space 凭证的写回目标(批 B6)。**web 端收下即丢** ——
	// apps/server 没有 space 维度(B4 勘误 5 同一条口径),转发给一个不认识它的
	// 宿主只会造出「以为分空间登录了」的假象。形态对齐,语义诚实。
	oauthStart: (providerId: string, _target?: OAuthCredentialTargetRequest) =>
		postJson("/api/oauth/start", { providerId }),
	oauthCallback: (
		providerId: string,
		code: string,
		state: string,
		_target?: OAuthCredentialTargetRequest,
	) => postJson("/api/oauth/callback", { providerId, code, state }),
	oauthLogout: (providerId: string, _target?: OAuthCredentialTargetRequest) =>
		postJson("/api/oauth/logout", { providerId }),
	oauthGetStatus: (providerId: string, _target?: OAuthCredentialTargetRequest) =>
		postJson("/api/oauth/status", { providerId }),
	oauthDevicePoll: (
		providerId: string,
		flowId?: string,
		_target?: OAuthCredentialTargetRequest,
	) => postJson("/api/oauth/device-poll", { providerId, flowId }),
	oauthRefresh: (providerId: string, _target?: OAuthCredentialTargetRequest) =>
		postJson("/api/oauth/refresh", { providerId }),
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
	gatewayGetStatus: () => requestJson("/api/gateway/status"),
	gatewayStart: (request?: GatewayStartRequest) =>
		postJson("/api/gateway/start", request),
	gatewayStop: () => postJson("/api/gateway/stop"),
	gatewayWechatLogout: (request?: GatewayWechatLogoutRequest) =>
		postJson("/api/gateway/wechat/logout", request ?? {}),
	gatewayWechatAddAccount: (request?: GatewayWechatAddAccountRequest) =>
		postJson("/api/gateway/wechat/accounts/add", request ?? {}),
	gatewayWechatStopAccount: (request: GatewayWechatStopAccountRequest) =>
		postJson("/api/gateway/wechat/accounts/stop", request),
	gatewayWechatRemoveAccount: (request: GatewayWechatRemoveAccountRequest) =>
		postJson("/api/gateway/wechat/accounts/remove", request),
	gatewayWechatRenameAccount: (request: GatewayWechatRenameAccountRequest) =>
		postJson("/api/gateway/wechat/accounts/rename", request),
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
	acpGetAgents: () => requestJson("/api/acp/agents"),
	acpAddAgent: (config: ACPAgentConfig) =>
		postJson("/api/acp/agents", { config }),
	acpUpdateAgent: (config: ACPAgentConfig) =>
		postJson("/api/acp/agents/update", { config }),
	acpRemoveAgent: (agentId: string) =>
		postJson("/api/acp/agents/remove", { agentId }),
	acpConnectAgent: (agentId: string) =>
		postJson("/api/acp/agents/connect", { agentId }),
	acpDisconnectAgent: (agentId: string) =>
		postJson("/api/acp/agents/disconnect", { agentId }),
	acpRefreshAgent: (agentId: string) =>
		postJson("/api/acp/agents/refresh", { agentId }),
	acpCancelSession: (sessionId: string, agentId?: string) =>
		postJson("/api/acp/sessions/cancel", { sessionId, agentId }),

	getScratchpad: (request: ScratchpadGetRequest) =>
		postJson("/api/scratchpad/get", request),
	updateScratchpad: (request: ScratchpadUpdateRequest) =>
		postJson("/api/scratchpad/update", request),
	deleteScratchpad: (request: ScratchpadDeleteRequest) =>
		postJson("/api/scratchpad/delete", request),
	adoptScratchpad: (request: ScratchpadAdoptRequest) =>
		postJson("/api/scratchpad/adopt", request),

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

	// The radio drives ncm-cli's mpv on the host machine, so a browser client
	// would only make audio come out of the server. Unsupported by design.
	musicGetState: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicSetup: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	onMusicEvent: () => () => {},
	musicCommand: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicGetNowPlaying: () => Promise.resolve(null),
	musicGetRadio: () =>
		Promise.resolve({ active: false, intent: '', programmeLength: 0, canResume: false }),
	musicOpenRadio: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicSearch: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicRequestSong: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicGetProgramme: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicProgrammeAction: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicListProviders: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicSetProvider: () => Promise.resolve({ success: false, error: MUSIC_UNSUPPORTED }),
	musicGetLyrics: () => Promise.resolve(null),
	onMusicLyrics: () => () => {},
	onMusicNowPlaying: () => () => {},
	onMusicDjSpeak: () => () => {},
	musicDjSpeakDone: () => Promise.resolve(),

	getTools: () => requestJson("/api/tools"),
	executeTool: (
		toolId: string,
		args: Record<string, unknown>,
		messageId: string,
		sessionId: string,
	) =>
		postJson("/api/tools/execute", {
			toolId,
			arguments: args,
			messageId,
			sessionId,
		}),
	cancelTool: (toolCallId: string) =>
		postJson("/api/tools/cancel", { toolCallId }),
	updateToolCall: (
		sessionId: string,
		messageId: string,
		toolCallId: string,
		updates: Partial<ToolCall>,
	) =>
		postJson("/api/tools/update-call", {
			sessionId,
			messageId,
			toolCallId,
			updates,
		}),
	listBackgroundJobs: (options?: { includeInactive?: boolean }) => {
		const query = options?.includeInactive ? "?includeInactive=true" : "";
		return requestJson(`/api/tools/background-jobs${query}`);
	},
	stopBackgroundJob: (jobId: string) =>
		postJson(`/api/tools/background-jobs/${encodeURIComponent(jobId)}/stop`),

	mcpGetServers: () => requestJson("/api/mcp/servers"),
	mcpAddServer: (config: MCPServerConfig) =>
		postJson("/api/mcp/servers", config),
	mcpUpdateServer: (config: MCPServerConfig) =>
		postJson(
			`/api/mcp/servers/${encodeURIComponent(config.id || "")}/update`,
			config,
		),
	mcpRemoveServer: (serverId: string) =>
		requestJson(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
			method: "DELETE",
		}),
	mcpConnectServer: (serverId: string) =>
		postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/connect`),
	mcpDisconnectServer: (serverId: string) =>
		postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/disconnect`),
	mcpLogoutServer: (serverId: string) =>
		postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/oauth/logout`),
	mcpProbeServer: (config: MCPServerConfig) =>
		postJson(`/api/mcp/probe`, config),
	mcpRefreshServer: (serverId: string) =>
		postJson(`/api/mcp/servers/${encodeURIComponent(serverId)}/refresh`),
	mcpGetTools: () => requestJson("/api/mcp/tools"),
	mcpCallTool: (
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
	) => postJson("/api/mcp/tools/call", { serverId, toolName, arguments: args }),
	mcpGetResources: () => requestJson("/api/mcp/resources"),
	mcpReadResource: (serverId: string, uri: string) =>
		postJson("/api/mcp/resources/read", { serverId, uri }),
	mcpGetPrompts: () => requestJson("/api/mcp/prompts"),
	mcpGetPrompt: (
		serverId: string,
		name: string,
		args?: Record<string, string>,
	) => postJson("/api/mcp/prompts/get", { serverId, name, arguments: args }),
	mcpReadConfigFile: (filePath: string) =>
		postJson("/api/mcp/config-file/read", { filePath }),

	listFiles: (request: {
		cwd?: string;
		query?: string;
		limit?: number;
		sessionId?: string;
	}) => postJson("/api/files/list", request),
	listDirs: (request: { basePath: string; query?: string; limit?: number }) =>
		postJson("/api/dirs/list", request),
	readFileContent: (filePath: string, maxSize?: number) =>
		postJson("/api/files/read", { path: filePath, maxSize }),
	saveFileContent: (
		filePath: string,
		content: string,
		expectedMtimeMs?: number,
	) =>
		postJson("/api/files/save", { path: filePath, content, expectedMtimeMs }),
	rollbackFile: (request: {
		auditPath?: string;
		filePath?: string;
		originalContent?: string;
		isNew?: boolean;
	}) => postJson("/api/files/rollback", request),
	watchWorkspace: (root: string) =>
		postJson("/api/files/watch/start", { root }),
	unwatchWorkspace: (root: string) =>
		postJson("/api/files/watch/stop", { root }),
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
	listDirectory: (dirPath: string) =>
		postJson("/api/files/list-directory", { path: dirPath }),
	statPath: (targetPath: string) =>
		postJson("/api/files/stat", { path: targetPath }),
	createFile: (filePath: string, content?: string) =>
		postJson("/api/files/create", { path: filePath, content }),
	createDirectory: (dirPath: string) =>
		postJson("/api/files/create-directory", { path: dirPath }),
	renamePath: (oldPath: string, newPath: string) =>
		postJson("/api/files/rename", { oldPath, newPath }),
	deletePath: (targetPath: string) =>
		postJson("/api/files/delete", { path: targetPath }),
	revealPath: (targetPath: string) =>
		postJson("/api/files/reveal", { path: targetPath }),
	recordEvalsDownvote: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsListRecords: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsListFixtures: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsReadFixture: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsListResults: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsListCases: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsGetCase: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsRunStart: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsRunCancel: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	onEvalsRunProgress: () => () => {},
	evalsPromoteFixture: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsRetireCase: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsGenerateTriage: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsReadRunDetail: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsIncidentList: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsIncidentGet: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsIncidentUpdate: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsIncidentReadFile: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsReplayStart: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsReplayCancel: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	onEvalsReplayProgress: () => () => {},
	evalsIncidentAnalyze: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsIncidentPromote: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsDiagnoseStart: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	onEvalsDiagnoseProgress: () => () => {},
	evalsRoundList: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	evalsRoundReplay: async () => ({
		success: false,
		error: "Evals is not supported in the web build",
	}),
	listVariables: (sessionId: string) =>
		postJson("/api/variables/list", { sessionId }),
	setVariable: (
		sessionId: string,
		name: string,
		value: string,
		description?: string,
		scope?: "global" | "session" | "agent" | "project",
	) =>
		postJson("/api/variables/set", {
			sessionId,
			name,
			value,
			description,
			scope,
		}),
	deleteVariable: (sessionId: string, name: string) =>
		postJson("/api/variables/delete", { sessionId, name }),

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

	// Practice runs on the Electron main process; the web build has no engine.
	// Values mirror ONETHING_PRACTICE_DEFAULT_CONFIG (no value import: the
	// runtime practice module pulls node:fs into the bundle).
	practiceStart: async () => ({ snapshot: { status: "idle" as const } }),
	practicePause: async () => ({ snapshot: { status: "idle" as const } }),
	practiceResume: async () => ({ snapshot: { status: "idle" as const } }),
	practiceStop: async () => ({ snapshot: { status: "idle" as const } }),
	practiceGetState: async () => ({ snapshot: { status: "idle" as const } }),
	practiceLog: async () => {
		throw new Error("Practice logging is not supported in the web build");
	},
	practiceSummary: async (request: PracticeSummaryRequest) => ({
		granularity: request.granularity,
		buckets: [],
	}),
	practiceRecent: async () => ({ records: [] }),
	practiceGetConfig: async (): Promise<PracticeConfigResponse> => ({
		config: {
			kegel: { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true },
			pomodoro: { minutes: 25, categories: ["学习", "看视频", "写作", "其他"] },
		},
	}),
	practiceSetConfig: async (): Promise<PracticeConfigResponse> => ({
		config: {
			kegel: { holdSec: 10, relaxSec: 5, reps: 20, sets: 3, setRestSec: 60, sound: true },
			pomodoro: { minutes: 25, categories: ["学习", "看视频", "写作", "其他"] },
		},
	}),
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

	// 名册 per-space 是桌面宿主的维度:apps/server 没有 space,`workspaceId` 在这里
	// 收下即丢 —— 传给一个不认识它的宿主只会造成「以为分家了」的假象(批 B4)。
	projectDirsList: (_workspaceId?: string) => requestJson("/api/project-dirs"),
	projectDirsGet: (path: string, _workspaceId?: string) =>
		postJson("/api/project-dirs/get", { path }),
	projectDirsAdd: (
		path: string,
		description?: string,
		paths?: string[],
		_workspaceId?: string,
	) => postJson("/api/project-dirs", { path, description, paths }),
	projectDirsUpdate: (
		path: string,
		patch: { description?: string; paths?: string[] },
		_workspaceId?: string,
	) => postJson("/api/project-dirs/update", { path, ...patch }),
	// Spaces(workspace)—— server 端本切片没有 /api/spaces 路由,请求必然失败。
	// 这里**不抛**:store 拿不到列表就降级成「只有 default 空间、切换器不画」,
	// 而不是让整个左栏跟着炸(优雅降级,见 workspace-spaces-2026-08.md 批 B1)。
	spacesList: () => softJson("/api/spaces", { spaces: [] }),
	spacesCreate: (request: SpacesCreateRequest) =>
		softJson("/api/spaces", undefined, { method: "POST", body: request }),
	spacesUpdate: (request: SpacesUpdateRequest) =>
		softJson(`/api/spaces/${encodeURIComponent(request.id)}`, undefined, {
			method: "POST",
			body: request,
		}),
	spacesRemove: (id: string) =>
		softJson(`/api/spaces/${encodeURIComponent(id)}`, undefined, {
			method: "DELETE",
		}),
	// overlay(批 B2)同样没有 server 路由:读退成空 overlay(= 只有全局层),
	// 写退成 `{success:false}`,设置页据此把 space 段标成不可用。
	spacesGetOverlay: (id: string) =>
		softJson(`/api/spaces/${encodeURIComponent(id)}/overlay`, { overlay: {} }),
	spacesSetOverlay: (request: SpacesSetOverlayRequest) =>
		softJson(`/api/spaces/${encodeURIComponent(request.id)}/overlay`, undefined, {
			method: "POST",
			body: request,
		}),
	// 整套 provider 设置(C2):同样没有 server 路由。读退成「这个空间是空的」,
	// 写退成 `{success:false}` —— 渲染层据此落回 `/api/settings` 那一份(web 端
	// 只有一个空间,那份就是 default 的生效设置)。
	spacesGetProviderSettings: (id: string) =>
		softJson(`/api/spaces/${encodeURIComponent(id)}/provider-settings`, undefined),
	spacesSetProviderSettings: (request: SpacesSetProviderSettingsRequest) =>
		softJson(
			`/api/spaces/${encodeURIComponent(request.id)}/provider-settings`,
			undefined,
			{ method: "POST", body: request },
		),
	// 凭证池(批 B3):server 侧没有这些路由,一律走 softJson 降级 —— 空凭证表
	// 即「这个宿主管不了空间凭证」,设置页那一段自然不画。
	spacesGetCredentials: (id: string) =>
		softJson(`/api/spaces/${encodeURIComponent(id)}/credentials`, {
			credentials: { providers: {} },
		}),
	spacesSetCredential: (request: SpacesSetCredentialRequest) =>
		softJson(`/api/spaces/${encodeURIComponent(request.id)}/credentials`, undefined, {
			method: "POST",
			body: request,
		}),
	spacesSetCredentialPool: (request: SpacesSetCredentialPoolRequest) =>
		softJson(`/api/spaces/${encodeURIComponent(request.id)}/credentials/pool`, undefined, {
			method: "POST",
			body: request,
		}),
	spacesClearCredential: (request: SpacesClearCredentialRequest) =>
		softJson(`/api/spaces/${encodeURIComponent(request.id)}/credentials/clear`, undefined, {
			method: "POST",
			body: request,
		}),
	spacesImportCredentials: (id: string) =>
		softJson(`/api/spaces/${encodeURIComponent(id)}/credentials/import`, undefined, {
			method: "POST",
			body: { id },
		}),
	projectDirsRemove: (path: string, _workspaceId?: string) =>
		postJson("/api/project-dirs/remove", { path }),

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
	}) => postJson("/api/media/save-image", data),
	loadAllMedia: () => requestJson("/api/media/legacy-images"),
	deleteMedia: (id: string) => postJson("/api/media/delete", { id }),
	clearAllMedia: () => postJson("/api/media/clear-all"),
	readImageBase64: (filePath: string) =>
		postJson("/api/media/read-image", { filePath }),
	listMediaAssets: (query?: {
		kind?: string;
		source?: string;
		search?: string;
		includeHidden?: boolean;
	}) => {
		const params = new URLSearchParams();
		if (query?.kind) params.set("kind", query.kind);
		if (query?.source) params.set("source", query.source);
		if (query?.search) params.set("search", query.search);
		if (query?.includeHidden) params.set("includeHidden", "true");
		const suffix = params.toString() ? `?${params.toString()}` : "";
		return requestJson(`/api/media/assets${suffix}`);
	},
	// 浏览器没有本地路径可给,所以 body 里一定是 base64(桌面才走 filePath)。
	// 请求整体透传:字段是共享契约,这里不逐个手抄。
	ingestMediaFiles: (request: MediaIngestFilesRequest) =>
		postJson("/api/media/ingest", request),
	/**
	 * 「另存为」在浏览器里不是一次宿主对话框,而是一次下载 —— 沙箱里页面自发的
	 * 下载会被拦,所以这里只**承认做不到**并让调用方退回 `<a download>`。
	 */
	saveMediaAs: async () => ({
		success: false,
		error: "Saving a copy is not available in the browser.",
	}),
	hideMediaAsset: (id: string) => postJson("/api/media/assets/hide", { id }),
	rebuildMediaLibrary: () => postJson("/api/media/rebuild"),
	getMediaGallery: (assetId: string, query?: MediaQuery) =>
		postJson("/api/media/gallery", { assetId, query }),
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
	openImagePreview: async (src: string, alt?: string) => {
		const response = await postJson<{ success?: boolean; previewId?: string }>(
			"/api/media/preview/open",
			{ src, alt },
		);
		if (response.success) {
			emitImagePreviewUpdate({
				mode: "single",
				previewId: response.previewId,
				src,
				alt,
			});
		}
		return response;
	},
	getImagePreview: (previewId: string) =>
		postJson("/api/media/preview/get", { previewId }),
	onImagePreviewUpdate: subscribeImagePreviewUpdate,
	openImageGallery: (mediaId: string) =>
		postJson("/api/media/gallery/open", { mediaId }),

	getSessionsList: () => requestJson("/api/sessions"),
	// 会话列表一律元数据(与 Electron IPC GET_SESSIONS 行为一致);消息经
	// activate/分页接口按会话加载,不存在全量含消息的列表请求。
	getSessions: () => requestJson("/api/sessions"),
	createSession: (
		name: string,
		options?: CreateSessionOptions,
	) =>
		// kind/room are desktop-only in P0 (rooms need the collab coordinator);
		// the server rejects unknown kinds if ever passed.
		postJson("/api/sessions", {
			name,
			sessionId: options?.sessionId,
			workspaceId: options?.workspaceId,
			kind: options?.kind,
			room: options?.room,
		}),
	activateSession: (sessionId: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/activate`),
	getSession: (sessionId: string) =>
		requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`),
	switchSession: (sessionId: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/switch`),
	deleteSession: (sessionId: string) =>
		requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, {
			method: "DELETE",
		}),
	renameSession: (sessionId: string, newName: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, {
			name: newName,
		}),
	createBranch: (parentSessionId: string, branchFromMessageId: string) =>
		postJson("/api/sessions/branch", { parentSessionId, branchFromMessageId }),
	updateSessionArchived: (
		sessionId: string,
		isArchived: boolean,
		archivedAt?: number | null,
	) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
			isArchived,
			archivedAt,
		}),
	updateSessionWorkingDirectory: (
		sessionId: string,
		workingDirectory: string | null,
	) =>
		postJson(
			`/api/sessions/${encodeURIComponent(sessionId)}/working-directory`,
			{ workingDirectory },
		),
	updateSessionAgent: (sessionId: string, agentId: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/agent`, {
			agentId,
		}),
	updateSessionPermissionMode: (
		sessionId: string,
		permissionMode: PermissionMode,
	) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
			permissionMode,
		}),
	updateSessionModel: (sessionId: string, provider: string, model: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/model`, {
			provider,
			model,
		}),
	updateSessionMaxTokens: (sessionId: string, maxTokens: number) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/max-tokens`, {
			maxTokens,
		}),
	getPendingPermissions: (sessionId: string) =>
		requestJson(
			`/api/sessions/${encodeURIComponent(sessionId)}/permissions/pending`,
		),
	clearSessionPermissions: (sessionId: string) =>
		postJson(
			`/api/sessions/${encodeURIComponent(sessionId)}/permissions/clear`,
		),

	getSessionMessagesPage: (request: GetSessionMessagesPageRequest) =>
		postJson("/api/session-messages/page", request),
	getSessionUserMarkers: (sessionId: string) =>
		requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/user-markers`),
	// The web build has no TOC pipeline (it runs in the Electron main process);
	// returning empty hides the preview rather than erroring on hover.
	getSessionSegments: async () => ({ success: true, segments: [] }),
	onSessionMessagesChanged: createSessionMessagesChangedSubscription,
	// Web build has no in-process session LRU cache to report on; stub keeps
	// the "cached" tab badge silently off instead of wiring a server endpoint.
	getSessionCacheStats: () =>
		Promise.resolve({ size: 0, maxSize: 0, cachedSessionIds: [] }),
	evictSessionCache: () => Promise.resolve({ success: true }),
	getChatHistory: (sessionId: string) =>
		postJson("/api/chat/history", { sessionId }),
	generateTitle: (message: string) => postJson("/api/chat/title", { message }),
	getSessionMessages: (sessionId: string) =>
		postJson("/api/chat/messages", { sessionId }),
	getSessionTokenUsage: (sessionId: string) =>
		postJson("/api/chat/token-usage", { sessionId }),
	updateSessionPin: (sessionId: string, isPinned: boolean) =>
		postJson("/api/chat/update-session-pin", { sessionId, isPinned }),
	addSystemMessage: (
		sessionId: string,
		message: { id: string; role: string; content: string; timestamp: number },
	) => postJson("/api/chat/add-system-message", { sessionId, message }),
	removeFilesChangedMessage: (sessionId: string) =>
		postJson("/api/chat/remove-system-marker", {
			sessionId,
			markerType: "files-changed",
		}),
	removeGitStatusMessage: (sessionId: string) =>
		postJson("/api/chat/remove-system-marker", {
			sessionId,
			markerType: "git-status",
		}),
	removeMessage: (sessionId: string, messageId: string) =>
		postJson("/api/chat/remove-message", { sessionId, messageId }),
	updateMessageThinkingTime: (
		sessionId: string,
		messageId: string,
		thinkingTime: number,
	) =>
		postJson("/api/chat/update-thinking-time", {
			sessionId,
			messageId,
			thinkingTime,
		}),
	emitCommand: (sessionId: string, command: SessionCommand) =>
		postJson(
			`/api/sessions/${encodeURIComponent(sessionId)}/commands`,
			command,
		),
	resumeAfterToolConfirm: (sessionId: string, messageId: string) =>
		postJson(`/api/sessions/${encodeURIComponent(sessionId)}/commands`, {
			type: SESSION_COMMAND_TYPES.RESUME_AFTER_CONFIRM,
			messageId,
		}),
	abortStream: (sessionId?: string) =>
		postJson("/api/streams/abort", { sessionId }),
	getActiveStreams: () => requestJson("/api/streams/active"),

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

	listSchedulerTasks: () => requestJson("/api/scheduler/tasks"),
	getSchedulerTask: (request: SchedulerGetRequest) =>
		postJson("/api/scheduler/tasks/get", request),
	runSchedulerTaskNow: (request: SchedulerRunNowRequest) =>
		postJson("/api/scheduler/tasks/run-now", request),
	setSchedulerTaskEnabled: (request: SchedulerSetEnabledRequest) =>
		postJson("/api/scheduler/tasks/enabled", request),
	createSchedulerTask: (request: SchedulerCreateTaskRequest) =>
		postJson("/api/scheduler/tasks", request),
	updateSchedulerTask: (request: SchedulerUpdateTaskRequest) =>
		postJson("/api/scheduler/tasks/update", request),
	deleteSchedulerTask: (request: SchedulerDeleteTaskRequest) =>
		postJson("/api/scheduler/tasks/delete", request),
	listSchedulerRuns: (request: SchedulerListRunsRequest) =>
		postJson("/api/scheduler/runs", request),
	getSchedulerRun: (request: SchedulerGetRunRequest) =>
		postJson("/api/scheduler/runs/get", request),

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
