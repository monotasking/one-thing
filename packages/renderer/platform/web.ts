import type {
	ScratchpadChangedPayload,
	Step,
	TodoPlanChangedPayload,
	VoiceEvent,
	VoiceRuntimeCommand,
} from "@/types";
import type { SessionEventEnvelope } from "@shared/events";
import type { AppSettings } from "@shared/ipc/settings.js";
import type { RpcRequest, RpcResponse } from "@shared/ipc/rpc.js";
import { IPC_CHANNELS } from "@shared/ipc/channels.js";
import { goalRouter } from "@shared/ipc/goal.js";
import { promptsRouter } from "@shared/ipc/prompts.js";
import { todoPlanRouter } from "@shared/ipc/todo-plan.js";
import { usageRouter } from "@shared/ipc/usage.js";
import type { TransportEvents } from "@onething/client";
import { clientApi, clientFor, transportFor, webApiUrl } from "./client";
import { dispatchWebShell, registerWebShellDomains } from "./shell-web";
import { subscribeWebSse } from "./web-sse";
import type {
	PlatformApi,
	PlatformCapabilities,
	SessionStreamPayload,
} from "./types";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";

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
	// P4 终态批 B(拍板 #12 / #13 / #15 / #17):四颗「通道通了但位关着」的能力位
	// 一起放开。这里是**静态默认**,服务器仍可在 `/api/capabilities` 里把某一位
	// 按下去(见 `normalizeServerCapabilities`)。collabRooms 是唯一真会被按下去
	// 的那颗:房间要进程内的 collab v3 actor,桌面(内嵌 HTTP 面)有、独立
	// `server:start` 没有,server 按 `isCollabV3RuntimeRunning()` 如实下发。
	// music:谁在服务这个 store,谁的机器就是那台放音机(桌面就是本机)。
	// interactionRespond:应答盖的章是那次提问自己的 `targetChannel`,由宿主从
	// 内核活账里读、不从请求体里读 —— 浏览器答桌面的提问因此不是冒答。
	// evals:按 wire 路径读盘的四条在 http 上夹进 evals 面自己那两棵树,越界结构化失败。
	collabRooms: true,
	music: true,
	interactionRespond: true,
	evals: true,
	// P4 终态批 C2(#16):插件写面在 web 上**默认关**。方案 A 下插件只在桌面
	// 执行 —— 安装要本机 npm、配置要写桌面那份 `config.json`、file-pick 要原生
	// 对话框。放开 = 把下面这行改成 `true`(或让它跟着 `/api/capabilities` 走),
	// 而那是一次独立拍板。
	pluginsManage: false,
	clipboardWrite: browserClipboardWriteCapability(),
	desktopWindows: false,
	globalMenuEvents: false,
};

type Unsubscribe = () => void;
type SearchActionHandler = (actionId: string) => void;
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

/**
 * 剩下的这一条 `fetch` 包装只服务**宿主壳路由的 web 侧**(`shell-web/search-window`
 * 的 `POST /api/search/execute-action`)—— core 的三条口(`/api/rpc` /
 * `/api/events` / `/api/capabilities`)已经全归 `@onething/client` 的 HTTP 传输,
 * 本文件不再自己拼它们。基址与传输同一个(`webApiUrl`);**Bearer 仍由
 * `apps/web/dev-api-proxy.ts` 注入,这里一个 token 都不补**(决不双份注入 ——
 * C1 之前 `transport-config.ts` 那条纪律的原话)。
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(webApiUrl(path), {
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
 * 通用 RPC 传输面 —— C2 起底下是 `@onething/client` 的 HTTP 传输
 * (`POST /api/rpc`,与从前逐字同一条路由),而不是本文件手拼的 fetch。
 * `rpcInvoke` 仍挂在 `PlatformApi` 上:它是 `ElectronAPI` 契约的一格,web 实现
 * 必须给出。四个域客户端走 `clientApi(...)`(按访问解析宿主 + 按 router 记忆)。
 */
const rpcInvoke = (request: RpcRequest): Promise<RpcResponse> =>
	transportFor().invoke(request);
const usageApi = clientApi(usageRouter);
const promptsApi = clientApi(promptsRouter);
const goalApi = clientApi(goalRouter);
const todoPlanApi = clientApi(todoPlanRouter);

/**
 * 宿主壳传输面(结构债 P4 终态批 A1-a)。窗口系的"宿主"在浏览器里就是渲染层
 * 自己,所以这条不出网:它打的是 `shell-web/registry` 那张本地派发表。
 * 八个域在下面注册一次,加域不再动本文件的管道。
 */
registerWebShellDomains({ postJson, emitSearchAction, emitImagePreviewUpdate });

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
		// 真 PTY:D2 迁 router 时按用户拍板保持默认关(真闸是域的 http 分叉)。
		terminal: booleanProperty(value, "terminal", false),
		// Embedded WebContentsView browser is Electron-only; web falls back to iframe.
		embeddedBrowser: booleanProperty(value, "embeddedBrowser", false),
		// P4 终态批 B(#12 / #13 / #15 / #17):四颗默认 true,但**服务器是权威**。
		// `collabRooms` 是唯一真会被按下去的那颗(`server/runtime.ts` 按
		// `isCollabV3RuntimeRunning()` 下发:桌面内嵌面 true、独立 server false);
		// 另外三颗今天没有宿主下发,默认值就是结果 —— 留着 `booleanProperty` 是
		// 为了以后某个宿主想按下去时不用再动渲染侧一行。
		collabRooms: booleanProperty(value, "collabRooms", true),
		music: booleanProperty(value, "music", true),
		interactionRespond: booleanProperty(value, "interactionRespond", true),
		evals: booleanProperty(value, "evals", true),
		// P4 终态批 C2(#16):插件写面默认关,服务器仍可按下去 / 抬起来 ——
		// 今天没有宿主下发它,默认值就是结果。
		pluginsManage: booleanProperty(value, "pluginsManage", false),
		clipboardWrite: browserClipboardWriteCapability(),
		desktopWindows: booleanProperty(value, "desktopWindows", false),
		globalMenuEvents: booleanProperty(value, "globalMenuEvents", false),
	};
}

async function refreshWebCapabilities(): Promise<PlatformCapabilities> {
	// `GET /api/capabilities` 走客户端(它记忆一次;`true` = 明确重新问一遍)。
	// 交回来的形是 `RuntimeHostCapabilities`,比渲染层的 `PlatformCapabilities`
	// 少几位 —— `normalizeServerCapabilities` 本来就按字段名逐位读、缺位用默认值,
	// 所以这里一个字都不用改。
	const capabilities = normalizeServerCapabilities(
		await clientFor().capabilities(true),
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

/**
 * core 的**主推送流** `GET /api/events` 上的一条 —— 走 `@onething/client` 的事件
 * 枢纽(一条 SSE 连接、按名分发、断线自愈、`?after=` 续播,Bearer 进 header
 * 不进 URL)。表里只有三个名字,全是 `IPC_CHANNELS` 常量(打错一个字母是 tsc 红)。
 *
 * **`EventSource` 与它那张共享表整段没了**(C2):浏览器的 `EventSource` 带不了
 * header,token 只能进 `?token=` query —— 那扇门是为它开的,现在没有消费者了
 * (server 侧那条口留到 Vue 宿主退役再删,方案 §9)。
 */
function subscribeCoreEvent<K extends keyof TransportEvents>(
	name: K,
	callback: (payload: TransportEvents[K]) => void,
): Unsubscribe {
	return clientFor().events.on(name, callback);
}

/** 会话事件流上的一条,先按 `envelope.event.type` 过一道。 */
function subscribeSessionEvent(
	callback: (envelope: SessionEventEnvelope) => void,
): Unsubscribe {
	return subscribeCoreEvent(IPC_CHANNELS.SESSION_EVENT, callback);
}

function createSessionMessagesChangedSubscription(
	callback: (data: {
		sessionId: string;
		action: "added" | "updated" | "deleted";
		messageId?: string;
	}) => void,
): Unsubscribe {
	return subscribeSessionEvent((envelope) => {
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
	});
}

function createStepAddedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		step: Step;
	}) => void,
): Unsubscribe {
	return subscribeSessionEvent((envelope) => {
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
	});
}

function createStepUpdatedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		stepId: string;
		updates: Partial<Step>;
	}) => void,
): Unsubscribe {
	return subscribeSessionEvent((envelope) => {
			const event = envelope.event;
			if (event?.type !== SESSION_EVENT_TYPES.STEP_UPDATED || typeof event.stepId !== "string")
				return;
			callback({
				sessionId: envelope.sessionId,
				messageId: "",
				stepId: event.stepId,
				updates: event.updates,
			});
	});
}

function createSkillActivatedSubscription(
	callback: (data: {
		sessionId: string;
		messageId: string;
		skillName: string;
	}) => void,
): Unsubscribe {
	return subscribeSessionEvent((envelope) => {
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
	});
}

function createContextSizeUpdatedSubscription(
	callback: (data: { sessionId: string; contextSize: number }) => void,
): Unsubscribe {
	return subscribeSessionEvent((envelope) => {
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
	});
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
	// **能力位也放开了**(P4 终态批 B,拍板 #12):`collabRooms` 默认 true,由服务器
	// 按进程内跑没跑 collab v3 运行时决定关不关(见上方 capabilities)。
	// Interaction(agent 提问 → 用户应答,E1)的两条已整只迁到通用 RPC 通道
	// (P4c 第九批,`interactionRouter` + `@/platform/interaction-client`),所以
	// 这份名单里不再有它们;能力位 `interactionRespond` 同批放开(#17)。
	// Terminal:七条请求面已迁通用 RPC 通道(P4 终态批 D2,terminalRouter);闸在
	// 服务端(域的 http 分叉一律拒),这里只剩两条推送订阅(router 无推送面)。
	"onTerminalData",
	"onTerminalExit",
	// Browser:19 条请求面于 A1-b 走宿主壳路由,web 侧的答复在
	// `shell-web/browser.ts` 里(文案逐字沿用这份名单从前生成的那句,
	// 能力位 `embeddedBrowser` 仍是 false)。这里只剩那条推送订阅。
	"onBrowserTabsChanged",
	// 四条搜索窗动作 + 关发起窗于 A1-a 走宿主壳路由,web 侧的答复在
	// `shell-web/search-window.ts` / `shell-web/window.ts` 里(文案逐字沿用这份
	// 名单从前生成的那句)—— 所以它们不再挂在 platformApi 上,也不在这份名单里。
	// A1-b 同理带走了 `openPath` / `getDataPath`(→ `shell-web/shell.ts`)与
	// `setWindowButtonVisibility`(→ `shell-web/window.ts`)。
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


	// settings —— 四条 REST 镜像已随 `settingsRouter` 迁走(P4c 第十一批);
	// 「开设置窗」在 web 上的等价物(改 hash)于 A1-a 搬进
	// `shell-web/settings-window.ts`。留下的是三条 noop / 本地推送。
	onSettingsNavigate: () => () => {},
	// E 批:从空桩改成真订阅 —— 骑既有的 `GET /api/events`,server 侧把设置变更
	// 作为一条具名 SSE 事件下发(载荷是脱敏过的整份设置,与 `settings.getSettings`
	// 在同一道 Bearer 闸后交出去的逐字同形)。不新开路由、不新开通道。
	onSettingsChanged: (callback: (settings: AppSettings) => void) =>
		subscribeCoreEvent(IPC_CHANNELS.SETTINGS_CHANGED, callback),
	// web 端没有第二个窗口,也没有这条广播(批 B9-0):noop 退订即可。
	onSpacesChanged: () => () => {},
	// `searchQuery` 于 A1-b 迁到通用 RPC 通道的 backend `search` 域(域自己按
	// `transport` 分叉:http 那一支调的就是从前 `POST /api/search/query` 背后的
	// 同一个闭包)。`searchExecuteAction` 于 A1-a 搬进 `shell-web/search-window.ts`。

	// Themes 走通用 RPC(themesRouter,P4c 第七批):浏览器从此拿到的是与桌面
	// 逐字相同的一份主题 —— 插件覆盖的合成也在同一个域处理者里做。

	// System prompt snapshot 与另外五条聊天面走通用 RPC(chatRouter,P4c 第五批);
	// User prompt snippets 走 promptsRouter。两者都见文件末尾的域客户端一行区。

	// plugins —— 十九条数据面已随 `pluginsRouter` 迁走(P4 终态批 C2)。读面
	// (list / enable / disable / refresh / commands / executeCommand / configGet)
	// 打的是同一批闭包(域在 http 上沿用 server 那本只读镜像目录);写面挡在前面的
	// 不再是这里的硬桩,而是能力位 `pluginsManage`(见上方 capabilities)与
	// `platform/plugins-client.ts` 里那份逐字相同的降级答案。
	// 只剩下面那两条**推送**订阅 —— router 今天没有推送面。
	// OAuth 的六条数据面走通用 RPC(oauthRouter,P4c 第七批)。顺带修掉一处说谎:
	// 从前 web 壳把凭证写回目标(批 B6 的 spaceId/entryId/label)**收下即丢**,
	// 浏览器里往空间凭证池登录等于没登;走 router 之后它真的传到 authService 了
	// —— 两个宿主吃的也是同一台 authService、同一本令牌账。
	// **两条推送仍走 SSE**:router 今天没有推送面。
	onOAuthTokenRefreshed: (callback: (data: { providerId: string }) => void) =>
		subscribeWebSse<{ providerId: string }>(
			"/api/oauth/events",
			"oauth:token-refreshed",
			callback,
		),
	onOAuthTokenExpired: (
		callback: (data: { providerId: string; error?: string }) => void,
	) =>
		subscribeWebSse<{ providerId: string; error?: string }>(
			"/api/oauth/events",
			"oauth:token-expired",
			callback,
		),
	// gateway —— 八条 REST 镜像已随 `gatewayRouter` 迁走(P4c 第八批),本域零推送。
	// voice —— 十一条 REST 镜像已随 `voiceRouter` 迁走(P4c 第十一批)。
	// 留下两条推送的 SSE 订阅,加下面这条**单向上行**的空实现。
	//
	// `voiceAudioChunk` 在浏览器里从来就是个空转:server 没有
	// `/api/voice/audio-chunk` 这条路由,旧实现是 `postJson(...).catch(() => {})`
	// —— 发出去、404、吞掉。可观察行为一字未变,只是不再白发那一趟。
	voiceAudioChunk: () => {},
	onVoiceEvent: (callback: (event: VoiceEvent) => void) =>
		subscribeWebSse<VoiceEvent>(
			"/api/voice/events",
			"voice:event",
			callback,
		),
	onVoiceRuntimeCommand: (callback: (command: VoiceRuntimeCommand) => void) =>
		subscribeWebSse<VoiceRuntimeCommand>(
			"/api/voice/runtime-commands",
			"voice:runtime-command",
			callback,
		),
	// Todo / plan 数据面走通用 RPC(todoPlanRouter);窗口面于 A1-a 走宿主壳路由,
	// web 侧那份「本地 DOM 事件 / 老实报 false」的实现搬进
	// `shell-web/todo-plan-window.ts`(逐字)。

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
		subscribeWebSse(
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
	// ── 宿主壳路由(A1-a)。窗口系的处理者表就在本包的 `shell-web/` 里。──
	shellInvoke: dispatchWebShell,
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

	// abort/progress 需要一条活的双向通道;方案 A 下 web 端根本没有执行面,
	// 所以进度订阅是诚实的空实现,而不是假装能收到。
	onPluginRequestProgress: () => () => {},

	// onething:// 深链只有桌面宿主接得到 —— 注册 URL scheme 是操作系统级的事,
	// 浏览器里没有"外面点一条链接回到这个标签页"这种东西。三条都是诚实的空实现:
	// ready 说成功(队列本来就不存在),没有卡会推来,respond 说得清地失败
	// (而不是回一个假的成功,让调用方以为投递过了)。
	onDeepLinkRequest: () => () => {},

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
		subscribeWebSse(
			"/api/media/events",
			"media:image-generated",
			callback,
		),
	onImagePreviewUpdate: subscribeImagePreviewUpdate,

	// ── Sessions:26 条数据面已走通用 RPC 通道(sessionsRouter over POST /api/rpc),
	//    本文件不再镜像一份 REST。`updateSessionMaxTokens` 于 A1-a 整条删掉
	//    (桌面从来没有处理者、渲染层零调用点;server 那条 REST 路由留着),
	//    所以这里只剩推送。──
	onSessionMessagesChanged: createSessionMessagesChangedSubscription,
	// ── Chat:六条数据面已走通用 RPC 通道(chatRouter over POST /api/rpc),
	//    本文件不再镜像一份 REST。第七条「工具审批后恢复流」于 2026-08-22(#21)
	//    连同桌面那条 invoke 一起删了 —— 渲染层零调用者;引擎的
	//    `command:resume-after-confirm` 仍在命令总线上,只是没有壳方法打它。──
	// getSystemTheme 已迁 `settingsRouter`;web 上它由 `platform/settings-client.ts`
	// 就地读 `prefers-color-scheme` 作答(浏览器的「系统」是看的人那台机器,
	// 问服务器等于问错机器),答案与这里删掉的那条桩逐字相同。
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
	// `openExternal` 于 A1-b 搬进 `shell-web/shell.ts`(`window.open` 那段逐字),
	// 与 `openPath` / `getDataPath` 同一个 `shell` 域。
	onSessionEvent: (callback: (envelope: SessionEventEnvelope) => void) =>
		subscribeCoreEvent(IPC_CHANNELS.SESSION_EVENT, callback),
	onSessionStream: (callback: (payload: SessionStreamPayload) => void) =>
		subscribeCoreEvent(IPC_CHANNELS.SESSION_STREAM, callback),
	onStepAdded: createStepAddedSubscription,
	onStepUpdated: createStepUpdatedSubscription,
	onSkillActivated: createSkillActivatedSubscription,
	onTodoPlanChanged: (callback: (payload: TodoPlanChangedPayload) => void) =>
		subscribeWebSse<TodoPlanChangedPayload>(
			"/api/todo-plan/events",
			"todo-plan:changed",
			callback,
		),
	onScratchpadChanged: (callback: (payload: ScratchpadChangedPayload) => void) =>
		subscribeWebSse<ScratchpadChangedPayload>(
			"/api/scratchpad/events",
			"scratchpad:changed",
			callback,
		),

	// Browsers never expose local file paths.
	getPathForFile: () => "",

	onMenuNewChat: () => () => {},
	onMenuCloseChat: () => () => {},
	onMenuNewBrowserTab: () => () => {},
	onSearchAction: subscribeSearchAction,

	// 系统通知的两条执行面于 A1-a 搬进 `shell-web/notify.ts`(web 端刻意降级为
	// 只剩未读墨点,理由写在那只文件里);这里只剩点击回传的空订阅。
	notify: {
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
