import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { watchClientDisconnect } from './request-abort.js'
import { tenantDirectory, tenantKey } from './tenant-paths.js'
import { sessionDeletion } from '../session/deletion.js'
import { sessionAccess, createSessionAccess } from '../session/access.js'
import { createServerLiveSessionDelivery } from './live-session-delivery.js'
import { createServerMediaDelivery } from './media-delivery.js'
import { collectSessionCascadeDeleteIds } from '@onething/core/session'
import type { OnethingPermissionGrantStorageAdapters } from "@onething/runtime/permissions";
import { EventEmitter } from "node:events";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
	EventBus,
	type JsonObject,
	Permission,
	StreamChannel,
	createOnethingRuntimeFacade,
	type AgentEngineSessionEvent,
	type AgentEngineStreamChunk,
	type OnethingRuntimeFacade,
	type RuntimeHostCapabilities,
	type RuntimeOAuthTokenEvent,
	type RuntimeRequestContext,
	type RuntimeStreamPayload,
	type RuntimeUnsubscribe,
} from "@onething/core";
import { createOnethingBackend, type OnethingBackend } from "@onething/backend/backend.js";
import type { McpSubsystem } from "../wiring/mcp/subsystem.js";
import type { ConfigureLoggingOptions } from "../wiring/logging/index.js";
import {
	createTenantAudienceFactory,
	ownerMatchesContext,
	ownsSessionRecord,
	sessionOwnerOf as sessionOwner,
	type SessionAudience,
	type SessionAudienceFactory,
	type SessionIndexPort,
	type SessionOwner as ServerSessionOwner,
} from "./audience.js";
import { invalidateSettingsCache as invalidateAppSettingsCache } from "@onething/backend/stores/settings.js";
import { invalidateAgentsCache as invalidateAppAgentsCache } from "@onething/backend/wiring/agents/index.js";
import { getProjectsStore as getAppProjectsStore } from "@onething/backend/wiring/project-dirs/index.js";
import {
	MCPManager as appMCPManager,
	configureMCPClientHost,
} from "@onething/runtime/mcp/index.wiring";
import { configureMCPClientIdentity } from "@onething/runtime/mcp/identity";
import {
	createBranchSession as createAppStoreBranchSession,
	createSession as createAppStoreSession,
	flushAllPendingSaves as flushAllAppStorePendingSaves,
	flushSessionSave as flushAppStoreSessionSave,
	getCurrentSessionId as getAppStoreCurrentSessionId,
	getSession as getAppStoreSession,
	getSessionUserMessageMarkers as getAppStoreSessionUserMessageMarkers,
	getSessions as getAppStoreSessions,
	getSessionsList as getAppStoreSessionsList,
	setCurrentSessionId as setAppStoreCurrentSessionId,
	updateSessionWorkingDirectory as updateAppSessionWorkingDirectory,
	updateSessionWorkingDirectoryRoots as updateAppSessionWorkingDirectoryRoots,
} from "@onething/backend/store.js";
import {
	createSessionCommands,
	sessionCommands as appSessionCommands,
	type SessionCommands,
} from "../session/commands.js";
import { createEchoMessageEvents } from './echo-message-events.js';
import {
	sessionReads as appSessionReads,
	sessionPreviewText,
} from "../session/reads.js";
import { sessionCommandEvents } from "../session/command-events.js";
import { updateSessionsIndexMetaForCommands as updateAppStoreSessionsIndexMeta } from "@onething/backend/stores/sessions.js";
import {
	findSessionIndexMeta as findAppStoreSessionIndexMeta,
	onSessionIndexChanged,
} from "@onething/backend/stores/sessions.js";
import { configureServerPluginCatalogPort } from "./plugin-catalog.js";
import { configureServerSearchPort } from "./search-providers.js";
import {
	CorePluginStore,
	createBuiltinPluginDefinitions,
	ensureCorePluginsDir,
	getCorePluginSettingsPath,
	getCorePluginsDir,
	getPluginEnabledWithAdapters,
	readPluginSettingsFile,
	scanCorePlugins,
	setPluginEnabledWithAdapters,
	writePluginSettingsFile,
	type CorePluginCommandDefinition,
	type CorePluginDefinition,
	type CorePluginInfo,
	type PluginSettings, type CorePluginSettingsStorageAdapters,
} from "@onething/core/plugins";
import {
	createMCPServerState,
	HeadlessMCPManager,
	type MCPClientLike,
} from "@onething/core/mcp";
// P4c 第七批:oauth 的六条数据面(与它们背后那台 per-owner 的第二台 authService)
// 已随 `oauthRouter` 迁走;server 这侧只剩令牌事件的广播端口。
import {
	configureOAuthEventBroadcaster,
	getOAuthEventBroadcaster,
	type OAuthTokenEvent,
} from "../wiring/auth/oauth-events.js";
// E 批:设置变更的推送端口。数据面(读 / 存 / 系统深浅色 / 代理自检)仍然只走
// `settingsRouter`,这里只串一条广播 —— 见下面 `settingsChangedHandlers`。
import {
	configureSettingsEventBroadcaster,
	getSettingsEventBroadcaster,
	type SettingsEvent,
} from "../wiring/settings/events.js";
// `/api/capabilities` 的 `collabRooms` 那一位:问的是这个进程里跑没跑 collab v3
// 的 actor 运行时(桌面内嵌面 = 跑,独立 server:start = 不跑)。
import { isCollabV3RuntimeRunning } from "../wiring/collab/index.js";
// B3:`/api/capabilities` 的五位从这些判据推导 —— 每一个都是对应 RPC 域
// 自己在读的那一个函数(方案 §2.3「一位能力 = 一个判据」)。
import { getPluginManager } from "../wiring/plugins/index.js";
import { isHostLocallyTrusted } from "./host-trust.js";
import { hasShellHost } from "@onething/runtime/shell/host-ports";
import { hasTerminalHost } from "@onething/runtime/terminal/service.wiring";
import {
	createOnethingSearchService,
	type OnethingSearchProvidersAdapters,
	type SearchServiceRequest,
} from "@onething/runtime/search";
import { unavailableIndexFace } from "../wiring/search/index.js";
import { createDailyNote as createDailyNoteWith } from "@onething/runtime/search/capabilities";
import type { MediaLibraryService, OnethingMediaLibraryPaths } from "@onething/runtime/media";
import {
	ONETHING_LOG_MONITOR_MANIFEST,
	ONETHING_NOTE_SKILLS_MANIFEST,
	executeOnethingPluginCommandForIpc,
	disableOnethingPluginForIpc,
	enableOnethingPluginForIpc,
	listOnethingPluginCommandsForIpc,
	listOnethingPluginsForIpc,
	refreshOnethingPluginsForIpc,
} from "@onething/runtime/plugins";
import {
	createOnethingAgentStore,
	DEFAULT_ONETHING_AGENT_ID,
} from "@onething/runtime/agents";
import {
	createRequiredOnethingAppFetch,
} from "@onething/runtime/providers";
// 片段的 ipc-operations 已随 CRUD 一起迁到 RPC 域;这里只剩搜索面还要读 store。
import { OnethingPromptStore } from "@onething/runtime/prompts";
import {
	addOnethingProjectDirForIpc,
	getOnethingProjectDirForIpc,
	listOnethingProjectDirsForIpc,
	normalizeProjectRoots,
	projectIdFromPath,
	projectRootsInclude,
	removeOnethingProjectDirForIpc,
	updateOnethingProjectDirForIpc,
	type Project,
	type ProjectDirsAddRequest,
	type ProjectDirsGetRequest,
	type ProjectDirsRemoveRequest,
	type ProjectDirsUpdateRequest,
	type ProjectIndexEntry,
} from "@onething/runtime/project-dirs";
import {
	createOnethingDirectory,
	createOnethingFile,
	deleteOnethingPath,
	listOnethingDirectoriesForCompletionForIpc,
	listOnethingDirectory,
	listOnethingFileSearchEntriesForIpc,
	readOnethingFileContent,
	renameOnethingPath,
	rollbackOnethingFile,
	saveOnethingFileContent,
	statOnethingPath,
} from "@onething/runtime/files";
import { applyFileMutationUndo } from "@onething/runtime/tools/file-mutation-audit";
import {
	resolveOnethingMarkdownAsset,
	resolveOnethingMarkdownAssetForIpc,
	saveOnethingMarkdownAttachments,
	saveOnethingMarkdownAttachmentsForIpc,
	type MarkdownAssetResolution,
	type MarkdownResolveAssetRequest,
	type MarkdownSaveAttachmentsRequest,
	type MarkdownSaveAttachmentsResponse,
	type OnethingMarkdownAssetServiceAdapters,
	type OnethingMarkdownEditorSettings,
} from "@onething/runtime/markdown";
import { expandOnethingToolSandboxPath } from "@onething/runtime/tools";
import {
	addGrant,
	clearOnethingPermissionSessionForIpc,
	clearOnethingSessionPermissionGrantsForIpc,
	clearOnethingWorkspacePermissionGrantsForIpc,
	clearSessionGrants,
	clearWorkspaceGrants,
	configureOnethingPermissionGrantStorage,
	getOnethingPendingPermissionsForIpc,
	listOnethingPermissionGrantsForIpc,
	listSessionGrants,
	listWorkspaceGrants,
	revokeGrant,
	revokeOnethingPermissionGrantForIpc,
	type PermissionGrant,
} from "@onething/runtime/permissions";
// todo/plan 的数据面已整体迁走(含 per-owner 分库);server 这侧只剩变更广播的载荷类型。
import type { TodoPlanChangedPayload } from "@onething/runtime/todo-plan";
import {
	configureTodoPlanHost,
	getTodoPlanHostPorts,
} from "@onething/backend/wiring/todo-plan/store.js";
import {
	VariableRegistry,
	VariablesStore,
	registerStandardVariableProviders,
	createDefaultVariablesFile,
	deleteOnethingVariableForIpc,
	listOnethingVariablesForIpc,
	parseVariablesFile,
	setOnethingVariableForIpc,
	type ContextVariable,
	type NoteVarName,
	type VariablesDeleteRequest,
	type VariablesFile,
	type VariablesListRequest,
	type VariablesSetRequest,
} from "@onething/runtime/variables";
import {
	getOnethingAgentsPath,
	getOnethingAppStatePath,
	getOnethingCurrentSessionId,
	getOnethingMediaFilesDir,
	getOnethingMediaImagesDir,
	getOnethingMediaIndexPath,
	getOnethingSessionPath,
	getOnethingSessionsDir,
	getOnethingSettingsPath,
	getOnethingStorePath,
	getOnethingVariablesPath,
	saveOnethingUiState,
	setOnethingCurrentSessionId,
} from "@onething/runtime/storage";
import { createOnethingSessionRepository, type OnethingSessionRepositoryOptions, type OnethingSessionRepositoryLogger } from "@onething/runtime/sessions/session-repository";
import {
	deleteJsonFile,
	readJsonFile as readCoreJsonFile,
	writeJsonFile as writeCoreJsonFile,
	writeJsonFileAsync as writeCoreJsonFileAsync,
} from "@onething/core/storage";
import {
	deriveSessionLastMessagePreview,
	findLastPreviewableMessage,
} from "@onething/core/session";
import { mergeWithDefaults } from "@shared/defaults/settings.js";
import { toJsonValue } from "@shared/json.js";
import type { RpcDispatchContext } from "@shared/ipc/rpc.js";
import { ownerSandboxRoot } from "@onething/backend/rpc/sandbox.js";
import type { RpcDispatchPorts } from "../rpc/registry.js";
/*
 * P4c 第九批:"有哪些工具 / 跑一个工具"整只迁到 `backend/rpc/domains/tools.ts`。
 * 连同 echo/test 假路那份本地只读目录 + 本地 runner 一起消失 —— 一个 store 一份
 * 工具目录,http 侧的白名单与路径校验搬进了域处理者的 `transport:'http'` 分叉。
 */
import {
	createWorkspaceWatchService,
	type WorkspaceFileChangedHandler,
} from "../wiring/files/workspace-watch.js";
import type {
	VoiceEvent,
	VoiceRuntimeCommand,
} from "@shared/ipc/voice.js";
import {
	adoptScratchpad as adoptAppScratchpad,
	configureScratchpadHost,
	getScratchpadHostPorts,
	readScratchpad as readAppScratchpad,
	removeScratchpad as removeAppScratchpad,
	startScratchpadWatcher,
	stopScratchpadWatcher,
	updateScratchpad as updateAppScratchpad,
} from "@onething/runtime/scratchpad/service-bound";
import type {
	ScratchpadAdoptRequest,
	ScratchpadChangedPayload,
	ScratchpadDeleteRequest,
	ScratchpadGetRequest,
	ScratchpadUpdateRequest,
} from "@shared/ipc/scratchpad.js";
import type {
	ChatMessage,
	ChatSession,
	ContentPart,
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	SessionDetails,
	SessionMeta,
	Step,
	UserMessageMarker,
} from "@shared/ipc/chat.js";
import type { MCPServerConfig, MCPServerState } from "@shared/ipc/mcp.js";
import type { AppSettings } from "@shared/ipc/settings.js";
import type { SessionCommand } from "@shared/events/session-commands.js";
import type { ToolCall } from "@shared/ipc/tools.js";
import type {
	PermissionInfo,
	PermissionResponse,
} from "@shared/ipc/permissions.js";
import { ServerMCPClient } from "./mcp-client.js";
// P4c 第六批:MCP 私密字段的脱敏 / 合并规则搬到 `./mcp-secrets.js`;P4c 第十一批
// 起设置面那半也搬到了 `./settings-projection.js`,两处都由域处理者的 http 分叉调用。
// 这里只剩一条再导出 —— 测试与旧调用点从 `server/runtime.js` 取那个哨兵常量。
export { SERVER_REDACTED_SECRET } from "./mcp-secrets.js";
import { sanitizeSettingsForClient } from "./settings-projection.js";

import { SESSION_EVENT_TYPES, SESSION_COMMAND_TYPES } from "@shared/events/index.js";
import { consolePort, getLogger } from '../wiring/logging/index.js'
import type { VariablesStorePersistence } from '@onething/runtime/variables/store'
import type { OnethingPromptStoreAdapters } from '@onething/runtime/prompts/store'
import type { RuntimeCapabilitiesAdapter, RuntimeSessionsAdapter, RuntimeMessagesAdapter, RuntimePermissionsAdapter, RuntimeFilesAdapter, RuntimeTodoPlanAdapter, RuntimeScratchpadAdapter, RuntimeOAuthAdapter, RuntimeVoiceAdapter } from '@onething/core/runtime-facade'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingPluginIpcLogger } from '@onething/runtime/plugins/ipc-operations'
import type { RuntimeGlobalEventsAdapter, RuntimeSearchAdapter, RuntimeMutationResult, RuntimeSettingsAdapter } from '@onething/core/runtime-facade'
import { GLOBAL_EVENT_LEAVES_PROCESS } from '@shared/events/index.js'

const log = getLogger('server.runtime')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingPluginIpcLogger & OnethingSessionRepositoryLogger = consolePort(log)


/**
 * 服务端视角的会话。
 *
 * **`workspaceId` 不在这里** —— 它是 `ChatSession` 自己的字段,语义是**产品空间**
 * (`docs/design/workspace-spaces-2026-08.md` 批 B:「归属的 space,缺席 = default」),
 * 侧栏分组 / `resolveSessionSpaceId` / `countSessionsInWorkspace` 读的都是它。
 * 服务端的**租户归属**从此住在自己的 `owner*` 两格里,不再借用产品那一格:借用的
 * 后果是 UI 建的会话被盖了半个章(有空间、没 userId),归属判据把它的事件从 SSE
 * 广播里整只滤掉(诊断:`docs/audit/web-lane-sse-diagnosis-2026-08-28.md` 第五节)。
 *
 * `userId` 保留为**存量租户字段**:它历来只由服务端盖(见 `stampOwner`),所以老会话
 * 上的它仍按租户读(`sessionOwner`),但新代码一律写 `ownerUserId`。
 */
type ServerChatSession = ChatSession & {
	/** @deprecated 存量租户 userId(只读兼容,新写走 `ownerUserId`)。 */
	userId?: string;
	/** 服务端租户:主体。缺席 = 这一格不参与判定(见 `ownsSession`)。 */
	ownerUserId?: string;
	/** 服务端租户:作用域。**不是**产品空间 —— 那是 `workspaceId`。 */
	ownerWorkspaceId?: string;
	messageCount?: number;
	previewText?: string;
	/** E 批:最后一条 user/assistant 消息的预览(经 `toSessionMeta` 落到索引元数据)。 */
	lastMessagePreview?: string;
};


/**
 * 归属取材与归属判定这两句**住在 `server/audience.ts`**(批 A):受众对象与这里的
 * `ownsSession` / `ownsSessionMeta` 判的必须是同一件事,所以它们共用同一个谓词,
 * 不是两份各算一遍的规则。
 */

export type ServerMCPClientFactory = (config: MCPServerConfig) => MCPClientLike;
type ServerMCPManager = HeadlessMCPManager<MCPClientLike>;

import type { SessionLayer } from '../session/index.js';

export interface OnethingServerRuntime {
	/** Present for a production Backend; absent only for explicit test adapters. */
	backend?: OnethingBackend;
	runtime: OnethingRuntimeFacade;
	eventBus: EventBus<AgentEngineSessionEvent>;
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
	eventBus: EventBus<AgentEngineSessionEvent>;
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
}

export interface OnethingServerRuntimeOverBackendOptions
	extends Omit<OnethingServerRuntimeOptions, "createBackend"> {
	/**
	 * `runtime.shutdown()` 要不要连带关掉传进来的 backend。
	 * `server:start` 自己装配的 → true(默认);桌面借出来的 → false。
	 */
	ownsBackend?: boolean;
}

export interface ServerSettingsStore {
	load(context: RuntimeRequestContext): Promise<AppSettings | undefined>;
	save(context: RuntimeRequestContext, settings: AppSettings): Promise<void>;
}

export interface ServerSessionStore {
	/**
	 * 按 id 取一条索引元数据(O(1) 的那口)。缺席时调用方退回对 `getSessionsList()`
	 * 的线性 `find` —— 所以这是一格**加速**,不是新语义。
	 */
	findSessionMeta?(sessionId: string): SessionMeta | undefined;
	getCurrentSessionId(): string;
	setCurrentSessionId(sessionId: string): void;
	saveUIState(uiState: unknown): {
		success: boolean;
		state?: unknown;
		error?: string;
	};
	getSessions(): ServerChatSession[];
	getSessionsList(): SessionMeta[];
	getSession(sessionId: string): ServerChatSession | undefined;
	/** Drop any cached body so the next read re-hits disk (engine writes in-process). */
	invalidateSession?(sessionId: string): void;
	createSession(
		sessionId: string,
		name: string,
		context: RuntimeRequestContext,
	): ServerChatSession;
	createBranchSession(
		sessionId: string,
		name: string,
		parentSessionId: string,
		branchFromMessageId: string,
		inheritedMessages: ChatMessage[],
		context: RuntimeRequestContext,
	): ServerChatSession;
	saveSession(session: ServerChatSession): void;
	/**
	 * 只盖 index 元数据,不重写会话体(P0.3)。消息命令已经按写计划落过盘,
	 * 再走一次 `saveSession` 等于把整份 messages.jsonl 重写一遍。
	 */
	saveSessionMeta(session: ServerChatSession): void;
	/**
	 * 会话消息的读口(P0.3 / docs/design/session-commands-p0-2026-08.md §3):
	 * server 不再持有 `session.messages`。app 后端走 `sessionReads`,echo/test
	 * 后端走自己那只仓库 —— 两只仓库是真的两只,不能合并成一个门面。
	 */
	getMessages(sessionId: string): readonly ChatMessage[];
	/**
	 * 会话消息的写口(§2 的 12 命令)。写计划 / COW / lazy 档只有命令面算一次。
	 */
	messages: SessionCommands;
	deleteSession(sessionId: string, context?: RuntimeRequestContext): Promise<{
		deletedIds: string[];
		parentSessionId?: string;
	}>;
	flushSession(sessionId: string): Promise<void>;
	flushAll(): Promise<void>;
	getMessagesPage(
		request: GetSessionMessagesPageRequest,
	): GetSessionMessagesPageResponse;
	getUserMessageMarkers(sessionId: string): UserMessageMarker[] | undefined;
}



export type ServerPluginCommandDefinition = CorePluginCommandDefinition;

type StreamPayloadHandler = (
	payload: RuntimeStreamPayload<AgentEngineStreamChunk>,
) => void;
type TodoPlanChangedHandler = (payload: TodoPlanChangedPayload) => void;
type PendingPermissionRecord = { sessionId: string; info: PermissionInfo };
type ServerVariablesRuntime = {
	registry: VariableRegistry;
	store: VariablesStore;
	unsubscribe: RuntimeUnsubscribe;
};
/**
 * 只剩**纯客户端形态**的那几位:它们问的是"拿着这个 HTTP 面的那个客户端是不是
 * 一只 Electron 窗口",与这个进程的宿主装了什么无关,所以常量就够。
 *
 * B3 之前这里还摊着 `localFileSystem` / `shellTools` 两个 `false` —— 那是两份
 * 真相(后端护栏各自另有判据),已经删掉,见 `currentServerCapabilities()`。
 */
const webServerCapabilities: Omit<
	RuntimeHostCapabilities,
	"localFileSystem" | "shellTools" | "terminal" | "pluginsManage" | "collabRooms"
> = {
	workspaceFileSystem: true,
	nativeWindowControls: false,
	clipboardWrite: false,
	desktopWindows: false,
	globalMenuEvents: false,
};

/**
 * `/api/capabilities` 的出门快照(P4 终态批 B 拍板 #12;B3 起五位从后端事实推导)。
 *
 * **一位能力 = 一个判据函数,而且是对应那个域自己在读的那一个**
 * (方案 `docs/design/backend-transport-forks-2026-09.md` §2.3)。B3 之前除
 * `collabRooms` 外全是静态常量,于是前端看到的能力位与后端真正的护栏是两套 ——
 * 审计 `backend-architecture-review-2026-09-02.md` §2.6 说的"对不齐"就是这个。
 * 现在下面每一行右边那个函数,都是同名的域处理器判"给不给做"时调的那一个;
 * 每次现取、不缓存,因为答案是**进程状态**(宿主装了什么、信任声明了没有),
 * 不是配置。
 *
 * 同一份 `server/` 代码既被独立 `server:start` 用,也被桌面内嵌 HTTP 面挂在自己
 * 那只 backend 上 —— 所以这五位在两种宿主上如实分岔,不需要两份代码。
 *
 * 不加 `voice` 一位:渲染侧 `PlatformCapabilities` 今天没有这一位,加就是新造一个
 * wire 键,不在 B 的范围里。
 */
function currentServerCapabilities(): RuntimeHostCapabilities {
	return {
		...webServerCapabilities,
		// 与 files / tools / search / evals / mcp / sessions 六个域同判据
		// (`isHostLocallyTrusted()`):可信 = 路径不夹,也就是"这台机器的文件系统"。
		localFileSystem: isHostLocallyTrusted(),
		// 与 oauth 域同判据(`hasShellHost()`):宿主注没注入"用系统的方式打开一个东西"。
		shellTools: hasShellHost(),
		// 与 terminal 域同判据(`hasTerminalHost()`):宿主注没注入 PTY 输出广播器。
		terminal: hasTerminalHost(),
		// 与 plugins 域同判据(`getPluginManager()`):这个进程装没装插件管理器。
		pluginsManage: getPluginManager() !== null,
		// 与 sessions 域建房那道闸同判据(`isCollabV3RuntimeRunning()`)。
		collabRooms: isCollabV3RuntimeRunning(),
	};
}

class ServerStreamChannel extends StreamChannel<AgentEngineStreamChunk> {
	private readonly wildcardHandlers = new Set<StreamPayloadHandler>();

	override push(sessionId: string, chunk: AgentEngineStreamChunk): void {
		super.push(sessionId, chunk);
		for (const handler of this.wildcardHandlers) {
			handler({ sessionId, chunk });
		}
	}

	subscribeAny(handler: StreamPayloadHandler): RuntimeUnsubscribe {
		this.wildcardHandlers.add(handler);
		return () => {
			this.wildcardHandlers.delete(handler);
		};
	}

	override shutdown(): void {
		this.wildcardHandlers.clear();
		super.shutdown();
	}
}

type ServerPluginCatalogEntry = () => void | Promise<void>;
type ServerPluginCatalogDefinition =
	CorePluginDefinition<ServerPluginCatalogEntry>;
type ServerPluginCatalogInfo = CorePluginInfo<
	ServerPluginCatalogEntry,
	ServerPluginCatalogDefinition
>;
type ServerPluginCatalogCommand = CorePluginCommandDefinition;

class ServerPluginCatalogManager {
	private plugins: ServerPluginCatalogInfo[] = [];
	private readonly serverCommands = new Map<
		string,
		ServerPluginCatalogCommand
	>();

	private readonly storePath: string;
	private readonly pluginsDir: string;
	private readonly settingsPath: string;

	constructor(
		dataRoot: string,
		context: RuntimeRequestContext,
		commands: ServerPluginCommandDefinition[] = [],
	) {
		this.storePath = join(
			tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId),
			"plugin-store",
		);
		this.pluginsDir = getCorePluginsDir({ storePath: this.storePath });
		this.settingsPath = getCorePluginSettingsPath({
			storePath: this.storePath,
		});
		for (const command of commands) {
			const name = normalizeServerPluginCommandName(command.name);
			this.serverCommands.set(name, { ...command, name });
		}
		this.refreshPlugins();
	}

	getPlugins(): ServerPluginCatalogInfo[] {
		return this.plugins;
	}

	enablePlugin(pluginId: string): void {
		this.setEnabled(pluginId, true);
		this.refreshPlugins();
	}

	disablePlugin(pluginId: string): void {
		this.setEnabled(pluginId, false);
		this.refreshPlugins();
	}

	refreshPlugins(): void {
		ensureCorePluginsDir(this.pluginsDir, { log: () => {} });
		this.plugins = this.scanDefinitions().map((definition) => ({
			definition,
			loaded: definition.id === "server-runtime",
			commands:
				definition.id === "server-runtime"
					? Array.from(this.serverCommands.keys())
					: [],
			error: definition.error,
		}));
	}

	getPluginCommands(): Map<string, ServerPluginCatalogCommand> {
		if (!this.getEnabled("server-runtime", true)) return new Map();
		return new Map(this.serverCommands);
	}

	getCommandHandler(
		commandName: string,
	): ServerPluginCatalogCommand | undefined {
		if (!this.getEnabled("server-runtime", true)) return undefined;
		return this.serverCommands.get(
			normalizeServerPluginCommandName(commandName),
		);
	}

	private scanDefinitions(): ServerPluginCatalogDefinition[] {
		const noopEntry: ServerPluginCatalogEntry = async () => {};
		const builtinPlugins =
			createBuiltinPluginDefinitions<ServerPluginCatalogEntry>([
				...(this.serverCommands.size > 0
					? [
							{
								id: "server-runtime",
								manifest: {
									name: "Server Runtime",
									version: "1.0.0",
									description: "Web-safe server runtime plugin commands",
									author: "onething",
								},
								entry: noopEntry,
								enabled: this.getEnabled("server-runtime", true),
							},
						]
					: []),
				{
					id: "log-monitor",
					manifest: ONETHING_LOG_MONITOR_MANIFEST,
					entry: noopEntry,
					enabled: this.getEnabled("log-monitor", true),
				},
				{
					id: "note-skills",
					manifest: ONETHING_NOTE_SKILLS_MANIFEST,
					entry: noopEntry,
					enabled: this.getEnabled("note-skills", true),
				},
			]);

		return scanCorePlugins<ServerPluginCatalogEntry>({
			builtinPlugins,
			pluginsDir: this.pluginsDir,
			getEnabled: (pluginId) => this.getEnabled(pluginId, true),
		});
	}

	private getEnabled(pluginId: string, fallback: boolean): boolean {
		return getPluginEnabledWithAdapters(pluginId, fallback, {
			readSettings: () => this.readSettings(),
		});
	}

	private setEnabled(pluginId: string, enabled: boolean): void {
		const pluginSettingsStorageAdapters: CorePluginSettingsStorageAdapters = {
			readSettings: () => this.readSettings(),
			writeSettings: (settings) => this.writeSettings(settings),
		};
		setPluginEnabledWithAdapters(pluginId, enabled, pluginSettingsStorageAdapters);
	}

	private readSettings(): PluginSettings {
		return readPluginSettingsFile(this.settingsPath);
	}

	private writeSettings(settings: PluginSettings): void {
		writePluginSettingsFile(this.settingsPath, settings);
	}
}

// P4c 第八批:`SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR` 与
// `createServerGatewayStatus` 随 `gateway` adapter 一起没了 —— 那台「server 上
// 网关永远禁用」的假状态机不再需要,降级由 `configureGatewayHost` 未注入给出。
function normalizeServerPluginCommandName(commandName: string): string {
	return commandName.startsWith("/") ? commandName : `/${commandName}`;
}

/**
 * 把产品后端(`createOnethingBackend` 的返回值)适配成 server runtime 认识的底座。
 *
 * A 期(docs/design/one-core-2026-08.md §3)之后这段适配有**两个**调用方:
 * `server:start` 自己装配的那只 backend,以及桌面主进程借出来的那只。区别只有
 * `ownsBackend` 一个:借来的不能在 HTTP 面关掉时把宿主的引擎一起关了。
 */
export function toOnethingServerBackend(
	backend: OnethingBackend,
	options: { ownsBackend?: boolean } = {},
): OnethingServerBackend {
	const ownsBackend = options.ownsBackend ?? true;
	return {
		eventBus: backend.eventBus as unknown as EventBus<AgentEngineSessionEvent>,
		streamChannel: backend.streamChannel as unknown as ServerStreamChannelLike,
		persistsMessages: true,
		mediaLibrary: backend.mediaLibrary,
		sessionLayer: backend.sessionLayer,
		// C1 收尾:MCP 的起法从 server runtime 手写的那三句改成问子系统要。透传的
		// 是**同一只** `MCPManager` 进程单例的门面 —— 子系统构造时拿的就是它。
		mcp: backend.mcp,
		abortSession(sessionId, reason) {
			backend.engine.abort(sessionId, reason ?? "server abort");
		},
		shutdown: async () => {
			if (ownsBackend) await backend.dispose();
		},
	};
}

async function createRealServerBackend(storePath: string, logging?: ConfigureLoggingOptions): Promise<OnethingBackend> {
	// The engine drops commands silently when no sender is bound (the guard
	// exists for the desktop's window lifecycle); the server observes the
	// EventBus/StreamChannel directly, so bind a no-op sender like the CLI
	// daemon does.
	class ServerNoopSender extends EventEmitter {
		isDestroyed(): boolean {
			return false;
		}
		send(): void {
			/* SSE subscribers observe the bus and stream channel directly. */
		}
	}
	// User decision (2026-07-25): web/server tools ship with desktop parity by
	// default; ONETHING_SERVER_TOOLS=readonly degrades to zero-side-effect
	// tools (no bash/write/edit) for exposed deployments.
	const serverToolRegistry =
		process.env.ONETHING_SERVER_TOOLS === "readonly" ? "readonly" : "full";
	if (serverToolRegistry === "readonly") {
		log.info("degraded tool set (read/time/web only)", {
			reason: "ONETHING_SERVER_TOOLS=readonly",
		});
	}
	// No `owner`: 2026-08-24 ruling — apps/server takes no store lock. It defers
	// through `<store>/run/http.json` (see apps/server/src/main.ts) instead.
	return createOnethingBackend({
		storePath,
		logging,
		/*
		 * A1:宿主能力一次交清。这个进程是个无头 server —— 除了下载目录之外
		 * 一件宿主能力都没有,于是十四个 `null` 就是这里的事实清单(从前那是
		 * 「一个 `sandboxHost` 之外什么都没写」,看不出是没有还是漏了)。
		 *
		 * `storePath: {}` = 打包资源目录无话可说,与从前从不调
		 * `configureStorePathHost` 时的缺省逐字相同(`isPackaged` 为假、
		 * `resourcesPath` 退到 `process.resourcesPath`)。
		 *
		 * MCP 那一格仍是 `null`:server 自己的客户端工厂由
		 * `createServerRuntimeOverServerBackend` 在**后面**按 `processPorts`
		 * 决定装不装(它要 stdio 闸门与借来/自有的判定),不归这张表。
		 */
		host: {
			storePath: {},
			sandbox: {
				getPath(name) {
					if (name === "downloads") return join(homedir(), "Downloads");
					return homedir();
				},
			},
			auth: null,
			logging: null,
			shell: null,
			voice: null,
			terminal: null,
			skillsEnvironment: null,
			todoPlan: null,
			scratchpad: null,
			plugins: null,
			gateway: null,
			settings: null,
			evals: null,
			mcp: null,
			/**
			 * 本机可信在这里必须是 `null`(B3):独立 server 到底可不可信取决于它
			 * **绑到哪个地址**,而装配的时候还没 listen。声明点在
			 * `apps/server/src/main.ts` —— 回环才声明 `loopback-server`,非回环
			 * 一个字不说。桌面把自己那只 backend 交给这段代码时(`embed.ts`)走的
			 * 是另一张表,那张表里 `localTrust` 是 `desktop-embedded`。
			 */
			localTrust: null,
		},
		toolRegistry: serverToolRegistry,
		sessionSkills: true,
		sender: new ServerNoopSender() as never,
	});
}

/**
 * 在一只**已经存在**的产品后端之上建 server runtime(A 期的核心接缝)。
 *
 * 桌面主进程装配完 backend 之后调这个:HTTP/SSE 面因此和 renderer 的 IPC 面
 * 共享同一条事件流、同一份内存真相、同一个 seq 分配器 —— 而不是像从前那样
 * 由 apps/server 再装配一只引擎。
 *
 * 借来的 backend 必须传 `processPorts: 'host'`:MCP 客户端宿主、授权账页存储、
 * todo/scratchpad 广播这三组是**进程级单槽端口**,宿主已经配好了,server runtime
 * 再配一次就是把桌面的接线覆盖掉(MCP 会被换成 DisabledServerMCPClient)。
 */
export async function createOnethingServerRuntimeOverBackend(
	backend: OnethingBackend,
	options: OnethingServerRuntimeOverBackendOptions = {},
): Promise<OnethingServerRuntime> {
	backend.assertActive();
	let surface: OnethingServerRuntime
	try {
		surface = await createServerRuntimeOverServerBackend(
			toOnethingServerBackend(backend, { ownsBackend: false }), options,
		)
	} catch (error) {
		if (options.ownsBackend !== false) {
			try { await backend.requestShutdown('server runtime startup failed') }
			catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Server startup and cleanup failed', { cause: error }) }
		}
		throw error
	}
	if (options.ownsBackend !== false) {
		backend.own(() => surface.shutdown(), 'serverRuntime');
		return { ...surface, backend, shutdown: () => backend.requestShutdown('server shutdown') };
	}
	return { ...surface, backend };
}

export async function createDevelopmentOnethingServerRuntime(
	options: OnethingServerRuntimeOptions = {},
): Promise<OnethingServerRuntime> {
	const storePath = resolve(options.storePath ?? getOnethingStorePath());
	// echo / local-store 测试后端仍然走原路:它们给的就是 `OnethingServerBackend`
	// 这只适配壳,不是产品后端。
	if (options.createBackend) {
		return createServerRuntimeOverServerBackend(await options.createBackend(), {
			...options,
			storePath,
		});
	}
	return createOnethingServerRuntimeOverBackend(
		await createRealServerBackend(storePath, options.logging),
		{ ...options, storePath, ownsBackend: true },
	);
}

async function createServerRuntimeOverServerBackend(
	backend: OnethingServerBackend,
	options: OnethingServerRuntimeOptions = {},
): Promise<OnethingServerRuntime> {
	const storePath = resolve(options.storePath ?? getOnethingStorePath());
	// 进程级单槽端口:'own' = 这个进程就是 core 进程,由 server runtime 配;
	// 'host' = 宿主(桌面)已经配好了,只做叠加不做改写。
	const ownsProcessPorts = (options.processPorts ?? "own") === "own";
	const eventBus = backend.eventBus;
	const streamChannel = backend.streamChannel;
	// Real engine backends persist through the @onething/backend repository; a
	// second local repository over the same files would fork the in-memory
	// truth and race writes (intermittent 404/empty history, jsonl ENOENT).
	const sessionStore =
		options.sessionStore ??
		(backend.persistsMessages
			? createAppBackedServerSessionStore(storePath)
			: createEchoServerSessionStore(storePath));
	// 触碰即驻留的工作集,不再启动全量镜像:同一 sessionId 在本进程内保持
	// 单一对象身份(事件回放与 API 变更共用),冷会话按需从存储加载。
	const sessions = new Map<string, ServerChatSession>();
	// Live-stream ledger derived from engine events (stream:start adds, any
	// terminal stream event removes). Works identically for the real engine
	// and echo test backends — its predecessor was an AbortController map that
	// nothing ever populated, so /api/streams/abort no-oped while the engine
	// kept streaming (architecture-review-2026-07-26.md A1).
	const activeStreamSessions = new Set<string>();
	const currentSessionIds = new Map<string, string>();
	const pendingPermissions = new Map<string, PendingPermissionRecord>();
	const settingsByOwner = new Map<string, AppSettings>();
	const mcpManagersByOwner = new Map<string, ServerMCPManager>();
	const agentStoresByOwner = new Map<
		string,
		ReturnType<typeof createOnethingAgentStore>
	>();
	const promptStoresByOwner = new Map<string, OnethingPromptStore>();
	const pluginCatalogManagersByOwner = new Map<
		string,
		ServerPluginCatalogManager
	>();
	const variableRuntimesByOwner = new Map<string, ServerVariablesRuntime>();
	// This surface owns both RPC watches and SSE subscriptions, including setup.
	const workspaceWatches = createWorkspaceWatchService();
	const workspaceRoot = resolve(
		options.workspaceRoot ??
			process.env.ONETHING_SERVER_WORKSPACE_ROOT ??
			join(tmpdir(), "onething-server-workspaces"),
	);
	const dataRoot = resolve(
		options.dataRoot ?? process.env.ONETHING_SERVER_DATA_ROOT ?? storePath,
	);
	const explicitSettingsRoot =
		options.settingsRoot ?? process.env.ONETHING_SERVER_SETTINGS_ROOT;
	const baseSettingsStore =
		options.settingsStore ??
		(explicitSettingsRoot
			? createFileServerSettingsStore(explicitSettingsRoot)
			: createDefaultContextServerSettingsStore(
					getOnethingSettingsPath({ storePath }),
					join(dataRoot, "settings"),
				));
	// Real engine: the in-process engine reads settings through the app store's
	// memory cache. A default-context save from the HTTP API writes the same
	// settings.json — drop the app cache so the engine's next read reloads,
	// otherwise e.g. a freshly entered API key needs a server restart.
	const settingsStore: ServerSettingsStore = backend.persistsMessages
		? {
				load: (context) => baseSettingsStore.load(context),
				async save(context, settings) {
					await baseSettingsStore.save(context, settings);
					if (isDefaultServerRequestContext(context)) {
						invalidateAppSettingsCache();
					}
				},
			}
		: baseSettingsStore;
	// 嵌在宿主里时不碰这个端口:桌面已经按它自己的口径配过了,再配一次等于把
	// 桌面的授权账页搬到另一个目录(dataRoot 与 store 不一定同一处)。
	if (ownsProcessPorts) {
		const permissionGrantStorageAdapters: OnethingPermissionGrantStorageAdapters = {
			getPermissionsDir: () => join(dataRoot, "permissions"),
			readJsonFile: readServerRuntimeJsonFile,
			writeJsonFile: writeServerRuntimeJsonFile,
		}
		configureOnethingPermissionGrantStorage(permissionGrantStorageAdapters);
	}
	const enableMCPConnections =
		options.enableMCPConnections ??
		process.env.ONETHING_SERVER_MCP_CONNECTIONS === "1";
	const allowMCPStdio =
		options.allowMCPStdio ?? process.env.ONETHING_SERVER_MCP_STDIO === "1";
	const mcpClientFactory =
		options.mcpClientFactory ??
		(enableMCPConnections
			? (config: MCPServerConfig) =>
					new ServerMCPClient(config, { allowStdio: allowMCPStdio })
			: (config: MCPServerConfig) => new DisabledServerMCPClient(config));
	const isDefaultContext = (context = defaultRequestContext()) =>
		context.userId === defaultRequestContext().userId &&
		context.workspaceId === defaultRequestContext().workspaceId;

	// App-subsystem delegation: with the real engine, default-owner requests
	// read/write the same app stores the engine uses in-process; echo/test
	// backends and scoped owners keep the server-local implementations.
	const useAppSubsystems = (context = defaultRequestContext()) =>
		backend.persistsMessages && isDefaultContext(context);

	const ownerDataRootForContext = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? storePath
			: tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId);

	const agentStorePathForContext = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? getOnethingAgentsPath({ storePath })
			: join(ownerDataRootForContext(context), "agents.json");

	const findSessionIndexMeta = (
		sessionId: string,
	): ServerSessionIndexMeta | undefined =>
		sessionStore.findSessionMeta
			? (sessionStore.findSessionMeta(sessionId) as
					| ServerSessionIndexMeta
					| undefined)
			: (sessionStore.getSessionsList() as ServerSessionIndexMeta[]).find(
					(meta) => meta.id === sessionId,
				);

	/**
	 * 受众的真相源(批 A §3.1)。`findMeta` 走上面那口;`onChanged` 是 app 仓库
	 * 索引写门的通知口。
	 *
	 * **为什么一个通知口就够**:备忘记的是「这条会话归不归我」,而归属只在会话
	 * **创建**那一刻盖一次章(`stampOwner`),之后没有改归属的写路。新会话对备忘
	 * 恒是一次未命中(没记过就现判),所以通知口今天的作用是**防御性**的 ——
	 * 将来真出现「共享会话」这类新归属规则时,失效口已经在正确的位置上。
	 */
	const sessionIndexPort: SessionIndexPort = {
		// 索引里没有这条时**回落到会话对象**:批 A 之前那把尺子问的是
		// `getSessionForContext`(会话对象上的归属),而索引条目理论上可以还没写
		// (存量盘、echo 后端的工作集)。回落只在**备忘未命中且索引查无此条**时跑,
		// 热路上一步都不多 —— 换来的是与批 A 之前逐字同判,不是「大概一样」。
		findMeta: (sessionId) => findSessionIndexMeta(sessionId) ?? resolveSession(sessionId),
		onChanged: (listener) => onSessionIndexChanged(listener),
	};
	const audienceFactory: SessionAudienceFactory =
		options.audienceFactory ?? createTenantAudienceFactory(sessionIndexPort);

	const loadSessionIntoWorkingSet = (
		sessionId: string,
	): ServerChatSession | undefined => {
		const session = sessionStore.getSession(sessionId);
		if (!session) return undefined;
		normalizeStoredServerSession(session, sessionStore.getMessages(sessionId));
		sessions.set(sessionId, session);
		return session;
	};

	// 取会话:活跃流会话以内存态为准;冷会话按 index 元数据的 updatedAt 判断
	// 是否被其他进程(桌面端共用同一存储)改写,过期才重读单个会话文件。
	const resolveSession = (sessionId: string): ServerChatSession | undefined => {
		if (backend.persistsMessages) {
			// sessionStore is app-backed: the same repository the in-process
			// engine writes through, so its in-memory session is the freshest
			// truth (async writes may still be queued). Never route real-engine
			// sessions through the `sessions` working set — a stale copy there
			// would shadow engine state.
			return sessionStore.getSession(sessionId);
		}
		const cached = sessions.get(sessionId);
		if (cached && activeStreamSessions.has(sessionId)) return cached;
		if (cached) {
			const meta = findSessionIndexMeta(sessionId);
			if (!meta || meta.updatedAt === cached.updatedAt) return cached;
		}
		return loadSessionIntoWorkingSet(sessionId) ?? cached;
	};

	const getServerCurrentSessionId = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? sessionStore.getCurrentSessionId()
			: getCurrentSessionId(currentSessionIds, context);

	const setServerCurrentSessionId = (
		context: RuntimeRequestContext,
		sessionId: string,
	): void => {
		if (isDefaultContext(context)) {
			sessionStore.setCurrentSessionId(sessionId);
		} else {
			setCurrentSessionId(currentSessionIds, context, sessionId);
		}
	};

	const persistSession = (session: ServerChatSession): void => {
		if (!backend.persistsMessages) {
			// Echo path only: stamp echo-provider defaults and keep the session
			// resident in the working set. Real-engine sessions live in the app
			// repository — stamping 'local-echo' here would persist into the
			// store shared with the desktop.
			normalizeStoredServerSession(
				session,
				sessionStore.getMessages(session.id),
			);
			sessions.set(session.id, session);
		}
		sessionStore.saveSession(session);
	};

	/**
	 * 消息命令之后的会话级收尾(P0.3)。
	 *
	 * 命令面已经按写计划把消息落过盘了,这里只补派生字段与 index 元数据 ——
	 * 再走一次 `persistSession` 就是把整份 messages.jsonl 重写一遍(SV12 的病根)。
	 * 例外是自动标题:`name` 住在会话体里,改了才需要整份写。
	 * 会话对象**重新解析**:命令写的是仓库里那一份,手上那一份可能已经被 LRU 换过。
	 */
	const settleMessageCommand = (sessionId: string): void => {
		const session = resolveSession(sessionId);
		if (!session) return;
		const previousName = session.name;
		refreshSessionMeta(session, sessionStore.getMessages(sessionId), {
			preserveUpdatedAt: true,
		});
		if (session.name !== previousName) {
			persistSession(session);
			return;
		}
		sessionStore.saveSessionMeta(session);
	};

	const getSessionForContext = (
		sessionId: string,
		context = defaultRequestContext(),
	): ServerChatSession | undefined => {
		const session = resolveSession(sessionId);
		if (!session || !ownsSession(session, context)) return undefined;
		return session;
	};

	// 会话列表只读 index 元数据(所有权字段由 store 回填/盖章),不加载消息体。
	const listOwnedSessionMetas = (
		context = defaultRequestContext(),
	): ServerSessionIndexMeta[] =>
		(sessionStore.getSessionsList() as ServerSessionIndexMeta[]).filter(
			(meta) => ownsSessionMeta(meta, context),
		);

	const listSessionsForContext = (
		context = defaultRequestContext(),
	): SessionMeta[] =>
		listOwnedSessionMetas(context).map(stripSessionOwnerFields);

	const ensureSession = (
		context: RuntimeRequestContext,
		sessionId = createSessionId(),
	): ServerChatSession => {
		const existing = resolveSession(sessionId);
		if (existing) {
			if (!ownsSession(existing, context)) throw new Error('Session not found')
			return existing;
		}

		const root = workspaceSandboxRoot(workspaceRoot, context);
		// Synchronous: callers (file watch, tools) may stat this root right
		// after session creation, and a fire-and-forget mkdir loses that race.
		try {
			mkdirSync(root, { recursive: true });
		} catch (error) {
			log.error("create workspace root failed", { root }, error);
		}
		let session: ServerChatSession;
		if (backend.persistsMessages) {
			// Single-writer: the app-backed store creates through the same
			// repository the engine reads from, so the session is visible to an
			// immediately-following command:send-message (draft-id flows send
			// right after create) without waiting for any async flush.
			session = sessionStore.createSession(sessionId, "New Chat", context);
			updateAppSessionWorkingDirectory(sessionId, root);
			updateAppSessionWorkingDirectoryRoots(sessionId, [root]);
		} else {
			session = sessionStore.createSession(sessionId, "New Chat", context);
			if (!session.workingDirectory) session.workingDirectory = root;
			if (!session.workingDirectoryRoots?.length)
				session.workingDirectoryRoots = [root];
			persistSession(session);
		}
		if (!getServerCurrentSessionId(context)) {
			setServerCurrentSessionId(context, session.id);
		}
		return session;
	};

	const unsubscribeRuntimeStore = eventBus.onAnySessionAny((envelope) => {
		const eventType = (envelope.event as { type?: string }).type;
		if (eventType === SESSION_EVENT_TYPES.STREAM_START) {
			activeStreamSessions.add(envelope.sessionId);
		} else if (
			eventType === SESSION_EVENT_TYPES.STREAM_COMPLETE ||
			eventType === SESSION_EVENT_TYPES.STREAM_ERROR ||
			eventType === SESSION_EVENT_TYPES.STREAM_ABORTED
		) {
			activeStreamSessions.delete(envelope.sessionId);
		}
		const permissionEvent = readPermissionTrackingEvent(envelope.event);
		if (permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_REQUEST) {
			// Resolve through the store (not the echo working set): real-engine
			// sessions never enter the `sessions` map.
			const session = resolveSession(envelope.sessionId);
			const info = session
				? toPendingPermissionInfo(envelope.event, envelope.sessionId, session)
				: undefined;
			if (info)
				pendingPermissions.set(permissionEvent.requestId, {
					sessionId: envelope.sessionId,
					info,
				});
		} else if (
			permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_TIMEOUT ||
			permissionEvent?.type === SESSION_EVENT_TYPES.PERMISSION_SETTLED
		) {
			pendingPermissions.delete(permissionEvent.requestId);
		}
		if (!backend.persistsMessages) {
			// Test/echo backends do not persist; project their events into the
			// server store. The real StreamEngine writes through the shared app
			// repository itself — projecting again would double-write, and
			// there is no second cache left to invalidate.
			const session = sessions.get(envelope.sessionId);
			if (!session) return;
			applySessionEvent(sessionStore, session, envelope.event);
			persistSession(session);
		}
	}, "ServerRuntimeStore");

	// C1 收尾:`getMCPSettingsForContext` 随最后一个调用方(下面那句 `initialize`)
	// 一起没了 —— 默认 owner 的 MCP 设置现在由子系统自己读(`getSettings().mcp`,
	// 同一个 `<store>/settings.json`,见下面那段的核实记录)。scoped owner 从来
	// 不经这条路:它们各有自己的 server-local manager。

	// The engine's MCP bridge is hard-bound to the @onething/backend singleton
	// manager, so the default owner MUST route through that same instance —
	// a server-local manager would connect servers the model never sees
	// (same class of split as the session double-repository above).
	// Scoped owners keep their isolated server-local managers.
	if (backend.persistsMessages) {
		// 嵌在宿主里(processPorts: 'host')时这三个 configure* 一律不碰:桌面配的是
		// 真的 MCP 客户端,server 这份默认是 DisabledServerMCPClient —— 覆盖过去
		// 等于把桌面的 MCP 静悄悄关掉。初始化同理由桌面的 initializeMCP() 负责。
		if (ownsProcessPorts) {
			// clientInfo version: workspace packages all say 0.0.0 — only the repo
			// root package.json carries the product version, and this host runs
			// from the repo (a packaged form would configure its own).
			try {
				const rootPkg = JSON.parse(
					readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
				) as { version?: unknown };
				configureMCPClientIdentity({
					version: typeof rootPkg.version === "string" ? rootPkg.version : undefined,
				});
			} catch {
				// Root package.json unreadable → identity default stays.
			}
			configureMCPClientHost(mcpClientFactory);
			// P2-1(server-pushed list changes → 重建模型面的工具目录)那口
			// `configureMCPCapabilitiesChangedHandler` 从这里删掉了:它是个**单槽**
			// 端口,而 `McpSubsystem` 在构造点就接了逐字同一个函数
			// (`registerMCPTools`,本文件里的别名是 `registerAppMCPTools`)。从前
			// 两处各接一份,谁后接谁生效;现在只有子系统那一份,而且它在
			// `dispose()` 里会把这口摘回 `null` —— 从前 server 这份接上去就再也没人摘。
		}
		mcpManagersByOwner.set(
			ownerKey(defaultRequestContext()),
			appMCPManager as ServerMCPManager,
		);
		if (ownsProcessPorts) {
			/*
			 * C1 收尾(方案 §2.2 偏离 1 留的那一条):从前这里是
			 * `appMCPManager.initialize(await getMCPSettingsForContext())` +
			 * `registerAppMCPTools()` 两句手写词,与装配层、React 壳各抄一遍的
			 * 那两份并列。现在问子系统要 —— `start()` 内部就是这两句同一个顺序。
			 *
			 * **设置同源已核实**:`getMCPSettingsForContext(defaultRequestContext())`
			 * 走 `createDefaultContextServerSettingsStore`,它对**默认上下文**特判到
			 * `createSingleFileServerSettingsStore(getOnethingSettingsPath({storePath}))`
			 * = `<store>/settings.json`;而子系统读的 `getSettings().mcp` 走
			 * `stores/settings.ts` 的 repository,`filePath: getOnethingSettingsPath`,
			 * 同一个文件、同一个 `mergeWithDefaults`(`resolveEffectiveAppSettings`
			 * 只重算 `.ai`,不碰 `.mcp`)。`createRealServerBackend` 开头就把
			 * `ONETHING_STORE_PATH` 钉到同一个 storePath,所以两边的路径也同一个。
			 * 唯一的分叉是显式 `ONETHING_SERVER_SETTINGS_ROOT` / `options.settingsRoot`
			 * / `options.settingsStore` —— 那会把**连默认 owner 在内**的设置整体挪到
			 * `<root>/<uid>/<wid>.json`,而进程里的引擎照旧读 `<store>/settings.json`,
			 * 也就是说那条路上 MCP 从前是全进程唯一一个跟着挪的读者。仓里无人设它。
			 *
			 * `backend.mcp` 缺席(echo/local 测试替身)= 不起 MCP。替身的
			 * `persistsMessages` 是 `false`,本来就进不到这个块。
			 *
			 * 顺序不动:`configureMCPClientIdentity` / `configureMCPClientHost` 必须
			 * 排在 `start()` 之前 —— manager 是在 start 里才按工厂建客户端的。
			 *
			 * **一处真实的行为变化**:MCP 的收尾从"`backend.shutdown()` 跑完之后
			 * 那一圈 fire-and-forget 的 `mcpManagersByOwner`"挪进了 `backend.dispose()`
			 * (`own('mcp')` 那一格),而子系统的 `dispose()` 按 C1 的设计**要等在途的
			 * `start()` 落地**。于是一台在初次握手上挂死的 stdio 服务器会拖住收尾 ——
			 * 初版实测把 `apps/server` 那 5s 预算吃干净(5.06s + `shutdown did not
			 * finish in time; pending session writes may be lost`),从前是 0.05s。
			 * **用户裁定不接受无界等待**,于是 `McpSubsystem.dispose()` 现在自带
			 * 3000ms 上限(见 `wiring/mcp/subsystem.ts` 的
			 * `DEFAULT_MCP_DISPOSE_TIMEOUT_MS`),超时记 warn 并放行,把余量留给排在
			 * 后面的账本 flush:同一场景现在 3.05s,那行 `pending session writes` 消失。
			 * MCP 正常(0 台 / 连不上但快速失败)时收尾仍是 0.04–0.18s。
			 */
			if (backend.mcp) {
				void backend.mcp
					.start()
					.then(() => {
						/*
						 * 起完了记一行 —— 这行是**新加的**,补的是一个真实的可观测性
						 * 缺口:core 自己那两句(`mcp initializing` /
						 * `mcp connecting to servers`)在独立 server 上从此进不了
						 * `server.jsonl` 了。原因不是行为变了,是**时序**:
						 * `apps/server/src/main.ts` 要等 runtime 装配完才
						 * `configureLogging`(store 根由装配钉死,提前接线会写进另一个
						 * store 的 log/),而从前那句 `await getMCPSettingsForContext()`
						 * 带一次真实的文件读,把 `initialize` 顶到了 `configureLogging`
						 * 之后 —— 那是运气,不是设计。子系统读设置是同步的
						 * (`getSettings()` 走内存缓存),于是 core 那两句落在了接线之前。
						 * `start()` 兑现时接线早已完成,所以这一行必到。
						 */
						log.info("mcp subsystem started", {
							servers: appMCPManager.getSettings().servers.length,
						});
					})
					.catch((error: unknown) => {
						log.error("mcp initialization failed", {}, error);
					});
			}
		}
	}

	/**
	 * 草稿纸的广播是**进程级**的:store 是 `@onething/runtime/scratchpad` 的单例
	 * (引擎在同一进程里读同一张纸),所以订阅者也不按 owner 分表 —— 分了就要
	 * 有第二个 store,而第二个 store 就是第二份事实。
	 */
	const scratchpadChangedHandlers = new Set<
		(payload: ScratchpadChangedPayload) => void
	>();
	/**
	 * todo/plan 的广播和草稿纸同形:数据面迁到通用 RPC 通道之后,写发生在
	 * `@onething/backend/wiring/todo-plan` 那一个进程级 store 里,per-owner 的第二个 store
	 * 连同它的 per-owner 订阅表一起没了。**这个端口是 `/api/todo-plan/events`
	 * 这条 SSE 唯一的货源** —— 少了它,浏览器端的变更推送会安静地断掉。
	 */
	const todoPlanChangedHandlers = new Set<TodoPlanChangedHandler>();
	// 两个单槽端口:嵌在宿主里时**串联**(先调宿主原来那只,再喂 SSE),
	// `shutdown()` 里还原。独立进程里前一位是空的,串联退化成今天的行为。
	const previousTodoPlanHostPorts = getTodoPlanHostPorts();
	const previousScratchpadHostPorts = getScratchpadHostPorts();
	/**
	 * OAuth 令牌事件同形(P4c 第七批):数据面迁走之后,事件源是装配层那台
	 * `authService` 单例,而 `GET /api/oauth/events` 那条 SSE 是它在 web 上的出口。
	 * 端口是单槽的,所以嵌在宿主里时**串联** —— 先让桌面那只把事件推给窗口,
	 * 再扇进这里的订阅表;`shutdown()` 还原。
	 */
	const oauthTokenEventHandlers = new Set<(event: OAuthTokenEvent) => void>();
	const previousOAuthEventBroadcaster = getOAuthEventBroadcaster();
	configureOAuthEventBroadcaster((event) => {
		previousOAuthEventBroadcaster?.(event);
		for (const handler of oauthTokenEventHandlers) {
			try {
				handler(event);
			} catch (error) {
				log.error("oauth token event broadcast failed", {}, error);
			}
		}
	});
	const restoreOAuthEventBroadcaster = (): void => {
		configureOAuthEventBroadcaster(previousOAuthEventBroadcaster);
		oauthTokenEventHandlers.clear();
	};
	/**
	 * 设置变更(E 批)——**与 oauth 逐字同形**的单槽端口串联:先让宿主那只把
	 * 事件推给窗口,再扇进这里的 SSE 订阅表;`shutdown()` 还原。
	 *
	 * 两件事故意与桌面那一侧不同,理由都写在这儿:
	 *
	 *  - **载荷脱敏**。桌面回灌的是整份 `AppSettings`(同一台机器,设置页要读到
	 *    自己刚填的凭证);SSE 那头是网络对端,所以过一遍 `sanitizeSettingsForClient`
	 *    —— **逐字复用** `settings.getSettings` 在 `transport === 'http'` 那一支上
	 *    已经在用的那个投影,于是推送与读取交出去的是同一形状,一格不多。
	 *  - **不排除发起窗**。`excludeCallerId` 说的是"哪扇 BrowserWindow 别收自己的
	 *    回声",它是 `webContents.id`;SSE 连接里没有那样一个东西,而浏览器那侧
	 *    发起保存后本来就要用回执刷新自己。原样全发。
	 */
	const settingsChangedHandlers = new Set<(settings: AppSettings) => void>();
	const previousSettingsEventBroadcaster = getSettingsEventBroadcaster();
	configureSettingsEventBroadcaster((event: SettingsEvent) => {
		previousSettingsEventBroadcaster?.(event);
		if (settingsChangedHandlers.size === 0) return;
		const sanitized = sanitizeSettingsForClient(event.settings);
		for (const handler of settingsChangedHandlers) {
			try {
				handler(sanitized);
			} catch (error) {
				log.error("settings changed broadcast failed", {}, error);
			}
		}
	});
	const restoreSettingsEventBroadcaster = (): void => {
		configureSettingsEventBroadcaster(previousSettingsEventBroadcaster);
		settingsChangedHandlers.clear();
	};
	const settingsPort: RuntimeSettingsAdapter = {
		subscribeChanged(handler) {
			const typedHandler = handler as (settings: AppSettings) => void;
			settingsChangedHandlers.add(typedHandler);
			return () => {
				settingsChangedHandlers.delete(typedHandler);
			};
		},
	};
	const subscribeOAuthTokenEvents = (
		handler: (event: OAuthTokenEvent) => void,
	): RuntimeUnsubscribe => {
		oauthTokenEventHandlers.add(handler);
		return () => {
			oauthTokenEventHandlers.delete(handler);
		};
	};
	configureTodoPlanHost({
		...previousTodoPlanHostPorts,
		broadcastChanged: (payload) => {
			previousTodoPlanHostPorts.broadcastChanged?.(payload);
			for (const handler of todoPlanChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					log.error("todo-plan broadcast failed", {}, error);
				}
			}
		},
	});

	configureScratchpadHost({
		...previousScratchpadHostPorts,
		broadcastChanged: (payload) => {
			previousScratchpadHostPorts.broadcastChanged?.(payload);
			for (const handler of scratchpadChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					log.error("scratchpad broadcast failed", {}, error);
				}
			}
		},
	});
	// AI 用普通 write/edit 工具改纸时不经过 store —— watcher 是唯一会告诉
	// 浏览器"纸变了"的人。嵌在宿主里时宿主已经起过同一只 watcher(它是单例),
	// 不重复起,也因此不由这里停。
	if (ownsProcessPorts) {
		void startScratchpadWatcher().catch((error) => {
			log.error("scratchpad watcher failed to start", {}, error);
		});
	}

	const subscribeScratchpadChanged = (
		handler: (payload: ScratchpadChangedPayload) => void,
	): RuntimeUnsubscribe => {
		scratchpadChangedHandlers.add(handler);
		return () => {
			scratchpadChangedHandlers.delete(handler);
		};
	};

	function describeRuntimeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	const subscribeTodoPlanChanged = (
		handler: TodoPlanChangedHandler,
	): RuntimeUnsubscribe => {
		todoPlanChangedHandlers.add(handler);
		return () => {
			todoPlanChangedHandlers.delete(handler);
		};
	};

	const getAgentStoreForContext = (context = defaultRequestContext()) => {
		const key = ownerKey(context);
		let store = agentStoresByOwner.get(key);
		if (!store) {
			const created = createOnethingAgentStore({
				agentsPath: agentStorePathForContext(context),
			});
			// The default context writes the same agents.json the in-process
			// engine reads through the app store's memory cache. Drop that cache
			// after every write, or an agent edited over HTTP would keep running
			// with its old prompt/tools until the server restarts (same shape as
			// the settings-store wrapper above).
			store = isDefaultContext(context)
				? {
						...created,
						createAgent(input) {
							const agent = created.createAgent(input);
							invalidateAppAgentsCache();
							return agent;
						},
						updateAgent(input) {
							const agent = created.updateAgent(input);
							invalidateAppAgentsCache();
							return agent;
						},
						// 退休/恢复也是写 —— 少一次 invalidate,退休了的 agent 在
						// 引擎眼里还是 active,照样被激活开口。
						retireAgent(agentId) {
							const agent = created.retireAgent(agentId);
							invalidateAppAgentsCache();
							return agent;
						},
						restoreAgent(agentId) {
							const agent = created.restoreAgent(agentId);
							invalidateAppAgentsCache();
							return agent;
						},
						deleteAgent(agentId) {
							created.deleteAgent(agentId);
							invalidateAppAgentsCache();
						},
					}
				: created;
			agentStoresByOwner.set(key, store);
		}
		return store;
	};

	const getPromptStoreForContext = (
		context = defaultRequestContext(),
	): OnethingPromptStore => {
		const key = ownerKey(context);
		let store = promptStoresByOwner.get(key);
		if (!store) {
			const promptStoreAdapters: OnethingPromptStoreAdapters = {
				getPath: () =>
					join(
						tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId),
						"prompts.json",
					),
				readJson: readServerRuntimeJsonFile,
				writeJson: writeServerRuntimeJsonFile,
				warn: (message, details) => {
					log.warn(
						"prompt store",
						details === undefined ? { detail: message } : { detail: message, details },
					);
				},
			};
			store = new OnethingPromptStore(promptStoreAdapters);
			promptStoresByOwner.set(key, store);
		}
		return store;
	};

	const getVariableRuntimeForContext = (
		context = defaultRequestContext(),
	): ServerVariablesRuntime => {
		const key = ownerKey(context);
		let variableRuntime = variableRuntimesByOwner.get(key);
		if (variableRuntime) return variableRuntime;

		const variablesPath = serverVariablesFilePath(
			dataRoot,
			context,
			isDefaultContext(context) ? storePath : undefined,
		);
		const variablesStorePersistence: VariablesStorePersistence = {
			loadFromDisk: () => {
				const raw = readServerRuntimeJsonFile<unknown | undefined>(
					variablesPath,
					undefined,
				);
				return sanitizeServerVariablesFile(
					raw === undefined
						? createServerDefaultVariablesFile(workspaceRoot, context)
						: parseVariablesFile(raw).data,
					workspaceRoot,
					context,
				);
			},
			saveToDisk: (state) =>
				writeServerRuntimeJsonFile(
					variablesPath,
					sanitizeServerVariablesFile(state, workspaceRoot, context),
				),
		};
		const store = new VariablesStore(variablesStorePersistence);
		store.initialize();

		const registry = new VariableRegistry();
		const sandboxRoot = workspaceSandboxRoot(workspaceRoot, context);
		const invalidPath = () => join(sandboxRoot, "__outside_workspace__");
		const expandWorkspaceVariablePath = (input: string): string =>
			resolveServerWorkspaceFilePath(workspaceRoot, context, input) ??
			invalidPath();

		registerStandardVariableProviders(registry, {
			workdir: {
				read: (sessionId) => {
					const session = getSessionForContext(sessionId, context);
					return session
						? session.workingDirectory ||
								workspaceSandboxRootForSession(workspaceRoot, session)
						: sandboxRoot;
				},
				readRoots: (sessionId) => {
					const session = getSessionForContext(sessionId, context);
					return session
						? (session.workingDirectoryRoots ?? [
								workspaceSandboxRootForSession(workspaceRoot, session),
							])
						: [sandboxRoot];
				},
				write: (sessionId, workdir) => {
					const session = getSessionForContext(sessionId, context);
					if (!session) throw new Error("Session not found");
					const resolvedPath = resolveServerWorkspaceFilePath(
						workspaceRoot,
						context,
						workdir,
					);
					if (!resolvedPath)
						throw new Error(
							"Working directory must stay inside the workspace sandbox root.",
						);
					session.workingDirectory = resolvedPath;
					persistSession(session);
				},
				writeRoots: (sessionId, roots) => {
					const session = getSessionForContext(sessionId, context);
					if (!session) throw new Error("Session not found");
					const resolvedRoots = roots
						.map((root) =>
							resolveServerWorkspaceFilePath(workspaceRoot, context, root),
						)
						.filter((root): root is string => Boolean(root));
					session.workingDirectoryRoots = [
						workspaceSandboxRootForSession(workspaceRoot, session),
						...resolvedRoots,
					];
					persistSession(session);
				},
				expandPath: expandWorkspaceVariablePath,
			},
			notes: {
				read: (which) => readServerNoteVariable(store, which),
				write: (which, value) => writeServerNoteVariable(store, which, value),
				expandPath: expandWorkspaceVariablePath,
				onChange: (callback) => store.subscribe(callback),
			},
			globalStore: {
				read: () => store.getGlobalVariables(),
				write: (variables) => store.setGlobalVariables(variables),
				onChange: (callback) => store.subscribe(callback),
			},
			sessionStore: {
				read: (sessionId) => {
					const session = getSessionForContext(sessionId, context);
					return session ? (session.variables ?? []) : [];
				},
				write: (sessionId, variables) => {
					const session = getSessionForContext(sessionId, context);
					if (!session) throw new Error("Session not found");
					session.variables = variables;
					persistSession(session);
				},
			},
			agentStore: {
				resolveKey: (sessionId) => {
					const session = getSessionForContext(sessionId, context);
					if (!session) return null;
					return session.agentId || DEFAULT_ONETHING_AGENT_ID;
				},
				read: (key) => store.getScopedVariables("agent", key),
				write: (key, variables) =>
					store.setScopedVariables("agent", key, variables),
				onChange: (callback) => store.subscribe(callback),
			},
			projectStore: {
				resolveKey: (sessionId) => {
					const workdir = getSessionForContext(
						sessionId,
						context,
					)?.workingDirectory;
					return workdir ? projectIdFromPath(workdir) : null;
				},
				read: (key) => store.getScopedVariables("project", key),
				write: (key, variables) =>
					store.setScopedVariables("project", key, variables),
				onChange: (callback) => store.subscribe(callback),
			},
		});

		// Broadcasts (empty sessionId) come from shared-scope writes
		// (global/agent/project) or external store changes; other sessions'
		// variable panels would go stale without a fresh snapshot. Emit-only:
		// re-persisting every session on a broadcast would be write
		// amplification for a UI refresh. Coalesced per tick.
		let broadcastRefreshScheduled = false;
		const refreshAllSessions = () => {
			if (broadcastRefreshScheduled) return;
			broadcastRefreshScheduled = true;
			queueMicrotask(() => {
				broadcastRefreshScheduled = false;
				for (const meta of listSessionsForContext(context)) {
					registry
						.list({ sessionId: meta.id })
						.then((snapshot) => {
							const session = getSessionForContext(meta.id, context);
							if (!session) return;
							emitSessionSnapshot(session, snapshot);
						})
						.catch((error) => {
							log.error(
								"variables broadcast refresh failed",
								{ sessionId: meta.id },
								error,
							);
						});
				}
			});
		};
		const emitSessionSnapshot = (
			session: ServerChatSession,
			snapshot: Awaited<ReturnType<typeof registry.list>>,
		) => {
			eventBus
				.emit(session.id, {
					type: SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED,
					workingDirectory: session.workingDirectory,
					workingDirectoryRoots: session.workingDirectoryRoots,
					variables: snapshot,
				} as unknown as AgentEngineSessionEvent)
				.catch((error) => {
					log.error("variables snapshot emit failed", { sessionId: session.id }, error);
				});
		};
		const unsubscribe = registry.subscribe((variableContext, snapshot) => {
			if (!variableContext.sessionId) {
				refreshAllSessions();
				return;
			}
			const session = getSessionForContext(variableContext.sessionId, context);
			if (!session) return;
			applyVariablesSnapshotToSession(session, snapshot);
			persistSession(session);
			emitSessionSnapshot(session, snapshot);
		});

		variableRuntime = { registry, store, unsubscribe };
		variableRuntimesByOwner.set(key, variableRuntime);
		return variableRuntime;
	};

	/**
	 * 这个 owner 的取材面(会话 / 文件 / 提示词全按请求上下文取)。
	 *
	 * 提成命名函数是 S2 的需要(检索重建,`docs/design/search-index-2026-09.md` §10):
	 * 「同一件事的两个口径」现在也是**同一个门面的两次装配** —— 桌面按整台机器装一份
	 * `SearchService`,server 按 owner 各装一份,吃的是同一批能力。
	 */
	const createSearchAdaptersForContext = async (
		context = defaultRequestContext(),
	): Promise<OnethingSearchProvidersAdapters> => {
		const settings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);

		return {
			getSessionsList: () => listSessionsForContext(context),
			// P0.4:全库搜索按会话取消息走读口(`sessionStore.getMessages`),
			// 不再借 `getSessionRaw` 端口整条会话地拿 —— 那个回落端口已删。
			// 归属判定仍旧走 `getSessionForContext`(不是本人的会话不进搜索结果)。
			iterateSessionMessages: (sessionId) =>
				getSessionForContext(sessionId, context)
					? sessionStore.getMessages(sessionId)
					: [],
			getSession: (sessionId) => getSessionForContext(sessionId, context),
			getCurrentSessionId: () => getServerCurrentSessionId(context),
			getSettings: () => settings,
			getVariablesStore: () => getVariableRuntimeForContext(context).store,
			listFiles: (options) => {
				const rootPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					options.cwd,
				);
				return rootPath
					? listServerToolFiles({ cwd: rootPath, glob: options.glob })
					: emptyServerFileSearchResults();
			},
			listPrompts: () => getPromptStoreForContext(context).list(),
			// 「新建提示词」那个页级动作按下去的落点(检索面终稿 §0 ③)。
			// 与 listPrompts 同一份 per-owner 仓 —— 建到别人的仓里是越权。
			createPrompt: (request) =>
				getPromptStoreForContext(context).create({ title: request.title, body: "" }),
		};
	};

	const resolveSearchActionForContext = async (
		actionId: string,
		context = defaultRequestContext(),
	): Promise<{ success: boolean; actionId?: string; error?: string }> => {
		const createDailyNotePrefix = "create-daily-note:";
		if (!actionId.startsWith(createDailyNotePrefix)) {
			return { success: true, actionId };
		}

		const encodedPath = actionId.slice(createDailyNotePrefix.length);
		const requestedPath = decodeURIComponent(encodedPath);
		const filePath = resolveServerWorkspaceFilePath(
			workspaceRoot,
			context,
			requestedPath,
		);
		if (!filePath) {
			return {
				success: false,
				error:
					"Search action path must stay inside the workspace sandbox root.",
			};
		}

		try {
			// 取材面按请求上下文现装一份(设置 / 变量仓都是 per-owner 的),交给
			// 每日笔记那一类自己的 `createDailyNote` —— S5 之前这里绕的那个
			// 从前这里绕的那个 providers 门面是旧扫描路的入口,S5 随它一起删了。
			await createDailyNoteWith(
				filePath,
				await createSearchAdaptersForContext(context),
			);
			return { success: true, actionId: `open-file:${filePath}` };
		} catch (error: any) {
			return {
				success: false,
				error: error.message || "Failed to execute search action.",
			};
		}
	};

	const respondToPermission = async (
		requestId: string,
		response: unknown,
		context = defaultRequestContext(),
		expectedSessionId?: string,
	): Promise<{ success: boolean; error?: string }> => {
		const pending = pendingPermissions.get(requestId);
		if (!pending)
			return { success: false, error: "Permission request not found" };
		const sessionId = pending.sessionId;
		if (expectedSessionId && sessionId !== expectedSessionId) {
			return { success: false, error: "Permission request not found" };
		}

		const session = getSessionForContext(sessionId, context);
		if (!session) {
			return { success: false, error: "Permission request not found" };
		}

		const permissionResponse = normalizePermissionResponse(response);
		if (!permissionResponse)
			return { success: false, error: "Invalid permission response" };

		if (!backend.persistsMessages) {
			// Echo path only: with the real engine, core Permission.respond()
			// persists session/workspace grants itself — persisting here too
			// would double-write the grant store.
			persistPermissionGrantFromDecision(
				pending.info,
				permissionResponse.decision,
			);
		}
		pendingPermissions.delete(requestId);
		const command: Record<string, unknown> = {
			type: SESSION_COMMAND_TYPES.PERMISSION_RESPOND,
			// Adopt the ask's target channel (owner already authenticated at
			// the HTTP boundary); the normalized body channel is the fallback.
			channel: pending.info.targetChannel || permissionResponse.channel,
			requestId,
			decision: permissionResponse.decision,
		};
		if (permissionResponse.rejectReason)
			command.rejectReason = permissionResponse.rejectReason;
		await eventBus.emit(
			sessionId,
			command as unknown as AgentEngineSessionEvent,
		);
		return { success: true };
	};

	/**
	 * server 侧插件目录的六条读/开关面(P4 终态批 C2)。
	 *
	 * 从前它们是 `OnethingRuntimeFacade` 上的 `plugins` adapter,由
	 * `/api/plugins*` 六条 REST 路由调用。C2 把入口换成 `plugins` RPC 域,
	 * **闭包一行没改** —— 只是从 facade 的一格改成注册进单槽端口,域在
	 * `transport === 'http'` 那一支上原样调用。返回的是**还原**函数:
	 * 桌面内嵌 HTTP 面与 `server:start` 在同一进程里先后起落时,后者的槽
	 * 不会被前者的 shutdown 抹掉。
	 */
	const restoreServerPluginCatalogPort = configureServerPluginCatalogPort({
		list(context = defaultRequestContext()) {
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return listOnethingPluginsForIpc({
				manager,
				logger: consoleLog,
			});
		},
		enable(pluginId: string, context = defaultRequestContext()) {
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return enableOnethingPluginForIpc({
				manager,
				pluginId,
				logger: consoleLog,
			});
		},
		disable(pluginId: string, context = defaultRequestContext()) {
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return disableOnethingPluginForIpc({
				manager,
				pluginId,
				logger: consoleLog,
			});
		},
		refresh(context = defaultRequestContext()) {
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return refreshOnethingPluginsForIpc({
				manager,
				logger: consoleLog,
			});
		},
		commands(context = defaultRequestContext()) {
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return listOnethingPluginCommandsForIpc({
				manager,
				logger: consoleLog,
			});
		},
		executeCommand(request: unknown, context = defaultRequestContext()) {
			const typedRequest = request as {
				commandName?: string;
				args?: string;
				sessionId?: string;
			};
			const session = typedRequest.sessionId
				? getSessionForContext(typedRequest.sessionId, context)
				: undefined;
			if (!session) {
				return Promise.resolve({
					success: false,
					error: "Session not found",
				});
			}
			const manager = getServerPluginCatalogManagerForContext(
				pluginCatalogManagersByOwner,
				dataRoot,
				context,
				options.pluginCommands,
			);
			return executeOnethingPluginCommandForIpc({
				manager,
				commandName: typedRequest.commandName || "",
				args: typedRequest.args,
				sessionId: typedRequest.sessionId || "",
				getSession: () => session,
				emitSessionCommand: (sessionId, event) =>
					eventBus.emit(
						sessionId,
						event as unknown as AgentEngineSessionEvent,
					),
				emitGlobalEvent: (event) =>
					eventBus.emitGlobal(event as unknown as AgentEngineSessionEvent),
				exec: async () => ({
					stdout: "",
					stderr: "Shell execution is disabled in the web server runtime.",
					exitCode: 126,
				}),
				onEmitError(label, error) {
					log.error("server plugin emit failed", { label }, error);
				},
				logger: consolePort(log),
			});
		},
	});

	/**
	 * server 侧搜索的单槽端口(结构债 P4 终态批 A1-b)。
	 *
	 * 从前它是 `OnethingRuntimeFacade` 上 `search.query` 那一格,由
	 * `POST /api/search/query` 调用。A1-b 把入口换成 `search` RPC 域,
	 * **闭包一行没改** —— 域在 `transport === 'http'` 那一支上原样调用它。
	 * 同 `restoreServerPluginCatalogPort`:返回的是**还原**函数。
	 */
	const restoreServerSearchPort = configureServerSearchPort({
		async query(
			request: unknown,
			context = defaultRequestContext(),
		) {
			// S2:与桌面同一个门面、同一批能力,只是取材面按 owner 现装一份
			// (它的会话 / 文件 / 提示词表本来就是 per-owner 的,组不出进程单例)。
			//
			/*
			 * S3b:**这一条路上没有索引**,三条索引型能力(chats / messages / daily)
			 * 在这里答空。
			 *
			 * 这个端口只在**不可信**那一支上被调到(`isHostLocallyTrusted()` 为假 =
			 * 非回环部署的 server;桌面与回环 `server:start` 走的是进程单槽那份真服务,
			 * 索引照常)。而进程里那一份索引是 **store 级**的:它折的是
			 * `<store>/sessions` 那棵树,文档上只有 sessionId / spaceId / role /
			 * archived / time 几格,**没有 owner**。把它交给一个按 owner 沙箱化的调用者
			 * 等于让 bob 读到宿主机器上 alice 的会话 —— 那正是这个端口存在的理由的反面
			 * (`server/__tests__/http.test.ts` 里「bob 看不见 alice 的会话」那条)。
			 *
			 * 所以这里选**如实答不可用**,而不是「共用一份库、以后再补过滤」:少一类
			 * 结果是可见的缺口,串了 owner 是不可见的事故。给索引加 owner facet(或让
			 * server 按 owner 各建一个库)是 §5.6 / S6 的事,那之前这一格就该是空的。
			 */
			const service = createOnethingSearchService(
				await createSearchAdaptersForContext(context),
				{ index: unavailableIndexFace() },
			);
			return service.query(request as SearchServiceRequest, {
				principal: { kind: "user", id: context.userId ?? "local" },
				spaceId: context.workspaceId ?? "",
			});
		},
	});

	const capabilitiesPort: RuntimeCapabilitiesAdapter<RuntimeHostCapabilities> = {
		async get() {
			return currentServerCapabilities();
		},
	};
	const sessionsPort: RuntimeSessionsAdapter<unknown, unknown, string, Record<string, unknown>> = {
		async list(context = defaultRequestContext()) {
			return {
				success: true,
				sessions: listSessionsForContext(context),
			};
		},
		async create(
			name: string,
			context = defaultRequestContext(),
			requestedSessionId?: string,
		) {
			// Client-supplied ids keep the renderer's draft identity stable
			// (the draft id becomes the session id). Only plain v4 UUIDs are
			// accepted — the id is a storage path segment — and an id that
			// already exists is refused rather than silently adopted.
			if (requestedSessionId !== undefined) {
				if (!SESSION_ID_V4_RE.test(requestedSessionId)) {
					return { success: false as const, error: "Invalid session id" };
				}
				if (getSessionForContext(requestedSessionId, context)) {
					return {
						success: false as const,
						error: "Session id already exists",
					};
				}
			}
			const session = ensureSession(
				context,
				requestedSessionId ?? createSessionId(),
			);
			session.name = name || "New Chat";
			session.updatedAt = Date.now();
			persistSession(session);
			setServerCurrentSessionId(context, session.id);
			return { success: true, session: toChatSession(session) };
		},
		// P4c 第五批:会话的读/改/删(get / activate / delete / rename /
		// createBranch)整批迁到 `sessions` RPC 域 —— server 从此与桌面吃同一份
		// 实现,这里那套 per-owner 的第二份没有了。`list` / `create` 留着是因为
		// `apps/mobile` 仍然直接打那两条 REST(拍板 #32);`update` 留着是因为
		// `POST /api/sessions/:id/max-tokens` 从来不在那 26 条里。
		async update(
			sessionId: string,
			patch: Record<string, unknown>,
			context = defaultRequestContext(),
		) {
			const session = getSessionForContext(sessionId, context);
			if (!session) return { success: false, error: "Session not found" };
			// §13.10 M7:快照必须**在 applySessionPatch 之前**取。
			//
			// `applySessionPatch` 就地改这只对象,而真后端上它正是 app store
			// 里那一份 —— 等 `persistSession` → `sessionCommands.patchSession`
			// 再去问"改之前是什么",问到的已经是改之后的值,三格
			// (agent / model / workdir)于是一条事件都写不出来。
			// `POST /api/sessions/:id/agent` 从此在账本上是无声的。
			const beforeMeta = sessionMetaFieldsOf(session);
			const patchResult = applySessionPatch(session, patch, workspaceRoot);
			if (!patchResult.success) return patchResult;
			persistSession(session);
			// 翻译排在写成功之后(翻译器的纪律 1)。三格里没变的那些由翻译器
			// 自己按 before 逐格比对丢掉,这里不预筛。
			if (backend.persistsMessages) sessionCommandEvents.patchSession(
				sessionId,
				sessionMetaFieldsOf(session),
				beforeMeta,
			);
			return { success: true, session: toSessionDetails(session) };
		},
	};
	const messagesPort: RuntimeMessagesAdapter<GetSessionMessagesPageRequest, GetSessionMessagesPageResponse, unknown> = {
		async page(
			request: GetSessionMessagesPageRequest,
			context = defaultRequestContext(),
		) {
			const session = getSessionForContext(request.sessionId, context);
			if (!session) {
				return { success: false, error: "Session not found" };
			}
			// Real backends: the app-store session in memory is the truth
			// (async writes may still be queued) — page from it directly.
			return backend.persistsMessages || activeStreamSessions.has(request.sessionId)
				? getMessagePage(sessionStore.getMessages(request.sessionId), request)
				: sessionStore.getMessagesPage(request);
		},
	};
	const liveSessionDelivery = createServerLiveSessionDelivery({ eventBus, streamChannel, audienceFactory, defaultContext: defaultRequestContext });
	const permissionsPort: RuntimePermissionsAdapter<unknown> = {
		async respond(requestId, response, context = defaultRequestContext()) {
			return respondToPermission(requestId, response, context);
		},
	};
	const filesPort: RuntimeFilesAdapter = {
		startWorkspaceWatch: (scope, root) => workspaceWatches.start(scope, root),
		stopWorkspaceWatch: (scope, root) => workspaceWatches.stop(scope, root),
		subscribeWorkspaceFileChanged: (
			handler,
			context = defaultRequestContext(),
		) =>
			workspaceWatches.subscribe(
				workspaceSandboxRoot(workspaceRoot, context),
				handler as WorkspaceFileChangedHandler,
			),
	};
	const mediaDelivery = createServerMediaDelivery({
		defaultContext: defaultRequestContext, ownerKey,
		access: createSessionAccess({ findMeta: findSessionIndexMeta }), sharedLibrary: backend.mediaLibrary,
		libraryPaths: context => serverMediaLibraryPaths(dataRoot, context, isDefaultContext(context) ? storePath : undefined),
	});
	const todoPlanPort: RuntimeTodoPlanAdapter<unknown> = {
		subscribeChanged: subscribeTodoPlanChanged,
	};
	const scratchpadPort: RuntimeScratchpadAdapter<unknown> = {
		// 结构债 P4c:四条数据面已迁到 `scratchpad` RPC 域。这里只剩推送面 ——
		// `GET /api/scratchpad/events` 的 SSE 源,router 今天没有推送面。
		subscribeChanged: subscribeScratchpadChanged,
	};
	const oauthPort: RuntimeOAuthAdapter = {
		subscribe: subscribeOAuthTokenEvents,
	};
	const voicePort: RuntimeVoiceAdapter = {
		subscribeEvents(
			_handler: (event: VoiceEvent) => void,
		): RuntimeUnsubscribe {
			return () => {};
		},
		subscribeRuntimeCommands(
			_handler: (command: VoiceRuntimeCommand) => void,
		): RuntimeUnsubscribe {
			return () => {};
		},
	};
	const runtimeSearchAdapter: RuntimeSearchAdapter<RuntimeMutationResult> = {
		executeAction(actionId: string, context = defaultRequestContext()) {
			return resolveSearchActionForContext(actionId, context);
		},
	};
	/**
	 * 全局(非会话)事件的推送面(原子 K2a')。
	 *
	 * 名单来自 `@shared/events` 的 `GLOBAL_EVENT_LEAVES_PROCESS` —— **这里逐条
	 * `onGlobal` 而不是挂一个"什么都收"的钩子**:`EventBus` 只有按类型的订阅面,
	 * 而为转发在总线上新开一个通配钩子,等于给一个只有一个读者的需求加一种机制。
	 * 名单是数据(加一种事件在那张表上加一行),这一句循环里没有任何事件的名字。
	 *
	 * 过滤在**这一头**做一次(哪些出得了进程),SSE 那头(`global-event-delivery.ts`)
	 * 再读同一张表做一次:一次是"不订阅",一次是"不写帧"。两处读同一张表,不是两份
	 * 名单 —— 别的宿主将来装自己的 `globalEvents` 端口时,SSE 那一道仍然在。
	 */
	const globalEventsPort: RuntimeGlobalEventsAdapter = {
		subscribe(handler: (event: unknown) => void): RuntimeUnsubscribe {
			const unsubs: RuntimeUnsubscribe[] = [];
			for (const [type, leaves] of Object.entries(GLOBAL_EVENT_LEAVES_PROCESS)) {
				if (!leaves) continue;
				unsubs.push(
					eventBus.onGlobal(type as never, (envelope: { event: unknown }) => {
						handler(envelope.event);
					}),
				);
			}
			return () => {
				for (const unsubscribe of unsubs.splice(0)) unsubscribe();
			};
		},
	};
	let shutdownPromise: Promise<void> | undefined;
	const runtime = createOnethingRuntimeFacade<
		unknown,
		unknown,
		unknown,
		unknown,
		string,
		Record<string, unknown>,
		GetSessionMessagesPageRequest,
		GetSessionMessagesPageResponse,
		unknown,
		SessionCommand,
		{ success: boolean; error?: string; result?: unknown },
		AgentEngineSessionEvent,
		AgentEngineStreamChunk
	>({
		capabilities: capabilitiesPort,
		sessions: sessionsPort,
		messages: messagesPort,
		// P4c 第五批:`chat` adapter 整只没了。属于**会话域**的六条随
		// `sessionsRouter` 走,剩下的三条真正的聊天面(getHistory / generateTitle /
		// updateMessageThinkingTime)随 `chatRouter` 走 —— 两个宿主从此是同一条
		// 实现,这里不再留第二份。
		events: liveSessionDelivery.events,
		// K2a':全局事件的推送面。会话事件那一格一个字没动 —— 全局事件没有会话
		// 坐标,也就没有环形缓冲与 `?after=` 回放,它是另一格而不是那一格的参数。
		globalEvents: globalEventsPort,
		streams: liveSessionDelivery.streams,
		permissions: permissionsPort,
		// P4c 第十一批:`settings` / `network` 两格 adapter 整只没了 —— 四条数据面
		// (读 / 存 / 系统深浅色 / 代理自检)随 `settingsRouter` 走通用 RPC。
		// 出门脱敏与回来合并两道真护栏搬进 `server/settings-projection.ts`,由域处理者
		// 在 `transport === 'http'` 那一支上逐字调用;读写的那份设置从 server 自己
		// 那本 per-owner 缓存改成装配层单例(拍板 #20,同 mcp / oauth / agents 判例)。
		// **推送那一格 E 批加了回来**(数据面四条一字未动):浏览器 / React 壳读的是
		// 同一本 `<store>/settings.json`,却听不见它变了,主题联动因此断在半路。
		// 它骑既有的 `GET /api/events`,不新开路由;出门那份过同一个脱敏投影。
		settings: settingsPort,
		// P4 终态批 A1-b:`query` 这一格没了 —— 数据面随 `searchRouter` 走通用 RPC,
		// **实现一行没搬**(同一个闭包改成注册进 `server/search-providers.ts` 的单槽
		// 端口,见上面的 `restoreServerSearchPort`)。留下的 `executeAction` 是**窗口
		// 活的 server 侧对应物**:它仍由 `POST /api/search/actions` 调用,而那条路由
		// 正是 A1-a 里 web 壳 `searchWindowRouter.executeAction` 的真实现。
		search: runtimeSearchAdapter,
		// P4c 第七批:`themes` adapter 整只没了 —— 五条随 `themesRouter` 走通用 RPC,
		// 两个宿主读同一台 `defaultOnethingThemeRuntime`,连插件主题覆盖的合成都同一份。
		// 从前那句「web server runtime 不支持打开本地主题目录」如今是
		// `configureShellHost` 未注入时的结构化降级。
		// P4c 第五批:`prompts` adapter 整只没了 —— 系统提示词快照随 `chatRouter`
		// 走,两个宿主读的是同一条 `buildSystemPromptSnapshot`。
		/**
		 * files —— **只剩推送面一条**(结构债 P4c 第八批)。
		 *
		 * 十四条数据面已整只迁到通用 `POST /api/rpc`(`filesRouter` +
		 * `backend/rpc/domains/files.ts`),**护栏跟着走**:域处理者按
		 * `context.transport` 逐方法夹紧 `sandboxRoot`,越界文案逐字沿用这里
		 * 从前那几句(`resolveServerWorkspaceFilePath` 的公式本来就已经委托给
		 * `rpc/sandbox.ts` 了,现在连调用点也归它)。
		 *
		 * 留下的一条是 `GET /api/files/watch/events` 那条 SSE 的货源。真正的监视器
		 * 登记簿搬到了 `wiring/files/workspace-watch.ts`,按沙箱根分表 —— `watchStart`
		 * / `watchStop`(请求面,在 router 上)与这里(推送面)指的是同一张表。
		 */
		files: filesPort,
		/**
		 * media —— **只剩两条不是 RPC 形状的**(结构债 P4c 第三批)。
		 *
		 * 十一条数据面已整只迁到通用 `POST /api/rpc`(`mediaRouter` +
		 * `backend/rpc/domains/media.ts`),连同它们背后那套 per-owner 的第二台
		 * `MediaLibraryService`——一个 store 一份媒体库,web 与桌面从此读同一份
		 * (拍板 #27 同 agents / models / skills 判例)。随之消失的还有
		 * `toServerClientMediaAsset` / `toServerClientLegacyMediaItem` 那层
		 * 「把 `filePath` 改写成 `/api/media/file/…`」的投影:该用哪种 URL 去取
		 * 一个媒体文件,现在由渲染侧按 environment 判断(`services/media-src.ts`)。
		 *
		 * 留下的两条:
		 *  - `resolveFile` —— `/api/media/file/<name>` 按文件名取**字节**,不是 JSON,
		 *    router 上没有它的位置;浏览器渲染每一张图都靠它。
		 *  - `subscribeImageGenerated` —— `/api/media/events` 那条 SSE。router 没有
		 *    推送面,所以订阅面照旧留在 adapter 上(与 scratchpad / todo-plan 同型)。
		 *    注意它现在**没有生产者**:唯一那个(server 自己的 `saveImage`)随数据面
		 *    走了,而桌面那条真通知走的是引擎的 `IPC_CHANNELS.IMAGE_GENERATED`
		 *    (server 的 sender 是 noop)—— 事件下行的收敛是主线 T2 的事。
		 */
		media: mediaDelivery.adapter,
		// todo/plan 的数据面已迁到通用 RPC 通道(todoPlanRouter);这里只剩事件订阅,
		// 它给 `/api/todo-plan/events` 那条 SSE 供货 —— 事件下行的收敛是主线 T2。
		todoPlan: todoPlanPort,
		// 草稿纸没有 per-owner 分表:server 是单用户,而且**引擎在同一个进程里
		// 读同一张纸**(beforeTurn 尾块注入)。第二个仓等于把事实分叉。
		scratchpad: scratchpadPort,
		// P4 终态批 C2:六条读/开关面(list / enable / disable / refresh / commands /
		// executeCommand)随 `pluginsRouter` 走通用 RPC,`/api/plugins*` 那六条 REST
		// 路由与那条 501 的 `/api/plugins/:id/:action` 一起没了。**实现一行没搬** ——
		// 同一批闭包改成注册进 `server/plugin-catalog.ts` 的单槽端口(见下面的
		// `restoreServerPluginCatalogPort`),域在 `transport === 'http'` 那一支上
		// 原样调用,于是 web 读到的仍是这棵只读镜像树,一字不差。
		// P4c 第七批:六条数据面已迁到 `oauthRouter`,连同 server 那台 per-owner 的
		// 第二台 authService(拍板 #20:一个 store 一本令牌账)。这里只剩**推送面** ——
		// `GET /api/oauth/events` 的 SSE 源,它从装配层那条广播端口取货,而不是
		// 自己再挂一次 authService 的监听。
		oauth: oauthPort,
		// P4c 第八批:`gateway` adapter 整只没了 —— 八条随 `gatewayRouter` 走通用 RPC,
		// 由 `configureGatewayHost` 决定这台进程有没有网关能力。server 不注入,于是
		// 拿到的是结构化降级,而不是这里从前那句写死的
		// "Gateway channel connections are disabled on the server runtime."。
		// **本域零推送**,所以这一格连订阅面都不留。
		// P4c 第十一批:十一条数据面(状态/起停/上行/合成/自检/运行时窗)随
		// `voiceRouter` 走通用 RPC,adapter 上只剩**两条推送的订阅面** —— router
		// 今天没有推送面,`/api/voice/events` 与 `/api/voice/runtime-commands`
		// 两条 SSE 因此原样保留(server 上语音运行时不存在,两条订阅一如既往是空的)。
		// 十一条在 http 上的答案(「server 上没有语音运行时」)由域处理者在
		// `transport === 'http'` 那一支上逐字给出,与这里删掉的这批一字不差。
		voice: voicePort,
		// tools —— 七条数据面已迁到通用 RPC 通道(toolsRouter,P4c 第九批)。
		// 护栏跟着走:域处理者按 `context.transport` 逐方法保留这份 adapter 的语义
		// (执行面只放 `read` + 会话必须存在 + 路径夹进会话沙箱;后台任务表恒空;
		// 停任务与回写工具调用按原话拒绝)。facade 上因此一格都不剩。
		shutdown() {
			return shutdownPromise ??= (async () => {
				// Close watch admission before the first await in surface teardown.
				const workspaceWatchClosing = workspaceWatches.close();
				void workspaceWatchClosing.catch(() => {});
				const failures: unknown[] = [];
				const attempt = async (step: string, run: () => void | Promise<void>): Promise<void> => {
					try { await run(); }
					catch (error) { failures.push(error); log.error('server surface cleanup failed', { step }, error); }
				};
				// Stop scoped workers before saving. The default manager belongs to
				// the Backend and is disposed only by its own resource registration.
				for (const manager of mcpManagersByOwner.values()) {
					if (backend.persistsMessages && manager === appMCPManager) continue;
					await attempt('scoped MCP manager', () => manager.shutdown());
				}
				mcpManagersByOwner.clear();
				const restores: Array<[string, () => void | Promise<void>]> = [
					['live session delivery', () => liveSessionDelivery.dispose()],
					['media delivery', () => mediaDelivery.dispose()],
					['runtime store subscription', () => { unsubscribeRuntimeStore(); }],
					['MCP host', () => { if (backend.persistsMessages && ownsProcessPorts) configureMCPClientHost(null); }],
					['todo host', () => configureTodoPlanHost(previousTodoPlanHostPorts)],
					['scratchpad host', () => configureScratchpadHost(previousScratchpadHostPorts)],
					['OAuth broadcaster', restoreOAuthEventBroadcaster],
					['settings broadcaster', restoreSettingsEventBroadcaster],
					['plugin catalog', restoreServerPluginCatalogPort],
					['search port', restoreServerSearchPort],
					['workspace watches', () => workspaceWatchClosing],
					['scratchpad watcher', () => { if (ownsProcessPorts) stopScratchpadWatcher(); }],
				];
				for (const [label, restore] of restores) await attempt(label, restore);
				for (const variableRuntime of variableRuntimesByOwner.values()) {
					await attempt('variable subscription', () => variableRuntime.unsubscribe());
					await attempt('variable registry', () => variableRuntime.registry.reset());
				}
				variableRuntimesByOwner.clear();
				todoPlanChangedHandlers.clear();
				scratchpadChangedHandlers.clear();
				agentStoresByOwner.clear();
				promptStoresByOwner.clear();
				pluginCatalogManagersByOwner.clear();
				await attempt('session store', () => sessionStore.flushAll());
				await attempt('backend adapter', () => backend.shutdown());
				if (failures.length) throw new AggregateError(failures, 'Server surface cleanup failed');
			})();
		},
	});

	return {
		runtime,
		eventBus,
		streamChannel,
		workspaceRoot,
		shutdown() {
			return runtime.shutdown();
		},
	};
}

/**
 * echo/test 后端的事件投影(真引擎自己写库,这条路只在 `persistsMessages === false`
 * 时跑)。P0.3:消息写全部走命令面 —— 但走的是**这只 store 自己的**命令面
 * (`store.messages`),不是 app store 那个单例:两只仓库是真的两只。
 */
function applySessionEvent(
	store: ServerSessionStore,
	session: ServerChatSession,
	event: AgentEngineSessionEvent,
): void {
	const settle = () =>
		refreshSessionMeta(session, store.getMessages(session.id));
	const variablesEvent = readSessionVariablesUpdatedEvent(event);
	if (variablesEvent) {
		if (variablesEvent.workingDirectory)
			session.workingDirectory = variablesEvent.workingDirectory;
		if (variablesEvent.workingDirectoryRoots)
			session.workingDirectoryRoots = variablesEvent.workingDirectoryRoots;
		session.variables = variablesEvent.variables;
		settle();
		return;
	}

	if ((event as { type?: string }).type === SESSION_EVENT_TYPES.MESSAGES_REPLACED) {
		const replaced = event as unknown as { messages: ChatMessage[] };
		// `reason:'replaced'` 是同步的(只有 'clear' 会 await 刷盘/留档),
		// 所以这里 void 掉 promise 不改变执行顺序。
		void store.messages.replaceAll(session.id, {
			messages: replaced.messages.map((message) => ({ ...message })),
			reason: "replaced",
		});
		settle();
		return;
	}

	switch (event.type) {
		case SESSION_EVENT_TYPES.MESSAGE_USER_CREATED:
		case SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED:
			upsertServerMessage(store, session.id, toChatMessage(session.id, event.message));
			break;
		case SESSION_EVENT_TYPES.MESSAGE_UPDATED:
			updateServerMessage(
				store,
				session.id,
				event.messageId,
				event.updates as Partial<ChatMessage>,
			);
			break;
		case SESSION_EVENT_TYPES.STREAM_START:
			updateServerMessage(
				store,
				session.id,
				event.messageId || event.assistantMessageId,
				{
					isStreaming: true,
					model: event.model,
					provider: "local",
				},
			);
			break;
		case SESSION_EVENT_TYPES.STREAM_COMPLETE:
			markStreamingComplete(store, session.id);
			applyServerSessionUsage(session, event.data.usage);
			break;
		case SESSION_EVENT_TYPES.STREAM_ERROR:
			markStreamingComplete(store, session.id);
			store.messages.appendMessage(session.id, {
				message: {
					id: `error-${Date.now()}`,
					role: "error",
					content: event.data.error,
					errorDetails: event.data.errorDetails,
					timestamp: Date.now(),
				} as ChatMessage,
			});
			break;
	}
	settle();
}


function applyServerSessionUsage(
	session: ServerChatSession,
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
): void {
	if (!usage) return;
	const inputTokens = finiteTokenCount(usage.inputTokens);
	const outputTokens = finiteTokenCount(usage.outputTokens);
	const totalTokens =
		finiteTokenCount(usage.totalTokens) || inputTokens + outputTokens;

	session.totalInputTokens = (session.totalInputTokens ?? 0) + inputTokens;
	session.totalOutputTokens = (session.totalOutputTokens ?? 0) + outputTokens;
	session.totalTokens = (session.totalTokens ?? 0) + totalTokens;
	session.lastInputTokens = inputTokens;
	session.contextSize = inputTokens;
}

function finiteTokenCount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

function toChatMessage(
	sessionId: string,
	message: { id: string; role: string; content: string },
): ChatMessage {
	return {
		id: message.id,
		sessionId,
		role: message.role === "assistant" ? "assistant" : "user",
		content: message.content,
		timestamp: Date.now(),
		// §17.7.1 批 3:这只**假引擎**不写 `run/start`,所以流中占位在账本上没有
		// 任何一格(命令面对 `isStreaming` 的 assistant 一条事件都不写,§9.3)。
		// 真引擎那条路由 `openAssistantRun` 补产地;假引擎没有那一步,于是它的
		// 助手消息一律以**落定**形态入账(`system/message`),正文随后由 upsert 的
		// `fullBody` 档补上。`isStreaming` 本来就不是存储字段 —— 投影按 run 开合现算。
		contentParts: message.content
			? [{ type: "text", content: message.content }]
			: [],
	};
}

/**
 * SV7:命令面的 `upsertMessage` 是**整条替换**,而 server 这条投影一直是**合并**
 * (事件只带 id/role/content,合并才不会把 isStreaming/model 抹掉)。合并在这里
 * 做完再交给命令,行为一字不改。
 */
function upsertServerMessage(
	store: ServerSessionStore,
	sessionId: string,
	message: ChatMessage,
): void {
	const existing = store
		.getMessages(sessionId)
		.find((item) => item.id === message.id);
	store.messages.upsertMessage(sessionId, {
		message: existing ? { ...existing, ...message } : message,
	});
}

/**
 * SV8:`Object.assign(message, updates)` + content→contentParts 的派生规则。
 * 派生保留 —— 只是从"改完再补一刀"变成把它算进同一份 patch 里。
 */
function updateServerMessage(
	store: ServerSessionStore,
	sessionId: string,
	messageId: string,
	updates: Partial<ChatMessage>,
): void {
	const patch: Partial<ChatMessage> =
		typeof updates.content === "string"
			? {
					...updates,
					contentParts: [{ type: "text", content: updates.content }],
				}
			: updates;
	// §17.7.1 批 3:走 **upsert(整条替换)** 而不是 `patchMessage`。
	//
	// 这只 echo/test 后端是**假引擎**:它不像真引擎那样写 `run/start` + 
	// `assistant/chunks`,助手消息的正文只从这一口进来。而 `message/patched` 的
	// 正文三件套永远被丢弃(`BODY_KEYS`:正文只有 chunks 一个来源)—— 从前它靠
	// 老 reducer 把补丁写进内存数组才看得见,reducer 一删就整条不见了。
	// upsert 的 `fullBody` 档正是为"这条消息现在整条长这样"准备的,假引擎要的
	// 就是它;真引擎那条路一格未动。
	const existing = store.getMessages(sessionId).find((item) => item.id === messageId);
	if (!existing) return;
	store.messages.upsertMessage(sessionId, {
		message: { ...existing, ...patch, isStreaming: false } as ChatMessage,
	});
}

/**
 * SV9:`stream:complete` / `stream:error` 事件**不带 messageId**
 * (`StreamCompleteEvent` / `StreamErrorEvent` 只有 `data`),所以"最后一条
 * assistant"的定位保留,只是取数改走 store 的读口。
 */
function markStreamingComplete(
	store: ServerSessionStore,
	sessionId: string,
): void {
	const messages = store.getMessages(sessionId);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role !== "assistant") continue;
		store.messages.patchMessage(sessionId, {
			messageId: messages[index].id,
			patch: { isStreaming: false },
		});
		return;
	}
}

/**
 * 会话级派生字段(updatedAt / messageCount / previewText / 自动标题)。
 *
 * P0.3:消息不再从 `session.messages` 取,由调用方从读门面递进来
 * (`sessionStore.getMessages`)—— 命令面之外没有人持有那份数组。
 * P0.4(用户 2026-08-19 拍板):预览文本从 server 自己的 `slice(0,160)` 换成读门面
 * 的唯一口径 `sessionPreviewText`(trim / 120 字 / 补 `…` / 空串给 undefined)。
 * 这是会话列表上肉眼可见的行为变化,已获批准。
 */
function refreshSessionMeta(
	session: ServerChatSession,
	messages: readonly ChatMessage[],
	options: { preserveUpdatedAt?: boolean } = {},
): void {
	if (!options.preserveUpdatedAt) session.updatedAt = Date.now();
	session.messageCount = messages.length;
	session.previewText = sessionPreviewText(messages);
	// E 批:与 `previewText`(第一句)并列的"最近说到哪儿",同一刻算,同一个纯函数。
	session.lastMessagePreview = deriveSessionLastMessagePreview(
		findLastPreviewableMessage(messages),
	);
	if (session.name === "New Chat" && session.previewText) {
		session.name = session.previewText.slice(0, 40);
	}
}

/**
 * §13.10 M7:进事件账本的那三格会话级字段(agent / model+provider / workdir)。
 *
 * 它们就是翻译器 `patchSession` 认识的那一张表 —— 其余会话级字段是 UI 偏好,
 * 留在 `meta.json`(§2)。取快照与取新值用**同一个函数**,前后两份因此永远同形。
 */
function sessionMetaFieldsOf(session: ServerChatSession): {
	agentId?: string;
	lastModel?: string;
	lastProvider?: string;
	workingDirectory?: string;
} {
	return {
		...(session.agentId !== undefined ? { agentId: session.agentId } : {}),
		...(session.lastModel !== undefined ? { lastModel: session.lastModel } : {}),
		...(session.lastProvider !== undefined
			? { lastProvider: session.lastProvider }
			: {}),
		...(session.workingDirectory !== undefined
			? { workingDirectory: session.workingDirectory }
			: {}),
	};
}

function applySessionPatch(
	session: ServerChatSession,
	patch: Record<string, unknown>,
	workspaceRoot: string,
): { success: boolean; error?: string } {
	if (typeof patch.isArchived === "boolean") {
		session.isArchived = patch.isArchived;
		if (patch.isArchived && typeof patch.archivedAt === "number") {
			session.archivedAt = patch.archivedAt;
		} else if (!patch.isArchived || patch.archivedAt === null) {
			delete session.archivedAt;
		}
	}

	if ("workingDirectory" in patch) {
		if (
			typeof patch.workingDirectory === "string" &&
			patch.workingDirectory.length > 0
		) {
			const nextWorkingDirectory = resolveWorkspacePath(
				workspaceRoot,
				session,
				patch.workingDirectory,
			);
			if (!nextWorkingDirectory) {
				return {
					success: false,
					error:
						"Working directory must stay inside the workspace sandbox root.",
				};
			}
			session.workingDirectory = nextWorkingDirectory;
			session.workingDirectoryRoots = [
				workspaceSandboxRootForSession(workspaceRoot, session),
			];
		} else {
			const root = workspaceSandboxRootForSession(workspaceRoot, session);
			session.workingDirectory = root;
			session.workingDirectoryRoots = [root];
		}
	}

	if (typeof patch.agentId === "string" && patch.agentId.length > 0) {
		session.agentId = patch.agentId;
	}

	if ("permissionMode" in patch) {
		if (
			typeof patch.permissionMode === "string" &&
			patch.permissionMode.length > 0
		) {
			session.permissionMode =
				patch.permissionMode as ServerChatSession["permissionMode"];
		} else {
			delete session.permissionMode;
		}
	}

	if (typeof patch.lastProvider === "string" && patch.lastProvider.length > 0) {
		session.lastProvider = patch.lastProvider;
	}

	if (typeof patch.lastModel === "string" && patch.lastModel.length > 0) {
		session.lastModel = patch.lastModel;
	}

	// The pin says "a human chose this pair", which is what stops an agent's
	// model binding from outranking it. It is set by the model-picker route,
	// never by the per-turn provider/model stamp.
	if ("modelPinned" in patch) {
		if (patch.modelPinned === true) session.modelPinned = true;
		else delete session.modelPinned;
	}

	if ("maxTokens" in patch) {
		if (
			typeof patch.maxTokens !== "number" ||
			!Number.isFinite(patch.maxTokens) ||
			patch.maxTokens <= 0
		) {
			return {
				success: false,
				error: "Max tokens must be a positive number.",
			};
		}
		session.maxTokens = Math.trunc(patch.maxTokens);
	}

	session.updatedAt = Date.now();
	return { success: true };
}

function toSessionMeta(session: ServerChatSession): SessionMeta {
	const {
		messages: _messages,
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		// 摘出来单独条件展开 —— 留在 `...meta` 里的话,「键在、值是 undefined」
		// 那一档照样会被铺进投影,条件展开就白写了。
		previewText: _previewText,
		...meta
	} = session;
	return {
		...meta,
		// P0.3:messageCount 由 normalize* / refreshSessionMeta 盖在会话上,
		// 这里不再自己数一遍 `session.messages`(两只仓库各有各的取数口)。
		messageCount: session.messageCount ?? 0,
		// 条件展开而不是直给:这份投影被 `Object.assign(meta, ...)` 灌进索引元数据,
		// 直给 undefined 会把命令面刚维护好的那一格洗掉。
		//
		// 批 A 起 `previewText` 也走这一条(从前它是直给):`normalizeAppSession`
		// 不再兜底重算之后,一条「索引里有 previewText、meta.json 里没有」的存量
		// 会话再存一次就会被洗成 undefined。真机上这类条目 6/460 —— 数目小,但
		// 洗掉是**可感知**的(会话卡上的预览那一行会空掉),所以按同款写法防住。
		...(session.previewText !== undefined
			? { previewText: session.previewText }
			: {}),
		...(session.lastMessagePreview !== undefined
			? { lastMessagePreview: session.lastMessagePreview }
			: {}),
	};
}

function toChatSession(session: ServerChatSession): ChatSession {
	const {
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		...chatSession
	} = session;
	return chatSession;
}

function toSessionDetails(session: ServerChatSession): SessionDetails {
	return {
		...toSessionMeta(session),
		workingDirectoryRoots: session.workingDirectoryRoots ?? [],
		variables: session.variables ?? [],
	};
}

function getMessagePage(
	messages: readonly ChatMessage[],
	request: GetSessionMessagesPageRequest,
): GetSessionMessagesPageResponse {
	const totalCount = messages.length;
	if (totalCount === 0) {
		return {
			success: true,
			messages: [],
			nextCursor: null,
			backwardsCursor: null,
			hasMoreBefore: false,
			hasMoreAfter: false,
			totalCount,
		};
	}

	const limit = Math.max(1, request.limit ?? 16);
	let end = totalCount;
	const anchor = request.anchor;
	if (request.cursor && request.direction === "older") {
		end = Math.max(0, Number.parseInt(request.cursor, 10) - 1);
	} else if (anchor && anchor !== "tail" && anchor.messageId) {
		const anchorIndex = messages.findIndex(
			(message) => message.id === anchor.messageId,
		);
		end =
			anchorIndex >= 0
				? Math.min(totalCount, anchorIndex + 1 + (anchor.after ?? limit))
				: totalCount;
	}
	const start = Math.max(0, end - limit);
	const page = messages.slice(start, end).map((message, index) => ({
		...message,
		seq: start + index + 1,
	}));

	return {
		success: true,
		messages: page,
		nextCursor: start > 0 ? String(start + 1) : null,
		backwardsCursor: end < totalCount ? String(end) : null,
		hasMoreBefore: start > 0,
		hasMoreAfter: end < totalCount,
		totalCount,
	};
}

function defaultRequestContext(): RuntimeRequestContext {
	return {
		userId: "local-user",
		workspaceId: "default",
	};
}

function isDefaultServerRequestContext(
	context = defaultRequestContext(),
): boolean {
	const defaultContext = defaultRequestContext();
	return (
		context.userId === defaultContext.userId &&
		context.workspaceId === defaultContext.workspaceId
	);
}

function ownsSession(
	session: ServerChatSession,
	context = defaultRequestContext(),
): boolean {
	return ownsSessionRecord(session, context);
}

/**
 * index.json 里的会话元数据(服务端视角):在共享的 SessionMeta 之上,
 * 由 saveSessionImmediately 盖章所有权字段,使会话列表可以只读 index、
 * 不加载消息体就完成 owner 过滤。ownerVersion 缺失表示存量条目尚未回填。
 */
type ServerSessionIndexMeta = SessionMeta & {
	/** @deprecated 存量租户 userId(只读兼容)。 */
	userId?: string;
	/** 服务端租户(`workspaceId` 是产品空间,继承自 `SessionMeta`,不是归属)。 */
	ownerUserId?: string;
	ownerWorkspaceId?: string;
	ownerVersion?: number;
	workingDirectory?: string;
};

/**
 * 2:租户归属从 `userId`/`workspaceId` 换到 `owner*` 两格。版本一升,存量 index 条目
 * 全部重新回填 —— 那些被错误抄成「空间 = 租户」的旧值就此清掉。
 */
const SESSION_INDEX_OWNER_VERSION = 2;

/** 会话工作区推导所需的最小字段集,ServerChatSession 与 index 元数据均满足。 */
interface SessionWorkspaceRef {
	id: string;
	userId?: string;
	ownerUserId?: string;
	ownerWorkspaceId?: string;
	workspaceId?: string;
	workingDirectory?: string;
}

function ownsSessionMeta(
	meta: ServerSessionIndexMeta,
	context = defaultRequestContext(),
): boolean {
	return ownsSessionRecord(meta, context);
}

/**
 * 交给客户端之前摘掉**服务端内部**的归属格。
 *
 * `workspaceId`(产品空间)照旧一并摘 —— 它今天就没出过这道门,现在把它留下等于
 * 让 web 端的左栏突然开始按空间过滤会话(可感知的行为变化)。**本批只修 bug、不改
 * 这件事**;要不要把空间交给 web,单独拍(留账见 §17.5)。
 */
function stripSessionOwnerFields(meta: ServerSessionIndexMeta): SessionMeta {
	const {
		userId: _userId,
		ownerUserId: _ownerUserId,
		ownerWorkspaceId: _ownerWorkspaceId,
		workspaceId: _workspaceId,
		ownerVersion: _ownerVersion,
		...rest
	} = meta;
	return rest;
}

// P4c 第九批:执行面那三件事(只读目录里的 runner、白名单校验、会话沙箱路径解析)
// 随 `tools` 域一起搬到了 `backend/rpc/domains/tools.ts` 的 http 分叉里 —— 桌面与
// 联网宿主从此吃同一份实现,这里不再留第二份。

async function* listServerToolFiles(options: {
	cwd: string;
	glob?: string[];
}): AsyncGenerator<string> {
	const cwd = resolve(options.cwd);
	const rootStat = await stat(cwd);
	if (!rootStat.isDirectory()) {
		throw new Error(`Not a directory: ${cwd}`);
	}

	const patterns = options.glob?.length ? options.glob : ["**/*"];

	async function* walk(directory: string): AsyncGenerator<string> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === ".git") continue;

			const fullPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				yield* walk(fullPath);
				continue;
			}

			if (!entry.isFile()) continue;

			const relativePath = toPosixRelativePath(cwd, fullPath);
			if (
				patterns.some((pattern) => matchesServerGlob(relativePath, pattern))
			) {
				yield relativePath;
			}
		}
	}

	yield* walk(cwd);
}

async function* emptyServerFileSearchResults(): AsyncGenerator<string> {}




function matchesServerGlob(relativePath: string, pattern: string): boolean {
	const normalizedPattern = normalizeServerGlobPattern(pattern);
	const normalizedPath = toPosixPath(relativePath);
	if (globPatternToRegExp(normalizedPattern).test(normalizedPath)) return true;

	if (!normalizedPattern.includes("/")) {
		const name = normalizedPath.split("/").pop() ?? normalizedPath;
		return globPatternToRegExp(normalizedPattern).test(name);
	}

	return false;
}

function normalizeServerGlobPattern(pattern: string): string {
	return toPosixPath(pattern.trim() || "**/*").replace(/^\.\//, "");
}

function globPatternToRegExp(pattern: string): RegExp {
	let source = "";
	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		if (char === "*") {
			if (pattern[index + 1] === "*") {
				if (pattern[index + 2] === "/") {
					source += "(?:.*/)?";
					index += 2;
				} else {
					source += ".*";
					index += 1;
				}
			} else {
				source += "[^/]*";
			}
			continue;
		}

		if (char === "?") {
			source += "[^/]";
			continue;
		}

		source += escapeRegExp(char);
	}

	return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function toPosixRelativePath(from: string, to: string): string {
	return toPosixPath(relative(from, to));
}

function toPosixPath(value: string): string {
	return value.split(/[\\/]+/).join("/");
}

async function getOwnerSettings(
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	context = defaultRequestContext(),
): Promise<AppSettings> {
	const key = ownerKey(context);
	let settings = settingsByOwner.get(key);
	if (!settings) {
		settings = mergeWithDefaults((await settingsStore.load(context)) ?? {});
		settingsByOwner.set(key, cloneJson(settings));
	}
	return cloneJson(settings);
}

export function createFileServerSettingsStore(
	settingsRoot: string,
): ServerSettingsStore {
	const root = resolve(settingsRoot);
	return {
		async load(context) {
			const filePath = ownerSettingsFilePath(root, context);
			try {
				const raw = await readFile(filePath, "utf8");
				const parsed = JSON.parse(raw) as Partial<AppSettings>;
				return mergeWithDefaults(parsed);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async save(context, settings) {
			const filePath = ownerSettingsFilePath(root, context);
			await mkdir(dirname(filePath), { recursive: true });
			const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
			await writeFile(
				tempPath,
				`${JSON.stringify(settings, null, 2)}\n`,
				"utf8",
			);
			await rename(tempPath, filePath);
		},
	};
}

export function createSingleFileServerSettingsStore(
	settingsPath: string,
): ServerSettingsStore {
	const filePath = resolve(settingsPath);
	return {
		async load() {
			try {
				const raw = await readFile(filePath, "utf8");
				const parsed = JSON.parse(raw) as Partial<AppSettings>;
				return mergeWithDefaults(parsed);
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return undefined;
				throw error;
			}
		},
		async save(_context, settings) {
			await mkdir(dirname(filePath), { recursive: true });
			const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
			await writeFile(
				tempPath,
				`${JSON.stringify(settings, null, 2)}\n`,
				"utf8",
			);
			await rename(tempPath, filePath);
		},
	};
}

export function createDefaultContextServerSettingsStore(
	settingsPath: string,
	ownerSettingsRoot: string,
): ServerSettingsStore {
	const defaultStore = createSingleFileServerSettingsStore(settingsPath);
	const ownerStore = createFileServerSettingsStore(ownerSettingsRoot);
	return {
		load(context) {
			return isDefaultServerRequestContext(context)
				? defaultStore.load(context)
				: ownerStore.load(context);
		},
		save(context, settings) {
			return isDefaultServerRequestContext(context)
				? defaultStore.save(context, settings)
				: ownerStore.save(context, settings);
		},
	};
}

/**
 * ServerSessionStore backed by the @onething/backend session repository — the same
 * repository the in-process StreamEngine reads and writes. Used when the
 * backend persists messages itself (real engine): a second local repository
 * over the same files would fork the in-memory truth (stale index/LRU reads
 * showing up as intermittent 404/empty history) and race its write queue
 * against the engine's (tmp-rename ENOENT on jsonl suffix writes).
 *
 * Requires ONETHING_STORE_PATH to already point at the served store —
 * createRealServerBackend pins it before booting the backend.
 */
export function createAppBackedServerSessionStore(
	storePath = getOnethingStorePath(),
): ServerSessionStore {
	const appStatePath = getOnethingAppStatePath({
		storePath: resolve(storePath),
	});
	// 不复刻 echo 侧的 lastProvider/lastModel 兜底:这里的会话对象就是引擎的
	// 活对象,凭空盖 'local-echo' 会被持久化进共享存储,污染桌面端数据。
	// P0.3:原来这里还有一句 `session.messages = Array.isArray(...) ? ... : []`。
	// 那是死代码 —— 走到这里的会话都经过 `getSession` → `sanitizeSessionOnStartup`
	// → `computeSessionRepairOnLoad(session, session.messages)`,messages 不是数组
	// 早就在那里 `.map` 崩了;createSession/createBranchSession 也恒建数组。
	// 派生字段改从读门面取,server 不再持有 `session.messages`。
	/**
	 * 批 A §3.4:**只剩 `agentId` 缺省那一行**。
	 *
	 * 从前这里无条件 `listMessages(session.id)` 把整条会话物化一遍,只为填
	 * `messageCount` 与 `previewText` 两个标量 —— 大会话上一次 69ms,而它挂在
	 * `getSession` 上,于是每一条流式分片的归属判定都要付这笔钱。
	 *
	 * 那两格本来就有写侧在维护:`messageCount` 由命令面的列表投影
	 * (`applySessionListProjectionToMeta`,E 批)每次落账时算,`previewText` 由
	 * server 自己的 `refreshSessionMeta` 在保存时算。读侧再算一遍就是「两边各算
	 * 一份」,正是这一批要消掉的东西。
	 */
	const normalizeAppSession = (
		session: ServerChatSession,
	): ServerChatSession => {
		if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
		return session;
	};
	// P0.4:`saveSessionSnapshot` 后门退役 —— 会话级字段改走命令面的
	// `patchSession`。差别不只是门牌:老后门按 `structural` 写计划落盘,等于每次
	// 改个名字/置顶/归档都把整份 `messages.jsonl` 重写一遍;jsonl 布局里会话级
	// 字段全住 `meta.json`,`patchSession` 一律 `meta` 计划,消息一行不动。
	const save = (session: ServerChatSession): void => {
		const normalized = normalizeAppSession(session);
		const { messages: _messages, ...fields } = normalized;
		appSessionCommands.patchSession(normalized.id, {
			patch: fields,
			mutateIndexMeta: (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					// 租户两格(产品空间不是归属,不进这里 —— 它随 `toSessionMeta`
					// 已经在会话元数据里了)。
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
		});
	};
	const stampOwner = (
		session: ServerChatSession,
		context: RuntimeRequestContext,
	): ServerChatSession => {
		if (!isDefaultServerRequestContext(context)) {
			// 盖的是**租户**章。产品空间(`session.workspaceId`)一个字不碰 ——
			// 从前这里把它覆盖成 `context.workspaceId`,等于用租户默认值抹掉用户
			// 选的空间。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			save(session);
		}
		return normalizeAppSession(session);
	};
	return {
		getCurrentSessionId: () => getAppStoreCurrentSessionId(),
		setCurrentSessionId: (sessionId) => {
			setAppStoreCurrentSessionId(sessionId);
		},
		saveUIState(uiState) {
			return saveOnethingUiStateForServer(appStatePath, uiState);
		},
		getSessions: () =>
			(getAppStoreSessions() as ServerChatSession[]).map(normalizeAppSession),
		getSessionsList: () => getAppStoreSessionsList(),
		findSessionMeta: (sessionId) => findAppStoreSessionIndexMeta(sessionId),
		// invalidateSession intentionally absent: single repository — the
		// engine's cache IS the fresh copy; dropping it would only cost reloads.
		getSession: (sessionId) => {
			const session = getAppStoreSession(sessionId) as
				| ServerChatSession
				| undefined;
			return session ? normalizeAppSession(session) : undefined;
		},
		createSession: (sessionId, name, context) =>
			stampOwner(
				createAppStoreSession(sessionId, name) as ServerChatSession,
				context,
			),
		createBranchSession: (
			sessionId,
			name,
			parentSessionId,
			branchFromMessageId,
			inheritedMessages,
			context,
		) =>
			stampOwner(
				createAppStoreBranchSession(
					sessionId,
					name,
					parentSessionId,
					branchFromMessageId,
					inheritedMessages,
				) as ServerChatSession,
				context,
			),
		saveSession: save,
		saveSessionMeta: (session) => {
			const normalized = normalizeAppSession(session);
			updateAppStoreSessionsIndexMeta(normalized.id, (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
			);
		},
		getMessages: (sessionId) =>
			appSessionReads.listMessages(sessionId).messages,
		messages: appSessionCommands,
		deleteSession: (sessionId, context = defaultRequestContext()) => {
			const ids = sessionAccess.resolveAll(context,
				collectSessionCascadeDeleteIds(getAppStoreSessionsList(), sessionId), 'delete')
			return sessionDeletion.delete(sessionId, ids, targets => {
				sessionAccess.resolveAll(context, targets, 'delete')
			})
		},
		flushSession: (sessionId) => flushAppStoreSessionSave(sessionId),
		flushAll: () => flushAllAppStorePendingSaves(),
		// S2b:app-store 背书的这只读门面两条读法都收口到 `appSessionReads`,
		// `ONETHING_SESSION_READ=events` 因此对分页也生效;messages 模式下
		// `pageMessages` 逐字走同一个 `getSessionMessagesPage`(store.js 再导出的
		// 就是 stores/sessions 那份),页信封一格不动。
		getMessagesPage: (request) =>
			appSessionReads.pageMessages(request) as GetSessionMessagesPageResponse,
		getUserMessageMarkers: (sessionId) =>
			getAppStoreSessionUserMessageMarkers(sessionId),
	};
}

export function createEchoServerSessionStore(
	storePath = getOnethingStorePath(),
): ServerSessionStore {
	const resolvedStorePath = resolve(storePath);
	const appStatePath = getOnethingAppStatePath({
		storePath: resolvedStorePath,
	});
	const getSessionFilePath = (sessionId: string) =>
		getOnethingSessionPath(sessionId, { storePath: resolvedStorePath });
	// 会话体紧凑序列化,与 Electron 宿主保持一致;index.json 仍走 pretty。
	const writeSessionJsonFileAsync = (filePath: string, data: unknown) =>
		writeCoreJsonFileAsync(filePath, data, { pretty: false });
	const sessionRepositoryOptions: OnethingSessionRepositoryOptions<ServerChatSession, ChatMessage, SessionMeta, SessionDetails, UserMessageMarker> = {
		defaultAgentId: DEFAULT_ONETHING_AGENT_ID,
		getSessionsDir: () =>
			getOnethingSessionsDir({ storePath: resolvedStorePath }),
		getSessionPath: getSessionFilePath,
		readJsonFile: readCoreJsonFile,
		writeJsonFile: writeCoreJsonFile,
		writeJsonFileAsync: writeSessionJsonFileAsync,
		deleteJsonFile,
		// The explicit echo host stores complete JSON transcripts. It never
		// reads, migrates or writes through the production session ledger.
		getCurrentSessionId: () => getOnethingCurrentSessionId(appStatePath),
		setCurrentSessionId: (sessionId) => {
			setOnethingCurrentSessionId(appStatePath, sessionId);
		},
		getDefaultWorkingDirectory: () =>
			readLocalDefaultWorkingDirectory(resolvedStorePath),
		expandPath: expandOnethingToolSandboxPath,
		logger: consoleLog,
	};
	const repository = createOnethingSessionRepository<
		ServerChatSession,
		ChatMessage,
		SessionMeta,
		SessionDetails,
		UserMessageMarker
	>(sessionRepositoryOptions);

	repository.initializeSessionRepositoryIndex();

	// P0.3:echo/test 后端这只仓库与 `@onething/backend` 的那只是**两只**(同一批文件、
	// 各有各的缓存与写队列),所以命令面也得为它单独装一份 —— `sessionCommands`
	// 那个单例绑死在 app store 上,借过来用会写到另一份内存真相里去。
	// 装的是同一个工厂,判据 / 会话账 / 落盘档的算法只有那一份(§17.7.1 批 3 起
	// 归约器退役,那层执行体也没有了)。
	const messageCommands = createSessionCommands({
		reads: {
			countMessages: sessionId => repository.getSessionMessages(sessionId)?.length ?? 0,
			getMessage: (sessionId, messageId) => repository.getSessionMessages(sessionId)?.find(message => message.id === messageId),
			findMessage: (sessionId, predicate, options) => {
				const messages = repository.getSessionMessages(sessionId) ?? [];
				if (options?.from === 'end') {
					for (let index = messages.length - 1; index >= 0; index--) {
						if (predicate(messages[index]!, index)) return messages[index];
					}
					return undefined;
				}
				return messages.find(predicate);
			},
			listMessages: sessionId => ({ messages: repository.getSessionMessages(sessionId) ?? [], changed: false }),
		},
		hasMessage: (sessionId, messageId) => repository.getSessionMessages(sessionId)?.some(message => message.id === messageId) ?? false,
		getSession: (sessionId) => repository.getSession(sessionId),
		// §17.7.1 批 3:落盘调度归写门(归约器退役,`result.lazy` 没有了产地)。
		saveSession: (sessionId, session, options) =>
			repository.saveSessionToFile(sessionId, session as ServerChatSession, options),
		updateSessionsIndexMeta: (sessionId, update) =>
			repository.updateSessionsIndexMeta(sessionId, (meta) =>
				update(meta as unknown as { [key: string]: unknown }),
			),
		flushSessionSave: (sessionId) => repository.flushSessionSave(sessionId),
		patchSession: (sessionId, patch, mutateIndexMeta) =>
			repository.patchSession(sessionId, patch, mutateIndexMeta),
		// 协作署名是桌面/引擎侧的事,server 不盖章(与迁移前 `session.messages.push`
		// 的行为一致)。
	}, { events: createEchoMessageEvents(id => repository.getSession(id)), account: () => undefined });

	const readMessages = (sessionId: string): readonly ChatMessage[] =>
		repository.getSessionMessages(sessionId) ?? [];

	// 存量 index 条目补齐所有权字段(一次性,ownerVersion 盖章后不再重跑):
	// 会话列表因此可以只读 index 完成 owner 过滤,不必加载消息体。
	const backfillSessionIndexOwnership = (): void => {
		// 整个读-改-写放进跨进程 index 锁,锁内重新读盘,避免与桌面端并发写丢条目。
		repository.runWithSessionsIndexLock(() => {
			const index = repository.loadSessionsIndex() as ServerSessionIndexMeta[];
			const missing = index.filter(
				(meta) => meta.ownerVersion !== SESSION_INDEX_OWNER_VERSION,
			);
			if (missing.length === 0) return;
			const start = Date.now();
			for (const meta of missing) {
				// 只读加载(不 sanitize、不入队写会话体):避免 headless server 在启动 backfill 时
				// 重写 Electron 拥有的会话体,与其 suffix 写竞态损坏 messages.jsonl。
				const session = repository.getSessionRaw(meta.id);
				const owner = sessionOwner((session ?? {}) as ServerChatSession);
				meta.ownerUserId = owner.userId;
				meta.ownerWorkspaceId = owner.workspaceId;
				meta.ownerVersion = SESSION_INDEX_OWNER_VERSION;
			}
			repository.saveSessionsIndex(index);
			log.info("session index ownership backfilled", {
				sessions: missing.length,
				ms: Date.now() - start,
			});
		});
	};
	backfillSessionIndexOwnership();

	const saveSessionImmediately = (session: ServerChatSession): void => {
		const normalized = normalizeStoredServerSession(
			session,
			readMessages(session.id),
		);
		repository.saveSessionToFile(normalized.id, normalized);
		// Echo owns a complete transcript; queued command writes still drain
		// through flushSession/flushAll before this store is released.
		{
			writeCoreJsonFile(getSessionFilePath(normalized.id), normalized, {
				pretty: false,
			});
			repository.cancelPendingSave(normalized.id);
		}
		repository.updateSessionsIndexMeta(normalized.id, (meta) =>
			Object.assign(meta, toSessionMeta(normalized), {
				ownerUserId: sessionOwner(normalized).userId,
				ownerWorkspaceId: sessionOwner(normalized).workspaceId,
				ownerVersion: SESSION_INDEX_OWNER_VERSION,
			}),
		);
		repository.syncSessionToSqliteIfReady(normalized);
	};

	return {
		getCurrentSessionId: () => getOnethingCurrentSessionId(appStatePath),
		setCurrentSessionId: (sessionId) => {
			setOnethingCurrentSessionId(appStatePath, sessionId);
		},
		saveUIState(uiState) {
			return saveOnethingUiStateForServer(appStatePath, uiState);
		},
		getSessions: () =>
			repository
				.getSessions()
				.map((session) =>
					normalizeStoredServerSession(session, readMessages(session.id)),
				),
		getSessionsList: () => repository.getSessionsList(),
		invalidateSession: (sessionId) => {
			repository.invalidateSessionCache(sessionId);
		},
		getSession: (sessionId) => {
			const session = repository.getSession(sessionId);
			return session
				? normalizeStoredServerSession(session, readMessages(sessionId))
				: undefined;
		},
		createSession(sessionId, name, context) {
			const created = repository.createSession(sessionId, name);
			const session = normalizeStoredServerSession(
				created,
				readMessages(sessionId),
			);
			// 租户章;产品空间由建会话的入参决定,这里不覆盖。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			refreshSessionMeta(session, readMessages(sessionId), {
				preserveUpdatedAt: true,
			});
			saveSessionImmediately(session);
			return session;
		},
		createBranchSession(
			sessionId,
			name,
			parentSessionId,
			branchFromMessageId,
			inheritedMessages,
			context,
		) {
			const created = repository.createBranchSession(
				sessionId,
				name,
				parentSessionId,
				branchFromMessageId,
				inheritedMessages,
			);
			const session = normalizeStoredServerSession(
				created,
				readMessages(sessionId),
			);
			// 租户章;产品空间由建会话的入参决定,这里不覆盖。
			session.ownerUserId = context.userId;
			session.ownerWorkspaceId = context.workspaceId;
			refreshSessionMeta(session, readMessages(sessionId), {
				preserveUpdatedAt: true,
			});
			saveSessionImmediately(session);
			return session;
		},
		saveSession(session) {
			saveSessionImmediately(session);
		},
		saveSessionMeta(session) {
			const normalized = normalizeStoredServerSession(
				session,
				readMessages(session.id),
			);
			repository.updateSessionsIndexMeta(normalized.id, (meta) =>
				Object.assign(meta, toSessionMeta(normalized), {
					ownerUserId: sessionOwner(normalized).userId,
					ownerWorkspaceId: sessionOwner(normalized).workspaceId,
					ownerVersion: SESSION_INDEX_OWNER_VERSION,
				}),
			);
		},
		getMessages: readMessages,
		messages: messageCommands,
		deleteSession: (sessionId) => repository.deleteSession(sessionId),
		flushSession: (sessionId) => repository.flushSessionSave(sessionId),
		flushAll: () => repository.flushAllPendingSaves(),
		getMessagesPage: (request) =>
			repository.getSessionMessagesPage(
				request,
			) as GetSessionMessagesPageResponse,
		getUserMessageMarkers: (sessionId) =>
			repository.getSessionUserMessageMarkers(sessionId),
	};
}

/** Compatibility name for the explicitly selected echo-host store. */
export const createLocalServerSessionStore = createEchoServerSessionStore;

/**
 * P0.3:`session.messages = Array.isArray(...) ? ... : []` 这句删了 —— 它是死代码
 * (仓库的 `getSession` 里 `sanitizeSessionOnStartup` 先 `.map` 过一遍,不是数组
 * 早就崩了),而派生字段改由调用方把消息递进来。
 */
function normalizeStoredServerSession(
	session: ServerChatSession,
	messages: readonly ChatMessage[],
): ServerChatSession {
	if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
	if (!session.lastProvider) session.lastProvider = "local";
	if (!session.lastModel) session.lastModel = "local-echo";
	session.messageCount = messages.length;
	session.previewText = session.previewText ?? sessionPreviewText(messages);
	session.lastMessagePreview =
		session.lastMessagePreview ??
		deriveSessionLastMessagePreview(findLastPreviewableMessage(messages));
	return session;
}

function readLocalDefaultWorkingDirectory(
	storePath: string,
): string | undefined {
	const settings = mergeWithDefaults(
		readCoreJsonFile<Partial<AppSettings>>(
			getOnethingSettingsPath({ storePath }),
			{},
		),
	);
	return settings.tools?.bash?.defaultWorkingDirectory;
}

function saveOnethingUiStateForServer(
	appStatePath: string,
	uiState: unknown,
): { success: boolean; state?: unknown; error?: string } {
	try {
		return {
			success: true,
			state: saveOnethingUiState(
				appStatePath,
				isRecord(uiState) ? uiState : {},
			),
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error && error.message
					? error.message
					: "Failed to save UI state",
		};
	}
}

function ownerSettingsFilePath(
	settingsRoot: string,
	context = defaultRequestContext(),
): string {
	return join(
		settingsRoot,
		encodeURIComponent(context.userId),
		`${encodeURIComponent(context.workspaceId)}.json`,
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function readServerRuntimeJsonFile<T>(filePath: string, defaultValue: T): T {
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as T;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return defaultValue;
		throw error;
	}
}

function writeServerRuntimeJsonFile<T>(filePath: string, data: T): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}


// P4c 第十一批:`getOwnerMCPManager` 随 `settings` adapter 一起没了 —— 它唯一的
// 调用点是那条「存完设置顺带更新这个 owner 的 MCP 管理器」;设置面收敛成一份
// 之后(拍板 #20),MCP 设置的更新由域处理者走装配层那台 `MCPManager` 单例。
class DisabledServerMCPClient implements MCPClientLike {
	private currentState: MCPServerState;

	constructor(config: MCPServerConfig) {
		this.currentState = createMCPServerState(config, "disconnected");
	}

	get state(): MCPServerState {
		return cloneJson(this.currentState);
	}

	get status(): MCPServerState["status"] {
		return this.currentState.status;
	}

	async connect(): Promise<void> {
		this.currentState = createMCPServerState(
			this.currentState.config,
			"error",
			"MCP connections are disabled in the web server runtime.",
		);
	}

	async disconnect(): Promise<void> {
		this.currentState = createMCPServerState(
			this.currentState.config,
			"disconnected",
		);
	}

	async updateConfig(config: MCPServerConfig): Promise<void> {
		this.currentState = {
			...this.currentState,
			config: cloneJson(config),
			status: config.enabled ? this.currentState.status : "disconnected",
			error: config.enabled ? this.currentState.error : undefined,
		};
	}

	async callTool(): Promise<{ success: false; error: string }> {
		return { success: false, error: "Client not connected" };
	}

	async readResource(): Promise<{ success: false; error: string }> {
		return { success: false, error: "Client not connected" };
	}

	async getPrompt(): Promise<{ success: false; error: string }> {
		return { success: false, error: "Client not connected" };
	}

	async refreshCapabilities(): Promise<void> {}
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 第四份手抄的联合已经退役 —— 这里直接用契约那一份(它自己与核逐字相同,由
 * `shared/ipc/__tests__/permission-response-mirrors.test.ts` 编译期钉住)。
 */
type PermissionDecision = PermissionResponse;

interface NormalizedPermissionResponse {
	decision: PermissionDecision;
	channel: string;
	rejectReason?: string;
}

/**
 * 收得下哪几种应答。写成 `satisfies Record<PermissionDecision, true>` 而不是一个
 * 字面量数组:联合里多一支而这里忘了跟上,是**编译期**红,不是一条只在真机上
 * 才现形的「Invalid permission response」。
 */
const PERMISSION_DECISIONS = {
	once: true,
	session: true,
	workdir: true,
	/**
	 * 应用级许可(2026-09-10)。真引擎上由 core `Permission.respond` 落账 ——
	 * 只有当那次 ask 带着 `alwaysScope` 时它才是合法应答,否则内核结构化忽略。
	 * 下面那条回声路(假后端)不认识应用级许可,照旧只补 session / workdir 两档。
	 */
	always: true,
	reject: true,
} satisfies Record<PermissionDecision, true>;

const permissionDecisions = new Set<PermissionDecision>(
	Object.keys(PERMISSION_DECISIONS) as PermissionDecision[],
);

function toPendingPermissionInfo(
	event: unknown,
	sessionId: string,
	session: ServerChatSession,
): PermissionInfo | null {
	if (!isRecord(event)) return null;
	if (typeof event.requestId !== "string") return null;
	if (typeof event.permissionType !== "string") return null;
	if (typeof event.messageId !== "string") return null;
	if (typeof event.title !== "string") return null;

	return {
		id: event.requestId,
		type: event.permissionType,
		pattern:
			typeof event.pattern === "string" || Array.isArray(event.pattern)
				? (event.pattern as string | string[])
				: undefined,
		sessionId,
		messageId: event.messageId,
		callId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
		title: event.title,
		metadata: isRecord(event.metadata) ? (event.metadata as JsonObject) : {},
		createdAt: Date.now(),
		targetChannel:
			typeof event.targetChannel === "string" ? event.targetChannel : "api",
		workingDirectory: session.workingDirectory,
		// 授权记录的归属被 `permission-grants` 域按**租户**过滤
		// (`rpc/domains/permission-grants.ts:72-73`),所以这里给的是租户两格,
		// 不是产品空间。
		userId: sessionOwner(session).userId,
		workspaceId: sessionOwner(session).workspaceId,
	};
}

function persistPermissionGrantFromDecision(
	info: PermissionInfo,
	decision: PermissionDecision,
): void {
	if (decision === "session") {
		addGrant({
			scope: "session",
			type: info.type,
			pattern: info.pattern ?? info.type,
			sessionId: info.sessionId,
			userId: info.userId,
			workspaceId: info.workspaceId,
			createdFrom: {
				messageId: info.messageId,
				toolCallId: info.callId,
				title: info.title,
			},
			metadata: info.metadata,
		});
	}

	if (decision === "workdir" && info.workingDirectory) {
		addGrant({
			scope: "workspace",
			type: info.type,
			pattern: info.pattern ?? info.type,
			workspaceRoot: info.workingDirectory,
			userId: info.userId,
			workspaceId: info.workspaceId,
			createdFrom: {
				messageId: info.messageId,
				toolCallId: info.callId,
				title: info.title,
			},
			metadata: info.metadata,
		});
	}
}


async function ensureServerWorkspaceSandboxRoot(
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
): Promise<string> {
	const sandboxRoot = workspaceSandboxRoot(serverWorkspaceRoot, context);
	await mkdir(sandboxRoot, { recursive: true });
	return sandboxRoot;
}

function resolveServerWorkspaceFilePath(
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	requestedPath: string,
): string | null {
	const sandboxRoot = workspaceSandboxRoot(serverWorkspaceRoot, context);
	if (typeof requestedPath !== "string" || requestedPath.trim() === "")
		return null;

	const expandedPath =
		requestedPath === "~"
			? sandboxRoot
			: requestedPath.startsWith("~/")
				? join(sandboxRoot, requestedPath.slice(2))
				: requestedPath;
	const candidate = resolve(
		isAbsolute(expandedPath) ? expandedPath : join(sandboxRoot, expandedPath),
	);
	return isPathInside(candidate, sandboxRoot) ? candidate : null;
}

function getServerPluginCatalogManagerForContext(
	managers: Map<string, ServerPluginCatalogManager>,
	dataRoot: string,
	context: RuntimeRequestContext,
	commands: ServerPluginCommandDefinition[] = [],
): ServerPluginCatalogManager {
	const key = ownerKey(context);
	let manager = managers.get(key);
	if (!manager) {
		manager = new ServerPluginCatalogManager(dataRoot, context, commands);
		managers.set(key, manager);
	}
	return manager;
}

function serverMediaLibraryPaths(
	dataRoot: string,
	context: RuntimeRequestContext,
	desktopStorePath?: string,
): OnethingMediaLibraryPaths {
	if (desktopStorePath && isDefaultServerRequestContext(context)) {
		return {
			indexPath: getOnethingMediaIndexPath({ storePath: desktopStorePath }),
			imagesDir: getOnethingMediaImagesDir({ storePath: desktopStorePath }),
			filesDir: getOnethingMediaFilesDir({ storePath: desktopStorePath }),
		};
	}

	const root = join(
		tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId),
		"media",
	);
	return {
		indexPath: join(root, "index.json"),
		imagesDir: join(root, "images"),
		filesDir: join(root, "files"),
	};
}

function serverProjectDirsPathError(): {
	success: false;
	error: string;
	code: "WORKSPACE_PATH";
} {
	return {
		success: false,
		error:
			"Project directory path must stay inside the workspace sandbox root.",
		code: "WORKSPACE_PATH",
	};
}

function workspaceFilePathError(error: string): {
	success: false;
	error: string;
} {
	return { success: false, error };
}

function emptyWorkspaceFileList(error: string): {
	success: false;
	files: [];
	entries: [];
	error: string;
} {
	return {
		success: false,
		files: [],
		entries: [],
		error,
	};
}

function readPermissionTrackingEvent(event: unknown): {
	type:
		| typeof SESSION_EVENT_TYPES.PERMISSION_REQUEST
		| typeof SESSION_EVENT_TYPES.PERMISSION_TIMEOUT
		| typeof SESSION_EVENT_TYPES.PERMISSION_SETTLED;
	requestId: string;
} | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as Record<string, unknown>;
	const type = candidate.type;
	if (
		type !== SESSION_EVENT_TYPES.PERMISSION_REQUEST &&
		type !== SESSION_EVENT_TYPES.PERMISSION_TIMEOUT &&
		type !== SESSION_EVENT_TYPES.PERMISSION_SETTLED
	)
		return null;
	return typeof candidate.requestId === "string"
		? { type, requestId: candidate.requestId }
		: null;
}

function readSessionVariablesUpdatedEvent(event: unknown): {
	workingDirectory?: string;
	workingDirectoryRoots?: string[];
	variables: ContextVariable[];
} | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as Record<string, unknown>;
	if (candidate.type !== SESSION_EVENT_TYPES.SESSION_VARIABLES_UPDATED) return null;
	return {
		...(typeof candidate.workingDirectory === "string"
			? { workingDirectory: candidate.workingDirectory }
			: {}),
		...(Array.isArray(candidate.workingDirectoryRoots)
			? {
					workingDirectoryRoots: candidate.workingDirectoryRoots.filter(
						(root): root is string => typeof root === "string",
					),
				}
			: {}),
		variables: Array.isArray(candidate.variables)
			? candidate.variables.filter(isContextVariable)
			: [],
	};
}

function isContextVariable(value: unknown): value is ContextVariable {
	if (!value || typeof value !== "object") return false;
	const variable = value as Partial<ContextVariable>;
	return (
		typeof variable.name === "string" && typeof variable.value === "string"
	);
}

function normalizePermissionResponse(
	response: unknown,
): NormalizedPermissionResponse | null {
	const input =
		response && typeof response === "object"
			? (response as Record<string, unknown>)
			: { decision: response };
	const decision = input.decision;
	if (
		typeof decision !== "string" ||
		!permissionDecisions.has(decision as PermissionDecision)
	) {
		return null;
	}

	const channel =
		typeof input.channel === "string" && input.channel.trim()
			? input.channel.trim()
			: "api";
	const rejectReason =
		typeof input.rejectReason === "string" ? input.rejectReason : undefined;
	return {
		decision: decision as PermissionDecision,
		channel,
		rejectReason,
	};
}

function serverVariablesFilePath(
	dataRoot: string,
	context = defaultRequestContext(),
	desktopStorePath?: string,
): string {
	if (desktopStorePath && isDefaultServerRequestContext(context)) {
		return getOnethingVariablesPath({ storePath: desktopStorePath });
	}

	return join(
		tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId),
		"variables.json",
	);
}

function serverDateString(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createServerDefaultVariablesFile(
	workspaceRoot: string,
	context = defaultRequestContext(),
): VariablesFile {
	return sanitizeServerVariablesFile(
		createDefaultVariablesFile(),
		workspaceRoot,
		context,
	);
}

function sanitizeServerVariablesFile(
	variablesFile: VariablesFile,
	workspaceRoot: string,
	context = defaultRequestContext(),
): VariablesFile {
	const safeNotePath = (value: string, fallback: string): string => {
		if (
			!value ||
			value === "~/.onething/memory" ||
			value === "~/.onething/notes"
		)
			return fallback;
		const resolved = resolveServerWorkspaceFilePath(
			workspaceRoot,
			context,
			value,
		);
		return resolved ?? fallback;
	};

	return {
		...variablesFile,
		user_note_dir: safeNotePath(variablesFile.user_note_dir, ""),
		work_note_dir: safeNotePath(variablesFile.work_note_dir, ""),
	};
}

function readServerNoteVariable(
	store: VariablesStore,
	which: NoteVarName,
): string {
	if (which === "user_note_dir") return store.getUserNoteDir();
	return store.getWorkNoteDir();
}

function writeServerNoteVariable(
	store: VariablesStore,
	which: NoteVarName,
	value: string,
): void {
	if (which === "user_note_dir") {
		store.setUserNoteDir(value);
		return;
	}
	store.setWorkNoteDir(value);
}

function applyVariablesSnapshotToSession(
	session: ServerChatSession,
	variables: ContextVariable[],
): void {
	const workdir = variables.find((variable) => variable.name === "workdir");
	if (workdir?.value) session.workingDirectory = workdir.value;
	if (workdir?.values) session.workingDirectoryRoots = workdir.values;
	session.variables = variables;
}

/**
 * `<workspaceRoot>/<uid>/<wid>` —— per-owner 沙箱根。
 *
 * 主线 T 批 3：公式本身搬到了 `@onething/backend/rpc/sandbox`(域 handler 与宿主
 * 适配器都要用它),这里改成委托,免得同一条路径规则在仓库里有两份。
 */
function workspaceSandboxRoot(
	workspaceRoot: string,
	context = defaultRequestContext(),
): string {
	return ownerSandboxRoot(workspaceRoot, context.userId, context.workspaceId);
}

/**
 * 已认证身份 → 通用 RPC 通道的 dispatch context（主线 T 批 3）。
 *
 * 住在 runtime 而不是 http.ts,是因为「owner 的沙箱根长什么样」本来就是这个
 * 文件的知识;http.ts 只负责在鉴权之后把它取出来交给 `dispatchRpc`。
 * 身份字段来自 bearer 门放行之后的 RuntimeRequestContext；私有监听能力来自
 * 当前 surface 的 files 端口。两者均不从客户端可控的 RPC 信封恢复。
 */
export function createServerRpcDispatchContext(
	workspaceRoot: string | undefined,
	context: RuntimeRequestContext,
	/**
	 * 这一发的响应对象 —— 用来观察「调用方还在不在」(09-07 事故第四条修;
	 * 判据与理由都在 `request-abort.ts`)。**可选**:铸不出这个观察的调用方
	 * (单测、进程内直调)不给,于是 `signal` 缺席 = 「没人能告诉你调用方走了」。
	 *
	 * 它铸在这里而不是在路由处理者里,理由与这张表上别的格逐字相同:
	 * **身份与处境由宿主一次铸齐**,处理者只读,不自己去看连接。
	 */
	response?: ServerResponse,
): RpcDispatchContext {
	return {
		transport: "http",
		ownerUid: context.userId,
		workspaceId: context.workspaceId,
		sandboxRoot: workspaceRoot
			? workspaceSandboxRoot(workspaceRoot, context)
			: undefined,
		...(response === undefined
			? {}
			: { signal: watchClientDisconnect(response) }),
	};
}

/**
 * 这条 surface 自己带来的函数端口(工单 4 C3)。
 *
 * 与上面那个 context 分开:context 是纯数据(身份 + 作用域,到处被 spread),
 * 端口是函数。从前监听端口是用一个 Symbol + 非枚举属性挂在 context 上的 ——
 * 类型上说不出口,而且任何一次 `{ ...context }` 都会把它悄悄丢掉。
 */
export function createServerRpcDispatchPorts(
	files?: RuntimeFilesAdapter,
): RpcDispatchPorts | undefined {
	if (!files) return undefined;
	return {
		workspaceWatch: {
			startWorkspaceWatch: files.startWorkspaceWatch?.bind(files),
			stopWorkspaceWatch: files.stopWorkspaceWatch?.bind(files),
		},
	};
}

/**
 * 会话文件落在哪 —— **本批一个字节都不许挪**。
 *
 * 这条路径历来由 `(userId, workspaceId)` 推出来,而第二格上盘的其实是**产品空间**:
 * 在非 default 空间里建的会话,它的文件今天就住在 `owners/<uid>/<space>/` 下面。
 * 拆字段之后如果改读租户格,那些文件会当场"消失"(路径变了)。所以这里按
 * **租户优先、回落到盘上原值**的顺序取,存量与新建两种情况都与今天逐字相同。
 *
 * 「空间到底该不该决定沙箱路径」是另一个问题(workspace-spaces 的 per-space 目录
 * 方案里它是有意的),**留给单独一次拍板**,见 §17.5 留账。
 */
function workspaceSandboxRootForSession(
	workspaceRoot: string,
	session: SessionWorkspaceRef,
): string {
	const owner = sessionOwner(session);
	return tenantDirectory(
		workspaceRoot,
		owner.userId ?? defaultRequestContext().userId,
		owner.workspaceId ?? defaultRequestContext().workspaceId,
	);
}

function resolveWorkspacePath(
	workspaceRoot: string,
	session: ServerChatSession,
	requestedPath: string,
): string | null {
	const sandboxRoot = workspaceSandboxRootForSession(workspaceRoot, session);
	const candidate = resolve(
		isAbsolute(requestedPath)
			? requestedPath
			: join(sandboxRoot, requestedPath),
	);
	return isPathInside(candidate, sandboxRoot) ? candidate : null;
}

function isPathInside(candidate: string, root: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}

function ownerKey(context = defaultRequestContext()): string {
	return tenantKey(context.userId, context.workspaceId);
}

function getCurrentSessionId(
	currentSessionIds: Map<string, string>,
	context = defaultRequestContext(),
): string {
	return currentSessionIds.get(ownerKey(context)) ?? "";
}

function setCurrentSessionId(
	currentSessionIds: Map<string, string>,
	context: RuntimeRequestContext,
	sessionId: string,
): void {
	const key = ownerKey(context);
	if (sessionId) {
		currentSessionIds.set(key, sessionId);
	} else {
		currentSessionIds.delete(key);
	}
}

function createSessionId(): string {
	return `web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

// Renderer-supplied session ids (draft ids that materialize in place) must be
// plain v4 UUIDs — they end up in storage paths.
const SESSION_ID_V4_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
