/**
 * server runtime 的形状:装配出来的那台 runtime、它站在上面的底座、装配选项。
 *
 * 2026-10-04 从 `http-server-runtime.ts` 原样搬来(决策 D219),一个字段没改;
 * `http-server-runtime.ts` 原样转交这几个名字,外面照旧从那里拿。
 */
import type { OnethingBackend } from "@onething/backend/backend.js";
import type { McpSubsystem } from "@onething/backend/mcp";
import type { ConfigureLoggingOptions } from "@onething/backend/logging/logging-configure";
import type { GenericEventBus } from "@onething/backend/event";
import type { AgentEngineSessionEvent, AgentEngineStreamChunk } from "@onething/backend/agent";
import type { MediaLibraryService } from "@onething/backend/media";
import type { SessionLayer } from '@onething/backend/session';
import type { ServerSessionStore } from "../session/session-client-api-server-store.js";
import type { ServerSettingsStore } from "../settings/settings-client-api-server-store.js";
import type { ServerMCPClientFactory } from "../mcp/mcp-client-api-server-host.js";
import type { ServerPluginCommandDefinition } from "../plugin/plugin-client-api-catalog-mirror.js";
import type { OnethingRuntimeFacade, RuntimeStreamPayload, RuntimeUnsubscribe } from "./http-server-runtime-facade.js";
import type { SessionAudienceFactory } from "./http-server-audience.js";
import type { BackendLaunchProfile } from "@onething/backend/backend-launcher.js";

export interface OnethingServerRuntime {
	/** Present for a production Backend; absent only for explicit test adapters. */
	backend?: OnethingBackend;
	runtime: OnethingRuntimeFacade;
	eventBus: GenericEventBus<AgentEngineSessionEvent>;
	streamChannel: ServerStreamChannelLike;
	/**
	 * The resolved per-owner workspace sandbox base (`<root>/<uid>/<wid>`).
	 * The HTTP layer needs it to mint `RpcDispatchContext.sandboxRoot`
	 * (主线 T 批 3); exposing it here keeps the resolution in exactly one place
	 * instead of having `main.ts` re-derive it from the same env var.
	 */
	workspaceRoot: string;
	shutdown(): Promise<void>;
}

/**
 * The engine-bearing substrate the server runtime is assembled on. Production
 * uses the real product backend (createOnethingBackend); tests inject a stub
 * so HTTP-layer coverage never boots providers or touches the user store.
 */
export interface ServerStreamChannelLike {
	push(sessionId: string, chunk: AgentEngineStreamChunk): void;
	subscribe(
		sessionId: string,
		handler: (chunk: AgentEngineStreamChunk) => void,
	): RuntimeUnsubscribe;
	subscribeAny(handler: StreamPayloadHandler): RuntimeUnsubscribe;
	destroySession(sessionId: string): void;
	shutdown(): void;
}

export interface OnethingServerBackend {
	mediaLibrary?: MediaLibraryService;
	sessionLayer?: Pick<SessionLayer, 'reads' | 'events' | 'access'>;
	eventBus: GenericEventBus<AgentEngineSessionEvent>;
	streamChannel: ServerStreamChannelLike;
	/**
	 * True when the backend's engine persists messages itself (the real
	 * StreamEngine writes through the app session store). False keeps the
	 * server-side event projection alive so store state still materializes
	 * (test/echo backends).
	 */
	persistsMessages: boolean;
	/**
	 * 产品后端拥有的 MCP 子系统(C1 收尾,方案
	 * `docs/design/backend-principal-and-mcp-lifecycle-2026-09.md` §2.2)。
	 *
	 * 只暴露 `start` —— server runtime 对 MCP 的全部要求就是"这个进程是 core
	 * 进程时,把它起起来";关它的事归 `backend.dispose()` 里那格 `own('mcp')`。
	 *
	 * **可选**是因为这个接口的另一类实现是 echo/local 测试替身(它们根本没有产品
	 * 后端)。缺席 = 不起 MCP,与替身今天走的路一致:替身的 `persistsMessages`
	 * 通常是 `false`,压根进不到那个块。
	 */
	mcp?: Pick<McpSubsystem, "start">;
	abortSession(sessionId: string, reason?: string): void;
	shutdown(): Promise<void>;
}

export interface OnethingServerRuntimeOptions {
	createBackend?: () => Promise<OnethingServerBackend>;
	storePath?: string;
	logging?: ConfigureLoggingOptions;
	workspaceRoot?: string;
	dataRoot?: string;
	settingsRoot?: string;
	settingsStore?: ServerSettingsStore;
	sessionStore?: ServerSessionStore;
	enableMCPConnections?: boolean;
	allowMCPStdio?: boolean;
	mcpClientFactory?: ServerMCPClientFactory;
	pluginCommands?: ServerPluginCommandDefinition[];
	/**
	 * 进程级单槽端口(MCP 客户端宿主 + clientInfo + capabilities-changed、授权账页
	 * 存储、todo/scratchpad 广播)归谁配。
	 *
	 * - `'own'`(默认):这个进程就是 core 进程(`server:start`),由 server runtime 配。
	 * - `'host'`:宿主(Electron 桌面)已经配好了,HTTP 面只是搭车。此时
	 *   MCP/授权存储**一律不改写**,todo/scratchpad 广播改为**串联**(先调宿主
	 *   原本那只,再喂 SSE),`shutdown()` 里再把它们还原回去。
	 */
	processPorts?: "own" | "host";
	/**
	 * **受众**的产地(批 A,`docs/design/event-subscription-audience-2026-09.md` §3.1)。
	 *
	 * 一条订阅能看哪些会话,是订阅建立那一刻就定下的事实。缺省 = 按会话归属判
	 * (`TenantAudience`,与批 A 之前逐字同判);单用户宿主(自装 core 的桌面壳)
	 * 传 `createOpenAudienceFactory()`。**订阅代码不知道自己跑在哪** —— 新增一种
	 * 宿主只是这里多注一个实现。
	 */
	audienceFactory?: SessionAudienceFactory;
	/**
	 * 不带界面的后端进程的**档案**(第④步批 2a,`backend-launcher.ts`)。只有自己装配产品后端的那条路
	 * (`createDevelopmentOnethingServerRuntime` 没递 `createBackend`)读它:装配开关、宿主表两格、ACP
	 * 无人答卡的口径,以及 MCP 客户端工厂(`mcpClientFactory` 没显式给时用档案里那一只)。缺席 = 缺省档。
	 */
	launchProfile?: BackendLaunchProfile;
	/**
	 * 装配跑完之后、第一次按 PATH 找可执行或 spawn 之前要等的那件事(ACP 起名册之前;MCP stdio 更晚,在建
	 * runtime 时)。今天只有桌面档的登录 shell PATH 用它:它与装配并行跑,赶在那一拍之前落定。永不 reject 的
	 * 承诺才许递进来。只有自己装配产品后端的那条路读它。
	 */
	beforeFirstSpawn?: Promise<void>;
}

export interface OnethingServerRuntimeOverBackendOptions
	extends Omit<OnethingServerRuntimeOptions, "createBackend"> {
	/**
	 * `runtime.shutdown()` 要不要连带关掉传进来的 backend。
	 * `server:start` 自己装配的 → true(默认);桌面借出来的 → false。
	 */
	ownsBackend?: boolean;
}

type StreamPayloadHandler = (
	payload: RuntimeStreamPayload<AgentEngineStreamChunk>,
) => void;
