import { randomUUID } from "node:crypto";
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
	generateTitleFromMessage,
	type AgentEngineSessionEvent,
	type AgentEngineStreamChunk,
	type OnethingRuntimeFacade,
	type RuntimeHostCapabilities,
	type RuntimeOAuthTokenEvent,
	type RuntimeRequestContext,
	type RuntimeStreamPayload,
	type RuntimeUnsubscribe,
} from "@onething/core";
import { createOnethingBackend } from "@onething/app/backend.js";
import { buildSystemPromptSnapshot as buildAppSystemPromptSnapshot } from "@onething/app/engine/prompt/system-prompt-snapshot.js";
import { buildOnethingSystemPromptSnapshotForIpc } from "@onething/runtime/prompts";
import { invalidateSettingsCache as invalidateAppSettingsCache } from "@onething/app/stores/settings.js";
import { invalidateAgentsCache as invalidateAppAgentsCache } from "@onething/app/agents/index.js";
import {
	getAllSkillsForDisplay as getAppSkillsForDisplay,
	invalidateSessionSkillsCache as invalidateAppSessionSkillsCache,
} from "@onething/app/skills/session-skills.js";
import {
	createSkill as createAppSkill,
	deleteSkill as deleteAppSkill,
	readSkillFile as readAppSkillFile,
} from "@onething/app/skills/index.js";
import { getProjectsStore as getAppProjectsStore } from "@onething/app/project-dirs/index.js";
import {
	MCPManager as appMCPManager,
	configureMCPClientHost,
	registerMCPTools as registerAppMCPTools,
} from "@onething/app/mcp/index.js";
import { getMCPOAuthFlowManager } from "@onething/app/mcp/oauth/index.js";
import { configureMCPClientIdentity } from "@onething/app/mcp/identity.js";
import { configureMCPCapabilitiesChangedHandler } from "@onething/app/mcp/capabilities-changed.js";
import {
	createBranchSession as createAppStoreBranchSession,
	createSession as createAppStoreSession,
	deleteSession as deleteAppStoreSession,
	flushAllPendingSaves as flushAllAppStorePendingSaves,
	flushSessionSave as flushAppStoreSessionSave,
	getCurrentSessionId as getAppStoreCurrentSessionId,
	getSession as getAppStoreSession,
	getSessionMessagesPage as getAppStoreSessionMessagesPage,
	getSessionUserMessageMarkers as getAppStoreSessionUserMessageMarkers,
	getSessions as getAppStoreSessions,
	getSessionsList as getAppStoreSessionsList,
	saveSessionSnapshot as saveAppStoreSessionSnapshot,
	setCurrentSessionId as setAppStoreCurrentSessionId,
	updateSessionWorkingDirectory as updateAppSessionWorkingDirectory,
	updateSessionWorkingDirectoryRoots as updateAppSessionWorkingDirectoryRoots,
} from "@onething/app/store.js";
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
	type PluginSettings,
} from "@onething/core/plugins";
import {
	createMCPServerState,
	DEFAULT_MCP_SETTINGS,
	HeadlessMCPManager,
	type MCPClientLike,
} from "@onething/core/mcp";
import {
	addOnethingMCPServerForIpc,
	callOnethingMCPToolForIpc,
	connectOnethingMCPServerForIpc,
	disconnectOnethingMCPServerForIpc,
	logoutOnethingMCPServerForIpc,
	probeOnethingMCPServerForIpc,
	getOnethingMCPPromptForIpc,
	getOnethingMCPServersForIpc,
	listOnethingMCPPromptsForIpc,
	listOnethingMCPResourcesForIpc,
	listOnethingMCPToolsForIpc,
	readOnethingMCPConfigFileForIpc,
	readOnethingMCPResourceForIpc,
	refreshOnethingMCPServerForIpc,
	removeOnethingMCPServerForIpc,
	updateOnethingMCPServerForIpc,
} from "@onething/runtime/mcp";
import {
	type OnethingAuthService,
	OnethingTokenStore,
	completeOnethingOAuthCallbackForIpc,
	createOnethingAuthService,
	getOnethingOAuthStatusForIpc,
	logoutOnethingOAuthForIpc,
	pollOnethingOAuthDeviceFlowForIpc,
	refreshOnethingOAuthForIpc,
	startOnethingOAuthForIpc,
	type OnethingOAuthToken,
} from "@onething/runtime/auth";
import {
	addOnethingACPAgentForIpc,
	cancelOnethingACPSessionForIpc,
	connectOnethingACPAgentForIpc,
	disconnectOnethingACPAgentForIpc,
	getOnethingACPAgentsForIpc,
	refreshOnethingACPAgentForIpc,
	removeOnethingACPAgentForIpc,
	updateOnethingACPAgentForIpc,
} from "@onething/runtime/acp";
import {
	createOnethingSearchProviders,
	executeOnethingSearchForIpc,
	type OnethingSearchRequest,
} from "@onething/runtime/search";
import {
	clearOnethingMediaLibrary,
	deleteOnethingMediaItem,
	getOnethingMediaGallery,
	hideOnethingMediaAsset,
	ingestOnethingMediaFilesForIpc,
	listOnethingLegacyMediaImages,
	listOnethingMediaAssets,
	MediaLibraryService,
	OnethingImagePreviewRegistry,
	readOnethingImageFileDataUrlForIpc,
	rebuildOnethingMediaLibraryForIpc,
	type OnethingImagePreviewWindowRequest,
	type OnethingLegacyMediaItem,
	type OnethingMediaAsset,
	type OnethingMediaIngestGeneratedImageInput,
	type OnethingMediaIngestLocalFilesInput,
	type OnethingMediaLibraryPaths,
	type OnethingMediaQuery,
} from "@onething/runtime/media";
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
	validateOnethingAppProxyUrl,
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
import {
	createOnethingSkillForIpc,
	deleteOnethingSkillForIpc,
	listOnethingSkillsForIpc,
	readOnethingSkillFileForIpc,
	refreshOnethingSkillsForIpc,
	toggleOnethingSkillEnabledForIpc,
	type SkillDefinition,
	type SkillSettings,
	type SkillSource,
} from "@onething/runtime/skills";
import {
	OnethingToolRegistry,
	createGlobTool,
	createGrepTool,
	createReadTool,
	expandOnethingToolSandboxPath,
	type OnethingToolExecutionResult,
} from "@onething/runtime/tools";
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
import { defaultOnethingThemeRuntime } from "@onething/runtime/themes/theme-runtime";
// todo/plan 的数据面已整体迁走(含 per-owner 分库);server 这侧只剩变更广播的载荷类型。
import type { TodoPlanChangedPayload } from "@onething/runtime/todo-plan";
import { configureTodoPlanHost } from "@onething/app/todo-plan/store.js";
import {
	OnethingSchedulerRunHistory,
	OnethingSchedulerUserTaskStore,
	Scheduler,
	createOnethingSchedulerRunDetailFromRecord,
	createOnethingUserSchedulerTaskForIpc,
	deleteOnethingUserSchedulerTaskForIpc,
	getOnethingSchedulerRunForIpc,
	getOnethingSchedulerTaskForIpc,
	listOnethingSchedulerRunsForIpc,
	listOnethingSchedulerTasksForIpc,
	nextCronRunAt,
	previewOnethingSchedulerPrompt,
	runOnethingSchedulerAgentTask,
	runOnethingSchedulerTaskNowForIpc,
	setOnethingSchedulerTaskEnabledForIpc,
	updateOnethingUserSchedulerTaskForIpc,
	type OnethingSchedulerRunDetail,
	type OnethingSchedulerUserTask,
	type SchedulerTaskContext,
	type SchedulerTaskHandle,
} from "@onething/runtime/scheduler";
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
	getOnethingSchedulerDir,
	getOnethingSchedulerRunsDir,
	getOnethingSchedulerTasksPath,
	getOnethingSessionPath,
	getOnethingSessionsDir,
	getOnethingSettingsPath,
	getOnethingStorePath,
	getOnethingVariablesPath,
	saveOnethingUiState,
	setOnethingCurrentSessionId,
} from "@onething/runtime/storage";
import { createOnethingSessionRepository } from "@onething/runtime/sessions/session-repository";
import { createHybridSessionStorageDriver } from "@onething/runtime/sessions/storage-driver";
import {
	deleteJsonFile,
	readJsonFile as readCoreJsonFile,
	writeJsonFile as writeCoreJsonFile,
	writeJsonFileAsync as writeCoreJsonFileAsync,
} from "@onething/core/storage";
import { mergeWithDefaults } from "@shared/defaults/settings.js";
import { toJsonValue } from "@shared/json.js";
import type {
	ACPAgentConfig,
	ACPAgentState,
	ACPSettings,
	ACPAddAgentResponse,
	ACPCancelSessionResponse,
	ACPConnectAgentResponse,
	ACPDisconnectAgentResponse,
	ACPGetAgentsResponse,
	ACPRefreshAgentResponse,
	ACPRemoveAgentResponse,
	ACPUpdateAgentResponse,
} from "@shared/ipc/acp.js";
import type {
	GatewayGetStatusResponse,
	GatewayStartRequest,
	GatewayStartResponse,
	GatewayStatus,
	GatewayStopResponse,
	GatewayWechatAddAccountResponse,
	GatewayWechatLogoutResponse,
	GatewayWechatRemoveAccountResponse,
	GatewayWechatRenameAccountResponse,
	GatewayWechatStopAccountResponse,
} from "@shared/ipc/gateway.js";
import type {
	VoiceEvent,
	VoiceGetStateResponse,
	VoiceRuntimeCommand,
	VoiceRuntimeState,
	VoiceSynthesizeResponse,
	VoiceTTSModelsResponse,
	VoiceSubmitUtteranceResponse,
} from "@shared/ipc/voice.js";
import {
	adoptScratchpad as adoptAppScratchpad,
	configureScratchpadHost,
	readScratchpad as readAppScratchpad,
	removeScratchpad as removeAppScratchpad,
	startScratchpadWatcher,
	stopScratchpadWatcher,
	updateScratchpad as updateAppScratchpad,
} from "@onething/app/scratchpad/index.js";
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
	GetSessionMessagesPageRequest,
	GetSessionMessagesPageResponse,
	SessionDetails,
	SessionMeta,
	SystemPromptSnapshot,
	UserMessageMarker,
} from "@shared/ipc/chat.js";
import type {
	MCPAddServerResponse,
	MCPCallToolResponse,
	MCPConnectServerResponse,
	MCPDisconnectServerResponse,
	MCPLogoutServerResponse,
	MCPProbeServerResponse,
	MCPGetPromptResponse,
	MCPGetPromptsResponse,
	MCPGetResourcesResponse,
	MCPGetServersResponse,
	MCPGetToolsResponse,
	MCPReadConfigFileResponse,
	MCPReadResourceResponse,
	MCPRefreshServerResponse,
	MCPRemoveServerResponse,
	MCPServerConfig,
	MCPServerState,
	MCPSettings,
	MCPUpdateServerResponse,
} from "@shared/ipc/mcp.js";
import type {
	SchedulerCreateTaskRequest,
	SchedulerGetRequest,
	SchedulerGetRunRequest,
	SchedulerListRunsRequest,
	SchedulerRunDetailDTO,
	SchedulerRunNowRequest,
	SchedulerSetEnabledRequest,
	SchedulerTaskSnapshotDTO,
	SchedulerUpdateTaskRequest,
} from "@shared/ipc/scheduler.js";
import type {
	AppSettings,
	ProxySettings,
	TestProxyResponse,
} from "@shared/ipc/settings.js";
import type { SessionCommand } from "@shared/events/session-commands.js";
import type { PermissionInfo } from "@shared/ipc/permissions.js";
import type {
	ExecuteToolResponse,
	GetToolsResponse,
	ToolCall,
	ToolDefinition,
} from "@shared/ipc/tools.js";
import { ServerMCPClient, probeServerMCPConfig } from "./mcp-client.js";

type ServerChatSession = ChatSession & {
	userId?: string;
	workspaceId?: string;
	messageCount?: number;
	previewText?: string;
};

const DEFAULT_SESSION_MAX_TOKENS = 128000;
export type ServerMCPClientFactory = (config: MCPServerConfig) => MCPClientLike;
type ServerMCPManager = HeadlessMCPManager<MCPClientLike>;

export interface OnethingServerRuntime {
	runtime: OnethingRuntimeFacade;
	eventBus: EventBus<AgentEngineSessionEvent>;
	streamChannel: ServerStreamChannelLike;
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
	eventBus: EventBus<AgentEngineSessionEvent>;
	streamChannel: ServerStreamChannelLike;
	/**
	 * True when the backend's engine persists messages itself (the real
	 * StreamEngine writes through the app session store). False keeps the
	 * server-side event projection alive so store state still materializes
	 * (test/echo backends).
	 */
	persistsMessages: boolean;
	abortSession(sessionId: string, reason?: string): void;
	shutdown(): Promise<void>;
}

export interface OnethingServerRuntimeOptions {
	createBackend?: () => Promise<OnethingServerBackend>;
	storePath?: string;
	workspaceRoot?: string;
	dataRoot?: string;
	settingsRoot?: string;
	settingsStore?: ServerSettingsStore;
	sessionStore?: ServerSessionStore;
	enableMCPConnections?: boolean;
	allowMCPStdio?: boolean;
	mcpClientFactory?: ServerMCPClientFactory;
	pluginCommands?: ServerPluginCommandDefinition[];
	oauthFetch?: typeof fetch;
}

export interface ServerSettingsStore {
	load(context: RuntimeRequestContext): Promise<AppSettings | undefined>;
	save(context: RuntimeRequestContext, settings: AppSettings): Promise<void>;
}

export interface ServerSessionStore {
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
	deleteSession(sessionId: string): {
		deletedIds: string[];
		parentSessionId?: string;
	};
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
type ServerSchedulerRuntime = {
	scheduler: Scheduler;
	userTasks: OnethingSchedulerUserTaskStore;
	runHistory: OnethingSchedulerRunHistory<SchedulerRunDetailDTO>;
	taskHandles: Map<string, SchedulerTaskHandle>;
	registerUserTask?: (
		task: OnethingSchedulerUserTask,
	) => SchedulerTaskSnapshotDTO;
	unregisterUserTask?: (id: string) => void;
};
type ServerVariablesRuntime = {
	registry: VariableRegistry;
	store: VariablesStore;
	unsubscribe: RuntimeUnsubscribe;
};
type WorkspaceFileChangedHandler = (payload: {
	root: string;
	path: string;
	eventType: string;
}) => void;
export const SERVER_REDACTED_SECRET = "__onething_server_secret_set__";

const sensitiveSettingKeys = new Set([
	"apiKey",
	"oauthToken",
	"accessToken",
	"refreshToken",
	"idToken",
]);

const mcpServerPrivateKeys = new Set([
	"command",
	"args",
	"env",
	"cwd",
	"url",
	"headers",
]);

const serverReadOnlyToolIds = new Set(["read", "glob", "grep"]);
const serverSearchMaxFileBytes = 1024 * 1024;

const webServerCapabilities: RuntimeHostCapabilities = {
	localFileSystem: false,
	workspaceFileSystem: true,
	nativeWindowControls: false,
	shellTools: false,
	clipboardWrite: false,
	desktopWindows: false,
	globalMenuEvents: false,
};

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

interface ServerProjectDirsFile {
	projects: Project[];
}

class ServerProjectDirsStore {
	private projects: Project[] | null = null;

	constructor(private readonly filePath: string) {}

	list(): ProjectIndexEntry[] {
		return this.readProjects()
			.map((project) => ({
				id: project.id,
				path: project.path,
				paths: [...project.paths],
				lastUsedAt: project.lastUsedAt,
			}))
			.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
	}

	get(path: string): Project | null {
		return (
			this.readProjects().find((project) =>
				projectRootsInclude(project.paths, path),
			) ?? null
		);
	}

	add(input: ProjectDirsAddRequest): Project {
		const roots = normalizeProjectRoots(input.path, input.paths ?? []);
		if (!roots) throw new Error("project requires a non-empty path");

		const now = Date.now();
		const projects = this.readProjects();
		const existing =
			projects.find((project) =>
				roots.some((root) => projectRootsInclude(project.paths, root)),
			) ?? null;
		const project: Project = existing
			? {
					...existing,
					paths:
						normalizeProjectRoots(existing.path, [
							...existing.paths,
							...roots,
						]) ?? existing.paths,
					description: input.description ?? existing.description,
					lastUsedAt: now,
				}
			: {
					id: projectIdFromPath(roots[0]),
					path: roots[0],
					paths: roots,
					description: input.description ?? "",
					addedAt: now,
					lastUsedAt: now,
				};
		project.path = project.paths[0];

		this.projects = existing
			? projects.map((item) => (item.id === project.id ? project : item))
			: [...projects, project];
		this.save();
		return project;
	}

	update(
		path: string,
		patch: { description?: string; paths?: string[] },
	): Project | null {
		const projects = this.readProjects();
		const existing = projects.find((project) =>
			projectRootsInclude(project.paths, path),
		);
		if (!existing) return null;
		let nextPaths = existing.paths;
		if (patch.paths) {
			const normalized = normalizeProjectRoots(
				patch.paths[0] ?? "",
				patch.paths.slice(1),
			);
			if (!normalized)
				throw new Error("project requires at least one non-empty root");
			nextPaths = normalized;
		}
		const project: Project = {
			...existing,
			path: nextPaths[0],
			paths: nextPaths,
			description: patch.description ?? existing.description,
		};
		this.projects = projects.map((item) =>
			item.id === existing.id ? project : item,
		);
		this.save();
		return project;
	}

	remove(path: string): boolean {
		const projects = this.readProjects();
		const existing = projects.find((project) =>
			projectRootsInclude(project.paths, path),
		);
		if (!existing) return false;
		this.projects = projects.filter((project) => project.id !== existing.id);
		this.save();
		return true;
	}

	private readProjects(): Project[] {
		if (this.projects) return this.projects;
		try {
			if (!existsSync(this.filePath)) {
				this.projects = [];
				return this.projects;
			}
			const parsed = JSON.parse(
				readFileSync(this.filePath, "utf-8"),
			) as ServerProjectDirsFile;
			this.projects = Array.isArray(parsed.projects)
				? parsed.projects
						.filter(isServerProjectDirProject)
						.map(normalizeServerProjectDirRecord)
				: [];
			return this.projects;
		} catch {
			this.projects = [];
			return this.projects;
		}
	}

	private save(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		writeFileSync(
			this.filePath,
			JSON.stringify({ projects: this.projects ?? [] }, null, 2),
			"utf-8",
		);
	}
}

// Legacy rows carry only `path`; `paths` is normalized in afterwards.
function isServerProjectDirProject(value: unknown): value is Project {
	if (!value || typeof value !== "object") return false;
	const project = value as Partial<Project>;
	return (
		typeof project.id === "string" &&
		typeof project.path === "string" &&
		typeof project.description === "string" &&
		typeof project.addedAt === "number" &&
		typeof project.lastUsedAt === "number"
	);
}

function normalizeServerProjectDirRecord(project: Project): Project {
	const paths =
		normalizeProjectRoots(
			project.path,
			Array.isArray(project.paths)
				? project.paths.filter((p): p is string => typeof p === "string")
				: [],
		) ?? [project.path];
	return { ...project, path: paths[0], paths };
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
			dataRoot,
			"owners",
			safePathSegment(context.userId),
			safePathSegment(context.workspaceId),
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
		setPluginEnabledWithAdapters(pluginId, enabled, {
			readSettings: () => this.readSettings(),
			writeSettings: (settings) => this.writeSettings(settings),
		});
	}

	private readSettings(): PluginSettings {
		return readPluginSettingsFile(this.settingsPath);
	}

	private writeSettings(settings: PluginSettings): void {
		writePluginSettingsFile(this.settingsPath, settings);
	}
}

const SERVER_ACP_CONNECTIONS_DISABLED_ERROR =
	"ACP agent connections are disabled in the web server runtime.";
const SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR =
	"Gateway channels are disabled in the web server runtime.";
const SERVER_VOICE_UNAVAILABLE_ERROR =
	"Voice runtime is not available in the web server runtime.";

class ServerSafeACPManager {
	private settings: ACPSettings = { enabled: true, agents: [] };

	updateSettings(settings: ACPSettings): void {
		this.settings = cloneJson(settings);
	}

	getAgentStates(): ACPAgentState[] {
		return this.settings.agents.map((config) =>
			this.toDisconnectedState(config),
		);
	}

	getAgentState(agentId: string): ACPAgentState | undefined {
		const config = this.settings.agents.find((agent) => agent.id === agentId);
		return config ? this.toDisconnectedState(config) : undefined;
	}

	async connectAgent(agentId: string): Promise<ACPAgentState> {
		const state = this.getAgentState(agentId);
		if (!state) throw new Error(`ACP agent "${agentId}" not found`);
		throw new Error(SERVER_ACP_CONNECTIONS_DISABLED_ERROR);
	}

	async disconnectAgent(): Promise<void> {}

	async refreshAgent(agentId: string): Promise<ACPAgentState> {
		const state = this.getAgentState(agentId);
		if (!state) throw new Error(`ACP agent "${agentId}" not found`);
		return state;
	}

	async cancelSession(): Promise<void> {}

	private toDisconnectedState(config: ACPAgentConfig): ACPAgentState {
		return {
			config: cloneJson(config),
			status: "disconnected",
			sessionCount: 0,
			activePromptCount: 0,
		};
	}
}

function createServerGatewayStatus(
	settings: Pick<AppSettings, "channels">,
	lastError?: string,
): GatewayStatus {
	const enabled = settings.channels?.wechat?.enabled === true;
	return {
		running: false,
		starting: false,
		stopping: false,
		enabled,
		lastError,
		wechat: {
			enabled,
			running: false,
			loginStatus: lastError ? "error" : "idle",
			loggedIn: false,
			lastError,
			lastUpdatedAt: Date.now(),
		},
	};
}

function createServerVoiceState(lastError?: string): VoiceRuntimeState {
	return {
		status: lastError ? "error" : "disabled",
		enabled: false,
		runtimeReady: false,
		lastError,
		updatedAt: Date.now(),
	};
}

function normalizeServerPluginCommandName(commandName: string): string {
	return commandName.startsWith("/") ? commandName : `/${commandName}`;
}

async function createRealServerBackend(storePath: string): Promise<OnethingServerBackend> {
	// The @onething/app path layer resolves its root from ONETHING_STORE_PATH.
	// One server process assembles one backend; pin the root before booting so
	// engine writes land in the same store the server serves.
	if (resolve(getOnethingStorePath()) !== storePath) {
		process.env.ONETHING_STORE_PATH = storePath;
	}
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
		console.log(
			"[ServerRuntime] ONETHING_SERVER_TOOLS=readonly — degraded tool set (read/time/web only)",
		);
	}
	const backend = await createOnethingBackend({
		sandboxHost: {
			getPath(name) {
				if (name === "downloads") return join(homedir(), "Downloads");
				return homedir();
			},
		},
		toolRegistry: serverToolRegistry,
		sessionSkills: true,
		sender: new ServerNoopSender() as never,
	});
	return {
		eventBus: backend.eventBus as unknown as EventBus<AgentEngineSessionEvent>,
		streamChannel: backend.streamChannel as unknown as ServerStreamChannelLike,
		persistsMessages: true,
		abortSession(sessionId, reason) {
			backend.engine.abort(sessionId, reason ?? "server abort");
		},
		shutdown: () => backend.shutdown(),
	};
}

export async function createDevelopmentOnethingServerRuntime(
	options: OnethingServerRuntimeOptions = {},
): Promise<OnethingServerRuntime> {
	const storePath = resolve(options.storePath ?? getOnethingStorePath());
	const backend = options.createBackend
		? await options.createBackend()
		: await createRealServerBackend(storePath);
	const eventBus = backend.eventBus;
	const streamChannel = backend.streamChannel;
	// Real engine backends persist through the @onething/app repository; a
	// second local repository over the same files would fork the in-memory
	// truth and race writes (intermittent 404/empty history, jsonl ENOENT).
	const sessionStore =
		options.sessionStore ??
		(backend.persistsMessages
			? createAppBackedServerSessionStore(storePath)
			: createLocalServerSessionStore(storePath));
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
	// Rejects core-side pending asks as well as the local mirror. Leaving core
	// pendings behind would leave a dead head in the session's serialized
	// prompt queue and block every later permission ask in that session.
	const clearSessionPermissions = (sessionId: string): void => {
		Permission.clearSession(sessionId);
		clearPendingPermissionsForSession(pendingPermissions, sessionId);
	};
	const settingsByOwner = new Map<string, AppSettings>();
	const authServicesByOwner = new Map<
		string,
		OnethingAuthService<OnethingOAuthToken>
	>();
	const mcpManagersByOwner = new Map<string, ServerMCPManager>();
	const agentStoresByOwner = new Map<
		string,
		ReturnType<typeof createOnethingAgentStore>
	>();
	const promptStoresByOwner = new Map<string, OnethingPromptStore>();
	const projectDirStoresByOwner = new Map<string, ServerProjectDirsStore>();
	const pluginCatalogManagersByOwner = new Map<
		string,
		ServerPluginCatalogManager
	>();
	const mediaServicesByOwner = new Map<string, MediaLibraryService>();
	const mediaImageGeneratedHandlersByOwner = new Map<
		string,
		Set<(payload: unknown) => void>
	>();
	const schedulerRuntimesByOwner = new Map<string, ServerSchedulerRuntime>();
	const variableRuntimesByOwner = new Map<string, ServerVariablesRuntime>();
	const workspaceWatchersByOwner = new Map<string, Map<string, FSWatcher>>();
	const workspaceFileChangedHandlersByOwner = new Map<
		string,
		Set<WorkspaceFileChangedHandler>
	>();
	const imagePreviewRegistry = new OnethingImagePreviewRegistry({
		createId: randomUUID,
	});
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
	configureOnethingPermissionGrantStorage({
		getPermissionsDir: () => join(dataRoot, "permissions"),
		readJsonFile: readServerRuntimeJsonFile,
		writeJsonFile: writeServerRuntimeJsonFile,
	});
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
	const readOnlyToolRegistry = createServerReadOnlyToolRegistry();

	const isDefaultContext = (context = defaultRequestContext()) =>
		context.userId === defaultRequestContext().userId &&
		context.workspaceId === defaultRequestContext().workspaceId;

	// App-subsystem delegation: with the real engine, default-owner requests
	// read/write the same app stores the engine uses in-process; echo/test
	// backends and scoped owners keep the server-local implementations.
	const useAppSubsystems = (context = defaultRequestContext()) =>
		backend.persistsMessages && isDefaultContext(context);

	// Project dirs feed the engine's prompt vars — the app store is the one it
	// reads, so web-side edits must land there to be visible in prompts.
	const projectDirsStoreForContext = (context = defaultRequestContext()) =>
		useAppSubsystems(context)
			? getAppProjectsStore()
			: getServerProjectDirsStoreForContext(
					projectDirStoresByOwner,
					dataRoot,
					context,
				);

	const ownerDataRootForContext = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? storePath
			: join(
					dataRoot,
					"owners",
					safePathSegment(context.userId),
					safePathSegment(context.workspaceId),
				);

	const agentStorePathForContext = (
		context = defaultRequestContext(),
	): string =>
		isDefaultContext(context)
			? getOnethingAgentsPath({ storePath })
			: join(ownerDataRootForContext(context), "agents.json");

	const findSessionIndexMeta = (
		sessionId: string,
	): ServerSessionIndexMeta | undefined =>
		(sessionStore.getSessionsList() as ServerSessionIndexMeta[]).find(
			(meta) => meta.id === sessionId,
		);

	const loadSessionIntoWorkingSet = (
		sessionId: string,
	): ServerChatSession | undefined => {
		const session = sessionStore.getSession(sessionId);
		if (!session) return undefined;
		normalizeStoredServerSession(session);
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
			normalizeStoredServerSession(session);
			sessions.set(session.id, session);
		}
		sessionStore.saveSession(session);
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
		if (existing) return existing;

		const root = workspaceSandboxRoot(workspaceRoot, context);
		// Synchronous: callers (file watch, tools) may stat this root right
		// after session creation, and a fire-and-forget mkdir loses that race.
		try {
			mkdirSync(root, { recursive: true });
		} catch (error) {
			console.error("[ServerRuntime] Failed to create workspace root:", error);
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

	eventBus.onAnySessionAny((envelope) => {
		const eventType = (envelope.event as { type?: string }).type;
		if (eventType === "stream:start") {
			activeStreamSessions.add(envelope.sessionId);
		} else if (
			eventType === "stream:complete" ||
			eventType === "stream:error" ||
			eventType === "stream:aborted"
		) {
			activeStreamSessions.delete(envelope.sessionId);
		}
		const permissionEvent = readPermissionTrackingEvent(envelope.event);
		if (permissionEvent?.type === "permission:request") {
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
			permissionEvent?.type === "permission:timeout" ||
			permissionEvent?.type === "permission:settled"
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
			applySessionEvent(session, envelope.event);
			persistSession(session);
		}
	}, "ServerRuntimeStore");

	// Session commands ride the EventBus; the real StreamEngine subscribes to
	// them and owns persistence, retries, steering, and permission flow.
	const forwardSessionCommand = async (
		sessionId: string,
		command: SessionCommand,
	): Promise<{ success: boolean; error?: string }> => {
		await eventBus.emit(sessionId, command as unknown as AgentEngineSessionEvent);
		return { success: true };
	};

	const getMCPSettingsForContext = async (
		context = defaultRequestContext(),
	): Promise<MCPSettings> => {
		const settings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);
		return cloneJson(settings.mcp ?? DEFAULT_MCP_SETTINGS);
	};

	const saveMCPSettingsForContext = async (
		mcpSettings: MCPSettings,
		context = defaultRequestContext(),
	): Promise<void> => {
		const previousSettings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);
		const nextSettings = mergeServerSettingsUpdate(previousSettings, {
			...previousSettings,
			mcp: mcpSettings,
		});
		settingsByOwner.set(ownerKey(context), cloneJson(nextSettings));
		await settingsStore.save(context, nextSettings);
	};

	const mcpAdaptersForContext = (context = defaultRequestContext()) => ({
		getSettings: () => getMCPSettingsForContext(context),
		saveSettings: (mcpSettings: MCPSettings) =>
			saveMCPSettingsForContext(mcpSettings, context),
		manager: getOwnerMCPManager(mcpManagersByOwner, mcpClientFactory, context),
		// Regenerating the tools catalog is what makes newly connected servers
		// visible to the model; a no-op here is why HTTP-added servers used to
		// connect without ever reaching the engine.
		registerTools: useAppSubsystems(context)
			? registerAppMCPTools
			: async () => {},
		logoutOAuth: (serverId: string) => getMCPOAuthFlowManager().logout(serverId),
		logger: console,
	});

	// The engine's MCP bridge is hard-bound to the @onething/app singleton
	// manager, so the default owner MUST route through that same instance —
	// a server-local manager would connect servers the model never sees
	// (same class of split as the session double-repository above).
	// Scoped owners keep their isolated server-local managers.
	if (backend.persistsMessages) {
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
		// P2-1: server-pushed list changes re-read into state by the client;
		// regenerate the model-facing catalog through the same path.
		configureMCPCapabilitiesChangedHandler(() => {
			void registerAppMCPTools();
		});
		mcpManagersByOwner.set(
			ownerKey(defaultRequestContext()),
			appMCPManager as ServerMCPManager,
		);
		void (async () => {
			try {
				await appMCPManager.initialize(await getMCPSettingsForContext());
				await registerAppMCPTools();
			} catch (error) {
				console.error("[ServerRuntime] MCP initialization failed:", error);
			}
		})();
	}

	const getACPSettingsForContext = async (
		context = defaultRequestContext(),
	): Promise<ACPSettings> => {
		const settings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);
		return cloneJson(settings.acp ?? { enabled: true, agents: [] });
	};

	const saveACPSettingsForContext = async (
		acpSettings: ACPSettings,
		context = defaultRequestContext(),
	): Promise<void> => {
		const previousSettings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);
		await saveOwnerSettings(settingsByOwner, settingsStore, context, {
			...previousSettings,
			acp: acpSettings,
		});
	};

	const acpAdaptersForContext = (context = defaultRequestContext()) => {
		const manager = new ServerSafeACPManager();
		return {
			getSettings: () => getACPSettingsForContext(context),
			saveSettings: async (acpSettings: ACPSettings) => {
				await saveACPSettingsForContext(acpSettings, context);
				manager.updateSettings(acpSettings);
			},
			manager,
			logger: console,
		};
	};

	const notifyMediaImageGenerated = (
		context: RuntimeRequestContext,
		payload: unknown,
	): void => {
		const handlers = mediaImageGeneratedHandlersByOwner.get(ownerKey(context));
		if (!handlers) return;
		for (const handler of handlers) handler(payload);
	};

	/**
	 * 草稿纸的广播是**进程级**的:store 是 `@onething/app/scratchpad` 的单例
	 * (引擎在同一进程里读同一张纸),所以订阅者也不按 owner 分表 —— 分了就要
	 * 有第二个 store,而第二个 store 就是第二份事实。
	 */
	const scratchpadChangedHandlers = new Set<
		(payload: ScratchpadChangedPayload) => void
	>();
	/**
	 * todo/plan 的广播和草稿纸同形:数据面迁到通用 RPC 通道之后,写发生在
	 * `@onething/app/todo-plan` 那一个进程级 store 里,per-owner 的第二个 store
	 * 连同它的 per-owner 订阅表一起没了。**这个端口是 `/api/todo-plan/events`
	 * 这条 SSE 唯一的货源** —— 少了它,浏览器端的变更推送会安静地断掉。
	 */
	const todoPlanChangedHandlers = new Set<TodoPlanChangedHandler>();
	configureTodoPlanHost({
		broadcastChanged: (payload) => {
			for (const handler of todoPlanChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					console.error("[server] todo-plan broadcast failed:", error);
				}
			}
		},
	});

	configureScratchpadHost({
		broadcastChanged: (payload) => {
			for (const handler of scratchpadChangedHandlers) {
				try {
					handler(payload);
				} catch (error) {
					console.error("[server] scratchpad broadcast failed:", error);
				}
			}
		},
	});
	// AI 用普通 write/edit 工具改纸时不经过 store —— watcher 是唯一会告诉
	// 浏览器"纸变了"的人。
	void startScratchpadWatcher().catch((error) => {
		console.error("[server] scratchpad watcher failed to start:", error);
	});

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
			store = new OnethingPromptStore({
				getPath: () =>
					join(
						dataRoot,
						"owners",
						safePathSegment(context.userId),
						safePathSegment(context.workspaceId),
						"prompts.json",
					),
				readJson: readServerRuntimeJsonFile,
				writeJson: writeServerRuntimeJsonFile,
				warn: (message, details) => {
					if (details === undefined) console.warn(message);
					else console.warn(message, details);
				},
			});
			promptStoresByOwner.set(key, store);
		}
		return store;
	};

	const getAuthServiceForContext = (
		context = defaultRequestContext(),
	): OnethingAuthService<OnethingOAuthToken> => {
		const key = ownerKey(context);
		let service = authServicesByOwner.get(key);
		if (!service) {
			service = createOnethingAuthService<OnethingOAuthToken>({
				tokenStore: new OnethingTokenStore<OnethingOAuthToken>({
					tokenFilePath: join(
						dataRoot,
						"owners",
						safePathSegment(context.userId),
						safePathSegment(context.workspaceId),
						"oauth",
						"tokens.json",
					),
					logger: console,
				}),
				...(options.oauthFetch ? { fetch: options.oauthFetch } : {}),
				logger: console,
			});
			authServicesByOwner.set(key, service);
		}
		return service;
	};

	const getSchedulerRuntimeForContext = (
		context = defaultRequestContext(),
	): ServerSchedulerRuntime => {
		const key = ownerKey(context);
		let schedulerRuntime = schedulerRuntimesByOwner.get(key);
		if (schedulerRuntime) return schedulerRuntime;

		const paths = serverSchedulerPaths(
			dataRoot,
			context,
			isDefaultContext(context) ? storePath : undefined,
		);
		const userTasks = new OnethingSchedulerUserTaskStore({
			tasksFilePath: paths.tasksPath,
			defaultAgentId: DEFAULT_ONETHING_AGENT_ID,
			agentExists: (agentId) =>
				getAgentStoreForContext(context).agentExists(agentId),
			createId: randomUUID,
			logger: console,
		});
		const runHistory = new OnethingSchedulerRunHistory<SchedulerRunDetailDTO>({
			runsDir: paths.runsDir,
			logger: console,
		});
		const scheduler = new Scheduler({
			stateFilePath: paths.statePath,
			createRunId: randomUUID,
			logger: console,
		});
		schedulerRuntime = {
			scheduler,
			userTasks,
			runHistory,
			taskHandles: new Map(),
		};
		schedulerRuntimesByOwner.set(key, schedulerRuntime);

		const registerUserTask = (
			task: OnethingSchedulerUserTask,
		): SchedulerTaskSnapshotDTO => {
			schedulerRuntime.taskHandles.get(task.id)?.unregister();
			const handle = scheduler.register({
				id: task.id,
				name: task.name,
				kind: "agent",
				source: "user",
				readonly: false,
				agentId: task.agentId,
				prompt: task.prompt,
				promptPreview: previewOnethingSchedulerPrompt(task.prompt),
				workingDirectory: task.workingDirectory,
				tags: ["agent", "user"],
				enabled: () => task.enabled,
				schedule: () => task.schedule,
				timeoutMs: 30 * 60 * 1000,
				run: (taskContext) =>
					runServerSchedulerAgentTask(
						task.id,
						taskContext,
						context,
						schedulerRuntime!,
					),
			});
			schedulerRuntime.taskHandles.set(task.id, handle);
			const snapshot = handle.getStatus() as
				| SchedulerTaskSnapshotDTO
				| undefined;
			if (!snapshot) throw new Error("Failed to register scheduled task");
			return snapshot;
		};

		const unregisterUserTask = (id: string): void => {
			schedulerRuntime?.taskHandles.get(id)?.unregister();
			schedulerRuntime?.taskHandles.delete(id);
		};

		const runServerSchedulerAgentTask = async (
			taskId: string,
			taskContext: SchedulerTaskContext,
			ownerContext: RuntimeRequestContext,
			ownerSchedulerRuntime: ServerSchedulerRuntime,
		): Promise<Record<string, unknown>> =>
			runOnethingSchedulerAgentTask(taskId, taskContext, {
				getTask: (targetTaskId) =>
					ownerSchedulerRuntime.userTasks.get(targetTaskId),
				getStreamHost: () => ({
					hasBoundSender: () => true,
					abort: (sessionId) => {
						backend.abortSession(sessionId, "scheduler abort");
					},
				}),
				eventBus: {
					onAny: (sessionId, handler, label) =>
						eventBus.onAny(
							sessionId,
							handler as unknown as Parameters<typeof eventBus.onAny>[1],
							label,
						),
					emit: async (sessionId, event) => {
						if (event.type === "command:send-message") {
							const session = getSessionForContext(sessionId, ownerContext);
							if (!session) {
								throw new Error("Session not found");
							}
						}
						return eventBus.emit(
							sessionId,
							event as unknown as AgentEngineSessionEvent,
						);
					},
				},
				sessions: {
					getCurrentSessionId: () => getServerCurrentSessionId(ownerContext),
					createSession: (sessionId, name) => {
						const session = ensureSession(ownerContext, sessionId);
						session.name = name;
						session.updatedAt = Date.now();
						persistSession(session);
						return session;
					},
					updateSessionAgent: (sessionId, agentId) => {
						const session = getSessionForContext(sessionId, ownerContext);
						if (session) {
							session.agentId = agentId;
							persistSession(session);
						}
					},
					updateSessionWorkingDirectory: (sessionId, workingDirectory) => {
						const session = getSessionForContext(sessionId, ownerContext);
						const resolvedPath = resolveServerWorkspaceFilePath(
							workspaceRoot,
							ownerContext,
							workingDirectory,
						);
						if (session && resolvedPath) {
							session.workingDirectory = resolvedPath;
							persistSession(session);
						}
					},
					updateSessionArchived: (sessionId, isArchived, archivedAt) => {
						const session = getSessionForContext(sessionId, ownerContext);
						if (session) {
							session.isArchived = isArchived;
							session.archivedAt = archivedAt ?? undefined;
							persistSession(session);
						}
					},
					setCurrentSessionId: (sessionId) =>
						setServerCurrentSessionId(ownerContext, sessionId),
					getSession: (sessionId) => {
						return getSessionForContext(sessionId, ownerContext);
					},
				},
				saveRunDetail: (detail) =>
					ownerSchedulerRuntime.runHistory.save(
						detail as SchedulerRunDetailDTO,
					) as OnethingSchedulerRunDetail,
				createId: randomUUID,
				logger: console,
			});

		for (const task of userTasks.list()) {
			registerUserTask(task);
		}

		schedulerRuntime.registerUserTask = registerUserTask;
		schedulerRuntime.unregisterUserTask = unregisterUserTask;
		return schedulerRuntime;
	};

	const getSchedulerRuntimeWithSettingsForContext = async (
		context = defaultRequestContext(),
	): Promise<ServerSchedulerRuntime> => {
		await getOwnerSettings(settingsByOwner, settingsStore, context);
		return getSchedulerRuntimeForContext(context);
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
		const store = new VariablesStore({
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
		});
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
							console.error(
								"[server:variables] broadcast refresh failed:",
								meta.id,
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
					type: "session:variables-updated",
					workingDirectory: session.workingDirectory,
					workingDirectoryRoots: session.workingDirectoryRoots,
					variables: snapshot,
				} as unknown as AgentEngineSessionEvent)
				.catch((error) => {
					console.error("[server:variables] EventBus emit failed:", error);
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

	const createSearchProvidersForContext = async (
		context = defaultRequestContext(),
	) => {
		const settings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);

		return createOnethingSearchProviders({
			getSessionsList: () => listSessionsForContext(context),
			getSessionRaw: (sessionId) => getSessionForContext(sessionId, context),
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
		});
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
			const providers = await createSearchProvidersForContext(context);
			await providers.createDailyNote(filePath);
			return { success: true, actionId: `open-file:${filePath}` };
		} catch (error: any) {
			return {
				success: false,
				error: error.message || "Failed to execute search action.",
			};
		}
	};

	const notifyWorkspaceFileChanged = (
		context: RuntimeRequestContext,
		payload: { root: string; path: string; eventType: string },
	): void => {
		const handlers = workspaceFileChangedHandlersByOwner.get(ownerKey(context));
		if (!handlers) return;
		for (const handler of handlers) handler(payload);
	};

	const subscribeWorkspaceFileChanged = (
		handler: WorkspaceFileChangedHandler,
		context = defaultRequestContext(),
	): RuntimeUnsubscribe => {
		const key = ownerKey(context);
		let handlers = workspaceFileChangedHandlersByOwner.get(key);
		if (!handlers) {
			handlers = new Set();
			workspaceFileChangedHandlersByOwner.set(key, handlers);
		}
		handlers.add(handler);
		return () => {
			handlers?.delete(handler);
			if (handlers?.size === 0) workspaceFileChangedHandlersByOwner.delete(key);
		};
	};

	const watchWorkspaceForContext = async (
		root: string,
		context = defaultRequestContext(),
	): Promise<{ success: boolean; error?: string }> => {
		const watchRoot = resolveServerWorkspaceFilePath(
			workspaceRoot,
			context,
			root,
		);
		if (!watchRoot) {
			return {
				success: false,
				error:
					"Workspace watch root must stay inside the workspace sandbox root.",
			};
		}

		const rootStats = await stat(watchRoot).catch(() => null);
		if (!rootStats?.isDirectory()) {
			return {
				success: false,
				error: "Workspace watch root must be an existing directory.",
			};
		}

		const key = ownerKey(context);
		let watchers = workspaceWatchersByOwner.get(key);
		if (!watchers) {
			watchers = new Map();
			workspaceWatchersByOwner.set(key, watchers);
		}
		if (watchers.has(watchRoot)) return { success: true };

		const createWatcher = (recursive: boolean): FSWatcher =>
			watch(watchRoot, { recursive }, (eventType, fileName) => {
				const changedPath =
					typeof fileName === "string" && fileName.length > 0
						? resolve(watchRoot, fileName)
						: watchRoot;
				if (
					!isPathInside(
						changedPath,
						workspaceSandboxRoot(workspaceRoot, context),
					)
				)
					return;
				notifyWorkspaceFileChanged(context, {
					root: watchRoot,
					path: changedPath,
					eventType: eventType || "change",
				});
			});

		let watcher: FSWatcher;
		try {
			watcher = createWatcher(true);
		} catch {
			watcher = createWatcher(false);
		}
		watcher.on("error", (error) => {
			console.warn("[server:files] Workspace watcher failed:", error);
		});
		watchers.set(watchRoot, watcher);
		return { success: true };
	};

	const unwatchWorkspaceForContext = (
		root: string,
		context = defaultRequestContext(),
	): { success: boolean; error?: string } => {
		const watchRoot = resolveServerWorkspaceFilePath(
			workspaceRoot,
			context,
			root,
		);
		if (!watchRoot) {
			return {
				success: false,
				error:
					"Workspace watch root must stay inside the workspace sandbox root.",
			};
		}

		const watchers = workspaceWatchersByOwner.get(ownerKey(context));
		const watcher = watchers?.get(watchRoot);
		if (watcher) {
			watcher.close();
			watchers?.delete(watchRoot);
		}
		if (watchers?.size === 0)
			workspaceWatchersByOwner.delete(ownerKey(context));
		return { success: true };
	};

	const buildSystemPromptSnapshotForContext = async (
		sessionId: string,
		context = defaultRequestContext(),
	): Promise<
		| { success: true; snapshot: SystemPromptSnapshot }
		| { success: false; error: string }
	> => {
		if (useAppSubsystems(context)) {
			// Real engine, single-user: the app snapshot builder reads the same
			// store/settings/tool registry the live stream uses — the snapshot
			// is the prompt that will actually ship, not a web-host mock.
			return buildOnethingSystemPromptSnapshotForIpc({
				sessionId,
				buildSnapshot: buildAppSystemPromptSnapshot,
				logger: console,
			});
		}
		// Draft ids are ordinary session ids the server has never seen (the
		// renderer materializes them lazily), so an unknown id is treated as a
		// draft and gets the default-settings snapshot — this is a read-only
		// preview, strictness buys nothing here.
		const session = getSessionForContext(sessionId, context);

		const settings = await getOwnerSettings(
			settingsByOwner,
			settingsStore,
			context,
		);
		const providerId =
			session?.lastProvider || settings.ai?.provider || "local";
		const providerConfig = (
			settings.ai?.providers as
				| Record<string, { apiKey?: string; model?: string }>
				| undefined
		)?.[providerId];
		const model = session?.lastModel || providerConfig?.model || "local-echo";
		const tools =
			(await readOnlyToolRegistry.getAllToolsAsync()) as ToolDefinition[];
		const enableToolCalls = settings.tools?.enableToolCalls !== false;
		const enabledTools = tools.filter(
			(tool) => enableToolCalls && tool.enabled,
		);
		const workingDirectory =
			session?.workingDirectory || workspaceSandboxRoot(workspaceRoot, context);
		const systemPrompt = [
			"You are onething, an AI chat assistant running in the web host.",
			`Current work directory: ${workingDirectory}`,
			enabledTools.length > 0
				? `Available tools: ${enabledTools.map((tool) => tool.id).join(", ")}`
				: "Available tools: none",
		].join("\n\n");

		return {
			success: true,
			snapshot: {
				sessionId: session?.id || sessionId,
				generatedAt: Date.now(),
				providerId,
				model,
				providerSupported: providerId === "local",
				credentialsReady:
					providerId === "local" || Boolean(providerConfig?.apiKey),
				workingDirectory,
				agentId: session?.agentId || "default",
				agentName: session?.agentId || "Default Agent",
				systemPrompt,
				systemPromptChars: systemPrompt.length,
				tools: {
					enableToolCalls,
					modelSupportsTools: enabledTools.length > 0,
					hasTools: enabledTools.length > 0,
					configuredCount: tools.length,
					modelFacingCount: enabledTools.length,
					builtin: tools.map((tool) => ({
						id: tool.id,
						name: tool.name,
						description: tool.description,
						category: tool.category,
						source: "builtin",
						enabled: tool.enabled,
						autoExecute: tool.autoExecute,
						permissionGuard: tool.permissionGuard,
						executionMode: tool.executionMode,
						renderKind: tool.renderKind,
						parameters: tool.parameters,
					})),
					mcp: [],
					codexNative: [],
				},
				agentLoopStream: {
					enabled: false,
					enabledBy: "default",
					providerSupported: false,
					active: false,
					supportedProviderIds: [],
				},
				skills: {
					enabled: false,
					includedInPrompt: false,
					count: 0,
					items: [],
				},
			},
		};
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
			type: "command:permission-respond",
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
		capabilities: {
			async get() {
				return webServerCapabilities;
			},
		},
		appState: {
			async get(context = defaultRequestContext()) {
				const currentSessionId = getServerCurrentSessionId(context);
				return {
					currentSessionId,
					currentWorkspaceId: context.workspaceId,
					openTabs: currentSessionId
						? [{ type: "chat", sessionId: currentSessionId }]
						: [],
					activeTabIndex: 0,
					sidebarCollapsed: false,
				};
			},
			async saveUIState(uiState: unknown, context = defaultRequestContext()) {
				if (!isDefaultContext(context)) return { success: true };
				return sessionStore.saveUIState(uiState);
			},
		},
		sessions: {
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
			async get(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				return { success: true, session: toChatSession(session) };
			},
			async activate(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				setServerCurrentSessionId(context, session.id);
				return {
					success: true,
					session: toSessionDetails(session),
					messageCount: session.messages.length,
				};
			},
			async delete(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: true };
				const deleteResult = sessionStore.deleteSession(sessionId);
				for (const deletedId of deleteResult.deletedIds.length
					? deleteResult.deletedIds
					: [sessionId]) {
					// Deleting mid-stream: abort first — the terminal stream event
					// may never arrive once the session's channels are destroyed.
					if (activeStreamSessions.has(deletedId)) {
						backend.abortSession(deletedId, "session deleted");
						activeStreamSessions.delete(deletedId);
					}
					sessions.delete(deletedId);
					clearSessionPermissions(deletedId);
					eventBus.destroySession(deletedId);
					streamChannel.destroySession(deletedId);
				}
				clearSessionPermissions(sessionId);
				if (getServerCurrentSessionId(context) === sessionId) {
					setServerCurrentSessionId(
						context,
						listSessionsForContext(context)[0]?.id ?? "",
					);
				}
				return { success: true };
			},
			async rename(
				sessionId: string,
				name: string,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				session.name = name;
				session.updatedAt = Date.now();
				persistSession(session);
				return { success: true };
			},
			async createBranch(
				parentSessionId: string,
				branchFromMessageId: string,
				context = defaultRequestContext(),
			) {
				const parentSession = getSessionForContext(parentSessionId, context);
				if (!parentSession) {
					return { success: false, error: "Parent session not found" };
				}

				const messageIndex = parentSession.messages.findIndex(
					(message) => message.id === branchFromMessageId,
				);
				if (messageIndex < 0)
					return { success: false, error: "Message not found" };

				const now = Date.now();
				const branchId = createSessionId();
				const inheritedMessages = parentSession.messages
					.slice(0, messageIndex + 1)
					.map((message) => cloneBranchMessage(message, branchId));
				const branchSession = sessionStore.createBranchSession(
					branchId,
					`${parentSession.name} (Branch)`,
					parentSessionId,
					branchFromMessageId,
					inheritedMessages,
					context,
				);
				branchSession.createdAt = now;
				branchSession.updatedAt = now;
				branchSession.agentId = parentSession.agentId;
				branchSession.lastProvider = parentSession.lastProvider;
				branchSession.lastModel = parentSession.lastModel;
				branchSession.permissionMode = parentSession.permissionMode;
				branchSession.workingDirectory = parentSession.workingDirectory;
				branchSession.workingDirectoryRoots = cloneJson(
					parentSession.workingDirectoryRoots ?? [],
				);
				branchSession.variables = cloneJson(parentSession.variables ?? []);
				refreshSessionMeta(branchSession);
				persistSession(branchSession);
				setServerCurrentSessionId(context, branchSession.id);
				return { success: true, session: toChatSession(branchSession) };
			},
			async update(
				sessionId: string,
				patch: Record<string, unknown>,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				const patchResult = applySessionPatch(session, patch, workspaceRoot);
				if (!patchResult.success) return patchResult;
				persistSession(session);
				return { success: true, session: toSessionDetails(session) };
			},
		},
		messages: {
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
					? getMessagePage(session.messages, request)
					: sessionStore.getMessagesPage(request);
			},
			async userMarkers(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, markers: [], error: "Session not found" };
				}
				return {
					success: true,
					markers: backend.persistsMessages || activeStreamSessions.has(sessionId)
						? getUserMarkers(session.messages)
						: (sessionStore.getUserMessageMarkers(sessionId) ??
							getUserMarkers(session.messages)),
				};
			},
		},
		chat: {
			async getHistory(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				return { success: true, messages: session.messages };
			},
			async generateTitle(message: string) {
				return { success: true, title: generateTitleFromMessage(message) };
			},
			async getMessages(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				return { success: true, messages: session.messages };
			},
			async getTokenUsage(
				sessionId: string,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, error: "Session not found" };
				}
				return { success: true, usage: getServerSessionTokenUsage(session) };
			},
			async updateSessionPin(
				sessionId: string,
				isPinned: boolean,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				session.isPinned = isPinned;
				session.updatedAt = Date.now();
				persistSession(session);
				return { success: true };
			},
			async addSystemMessage(
				sessionId: string,
				message: unknown,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				const systemMessage = normalizeServerSystemMessage(sessionId, message);
				session.messages.push(systemMessage);
				refreshSessionMeta(session);
				persistSession(session);
				return { success: true };
			},
			async removeSystemMarkerMessage(
				sessionId: string,
				markerType: string,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				const marker = `"type":"${markerType}"`;
				const index = session.messages.findIndex(
					(message) =>
						message.role === "system" &&
						typeof message.content === "string" &&
						message.content.includes(marker),
				);
				if (index < 0) return { success: true, removedId: null };
				const [removed] = session.messages.splice(index, 1);
				refreshSessionMeta(session);
				persistSession(session);
				return { success: true, removedId: removed?.id ?? null };
			},
			async removeMessage(
				sessionId: string,
				messageId: string,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				const index = session.messages.findIndex(
					(message) => message.id === messageId,
				);
				if (index < 0) return { success: false, error: "Message not found" };
				session.messages.splice(index, 1);
				refreshSessionMeta(session);
				persistSession(session);
				return { success: true };
			},
			async updateMessageThinkingTime(
				sessionId: string,
				messageId: string,
				thinkingTime: number,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };
				const message = session.messages.find(
					(candidate) => candidate.id === messageId,
				);
				if (!message) return { success: false, error: "Message not found" };
				message.thinkingTime = thinkingTime;
				refreshSessionMeta(session);
				persistSession(session);
				return { success: true };
			},
		},
		commands: {
			async emit(
				sessionId: string,
				command: SessionCommand,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) return { success: false, error: "Session not found" };

				if (command.type === "command:abort") {
					backend.abortSession(sessionId, "HTTP abort");
					clearSessionPermissions(sessionId);
					return { success: true };
				}

				// Every other command forwards whole — the StreamEngine owns
				// send/edit/retry/resume/steering/compact/permission handling,
				// so no field is destructured away on this hop.
				//
				// Channel stamping is deliberately narrow. Do NOT stamp 'api'
				// onto send/edit/...: channel-identity resolves 'api' commands
				// to an anonymous external guest and remaps the message into an
				// identity session — but this HTTP surface is the owner's own
				// web UI, which must keep desktop semantics. Permission
				// responses instead ADOPT the pending ask's target channel:
				// this endpoint already authenticated the session owner, and
				// core's affinity check guards against cross-channel spoofing
				// on the bus, not against the owner approving over HTTP.
				if (command.type === "command:permission-respond") {
					const pending =
						(command.requestId
							? pendingPermissions.get(command.requestId)
							: undefined) ??
						(command.toolCallId
							? Array.from(pendingPermissions.values()).find(
									(record) => record.info.callId === command.toolCallId,
								)
							: undefined);
					return forwardSessionCommand(sessionId, {
						...command,
						channel:
							command.channel ?? pending?.info.targetChannel ?? "api",
					});
				}
				return forwardSessionCommand(sessionId, command);
			},
		},
		events: {
			subscribe(
				sessionId,
				handler,
				options,
				context = defaultRequestContext(),
			) {
				const canReadSession = (targetSessionId: string) => {
					return Boolean(getSessionForContext(targetSessionId, context));
				};

				if (sessionId !== "*" && options?.afterSeq !== undefined) {
					if (!canReadSession(sessionId)) return () => {};
					for (const envelope of eventBus.replay(
						sessionId,
						options.afterSeq + 1,
					)) {
						handler(envelope);
					}
				}

				if (sessionId === "*") {
					return eventBus.onAnySessionAny((envelope) => {
						if (canReadSession(envelope.sessionId)) handler(envelope);
					}, "ServerRuntimeEvents");
				}
				if (!canReadSession(sessionId)) return () => {};
				return eventBus.onAny(sessionId, handler, "ServerRuntimeEvents");
			},
		},
		streams: {
			subscribe(
				sessionId,
				handler,
				_options,
				context = defaultRequestContext(),
			) {
				const canReadSession = (targetSessionId: string) => {
					return Boolean(getSessionForContext(targetSessionId, context));
				};

				if (sessionId === "*") {
					return streamChannel.subscribeAny((payload) => {
						if (canReadSession(payload.sessionId)) handler(payload);
					});
				}
				if (!canReadSession(sessionId)) return () => {};
				return streamChannel.subscribe(sessionId, (chunk) =>
					handler({ sessionId, chunk }),
				);
			},
			async abort(sessionId?: string, context = defaultRequestContext()) {
				// The backend owns the abort (engine.abort for the real factory,
				// controller abort for echo); the ledger itself is settled by the
				// resulting stream:aborted event, not mutated here.
				if (sessionId) {
					const session = getSessionForContext(sessionId, context);
					if (!session) return { success: false, error: "Session not found" };
					backend.abortSession(sessionId, "HTTP abort");
					clearSessionPermissions(sessionId);
					return { success: true };
				}
				// Abort-all stays owner-scoped: only sessions this context can read.
				for (const activeSessionId of Array.from(activeStreamSessions)) {
					if (!getSessionForContext(activeSessionId, context)) continue;
					backend.abortSession(activeSessionId, "HTTP abort");
					clearSessionPermissions(activeSessionId);
				}
				return { success: true };
			},
			async active(context = defaultRequestContext()) {
				return Array.from(activeStreamSessions).filter((sessionId) => {
					return Boolean(getSessionForContext(sessionId, context));
				});
			},
		},
		permissions: {
			async respond(requestId, response, context = defaultRequestContext()) {
				return respondToPermission(requestId, response, context);
			},
			async getPending(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, pending: [], error: "Session not found" };
				}
				return getOnethingPendingPermissionsForIpc({
					sessionId,
					// Real engine: core Permission is the source of truth — same
					// wiring as the desktop IPC handler, including promptState
					// (actionable/queued) so a reloading client rebuilds queued
					// cards. The event-driven mirror only serves echo backends.
					getPending: (targetSessionId) =>
						backend.persistsMessages
							? (Permission.getPendingPrompts(
									targetSessionId,
								) as unknown as PermissionInfo[])
							: Array.from(pendingPermissions.values())
									.filter((record) => record.sessionId === targetSessionId)
									.map((record) => record.info),
					logger: console,
				});
			},
			async clearSession(sessionId: string, context = defaultRequestContext()) {
				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, error: "Session not found" };
				}
				return clearOnethingPermissionSessionForIpc({
					sessionId,
					clearSession: (targetSessionId) =>
						clearSessionPermissions(targetSessionId),
					logger: console,
				});
			},
			async listGrants(request = {}, context = defaultRequestContext()) {
				const sessionId =
					typeof request.sessionId === "string" ? request.sessionId : undefined;
				const workspaceRootInput =
					typeof request.workspaceRoot === "string"
						? request.workspaceRoot
						: undefined;
				const workspaceGrantRoot = workspaceRootInput
					? resolveServerWorkspaceGrantRoot(
							workspaceRoot,
							context,
							workspaceRootInput,
						)
					: undefined;
				if (workspaceRootInput && !workspaceGrantRoot) {
					return {
						success: false,
						error:
							"Workspace root must stay inside the workspace sandbox root.",
					};
				}
				if (sessionId) {
					const session = getSessionForContext(sessionId, context);
					if (!session) {
						return { success: false, error: "Session not found" };
					}
				}

				return listOnethingPermissionGrantsForIpc({
					sessionId,
					workspaceRoot: workspaceGrantRoot ?? undefined,
					userId: context.userId,
					workspaceId: context.workspaceId,
					listSessionGrants: (targetSessionId) =>
						listSessionGrants(targetSessionId),
					listWorkspaceGrants,
					logger: console,
				});
			},
			async revokeGrant(id: string, context = defaultRequestContext()) {
				if (
					!canRevokePermissionGrant(
						id,
						listOwnedSessionMetas(context),
						workspaceRoot,
						context,
					)
				) {
					return { success: false, error: "Permission grant not found" };
				}
				return revokeOnethingPermissionGrantForIpc({
					id,
					revokeGrant,
					logger: console,
				});
			},
			async clearSessionGrants(
				sessionId: string,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, error: "Session not found" };
				}
				return clearOnethingSessionPermissionGrantsForIpc({
					sessionId,
					clearSessionGrants,
					logger: console,
				});
			},
			async clearWorkspaceGrants(
				workspaceRootInput: string,
				context = defaultRequestContext(),
			) {
				const workspaceGrantRoot = resolveServerWorkspaceGrantRoot(
					workspaceRoot,
					context,
					workspaceRootInput,
				);
				if (!workspaceGrantRoot) {
					return {
						success: false,
						error:
							"Workspace root must stay inside the workspace sandbox root.",
					};
				}
				return clearOnethingWorkspacePermissionGrantsForIpc({
					workspaceRoot: workspaceGrantRoot,
					userId: context.userId,
					workspaceId: context.workspaceId,
					clearWorkspaceGrants,
					logger: console,
				});
			},
		},
		settings: {
			async get(context = defaultRequestContext()) {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return { success: true, settings: sanitizeSettingsForClient(settings) };
			},
			async update(settings, context = defaultRequestContext()) {
				const previousSettings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				const nextSettings = mergeServerSettingsUpdate(
					previousSettings,
					settings,
				);
				settingsByOwner.set(ownerKey(context), cloneJson(nextSettings));
				await settingsStore.save(context, nextSettings);
				if (nextSettings.mcp) {
					await getOwnerMCPManager(
						mcpManagersByOwner,
						mcpClientFactory,
						context,
					).updateSettings(nextSettings.mcp);
				}
				return {
					success: true,
					settings: sanitizeSettingsForClient(nextSettings),
				};
			},
		},
		network: {
			testProxy: (proxy: ProxySettings) => testServerProxy(proxy),
		},
		search: {
			async query(
				request: OnethingSearchRequest,
				context = defaultRequestContext(),
			) {
				const providers = await createSearchProvidersForContext(context);
				return executeOnethingSearchForIpc({
					request,
					executeSearch: (query, category, limit) =>
						providers.executeSearch(query, category, limit),
				});
			},
			executeAction(actionId: string, context = defaultRequestContext()) {
				return resolveSearchActionForContext(actionId, context);
			},
		},
		themes: {
			getThemes: () => defaultOnethingThemeRuntime.listThemes(),
			getTheme: (themeId: string) =>
				defaultOnethingThemeRuntime.getTheme(themeId),
			applyTheme: (themeId: string, mode: "dark" | "light") =>
				defaultOnethingThemeRuntime.applyTheme(themeId, mode),
			refreshThemes: (projectPath?: string) =>
				defaultOnethingThemeRuntime.refreshThemes(projectPath),
			async openThemesFolder() {
				return {
					success: false,
					error:
						"Opening the local themes folder is not available in the web server runtime.",
				};
			},
		},
		prompts: {
			getSystemPromptSnapshot: buildSystemPromptSnapshotForContext,
		},
		files: {
			async listFiles(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					cwd?: string;
					query?: string;
					limit?: number;
				};
				const sandboxRoot = await ensureServerWorkspaceSandboxRoot(
					workspaceRoot,
					context,
				);
				const cwd = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					typedRequest.cwd ?? sandboxRoot,
				);
				if (!cwd)
					return emptyWorkspaceFileList(
						"File search must stay inside the workspace sandbox root.",
					);

				return listOnethingFileSearchEntriesForIpc({
					cwd,
					query: typedRequest.query,
					limit: typedRequest.limit,
					homeDir: sandboxRoot,
					downloadsDir: null,
					getNoteRoots: () => ({}),
					listFiles: (root) => {
						const rootPath = resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							root.path,
						);
						return rootPath ? listServerToolFiles({ cwd: rootPath }) : [];
					},
					logger: console,
				});
			},
			async listDirs(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					basePath?: string;
					query?: string;
					limit?: number;
				};
				const sandboxRoot = await ensureServerWorkspaceSandboxRoot(
					workspaceRoot,
					context,
				);
				const basePath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					typedRequest.basePath || sandboxRoot,
				);
				if (!basePath) {
					return {
						success: false,
						dirs: [],
						basePath: "",
						error:
							"Directory completion must stay inside the workspace sandbox root.",
					};
				}

				return listOnethingDirectoriesForCompletionForIpc({
					basePath,
					query: typedRequest.query,
					limit: typedRequest.limit,
					homeDir: sandboxRoot,
					stat: async (targetPath) => {
						const resolvedPath = resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							targetPath,
						);
						return resolvedPath ? stat(resolvedPath).catch(() => null) : null;
					},
					readDir: async (targetPath) => {
						const resolvedPath = resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							targetPath,
						);
						return resolvedPath
							? readdir(resolvedPath, { withFileTypes: true })
							: [];
					},
					logger: console,
				});
			},
			async readContent(
				path: string,
				maxSize?: number,
				context = defaultRequestContext(),
			) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"File path must stay inside the workspace sandbox root.",
					);
				return readOnethingFileContent({
					path: targetPath,
					maxSize,
					stat: (filePath) => stat(filePath),
					async readBytes(filePath, byteLength) {
						const buffer = await readFile(filePath);
						return buffer.subarray(0, byteLength);
					},
				});
			},
			async saveContent(
				path: string,
				content: string,
				expectedMtimeMs?: number,
				context = defaultRequestContext(),
			) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"File path must stay inside the workspace sandbox root.",
					);
				return saveOnethingFileContent({
					path: targetPath,
					content,
					expectedMtimeMs,
					stat: (filePath) => stat(filePath),
					writeFile: (filePath, fileContent) =>
						writeFile(filePath, fileContent, "utf-8"),
				});
			},
			async rollback(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					auditPath?: string;
					filePath?: string;
					originalContent?: string;
					isNew?: boolean;
				};
				const auditPath = typedRequest.auditPath
					? (resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							typedRequest.auditPath,
						) ?? undefined)
					: undefined;
				if (typedRequest.auditPath && !auditPath) {
					return workspaceFilePathError(
						"Audit path must stay inside the workspace sandbox root.",
					);
				}

				const filePath = typedRequest.filePath
					? (resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							typedRequest.filePath,
						) ?? undefined)
					: undefined;
				if (typedRequest.filePath && !filePath) {
					return workspaceFilePathError(
						"Rollback file path must stay inside the workspace sandbox root.",
					);
				}

				return rollbackOnethingFile({
					auditPath,
					filePath,
					originalContent: typedRequest.originalContent,
					isNew: typedRequest.isNew,
					applyAuditUndo: applyFileMutationUndo,
					deleteFile: (filePathToDelete) =>
						rm(filePathToDelete, { force: true }),
					writeFile: (filePathToWrite, content) =>
						writeFile(filePathToWrite, content, "utf-8"),
				});
			},
			async listDirectory(path: string, context = defaultRequestContext()) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"Directory path must stay inside the workspace sandbox root.",
					);
				return listOnethingDirectory({
					path: targetPath,
					readDir: (dirPath) => readdir(dirPath, { withFileTypes: true }),
					stat: (entryPath) => stat(entryPath).catch(() => null),
				});
			},
			async stat(path: string, context = defaultRequestContext()) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"Path must stay inside the workspace sandbox root.",
					);
				return statOnethingPath({
					path: targetPath,
					stat: (target) => stat(target),
				});
			},
			async createFile(
				path: string,
				content?: string,
				context = defaultRequestContext(),
			) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"File path must stay inside the workspace sandbox root.",
					);
				return createOnethingFile({
					path: targetPath,
					content,
					createFile: (filePath, fileContent) =>
						writeFile(filePath, fileContent, { flag: "wx" }),
				});
			},
			async createDirectory(path: string, context = defaultRequestContext()) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"Directory path must stay inside the workspace sandbox root.",
					);
				return createOnethingDirectory({
					path: targetPath,
					createDirectory: (dirPath) =>
						mkdir(dirPath, { recursive: false }).then(() => undefined),
				});
			},
			async renamePath(
				oldPath: string,
				newPath: string,
				context = defaultRequestContext(),
			) {
				const resolvedOldPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					oldPath,
				);
				const resolvedNewPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					newPath,
				);
				if (!resolvedOldPath || !resolvedNewPath) {
					return workspaceFilePathError(
						"Rename paths must stay inside the workspace sandbox root.",
					);
				}
				return renameOnethingPath({
					oldPath: resolvedOldPath,
					newPath: resolvedNewPath,
					renamePath: rename,
				});
			},
			async deletePath(path: string, context = defaultRequestContext()) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"Path must stay inside the workspace sandbox root.",
					);
				return deleteOnethingPath({
					path: targetPath,
					deletePath: (target) => rm(target, { recursive: true, force: false }),
				});
			},
			async revealPath(path: string, context = defaultRequestContext()) {
				const targetPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!targetPath)
					return workspaceFilePathError(
						"Path must stay inside the workspace sandbox root.",
					);
				return {
					success: false,
					error:
						"Revealing local files is not available in the web server runtime.",
				};
			},
			watchWorkspace: (root: string, context = defaultRequestContext()) =>
				watchWorkspaceForContext(root, context),
			async unwatchWorkspace(root: string, context = defaultRequestContext()) {
				return unwatchWorkspaceForContext(root, context);
			},
			subscribeWorkspaceFileChanged: (
				handler,
				context = defaultRequestContext(),
			) =>
				subscribeWorkspaceFileChanged(
					handler as WorkspaceFileChangedHandler,
					context,
				),
		},
		markdown: {
			async resolveAsset(request: unknown, context = defaultRequestContext()) {
				const prepared = await prepareServerMarkdownRequest(
					workspaceRoot,
					settingsByOwner,
					settingsStore,
					context,
					request,
				);
				if (!prepared.success) return { success: false, error: prepared.error };
				if (!prepared.request.rawTarget)
					return {
						success: false,
						error: "Markdown asset target is required.",
					};
				return resolveOnethingMarkdownAssetForIpc({
					request: {
						documentPath: prepared.request.documentPath,
						workspaceRoot: prepared.request.workspaceRoot,
						rawTarget: prepared.request.rawTarget,
					},
					resolveAsset: async (markdownRequest) => {
						const asset = await resolveOnethingMarkdownAsset(
							markdownRequest,
							prepared.adapters,
						);
						return sanitizeServerMarkdownAsset(workspaceRoot, context, asset);
					},
				});
			},
			async saveAttachments(
				request: unknown,
				context = defaultRequestContext(),
			) {
				const prepared = await prepareServerMarkdownRequest(
					workspaceRoot,
					settingsByOwner,
					settingsStore,
					context,
					request,
				);
				if (!prepared.success)
					return {
						success: false,
						error: prepared.error,
						code: "WORKSPACE_PATH",
					};
				return saveOnethingMarkdownAttachmentsForIpc({
					request: {
						...prepared.request,
						files: Array.isArray((request as { files?: unknown }).files)
							? (request as MarkdownSaveAttachmentsRequest).files
							: [],
					},
					saveAttachments: async (markdownRequest) => {
						const result = await saveOnethingMarkdownAttachments(
							markdownRequest,
							prepared.adapters,
						);
						return sanitizeServerMarkdownAttachmentResult(
							workspaceRoot,
							context,
							result,
						);
					},
				});
			},
		},
		projectDirs: {
			async list(context = defaultRequestContext()) {
				const store = projectDirsStoreForContext(context);
				return listOnethingProjectDirsForIpc({
					listEntries: () => store.list(),
					getProject: (path) => store.get(path),
				});
			},
			async get(path: string, context = defaultRequestContext()) {
				const resolvedPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!resolvedPath) return serverProjectDirsPathError();
				const store = projectDirsStoreForContext(context);
				return getOnethingProjectDirForIpc({
					request: { path: resolvedPath },
					getProject: (targetPath) => store.get(targetPath),
				});
			},
			async add(
				path: string,
				description?: string,
				context = defaultRequestContext(),
				paths?: string[],
			) {
				const resolvedPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!resolvedPath) return serverProjectDirsPathError();
				let resolvedExtraPaths: string[] | undefined;
				if (paths && paths.length > 0) {
					resolvedExtraPaths = [];
					for (const extra of paths) {
						const resolvedExtra = resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							extra,
						);
						if (!resolvedExtra) return serverProjectDirsPathError();
						resolvedExtraPaths.push(resolvedExtra);
					}
				}
				const store = projectDirsStoreForContext(context);
				return addOnethingProjectDirForIpc({
					request: { path: resolvedPath, paths: resolvedExtraPaths, description },
					addProject: (input) => store.add(input),
				});
			},
			async update(
				path: string,
				patch: { description?: string; paths?: string[] },
				context = defaultRequestContext(),
			) {
				const resolvedPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!resolvedPath) return serverProjectDirsPathError();
				let resolvedPaths: string[] | undefined;
				if (patch.paths) {
					resolvedPaths = [];
					for (const root of patch.paths) {
						const resolvedRoot = resolveServerWorkspaceFilePath(
							workspaceRoot,
							context,
							root,
						);
						if (!resolvedRoot) return serverProjectDirsPathError();
						resolvedPaths.push(resolvedRoot);
					}
				}
				const store = projectDirsStoreForContext(context);
				return updateOnethingProjectDirForIpc({
					request: {
						path: resolvedPath,
						description: patch.description,
						paths: resolvedPaths,
					},
					updateProject: (targetPath, targetPatch) =>
						store.update(targetPath, targetPatch),
				});
			},
			async remove(path: string, context = defaultRequestContext()) {
				const resolvedPath = resolveServerWorkspaceFilePath(
					workspaceRoot,
					context,
					path,
				);
				if (!resolvedPath) return serverProjectDirsPathError();
				const store = projectDirsStoreForContext(context);
				return removeOnethingProjectDirForIpc({
					request: { path: resolvedPath },
					removeProject: (targetPath) => store.remove(targetPath),
				});
			},
		},
		variables: {
			async list(
				request: VariablesListRequest,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(request.sessionId, context);
				if (!session) {
					return {
						success: false,
						variables: [],
						error: "Session not found",
						code: "NOT_FOUND",
					};
				}
				const variableRuntime = getVariableRuntimeForContext(context);
				return listOnethingVariablesForIpc({
					request,
					listVariables: (variableContext) =>
						variableRuntime.registry.list(variableContext),
				});
			},
			async set(
				request: VariablesSetRequest,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(request.sessionId, context);
				if (!session) {
					return {
						success: false,
						error: "Session not found",
						code: "NOT_FOUND",
					};
				}
				const variableRuntime = getVariableRuntimeForContext(context);
				return setOnethingVariableForIpc({
					request,
					setVariable: (variableContext, input) =>
						variableRuntime.registry.set(variableContext, input),
				});
			},
			async delete(
				request: VariablesDeleteRequest,
				context = defaultRequestContext(),
			) {
				const session = getSessionForContext(request.sessionId, context);
				if (!session) {
					return {
						success: false,
						error: "Session not found",
						code: "NOT_FOUND",
					};
				}
				const variableRuntime = getVariableRuntimeForContext(context);
				return deleteOnethingVariableForIpc({
					request,
					deleteVariable: (variableContext, name, scope) =>
						variableRuntime.registry.delete(variableContext, name, scope),
				});
			},
		},
		media: {
			async listAssets(query: unknown, context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				const assets = await listOnethingMediaAssets({
					query: (query as OnethingMediaQuery | undefined) || {},
					listAssets: (mediaQuery) => service.listAssets(mediaQuery),
				});
				return assets.map(toServerClientMediaAsset);
			},
			async ingestFiles(request: unknown, context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				const result = await ingestOnethingMediaFilesForIpc({
					request: (request as OnethingMediaIngestLocalFilesInput | undefined) || {
						files: [],
					},
					ingestFiles: (input) => service.ingestLocalFiles(input),
					logger: console,
				});
				// 出站资产的 filePath 必须重写成 URL:浏览器拿到主机的绝对路径既没用
				// 也是一次泄露(其余 media 出口同此口径)。
				return {
					...result,
					assets: result.assets.map(toServerClientMediaAsset),
				};
			},
			async hideAsset(id: string, context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				return hideOnethingMediaAsset({
					id,
					hideAsset: (assetId) => service.hideAsset(assetId),
				});
			},
			async rebuildLibrary(context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				return rebuildOnethingMediaLibraryForIpc({
					// 媒体库重建语义上需要扫描全部消息附件:按 owned 元数据逐个瞬时
					// 加载会话体,不经 resolveSession,避免把全部会话钉进工作集。
					listSessions: () =>
						listOwnedSessionMetas(context)
							.map((meta) => sessionStore.getSession(meta.id))
							.filter((session): session is ServerChatSession =>
								Boolean(session),
							)
							.map(toMediaSession),
					rebuildFromSessions: (mediaSessions) =>
						service.rebuildFromSessions(mediaSessions),
					logger: console,
				});
			},
			async getGallery(
				assetId: string,
				query: unknown,
				context = defaultRequestContext(),
			) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				const gallery = await getOnethingMediaGallery({
					assetId,
					query: (query as OnethingMediaQuery | undefined) || {},
					getGallery: (targetAssetId, mediaQuery) =>
						service.getGallery(targetAssetId, mediaQuery),
				});
				return {
					...gallery,
					images: gallery.images.map(toServerClientMediaAsset),
				};
			},
			async saveImage(request: unknown, context = defaultRequestContext()) {
				const input = request as OnethingMediaIngestGeneratedImageInput;
				if (input.sessionId) {
					const session = getSessionForContext(input.sessionId, context);
					if (!session) {
						throw new Error("Session not found");
					}
				}
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				const item = await service.saveGeneratedImageAsLegacyItem(input);
				const clientItem = toServerClientLegacyMediaItem(item);
				notifyMediaImageGenerated(context, {
					...clientItem,
					url: clientItem.filePath,
				});
				return clientItem;
			},
			async loadAll(context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				const items = await listOnethingLegacyMediaImages({
					listLegacyImages: () => service.listLegacyImages(),
				});
				return items.map(toServerClientLegacyMediaItem);
			},
			async delete(id: string, context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				return deleteOnethingMediaItem({
					id,
					hideAsset: (assetId) => service.hideAsset(assetId),
				});
			},
			async clearAll(context = defaultRequestContext()) {
				const service = getServerMediaServiceForContext(
					mediaServicesByOwner,
					dataRoot,
					context,
					isDefaultContext(context) ? storePath : undefined,
				);
				await clearOnethingMediaLibrary({
					hideAllAssets: () => service.hideAllAssets(),
				});
			},
			async readImageBase64(
				filePath: string,
				context = defaultRequestContext(),
			) {
				const resolved = resolveServerMediaFilePath(
					mediaServicesByOwner,
					dataRoot,
					context,
					filePath,
					isDefaultContext(context) ? storePath : undefined,
				);
				if (!resolved) throw new Error("Media file not found");
				return readOnethingImageFileDataUrlForIpc(resolved.path, {
					logger: console,
				});
			},
			async openPreview(src: string, alt?: string) {
				const previewId = imagePreviewRegistry.create(src, alt);
				return { success: true, previewId };
			},
			async getPreview(previewId: string) {
				return imagePreviewRegistry.get(previewId);
			},
			async openGallery(mediaId: string) {
				return { success: true, mediaId };
			},
			async resolveFile(fileName: string, context = defaultRequestContext()) {
				const resolved = resolveServerMediaFilePath(
					mediaServicesByOwner,
					dataRoot,
					context,
					fileName,
					isDefaultContext(context) ? storePath : undefined,
				);
				return resolved
					? { success: true, path: resolved.path, mimeType: resolved.mimeType }
					: { success: false, error: "Media file not found" };
			},
			subscribeImageGenerated(
				handler: (payload: unknown) => void,
				context = defaultRequestContext(),
			) {
				const key = ownerKey(context);
				let handlers = mediaImageGeneratedHandlersByOwner.get(key);
				if (!handlers) {
					handlers = new Set<(payload: unknown) => void>();
					mediaImageGeneratedHandlersByOwner.set(key, handlers);
				}
				handlers.add(handler);
				return () => {
					handlers?.delete(handler);
					if (handlers?.size === 0)
						mediaImageGeneratedHandlersByOwner.delete(key);
				};
			},
		},
		// todo/plan 的数据面已迁到通用 RPC 通道(todoPlanRouter);这里只剩事件订阅,
		// 它给 `/api/todo-plan/events` 那条 SSE 供货 —— 事件下行的收敛是主线 T2。
		todoPlan: {
			subscribeChanged: subscribeTodoPlanChanged,
		},
		// 草稿纸没有 per-owner 分表:server 是单用户,而且**引擎在同一个进程里
		// 读同一张纸**(beforeTurn 尾块注入)。第二个仓等于把事实分叉。
		scratchpad: {
			async get(request: ScratchpadGetRequest) {
				try {
					const document = await readAppScratchpad(request.sessionId);
					return { success: true, document };
				} catch (error) {
					return { success: false, error: describeRuntimeError(error) };
				}
			},
			async update(request: ScratchpadUpdateRequest) {
				try {
					const document = await updateAppScratchpad(
						request.sessionId,
						request.content,
					);
					return { success: true, document };
				} catch (error) {
					return { success: false, error: describeRuntimeError(error) };
				}
			},
			async delete(request: ScratchpadDeleteRequest) {
				try {
					await removeAppScratchpad(request.sessionId);
					return { success: true };
				} catch (error) {
					return { success: false, error: describeRuntimeError(error) };
				}
			},
			async adopt(request: ScratchpadAdoptRequest) {
				try {
					await adoptAppScratchpad(
						request.fromSessionId,
						request.toSessionId,
					);
					return { success: true };
				} catch (error) {
					return { success: false, error: describeRuntimeError(error) };
				}
			},
			subscribeChanged: subscribeScratchpadChanged,
		},
		scheduler: {
			async listTasks(context = defaultRequestContext()) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return listOnethingSchedulerTasksForIpc({
					listTasks: () =>
						schedulerRuntime.scheduler.list() as SchedulerTaskSnapshotDTO[],
					logger: console,
				});
			},
			async getTask(
				request: SchedulerGetRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return getOnethingSchedulerTaskForIpc({
					id: request.id,
					getTaskStatus: (id) =>
						schedulerRuntime.scheduler.getStatus(id) as
							| SchedulerTaskSnapshotDTO
							| undefined,
					logger: console,
				});
			},
			async runTaskNow(
				request: SchedulerRunNowRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return runOnethingSchedulerTaskNowForIpc({
					id: request.id,
					force: request.force,
					runNow: (id, options) =>
						schedulerRuntime.scheduler.runNow(id, options),
					isUserTask: (id) => isServerUserSchedulerTask(schedulerRuntime, id),
					toRunDetail: (record) =>
						createOnethingSchedulerRunDetailFromRecord({
							...(record as SchedulerRunDetailDTO),
							result: toJsonValue((record as SchedulerRunDetailDTO).result),
						}) as SchedulerRunDetailDTO,
					saveRunDetail: (detail) => schedulerRuntime.runHistory.save(detail),
					logger: console,
				});
			},
			async setTaskEnabled(
				request: SchedulerSetEnabledRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return setOnethingSchedulerTaskEnabledForIpc({
					id: request.id,
					enabled: request.enabled,
					isUserTask: (id) => isServerUserSchedulerTask(schedulerRuntime, id),
					setUserTaskEnabled: (id, enabled) => {
						const task = schedulerRuntime.userTasks.setEnabled(id, enabled);
						return schedulerRuntime.registerUserTask!(task);
					},
					setSchedulerTaskEnabled: (id, enabled) =>
						schedulerRuntime.scheduler.setEnabled(id, enabled) as
							| SchedulerTaskSnapshotDTO
							| undefined,
					logger: console,
				});
			},
			async createTask(
				request: SchedulerCreateTaskRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return createOnethingUserSchedulerTaskForIpc({
					request,
					createUserTask: (taskRequest) => {
						const task = schedulerRuntime.userTasks.create(taskRequest);
						return schedulerRuntime.registerUserTask!(task);
					},
					logger: console,
				});
			},
			async updateTask(
				request: SchedulerUpdateTaskRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return updateOnethingUserSchedulerTaskForIpc({
					request,
					isUserTask: (id) => isServerUserSchedulerTask(schedulerRuntime, id),
					updateUserTask: (taskRequest) => {
						const task = schedulerRuntime.userTasks.update(taskRequest);
						return schedulerRuntime.registerUserTask!(task);
					},
					logger: console,
				});
			},
			async deleteTask(
				request: { id: string },
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return deleteOnethingUserSchedulerTaskForIpc({
					id: request.id,
					isUserTask: (id) => isServerUserSchedulerTask(schedulerRuntime, id),
					deleteUserTask: (id) => {
						schedulerRuntime.userTasks.delete(id);
						schedulerRuntime.unregisterUserTask?.(id);
					},
					logger: console,
				});
			},
			async listRuns(
				request: SchedulerListRunsRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return listOnethingSchedulerRunsForIpc({
					taskId: request.taskId,
					limit: request.limit,
					listSavedRuns: (taskId, limit) =>
						schedulerRuntime.runHistory.list(taskId, limit),
					getTaskStatus: (taskId) =>
						schedulerRuntime.scheduler.getStatus(taskId) as
							| SchedulerTaskSnapshotDTO
							| undefined,
					toRunDetail: (record) =>
						createOnethingSchedulerRunDetailFromRecord({
							...(record as SchedulerRunDetailDTO),
							result: toJsonValue((record as SchedulerRunDetailDTO).result),
						}) as SchedulerRunDetailDTO,
					logger: console,
				});
			},
			async getRun(
				request: SchedulerGetRunRequest,
				context = defaultRequestContext(),
			) {
				const schedulerRuntime =
					await getSchedulerRuntimeWithSettingsForContext(context);
				return getOnethingSchedulerRunForIpc({
					taskId: request.taskId,
					runId: request.runId,
					getSavedRun: (taskId, runId) =>
						schedulerRuntime.runHistory.get(taskId, runId),
					getTaskStatus: (taskId) =>
						schedulerRuntime.scheduler.getStatus(taskId) as
							| SchedulerTaskSnapshotDTO
							| undefined,
					toRunDetail: (record) =>
						createOnethingSchedulerRunDetailFromRecord({
							...(record as SchedulerRunDetailDTO),
							result: toJsonValue((record as SchedulerRunDetailDTO).result),
						}) as SchedulerRunDetailDTO,
					logger: console,
				});
			},
		},
		skills: {
			list(workingDirectory?: string, context = defaultRequestContext()) {
				if (useAppSubsystems(context)) {
					// Factory already ran initializeSessionSkills; this is the
					// exact skill set the engine injects into prompts.
					return listOnethingSkillsForIpc({
						workingDirectory,
						ensureInitialized: async () => {},
						listSkills: (options) => getAppSkillsForDisplay(options),
						logger: console,
					});
				}
				return listOnethingSkillsForIpc({
					workingDirectory,
					ensureInitialized: async () =>
						ensureServerSkillsDirectories(dataRoot, context),
					listSkills: (options) =>
						listServerSkillsForContext(
							dataRoot,
							workspaceRoot,
							context,
							settingsByOwner,
							settingsStore,
							options,
						),
					logger: console,
				});
			},
			refresh(context = defaultRequestContext()) {
				if (useAppSubsystems(context)) {
					return refreshOnethingSkillsForIpc({
						invalidateSkillsCache: async () =>
							invalidateAppSessionSkillsCache(),
						listSkills: (options) => getAppSkillsForDisplay(options),
						logger: console,
					});
				}
				return refreshOnethingSkillsForIpc({
					invalidateSkillsCache: async () => {},
					listSkills: (options) =>
						listServerSkillsForContext(
							dataRoot,
							workspaceRoot,
							context,
							settingsByOwner,
							settingsStore,
							options,
						),
					logger: console,
				});
			},
			readFile(
				skillId: string,
				fileName: string,
				context = defaultRequestContext(),
			) {
				if (useAppSubsystems(context)) {
					return readOnethingSkillFileForIpc({
						skillId,
						fileName,
						readSkillFile: readAppSkillFile,
						logger: console,
					});
				}
				return readOnethingSkillFileForIpc({
					skillId,
					fileName,
					readSkillFile: (targetSkillId, targetFileName) =>
						readServerSkillFile(
							dataRoot,
							workspaceRoot,
							context,
							settingsByOwner,
							settingsStore,
							targetSkillId,
							targetFileName,
						),
					logger: console,
				});
			},
			async openDirectory() {
				return {
					success: false,
					error:
						"Opening local skill directories is not available in the web server runtime.",
				};
			},
			create(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					name?: string;
					description?: string;
					instructions?: string;
					source?: SkillSource;
				};
				if (useAppSubsystems(context)) {
					return createOnethingSkillForIpc({
						name: typedRequest.name ?? "",
						description: typedRequest.description ?? "",
						instructions: typedRequest.instructions ?? "",
						source: typedRequest.source ?? "user",
						createSkill: createAppSkill,
						invalidateSkillsCache: async () =>
							invalidateAppSessionSkillsCache(),
						logger: console,
					});
				}
				return createOnethingSkillForIpc({
					name: typedRequest.name ?? "",
					description: typedRequest.description ?? "",
					instructions: typedRequest.instructions ?? "",
					source: typedRequest.source ?? "user",
					createSkill: (name, description, instructions, source) =>
						createServerSkill(
							dataRoot,
							workspaceRoot,
							context,
							name,
							description,
							instructions,
							source,
						),
					invalidateSkillsCache: async () => {},
					logger: console,
				});
			},
			delete(skillId: string, context = defaultRequestContext()) {
				if (useAppSubsystems(context)) {
					return deleteOnethingSkillForIpc({
						skillId,
						deleteSkill: deleteAppSkill,
						invalidateSkillsCache: async () =>
							invalidateAppSessionSkillsCache(),
						logger: console,
					});
				}
				return deleteOnethingSkillForIpc({
					skillId,
					deleteSkill: (targetSkillId) =>
						deleteServerSkill(
							dataRoot,
							workspaceRoot,
							context,
							settingsByOwner,
							settingsStore,
							targetSkillId,
						),
					invalidateSkillsCache: async () => {},
					logger: console,
				});
			},
			toggleEnabled(
				skillId: string,
				enabled: boolean,
				context = defaultRequestContext(),
			) {
				return toggleOnethingSkillEnabledForIpc<
					AppSettings & { skills?: SkillSettings }
				>({
					skillId,
					enabled,
					getSettings: () =>
						getOwnerSettings(
							settingsByOwner,
							settingsStore,
							context,
						) as Promise<AppSettings & { skills?: SkillSettings }>,
					saveSettings: (settings) =>
						saveOwnerSettings(
							settingsByOwner,
							settingsStore,
							context,
							settings,
						),
					logger: console,
				});
			},
			async execute() {
				return {
					success: false,
					error: "Skill execution is not available in the web server runtime.",
				};
			},
		},
		plugins: {
			list(context = defaultRequestContext()) {
				const manager = getServerPluginCatalogManagerForContext(
					pluginCatalogManagersByOwner,
					dataRoot,
					context,
					options.pluginCommands,
				);
				return listOnethingPluginsForIpc({
					manager,
					logger: console,
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
					logger: console,
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
					logger: console,
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
					logger: console,
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
					logger: console,
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
						console.error(`[ServerPlugin] ${label} emit failed:`, error);
					},
					logger: console,
				});
			},
		},
		oauth: {
			start(providerId: string, context = defaultRequestContext()) {
				const service = getAuthServiceForContext(context);
				return startOnethingOAuthForIpc({
					providerId,
					start: (id) => service.start(id),
					logger: console,
				});
			},
			callback(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					providerId?: string;
					code?: string;
					state?: string;
				};
				const service = getAuthServiceForContext(context);
				return completeOnethingOAuthCallbackForIpc({
					providerId: typedRequest.providerId || "",
					code: typedRequest.code || "",
					state: typedRequest.state || "",
					completeManualCode: (providerId, code, state) =>
						service.completeManualCode(providerId, code, state),
					logger: console,
				});
			},
			devicePoll(request: unknown, context = defaultRequestContext()) {
				const typedRequest = request as {
					providerId?: string;
					flowId?: string;
				};
				const service = getAuthServiceForContext(context);
				return pollOnethingOAuthDeviceFlowForIpc({
					providerId: typedRequest.providerId || "",
					flowId: typedRequest.flowId,
					pollDeviceFlow: (providerId, flowId) =>
						service.pollDeviceFlow(providerId, flowId),
					logger: console,
				});
			},
			refresh(providerId: string, context = defaultRequestContext()) {
				const service = getAuthServiceForContext(context);
				return refreshOnethingOAuthForIpc({
					providerId,
					refreshToken: (id) => service.refreshToken(id),
					notifyTokenExpired: (id, error) => {
						service.emit("token-expired", { providerId: id, error });
					},
					logger: console,
				});
			},
			status(providerId: string, context = defaultRequestContext()) {
				const service = getAuthServiceForContext(context);
				return getOnethingOAuthStatusForIpc({
					providerId,
					getStatus: (id) => service.getStatus(id),
					logger: console,
				});
			},
			logout(providerId: string, context = defaultRequestContext()) {
				const service = getAuthServiceForContext(context);
				return logoutOnethingOAuthForIpc({
					providerId,
					deleteToken: (id) => service.deleteToken(id),
					logger: console,
				});
			},
			subscribe(
				handler: (event: RuntimeOAuthTokenEvent) => void,
				context = defaultRequestContext(),
			) {
				const service = getAuthServiceForContext(context);
				const onRefreshed = (data: { providerId: string }) => {
					handler({
						type: "oauth:token-refreshed",
						providerId: data.providerId,
					});
				};
				const onExpired = (data: { providerId: string; error?: string }) => {
					handler({
						type: "oauth:token-expired",
						providerId: data.providerId,
						error: data.error,
					});
				};
				service.on("token-refreshed", onRefreshed);
				service.on("token-expired", onExpired);
				return () => {
					service.off("token-refreshed", onRefreshed);
					service.off("token-expired", onExpired);
				};
			},
		},
		gateway: {
			async getStatus(
				context = defaultRequestContext(),
			): Promise<GatewayGetStatusResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return { success: true, status: createServerGatewayStatus(settings) };
			},
			async start(
				_request?: GatewayStartRequest,
				context = defaultRequestContext(),
			): Promise<GatewayStartResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
			async stop(
				context = defaultRequestContext(),
			): Promise<GatewayStopResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return { success: true, status: createServerGatewayStatus(settings) };
			},
			async wechatLogout(
				_request?: unknown,
				context = defaultRequestContext(),
			): Promise<GatewayWechatLogoutResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
			async wechatAddAccount(
				_request?: unknown,
				context = defaultRequestContext(),
			): Promise<GatewayWechatAddAccountResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
			async wechatStopAccount(
				_request: unknown,
				context = defaultRequestContext(),
			): Promise<GatewayWechatStopAccountResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
			async wechatRemoveAccount(
				_request: unknown,
				context = defaultRequestContext(),
			): Promise<GatewayWechatRemoveAccountResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
			async wechatRenameAccount(
				_request: unknown,
				context = defaultRequestContext(),
			): Promise<GatewayWechatRenameAccountResponse> {
				const settings = await getOwnerSettings(
					settingsByOwner,
					settingsStore,
					context,
				);
				return {
					success: false,
					error: SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					status: createServerGatewayStatus(
						settings,
						SERVER_GATEWAY_CONNECTIONS_DISABLED_ERROR,
					),
				};
			},
		},
		voice: {
			async getState(): Promise<VoiceGetStateResponse> {
				return { success: true, state: createServerVoiceState() };
			},
			async start(): Promise<{
				success: boolean;
				error: string;
				state: VoiceRuntimeState;
			}> {
				return {
					success: false,
					error: SERVER_VOICE_UNAVAILABLE_ERROR,
					state: createServerVoiceState(SERVER_VOICE_UNAVAILABLE_ERROR),
				};
			},
			async stop(): Promise<{ success: boolean }> {
				return { success: true };
			},
			async submitUtterance(): Promise<VoiceSubmitUtteranceResponse> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async submitTranscript(): Promise<VoiceSubmitUtteranceResponse> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async synthesize(): Promise<VoiceSynthesizeResponse> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async testASR(): Promise<VoiceSubmitUtteranceResponse> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async testTTS(): Promise<{ success: boolean; error: string }> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async getTTSModels(): Promise<VoiceTTSModelsResponse> {
				return { success: true, models: [], fetchedAt: Date.now() };
			},
			async runtimeReady(): Promise<{ success: boolean; error: string }> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
			async runtimeEvent(): Promise<{ success: boolean; error: string }> {
				return { success: false, error: SERVER_VOICE_UNAVAILABLE_ERROR };
			},
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
		},
		acp: {
			getAgents(
				context = defaultRequestContext(),
			): Promise<ACPGetAgentsResponse> {
				return getOnethingACPAgentsForIpc(
					acpAdaptersForContext(context),
				) as Promise<ACPGetAgentsResponse>;
			},
			addAgent(
				config: unknown,
				context = defaultRequestContext(),
			): Promise<ACPAddAgentResponse> {
				return addOnethingACPAgentForIpc({
					...acpAdaptersForContext(context),
					config: config as ACPAgentConfig,
				}) as Promise<ACPAddAgentResponse>;
			},
			updateAgent(
				config: unknown,
				context = defaultRequestContext(),
			): Promise<ACPUpdateAgentResponse> {
				return updateOnethingACPAgentForIpc({
					...acpAdaptersForContext(context),
					config: config as ACPAgentConfig,
				}) as Promise<ACPUpdateAgentResponse>;
			},
			removeAgent(
				agentId: string,
				context = defaultRequestContext(),
			): Promise<ACPRemoveAgentResponse> {
				return removeOnethingACPAgentForIpc({
					...acpAdaptersForContext(context),
					agentId,
				}) as Promise<ACPRemoveAgentResponse>;
			},
			connectAgent(
				agentId: string,
				context = defaultRequestContext(),
			): Promise<ACPConnectAgentResponse> {
				return connectOnethingACPAgentForIpc({
					getSettings: () => getACPSettingsForContext(context),
					manager: new ServerSafeACPManager(),
					agentId,
					logger: console,
				}) as Promise<ACPConnectAgentResponse>;
			},
			disconnectAgent(agentId: string): Promise<ACPDisconnectAgentResponse> {
				return disconnectOnethingACPAgentForIpc({
					agentId,
					disconnectAgent: async () => {},
					logger: console,
				});
			},
			refreshAgent(
				agentId: string,
				context = defaultRequestContext(),
			): Promise<ACPRefreshAgentResponse> {
				return refreshOnethingACPAgentForIpc({
					getSettings: () => getACPSettingsForContext(context),
					manager: new ServerSafeACPManager(),
					agentId,
					logger: console,
				}) as Promise<ACPRefreshAgentResponse>;
			},
			cancelSession(
				sessionId: string,
				agentId?: string,
			): Promise<ACPCancelSessionResponse> {
				return cancelOnethingACPSessionForIpc({
					sessionId,
					agentId,
					cancelSession: async () => {},
					logger: console,
				});
			},
		},
		tools: {
			async getTools(): Promise<GetToolsResponse> {
				return {
					success: true,
					tools:
						(await readOnlyToolRegistry.getAllToolsAsync()) as ToolDefinition[],
				};
			},
			async executeTool(
				toolId,
				args,
				messageId,
				sessionId,
				context = defaultRequestContext(),
			): Promise<ExecuteToolResponse> {
				if (!serverReadOnlyToolIds.has(toolId)) {
					return {
						success: false,
						error: `Tool execution for "${toolId}" is disabled in the web server runtime.`,
					};
				}

				const session = getSessionForContext(sessionId, context);
				if (!session) {
					return { success: false, error: "Session not found" };
				}

				const access = validateServerReadOnlyToolAccess(
					toolId,
					args,
					session,
					workspaceRoot,
				);
				if (!access.success) return access;

				const result = (await readOnlyToolRegistry.executeTool(toolId, args, {
					sessionId,
					messageId,
					workingDirectory: session.workingDirectory,
					workingDirectoryRoots: session.workingDirectoryRoots,
				})) as OnethingToolExecutionResult;

				return {
					success: result.success,
					result: result.data as ExecuteToolResponse["result"],
					error: result.error,
				};
			},
			async cancelTool() {
				return { success: true };
			},
			async updateToolCall(
				_sessionId: string,
				_messageId: string,
				_toolCallId: string,
				_updates: Partial<ToolCall>,
			) {
				return {
					success: false,
					error:
						"Tool call updates are not available in the web server runtime yet.",
				};
			},
			async listBackgroundJobs() {
				return { success: true, jobs: [] };
			},
			async stopBackgroundJob() {
				return {
					success: false,
					error: "Background jobs are not available in the web server runtime.",
				};
			},
		},
		mcp: {
			async getServers(
				context = defaultRequestContext(),
			): Promise<MCPGetServersResponse> {
				const settings = await getMCPSettingsForContext(context);
				const states = projectMCPServerStates(
					settings,
					getOwnerMCPManager(mcpManagersByOwner, mcpClientFactory, context),
				);
				return getOnethingMCPServersForIpc({
					getServerStates: () => sanitizeMCPServerStatesForClient(states),
					logger: console,
				}) as Promise<MCPGetServersResponse>;
			},
			async addServer(
				config: MCPServerConfig,
				context = defaultRequestContext(),
			): Promise<MCPAddServerResponse> {
				const result = (await addOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					config,
				})) as MCPAddServerResponse;
				return sanitizeMCPMutationResultForClient(
					result,
				) as MCPAddServerResponse;
			},
			async updateServer(
				config: MCPServerConfig,
				context = defaultRequestContext(),
			): Promise<MCPUpdateServerResponse> {
				const preparedConfig = await prepareMCPServerConfigForUpdate(
					config,
					getMCPSettingsForContext,
					context,
				);
				const result = (await updateOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					config: preparedConfig,
				})) as MCPUpdateServerResponse;
				return sanitizeMCPMutationResultForClient(
					result,
				) as MCPUpdateServerResponse;
			},
			async removeServer(
				serverId: string,
				context = defaultRequestContext(),
			): Promise<MCPRemoveServerResponse> {
				return removeOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					serverId,
				}) as Promise<MCPRemoveServerResponse>;
			},
			async connectServer(
				serverId: string,
				context = defaultRequestContext(),
			): Promise<MCPConnectServerResponse> {
				const result = (await connectOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					serverId,
				})) as MCPConnectServerResponse;
				return sanitizeMCPMutationResultForClient(
					result,
				) as MCPConnectServerResponse;
			},
			async disconnectServer(
				serverId: string,
				context = defaultRequestContext(),
			): Promise<MCPDisconnectServerResponse> {
				return disconnectOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					serverId,
				}) as Promise<MCPDisconnectServerResponse>;
			},
			async logoutServer(
				serverId: string,
				context = defaultRequestContext(),
			): Promise<MCPLogoutServerResponse> {
				return logoutOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					serverId,
				}) as Promise<MCPLogoutServerResponse>;
			},
			async probeServer(
				config: MCPServerConfig,
				_context = defaultRequestContext(),
			): Promise<MCPProbeServerResponse> {
				return probeOnethingMCPServerForIpc({
					config,
					probe: candidate => probeServerMCPConfig(candidate, { allowStdio: allowMCPStdio }),
					logger: console,
				}) as Promise<MCPProbeServerResponse>;
			},
			async refreshServer(
				serverId: string,
				context = defaultRequestContext(),
			): Promise<MCPRefreshServerResponse> {
				const result = (await refreshOnethingMCPServerForIpc({
					...mcpAdaptersForContext(context),
					serverId,
				})) as MCPRefreshServerResponse;
				return sanitizeMCPMutationResultForClient(
					result,
				) as MCPRefreshServerResponse;
			},
			async getTools(
				context = defaultRequestContext(),
			): Promise<MCPGetToolsResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return listOnethingMCPToolsForIpc({
					getAllTools: () => manager.getAllTools(),
					logger: console,
				}) as Promise<MCPGetToolsResponse>;
			},
			async callTool(
				serverId,
				toolName,
				args,
				context = defaultRequestContext(),
			): Promise<MCPCallToolResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return callOnethingMCPToolForIpc({
					serverId,
					toolName,
					args,
					callTool: (targetServerId, targetToolName, targetArgs) =>
						manager.callTool(
							targetServerId,
							targetToolName,
							targetArgs as JsonObject,
						),
					logger: console,
				}) as Promise<MCPCallToolResponse>;
			},
			async getResources(
				context = defaultRequestContext(),
			): Promise<MCPGetResourcesResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return listOnethingMCPResourcesForIpc({
					getAllResources: () => manager.getAllResources(),
					logger: console,
				}) as Promise<MCPGetResourcesResponse>;
			},
			async readResource(
				serverId,
				uri,
				context = defaultRequestContext(),
			): Promise<MCPReadResourceResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return readOnethingMCPResourceForIpc({
					serverId,
					uri,
					readResource: (targetServerId, targetUri) =>
						manager.readResource(targetServerId, targetUri),
					logger: console,
				}) as Promise<MCPReadResourceResponse>;
			},
			async getPrompts(
				context = defaultRequestContext(),
			): Promise<MCPGetPromptsResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return listOnethingMCPPromptsForIpc({
					getAllPrompts: () => manager.getAllPrompts(),
					logger: console,
				}) as Promise<MCPGetPromptsResponse>;
			},
			async getPrompt(
				serverId,
				name,
				args,
				context = defaultRequestContext(),
			): Promise<MCPGetPromptResponse> {
				const manager = getOwnerMCPManager(
					mcpManagersByOwner,
					mcpClientFactory,
					context,
				);
				return getOnethingMCPPromptForIpc({
					serverId,
					name,
					args,
					getPrompt: (targetServerId, targetName, targetArgs) =>
						manager.getPrompt(targetServerId, targetName, targetArgs),
					logger: console,
				}) as Promise<MCPGetPromptResponse>;
			},
			async readConfigFile(): Promise<MCPReadConfigFileResponse> {
				return readOnethingMCPConfigFileForIpc({
					filePath: "",
					fileExists: () => false,
					readTextFile: () => "",
					logger: console,
				}) as Promise<MCPReadConfigFileResponse>;
			},
		},
		async shutdown() {
			// 必须等 flush 完成:jsonl 会话是多文件写,fire-and-forget 会与
			// 调用方随后的目录清理(如测试 teardown 的 rm)竞态
			try {
				await sessionStore.flushAll();
			} catch (error) {
				console.error("[ServerRuntime] Failed to flush local sessions:", error);
			}
			await backend.shutdown();
			for (const manager of mcpManagersByOwner.values()) {
				manager.shutdown().catch(() => {});
			}
			mcpManagersByOwner.clear();
			// Release the injected client factory: it closes over this runtime's
			// config, and the app singleton outlives us (module scope).
			if (backend.persistsMessages) configureMCPClientHost(null);
			for (const service of authServicesByOwner.values()) {
				service.cleanup();
			}
			authServicesByOwner.clear();
			for (const schedulerRuntime of schedulerRuntimesByOwner.values()) {
				schedulerRuntime.scheduler.dispose();
			}
			schedulerRuntimesByOwner.clear();
			for (const variableRuntime of variableRuntimesByOwner.values()) {
				variableRuntime.unsubscribe();
				variableRuntime.registry.reset();
			}
			variableRuntimesByOwner.clear();
			for (const watchers of workspaceWatchersByOwner.values()) {
				for (const watcher of watchers.values()) watcher.close();
			}
			workspaceWatchersByOwner.clear();
			workspaceFileChangedHandlersByOwner.clear();
			todoPlanChangedHandlers.clear();
			stopScratchpadWatcher();
			scratchpadChangedHandlers.clear();
			mediaImageGeneratedHandlersByOwner.clear();
			agentStoresByOwner.clear();
			promptStoresByOwner.clear();
			pluginCatalogManagersByOwner.clear();
		},
	});

	return {
		runtime,
		eventBus,
		streamChannel,
		shutdown() {
			return runtime.shutdown().catch(() => {});
		},
	};
}

function applySessionEvent(
	session: ServerChatSession,
	event: AgentEngineSessionEvent,
): void {
	const variablesEvent = readSessionVariablesUpdatedEvent(event);
	if (variablesEvent) {
		if (variablesEvent.workingDirectory)
			session.workingDirectory = variablesEvent.workingDirectory;
		if (variablesEvent.workingDirectoryRoots)
			session.workingDirectoryRoots = variablesEvent.workingDirectoryRoots;
		session.variables = variablesEvent.variables;
		refreshSessionMeta(session);
		return;
	}

	if ((event as { type?: string }).type === "messages:replaced") {
		const replaced = event as unknown as { messages: ChatMessage[] };
		session.messages = replaced.messages.map((message) => ({ ...message }));
		refreshSessionMeta(session);
		return;
	}

	switch (event.type) {
		case "message:user-created":
		case "message:assistant-created":
			upsertMessage(session, toChatMessage(session.id, event.message));
			break;
		case "message:updated":
			updateMessage(
				session,
				event.messageId,
				event.updates as Partial<ChatMessage>,
			);
			break;
		case "stream:start":
			updateMessage(session, event.messageId || event.assistantMessageId, {
				isStreaming: true,
				model: event.model,
				provider: "local",
			});
			break;
		case "stream:complete":
			markStreamingComplete(session);
			applyServerSessionUsage(session, event.data.usage);
			break;
		case "stream:error":
			markStreamingComplete(session);
			session.messages.push({
				id: `error-${Date.now()}`,
				role: "error",
				content: event.data.error,
				errorDetails: event.data.errorDetails,
				timestamp: Date.now(),
			});
			break;
	}
	refreshSessionMeta(session);
}

function getServerSessionTokenUsage(session: ServerChatSession): {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	maxTokens: number;
	lastInputTokens: number;
	contextSize: number;
} {
	return {
		totalInputTokens: session.totalInputTokens ?? 0,
		totalOutputTokens: session.totalOutputTokens ?? 0,
		totalTokens: session.totalTokens ?? 0,
		maxTokens: session.maxTokens ?? DEFAULT_SESSION_MAX_TOKENS,
		lastInputTokens: session.lastInputTokens ?? 0,
		contextSize: session.contextSize ?? 0,
	};
}

async function testServerProxy(
	proxy: ProxySettings,
): Promise<TestProxyResponse> {
	if (!proxy.enabled) {
		return { success: false, error: "Proxy is disabled." };
	}

	const validated = validateOnethingAppProxyUrl(proxy.url);
	if (!validated.valid) {
		return { success: false, error: validated.error };
	}

	try {
		const fetchImpl = createRequiredOnethingAppFetch({
			policy: "default",
			proxy: {
				...proxy,
				url: validated.normalizedUrl,
			},
		});
		const response = await fetchImpl("https://www.gstatic.com/generate_204", {
			method: "GET",
			signal: AbortSignal.timeout(10000),
		});
		return response.ok || response.status === 204
			? { success: true, status: response.status }
			: {
					success: false,
					status: response.status,
					error: `Proxy test returned HTTP ${response.status}.`,
				};
	} catch (error: any) {
		return { success: false, error: error.message || "Proxy test failed." };
	}
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

function normalizeServerSystemMessage(
	sessionId: string,
	value: unknown,
): ChatMessage {
	const message =
		value && typeof value === "object" ? (value as Partial<ChatMessage>) : {};
	const content = typeof message.content === "string" ? message.content : "";
	const timestamp =
		typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
			? message.timestamp
			: Date.now();

	return {
		id:
			typeof message.id === "string" && message.id.length > 0
				? message.id
				: `system-${Date.now()}`,
		sessionId,
		role: "system",
		content,
		timestamp,
		contentParts: content ? [{ type: "text", content }] : [],
	};
}

function cloneBranchMessage(
	message: ChatMessage,
	sessionId: string,
): ChatMessage {
	const cloned = cloneJson(message);
	cloned.id = randomUUID();
	cloned.sessionId = sessionId;
	cloned.isStreaming = false;
	delete cloned.seq;
	delete cloned.thinkingStartTime;
	return cloned;
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
		isStreaming: message.role === "assistant" && message.content.length === 0,
		contentParts: message.content
			? [{ type: "text", content: message.content }]
			: [],
	};
}

function upsertMessage(session: ServerChatSession, message: ChatMessage): void {
	const index = session.messages.findIndex((item) => item.id === message.id);
	if (index >= 0) {
		session.messages[index] = { ...session.messages[index], ...message };
	} else {
		session.messages.push(message);
	}
}

function updateMessage(
	session: ServerChatSession,
	messageId: string,
	updates: Partial<ChatMessage>,
): void {
	const message = session.messages.find((item) => item.id === messageId);
	if (!message) return;
	Object.assign(message, updates);
	if (typeof updates.content === "string") {
		message.contentParts = [{ type: "text", content: updates.content }];
	}
}

function markStreamingComplete(session: ServerChatSession): void {
	const lastAssistant = [...session.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (lastAssistant) lastAssistant.isStreaming = false;
}

function refreshSessionMeta(
	session: ServerChatSession,
	options: { preserveUpdatedAt?: boolean } = {},
): void {
	if (!options.preserveUpdatedAt) session.updatedAt = Date.now();
	session.messageCount = session.messages.length;
	session.previewText =
		session.messages
			.find((message) => message.role === "user")
			?.content.slice(0, 160) ?? "";
	if (session.name === "New Chat" && session.previewText) {
		session.name = session.previewText.slice(0, 40);
	}
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
		workspaceId: _workspaceId,
		...meta
	} = session;
	return {
		...meta,
		messageCount: session.messages.length,
		previewText: session.previewText,
	};
}

function toChatSession(session: ServerChatSession): ChatSession {
	const {
		userId: _userId,
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
	messages: ChatMessage[],
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

function getUserMarkers(messages: ChatMessage[]): UserMessageMarker[] {
	return messages
		.map((message, index) => ({ message, seq: index + 1 }))
		.filter(({ message }) => message.role === "user")
		.map(({ message, seq }) => ({
			id: message.id,
			seq,
			timestamp: message.timestamp,
			preview: message.content.slice(0, 120),
		}));
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
	if (!session.userId && !session.workspaceId) return true;
	return (
		session.userId === context.userId &&
		session.workspaceId === context.workspaceId
	);
}

/**
 * index.json 里的会话元数据(服务端视角):在共享的 SessionMeta 之上,
 * 由 saveSessionImmediately 盖章所有权字段,使会话列表可以只读 index、
 * 不加载消息体就完成 owner 过滤。ownerVersion 缺失表示存量条目尚未回填。
 */
type ServerSessionIndexMeta = SessionMeta & {
	userId?: string;
	workspaceId?: string;
	ownerVersion?: number;
	workingDirectory?: string;
};

const SESSION_INDEX_OWNER_VERSION = 1;

/** 会话工作区推导所需的最小字段集,ServerChatSession 与 index 元数据均满足。 */
interface SessionWorkspaceRef {
	id: string;
	userId?: string;
	workspaceId?: string;
	workingDirectory?: string;
}

function ownsSessionMeta(
	meta: ServerSessionIndexMeta,
	context = defaultRequestContext(),
): boolean {
	if (!meta.userId && !meta.workspaceId) return true;
	return (
		meta.userId === context.userId && meta.workspaceId === context.workspaceId
	);
}

function stripSessionOwnerFields(meta: ServerSessionIndexMeta): SessionMeta {
	const {
		userId: _userId,
		workspaceId: _workspaceId,
		ownerVersion: _ownerVersion,
		...rest
	} = meta;
	return rest;
}

function createServerReadOnlyToolRegistry(): OnethingToolRegistry {
	const registry = new OnethingToolRegistry({ logger: console });
	registry.registerTool(
		createReadTool({
			getDefaultReadRoots: () => [],
		}),
	);
	registry.registerTool(
		createGlobTool({
			files: listServerToolFiles,
		}),
	);
	registry.registerTool(
		createGrepTool({
			search: searchServerToolFiles,
		}),
	);
	return registry;
}

function validateServerReadOnlyToolAccess(
	toolId: string,
	args: JsonObject,
	session: ServerChatSession,
	workspaceRoot: string,
): { success: true } | ExecuteToolResponse {
	const pathValue =
		toolId === "read"
			? args.path
			: typeof args.path === "string"
				? args.path
				: ".";

	if (typeof pathValue !== "string") {
		return { success: true };
	}

	if (!resolveSessionToolPath(workspaceRoot, session, pathValue)) {
		return {
			success: false,
			error: `Tool "${toolId}" can only access paths inside the session workspace.`,
		};
	}

	return { success: true };
}

function resolveSessionToolPath(
	workspaceRoot: string,
	session: ServerChatSession,
	requestedPath: string,
): string | null {
	const sandboxRoot = workspaceSandboxRootForSession(workspaceRoot, session);
	const baseDirectory =
		session.workingDirectory &&
		isPathInside(resolve(session.workingDirectory), sandboxRoot)
			? session.workingDirectory
			: sandboxRoot;
	const candidate = resolve(
		isAbsolute(requestedPath)
			? requestedPath
			: join(baseDirectory, requestedPath),
	);
	return isPathInside(candidate, sandboxRoot) ? candidate : null;
}

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

async function searchServerToolFiles(options: {
	cwd: string;
	pattern: string;
	glob?: string[];
	maxCount?: number;
	ignoreCase?: boolean;
	literal?: boolean;
}): Promise<Array<{ path: string; lineNumber: number; lineText: string }>> {
	const matcher = createServerSearchMatcher(options.pattern, {
		ignoreCase: options.ignoreCase,
		literal: options.literal,
	});
	const targetPath = resolve(options.cwd);
	const targetStat = await stat(targetPath);
	const files: string[] = [];

	if (targetStat.isFile()) {
		const fileName = toPosixRelativePath(dirname(targetPath), targetPath);
		if (
			!options.glob?.length ||
			options.glob.some((pattern) => matchesServerGlob(fileName, pattern))
		) {
			files.push(targetPath);
		}
	} else if (targetStat.isDirectory()) {
		for await (const relativeFile of listServerToolFiles({
			cwd: targetPath,
			glob: options.glob,
		})) {
			files.push(resolve(targetPath, relativeFile));
		}
	} else {
		return [];
	}

	const results: Array<{ path: string; lineNumber: number; lineText: string }> =
		[];
	const limit = Math.max(1, Math.floor(options.maxCount ?? 100));

	for (const filePath of files) {
		const content = await readServerSearchableTextFile(filePath);
		if (content === null) continue;

		const lines = content
			.replace(/\r\n/g, "\n")
			.replace(/\r/g, "\n")
			.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			if (!matcher(lines[index] ?? "")) continue;
			results.push({
				path: filePath,
				lineNumber: index + 1,
				lineText: lines[index] ?? "",
			});
			if (results.length >= limit) return results;
		}
	}

	return results;
}

async function readServerSearchableTextFile(
	filePath: string,
): Promise<string | null> {
	try {
		const fileStat = await stat(filePath);
		if (!fileStat.isFile() || fileStat.size > serverSearchMaxFileBytes)
			return null;

		const buffer = await readFile(filePath);
		if (buffer.subarray(0, 8192).includes(0)) return null;
		return buffer.toString("utf8");
	} catch {
		return null;
	}
}

function createServerSearchMatcher(
	pattern: string,
	options: { ignoreCase?: boolean; literal?: boolean },
): (line: string) => boolean {
	if (options.literal) {
		const needle = options.ignoreCase ? pattern.toLowerCase() : pattern;
		return (line) =>
			(options.ignoreCase ? line.toLowerCase() : line).includes(needle);
	}

	const flags = options.ignoreCase ? "i" : "";
	const regex = new RegExp(pattern, flags);
	return (line) => regex.test(line);
}

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

async function saveOwnerSettings(
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	context: RuntimeRequestContext,
	settings: AppSettings,
): Promise<void> {
	const previousSettings = await getOwnerSettings(
		settingsByOwner,
		settingsStore,
		context,
	);
	const nextSettings = mergeServerSettingsUpdate(previousSettings, settings);
	settingsByOwner.set(ownerKey(context), cloneJson(nextSettings));
	await settingsStore.save(context, nextSettings);
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
 * ServerSessionStore backed by the @onething/app session repository — the same
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
	const normalizeAppSession = (
		session: ServerChatSession,
	): ServerChatSession => {
		session.messages = Array.isArray(session.messages) ? session.messages : [];
		if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
		session.messageCount = session.messages.length;
		session.previewText =
			session.previewText ??
			session.messages
				.find((message) => message.role === "user")
				?.content.slice(0, 160) ??
			"";
		return session;
	};
	const save = (session: ServerChatSession): void => {
		const normalized = normalizeAppSession(session);
		saveAppStoreSessionSnapshot(normalized, (meta) =>
			Object.assign(meta, toSessionMeta(normalized), {
				userId: normalized.userId,
				workspaceId: normalized.workspaceId,
				ownerVersion: SESSION_INDEX_OWNER_VERSION,
			}),
		);
	};
	const stampOwner = (
		session: ServerChatSession,
		context: RuntimeRequestContext,
	): ServerChatSession => {
		if (!isDefaultServerRequestContext(context)) {
			session.userId = context.userId;
			session.workspaceId = context.workspaceId;
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
		deleteSession: (sessionId) => deleteAppStoreSession(sessionId),
		flushSession: (sessionId) => flushAppStoreSessionSave(sessionId),
		flushAll: () => flushAllAppStorePendingSaves(),
		getMessagesPage: (request) =>
			getAppStoreSessionMessagesPage(
				request,
			) as GetSessionMessagesPageResponse,
		getUserMessageMarkers: (sessionId) =>
			getAppStoreSessionUserMessageMarkers(sessionId),
	};
}

export function createLocalServerSessionStore(
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
	const storageDriver = createHybridSessionStorageDriver<ServerChatSession>({
		getSessionsDir: () =>
			getOnethingSessionsDir({ storePath: resolvedStorePath }),
		getLegacySessionPath: getSessionFilePath,
		// 与 Electron 宿主一致走 jsonl;legacy 读路径仅作为兼容保险保留
		newSessionFormat: () => "jsonl",
		readJsonFile: readCoreJsonFile,
		writeJsonFileAsync: writeSessionJsonFileAsync,
		deleteJsonFile,
		logger: console,
	});
	const repository = createOnethingSessionRepository<
		ServerChatSession,
		ChatMessage,
		SessionMeta,
		SessionDetails,
		UserMessageMarker
	>({
		defaultAgentId: DEFAULT_ONETHING_AGENT_ID,
		getSessionsDir: () =>
			getOnethingSessionsDir({ storePath: resolvedStorePath }),
		getSessionPath: getSessionFilePath,
		readJsonFile: readCoreJsonFile,
		writeJsonFile: writeCoreJsonFile,
		writeJsonFileAsync: writeSessionJsonFileAsync,
		deleteJsonFile,
		storageDriver,
		getCurrentSessionId: () => getOnethingCurrentSessionId(appStatePath),
		setCurrentSessionId: (sessionId) => {
			setOnethingCurrentSessionId(appStatePath, sessionId);
		},
		getDefaultWorkingDirectory: () =>
			readLocalDefaultWorkingDirectory(resolvedStorePath),
		expandPath: expandOnethingToolSandboxPath,
		logger: console,
	});

	repository.initializeSessionRepositoryIndex();

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
				meta.userId = session?.userId;
				meta.workspaceId = session?.workspaceId;
				meta.ownerVersion = SESSION_INDEX_OWNER_VERSION;
			}
			repository.saveSessionsIndex(index);
			console.log(
				`[Sessions] index ownership backfilled for ${missing.length} sessions in ${Date.now() - start}ms`,
			);
		});
	};
	backfillSessionIndexOwnership();

	const saveSessionImmediately = (session: ServerChatSession): void => {
		const normalized = normalizeStoredServerSession(session);
		repository.saveSessionToFile(normalized.id, normalized);
		// 同步直写只适用于 legacy 文件;jsonl 会话走 300ms 队列(与 Electron 宿主一致),
		// 不在这里 fire-and-forget 地 flush——已启动的异步写会与 deleteSession 的目录删除竞态。
		// 关键时点的落盘由 facade 的 flushSession / 退出时 flushAll 保证。
		if (storageDriver.format(normalized.id) === "legacy-json") {
			writeCoreJsonFile(getSessionFilePath(normalized.id), normalized, {
				pretty: false,
			});
			repository.cancelPendingSave(normalized.id);
		}
		repository.updateSessionsIndexMeta(normalized.id, (meta) =>
			Object.assign(meta, toSessionMeta(normalized), {
				userId: normalized.userId,
				workspaceId: normalized.workspaceId,
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
			repository.getSessions().map(normalizeStoredServerSession),
		getSessionsList: () => repository.getSessionsList(),
		invalidateSession: (sessionId) => {
			repository.invalidateSessionCache(sessionId);
		},
		getSession: (sessionId) => {
			const session = repository.getSession(sessionId);
			return session ? normalizeStoredServerSession(session) : undefined;
		},
		createSession(sessionId, name, context) {
			const session = normalizeStoredServerSession(
				repository.createSession(sessionId, name),
			);
			session.userId = context.userId;
			session.workspaceId = context.workspaceId;
			refreshSessionMeta(session, { preserveUpdatedAt: true });
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
			const session = normalizeStoredServerSession(
				repository.createBranchSession(
					sessionId,
					name,
					parentSessionId,
					branchFromMessageId,
					inheritedMessages,
				),
			);
			session.userId = context.userId;
			session.workspaceId = context.workspaceId;
			refreshSessionMeta(session, { preserveUpdatedAt: true });
			saveSessionImmediately(session);
			return session;
		},
		saveSession(session) {
			saveSessionImmediately(session);
		},
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

function normalizeStoredServerSession(
	session: ServerChatSession,
): ServerChatSession {
	session.messages = Array.isArray(session.messages) ? session.messages : [];
	if (!session.agentId) session.agentId = DEFAULT_ONETHING_AGENT_ID;
	if (!session.lastProvider) session.lastProvider = "local";
	if (!session.lastModel) session.lastModel = "local-echo";
	session.messageCount = session.messages.length;
	session.previewText =
		session.previewText ??
		session.messages
			.find((message) => message.role === "user")
			?.content.slice(0, 160) ??
		"";
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


function ensureServerSkillsDirectories(
	dataRoot: string,
	context = defaultRequestContext(),
): void {
	mkdirSync(serverUserSkillsRoot(dataRoot, context), { recursive: true });
}

async function listServerSkillsForContext(
	dataRoot: string,
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	options: { workingDirectory?: string; enabledOnly?: boolean } = {},
): Promise<SkillDefinition[]> {
	ensureServerSkillsDirectories(dataRoot, context);
	const userSkills = readServerSkillsFromRoot(
		serverUserSkillsRoot(dataRoot, context),
		"user",
	);
	const projectBase = options.workingDirectory
		? resolveServerWorkspaceGrantRoot(
				serverWorkspaceRoot,
				context,
				options.workingDirectory,
			)
		: workspaceSandboxRoot(serverWorkspaceRoot, context);
	const projectSkills = projectBase
		? readServerSkillsFromRoot(
				join(projectBase, ".onething", "skills"),
				"project",
			)
		: [];
	const settings = await getOwnerSettings(
		settingsByOwner,
		settingsStore,
		context,
	);
	return applyServerSkillSettings(
		mergeServerSkillsByName(projectSkills, userSkills),
		settings.skills,
		options.enabledOnly ?? false,
	);
}

function readServerSkillFile(
	dataRoot: string,
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	skillId: string,
	fileName: string,
): Promise<string | null> {
	return listServerSkillsForContext(
		dataRoot,
		serverWorkspaceRoot,
		context,
		settingsByOwner,
		settingsStore,
		{
			enabledOnly: false,
		},
	).then((skills) => {
		const skill = skills.find((candidate) => candidate.id === skillId);
		if (!skill) return null;
		const skillRoot = resolve(skill.directoryPath);
		const filePath = resolve(skillRoot, fileName);
		if (!isPathInside(filePath, skillRoot)) return null;
		try {
			return readFileSync(filePath, "utf8");
		} catch {
			return null;
		}
	});
}

function createServerSkill(
	dataRoot: string,
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	name: string,
	description: string,
	instructions: string,
	source: SkillSource,
): SkillDefinition {
	const trimmedName = name.trim();
	const trimmedDescription = description.trim();
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmedName)) {
		throw new Error(
			"Skill name must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, and hyphens",
		);
	}
	if (trimmedName.length > 64)
		throw new Error("Skill name must be 64 characters or less");
	if (trimmedDescription.length > 1024)
		throw new Error("Skill description must be 1024 characters or less");
	if (source !== "user" && source !== "project") {
		throw new Error("Skills can only be created in user or project roots");
	}

	const root =
		source === "project"
			? join(
					workspaceSandboxRoot(serverWorkspaceRoot, context),
					".onething",
					"skills",
				)
			: serverUserSkillsRoot(dataRoot, context);
	const skillDir = resolve(root, trimmedName);
	if (!isPathInside(skillDir, resolve(root))) {
		throw new Error("Skill path must stay inside the owner skills root");
	}
	if (existsSync(skillDir))
		throw new Error(`Skill "${trimmedName}" already exists`);

	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		[
			"---",
			`name: ${JSON.stringify(trimmedName)}`,
			`description: ${JSON.stringify(trimmedDescription)}`,
			"---",
			"",
			instructions,
			"",
		].join("\n"),
		"utf8",
	);

	const skill = readServerSkillFromDirectory(skillDir, source, root);
	if (!skill) throw new Error(`Failed to load created skill "${trimmedName}"`);
	return skill;
}

async function deleteServerSkill(
	dataRoot: string,
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	skillId: string,
): Promise<boolean> {
	const skills = await listServerSkillsForContext(
		dataRoot,
		serverWorkspaceRoot,
		context,
		settingsByOwner,
		settingsStore,
		{
			enabledOnly: false,
		},
	);
	const skill = skills.find((candidate) => candidate.id === skillId);
	if (!skill || (skill.source !== "user" && skill.source !== "project"))
		return false;
	const allowedRoot =
		skill.source === "project"
			? join(
					workspaceSandboxRoot(serverWorkspaceRoot, context),
					".onething",
					"skills",
				)
			: serverUserSkillsRoot(dataRoot, context);
	const skillDir = resolve(skill.directoryPath);
	if (!isPathInside(skillDir, resolve(allowedRoot))) return false;
	try {
		rmSync(skillDir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

function serverUserSkillsRoot(
	dataRoot: string,
	context = defaultRequestContext(),
): string {
	return join(
		dataRoot,
		"owners",
		safePathSegment(context.userId),
		safePathSegment(context.workspaceId),
		"skills",
	);
}

function readServerSkillsFromRoot(
	root: string,
	source: SkillSource,
): SkillDefinition[] {
	if (!existsSync(root)) return [];
	const resolvedRoot = resolve(root);
	const skills: SkillDefinition[] = [];
	for (const entry of safeReadDir(resolvedRoot)) {
		const skillDir = join(resolvedRoot, entry);
		if (!safeIsDirectory(skillDir)) continue;
		const skill = readServerSkillFromDirectory(skillDir, source, resolvedRoot);
		if (skill) skills.push(skill);
	}
	return skills;
}

function readServerSkillFromDirectory(
	skillDir: string,
	source: SkillSource,
	root: string,
): SkillDefinition | null {
	const resolvedRoot = resolve(root);
	const resolvedDir = resolve(skillDir);
	if (!isPathInside(resolvedDir, resolvedRoot)) return null;
	const skillFile = join(resolvedDir, "SKILL.md");
	if (!existsSync(skillFile)) return null;
	const parsed = parseServerSkillMarkdown(readFileSync(skillFile, "utf8"));
	if (!parsed?.name || !parsed.description) return null;
	const relativeDirectory = toPosixPath(relative(resolvedRoot, resolvedDir));
	return {
		id: `${source}:${relativeDirectory || parsed.name}`,
		name: parsed.name,
		description: parsed.description.slice(0, 1024),
		tags: parsed.tags,
		platforms: parsed.platforms,
		source,
		path: skillFile,
		directoryPath: resolvedDir,
		rootPath: resolvedRoot,
		relativePath: toPosixPath(relative(resolvedRoot, skillFile)),
		enabled: true,
		instructions: parsed.instructions,
		files: scanServerSkillFiles(resolvedDir),
	};
}

function parseServerSkillMarkdown(content: string): {
	name: string;
	description: string;
	instructions: string;
	tags?: string[];
	platforms?: string[];
} | null {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!match) return null;
	const frontmatter = parseYaml(match[1]) as Record<string, unknown> | null;
	if (!frontmatter || typeof frontmatter !== "object") return null;
	const name =
		typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description =
		typeof frontmatter.description === "string"
			? frontmatter.description.trim()
			: "";
	if (!name || !description) return null;
	return {
		name,
		description,
		instructions: (match[2] ?? "").trim(),
		tags: normalizeServerSkillStringList(frontmatter.tags),
		platforms: normalizeServerSkillStringList(frontmatter.platforms),
	};
}

function normalizeServerSkillStringList(value: unknown): string[] | undefined {
	const values = Array.isArray(value)
		? value
		: typeof value === "string"
			? value.split(",")
			: [];
	const normalized = values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
	return normalized.length ? Array.from(new Set(normalized)) : undefined;
}

function scanServerSkillFiles(skillDir: string): SkillDefinition["files"] {
	const files: NonNullable<SkillDefinition["files"]> = [];
	for (const entry of safeReadDir(skillDir)) {
		if (entry === "SKILL.md") continue;
		const filePath = join(skillDir, entry);
		if (!safeIsFile(filePath)) continue;
		files.push({
			name: entry,
			path: filePath,
			type: entry.endsWith(".md") ? "markdown" : "other",
		});
	}
	return files.length ? files : undefined;
}

function safeReadDir(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

function safeIsDirectory(filePath: string): boolean {
	try {
		return statSync(filePath).isDirectory();
	} catch {
		return false;
	}
}

function safeIsFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function mergeServerSkillsByName(
	...groups: SkillDefinition[][]
): SkillDefinition[] {
	const names = new Set<string>();
	const merged: SkillDefinition[] = [];
	for (const group of groups) {
		for (const skill of group) {
			if (names.has(skill.name)) continue;
			names.add(skill.name);
			merged.push(skill);
		}
	}
	return merged;
}

function applyServerSkillSettings(
	skills: SkillDefinition[],
	settings: SkillSettings | undefined,
	enabledOnly: boolean,
): SkillDefinition[] {
	const withSettings = skills.map((skill) => ({
		...skill,
		enabled: settings?.skills?.[skill.id]?.enabled ?? skill.enabled,
	}));
	const result = enabledOnly
		? withSettings.filter((skill) => skill.enabled)
		: withSettings;
	return result.sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
	);
}

function getOwnerMCPManager(
	managersByOwner: Map<string, ServerMCPManager>,
	createClient: ServerMCPClientFactory,
	context = defaultRequestContext(),
): ServerMCPManager {
	const key = ownerKey(context);
	let manager = managersByOwner.get(key);
	if (!manager) {
		manager = new HeadlessMCPManager(createClient);
		managersByOwner.set(key, manager);
	}
	return manager;
}

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

function projectMCPServerStates(
	settings: MCPSettings,
	manager: ServerMCPManager,
): MCPServerState[] {
	return settings.servers.map(
		(config) =>
			manager.getServerState(config.id) ??
			createMCPServerState(config, "disconnected"),
	);
}

// createMCPServerState now comes from @onething/core/mcp — a local copy with a
// different arity shadowed the core export and read as if core's took one arg.

async function prepareMCPServerConfigForUpdate(
	config: MCPServerConfig,
	getSettings: (context?: RuntimeRequestContext) => Promise<MCPSettings>,
	context = defaultRequestContext(),
): Promise<MCPServerConfig> {
	const settings = await getSettings(context);
	const previous = settings.servers.find((server) => server.id === config.id);
	if (!previous) return config;

	const prepared = cloneJson(config) as unknown as Record<string, unknown>;
	const previousRecord = previous as unknown as Record<string, unknown>;
	const incomingRecord = config as unknown as Record<string, unknown>;

	for (const key of mcpServerPrivateKeys) {
		const previousValue = previousRecord[key];
		if (!shouldRedactMcpPrivateValue(previousValue)) continue;
		const hasIncomingValue = Object.hasOwn(incomingRecord, key);
		const incomingValue = incomingRecord[key];
		if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
			prepared[key] = cloneJson(previousValue);
		}
	}

	return prepared as unknown as MCPServerConfig;
}

function sanitizeMCPServerStatesForClient(
	states: MCPServerState[],
): MCPServerState[] {
	return states.map((state) => sanitizeMCPServerStateForClient(state));
}

function sanitizeMCPServerStateForClient(
	state: MCPServerState,
): MCPServerState {
	return {
		...state,
		config: sanitizeMCPServerConfigForClient(state.config),
	};
}

function sanitizeMCPMutationResultForClient<
	T extends { server?: MCPServerState },
>(result: T): T {
	if (!result.server) return result;
	return {
		...result,
		server: sanitizeMCPServerStateForClient(result.server),
	};
}

function sanitizeMCPServerConfigForClient(
	config: MCPServerConfig,
): MCPServerConfig {
	const redacted = cloneJson(config) as unknown as Record<string, unknown>;
	for (const key of mcpServerPrivateKeys) {
		if (shouldRedactMcpPrivateValue(redacted[key])) {
			redacted[key] = SERVER_REDACTED_SECRET;
		}
	}
	return redacted as unknown as MCPServerConfig;
}

export function mergeServerSettingsUpdate(
	previousSettings: AppSettings | undefined,
	incomingSettings: unknown,
): AppSettings {
	const incoming = isRecord(incomingSettings)
		? (incomingSettings as Partial<AppSettings>)
		: {};
	const nextSettings = mergeWithDefaults(incoming);
	if (previousSettings) {
		preserveSensitiveSettings(nextSettings, previousSettings, incoming);
		preserveMcpServerPrivateSettings(nextSettings, previousSettings, incoming);
	}
	return nextSettings;
}

export function sanitizeSettingsForClient(settings: AppSettings): AppSettings {
	const sanitized = cloneJson(settings);
	redactSensitiveSettings(sanitized);
	redactMcpServerPrivateSettings(sanitized);
	return sanitized;
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactSensitiveValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function shouldRedactMcpPrivateValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.length > 0;
	if (isRecord(value)) return Object.keys(value).length > 0;
	return shouldRedactSensitiveValue(value);
}

function redactSensitiveSettings(value: unknown): void {
	if (!value || typeof value !== "object") return;

	if (Array.isArray(value)) {
		for (const item of value) redactSensitiveSettings(item);
		return;
	}

	const record = value as Record<string, unknown>;
	for (const [key, child] of Object.entries(record)) {
		if (sensitiveSettingKeys.has(key) && shouldRedactSensitiveValue(child)) {
			record[key] = SERVER_REDACTED_SECRET;
		} else {
			redactSensitiveSettings(child);
		}
	}
}

function preserveSensitiveSettings(
	target: unknown,
	previous: unknown,
	incoming: unknown,
): void {
	if (
		!target ||
		!previous ||
		typeof target !== "object" ||
		typeof previous !== "object"
	)
		return;

	if (Array.isArray(target) && Array.isArray(previous)) {
		const incomingArray = Array.isArray(incoming) ? incoming : [];
		for (let index = 0; index < target.length; index += 1) {
			preserveSensitiveSettings(
				target[index],
				previous[index],
				incomingArray[index],
			);
		}
		return;
	}

	if (Array.isArray(target) || Array.isArray(previous)) return;

	const targetRecord = target as Record<string, unknown>;
	const previousRecord = previous as Record<string, unknown>;
	const incomingRecord = isRecord(incoming) ? incoming : {};

	for (const [key, previousValue] of Object.entries(previousRecord)) {
		if (sensitiveSettingKeys.has(key)) {
			if (!shouldRedactSensitiveValue(previousValue)) continue;
			const hasIncomingValue = Object.hasOwn(incomingRecord, key);
			const incomingValue = incomingRecord[key];
			if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
				targetRecord[key] = cloneJson(previousValue);
			}
			continue;
		}

		preserveSensitiveSettings(
			targetRecord[key],
			previousValue,
			incomingRecord[key],
		);
	}
}

function redactMcpServerPrivateSettings(settings: AppSettings): void {
	const servers = settings.mcp?.servers;
	if (!Array.isArray(servers)) return;

	for (const server of servers) {
		if (!isRecord(server)) continue;
		for (const key of mcpServerPrivateKeys) {
			if (shouldRedactMcpPrivateValue(server[key])) {
				server[key] = SERVER_REDACTED_SECRET;
			}
		}
	}
}

function preserveMcpServerPrivateSettings(
	target: AppSettings,
	previous: AppSettings,
	incoming: unknown,
): void {
	if (!previous.mcp) return;
	if (!isRecord(incoming) || !Object.hasOwn(incoming, "mcp")) {
		target.mcp = cloneJson(previous.mcp);
		return;
	}

	const targetServers = Array.isArray(target.mcp?.servers)
		? target.mcp.servers
		: [];
	const previousServers = Array.isArray(previous.mcp?.servers)
		? previous.mcp.servers
		: [];
	const incomingServers =
		isRecord(incoming.mcp) && Array.isArray(incoming.mcp.servers)
			? incoming.mcp.servers
			: [];
	const targetById = mcpServersById(targetServers);
	const incomingById = mcpServersById(incomingServers);

	for (const previousServer of previousServers) {
		if (!isRecord(previousServer) || typeof previousServer.id !== "string")
			continue;
		const targetServer = targetById.get(previousServer.id);
		if (!targetServer) continue;
		const incomingServer = incomingById.get(previousServer.id);

		for (const key of mcpServerPrivateKeys) {
			const previousValue = previousServer[key];
			if (!shouldRedactMcpPrivateValue(previousValue)) continue;
			const hasIncomingValue = Boolean(
				incomingServer && Object.hasOwn(incomingServer, key),
			);
			const incomingValue = incomingServer?.[key];
			if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
				targetServer[key] = cloneJson(previousValue);
			}
		}
	}
}

function mcpServersById(
	servers: unknown[],
): Map<string, Record<string, unknown>> {
	const byId = new Map<string, Record<string, unknown>>();
	for (const server of servers) {
		if (isRecord(server) && typeof server.id === "string") {
			byId.set(server.id, server);
		}
	}
	return byId;
}

type PermissionDecision = "once" | "session" | "workdir" | "reject";

interface NormalizedPermissionResponse {
	decision: PermissionDecision;
	channel: string;
	rejectReason?: string;
}

const permissionDecisions = new Set<PermissionDecision>([
	"once",
	"session",
	"workdir",
	"reject",
]);

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
		userId: session.userId,
		workspaceId: session.workspaceId,
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

function clearPendingPermissionsForSession(
	pendingPermissions: Map<string, PendingPermissionRecord>,
	sessionId: string,
): void {
	for (const [requestId, pending] of pendingPermissions) {
		if (pending.sessionId === sessionId) pendingPermissions.delete(requestId);
	}
}

function resolveServerWorkspaceGrantRoot(
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	requestedRoot: string,
): string | null {
	const sandboxRoot = workspaceSandboxRoot(serverWorkspaceRoot, context);
	const candidate = resolve(
		isAbsolute(requestedRoot)
			? requestedRoot
			: join(sandboxRoot, requestedRoot),
	);
	return isPathInside(candidate, sandboxRoot) ? candidate : null;
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

interface PreparedServerMarkdownRequest {
	success: true;
	request: {
		documentPath: string;
		workspaceRoot: string;
		rawTarget?: string;
		files?: MarkdownSaveAttachmentsRequest["files"];
	};
	adapters: OnethingMarkdownAssetServiceAdapters;
}

type PreparedServerMarkdownResult =
	| PreparedServerMarkdownRequest
	| {
			success: false;
			error: string;
	  };

async function prepareServerMarkdownRequest(
	serverWorkspaceRoot: string,
	settingsByOwner: Map<string, AppSettings>,
	settingsStore: ServerSettingsStore,
	context: RuntimeRequestContext,
	request: unknown,
): Promise<PreparedServerMarkdownResult> {
	const typedRequest =
		request && typeof request === "object"
			? (request as {
					documentPath?: unknown;
					workspaceRoot?: unknown;
					rawTarget?: unknown;
					files?: unknown;
				})
			: {};
	const documentPath =
		typeof typedRequest.documentPath === "string"
			? resolveServerWorkspaceFilePath(
					serverWorkspaceRoot,
					context,
					typedRequest.documentPath,
				)
			: null;
	if (!documentPath) {
		return {
			success: false,
			error:
				"Markdown document path must stay inside the workspace sandbox root.",
		};
	}

	const sandboxRoot = await ensureServerWorkspaceSandboxRoot(
		serverWorkspaceRoot,
		context,
	);
	const markdownWorkspaceRoot =
		typeof typedRequest.workspaceRoot === "string" && typedRequest.workspaceRoot
			? resolveServerWorkspaceFilePath(
					serverWorkspaceRoot,
					context,
					typedRequest.workspaceRoot,
				)
			: sandboxRoot;
	if (!markdownWorkspaceRoot) {
		return {
			success: false,
			error:
				"Markdown workspace root must stay inside the workspace sandbox root.",
		};
	}

	if (
		typeof typedRequest.rawTarget === "string" &&
		!isServerMarkdownTargetSafe(
			documentPath,
			sandboxRoot,
			typedRequest.rawTarget,
		)
	) {
		return {
			success: false,
			error:
				"Markdown asset target must stay inside the workspace sandbox root.",
		};
	}

	if (!(await isServerMarkdownObsidianConfigSafe(documentPath, sandboxRoot))) {
		return {
			success: false,
			error:
				"Markdown attachment configuration must stay inside the workspace sandbox root.",
		};
	}

	const settings = await getOwnerSettings(
		settingsByOwner,
		settingsStore,
		context,
	);
	return {
		success: true,
		request: {
			documentPath,
			workspaceRoot: markdownWorkspaceRoot,
			rawTarget:
				typeof typedRequest.rawTarget === "string"
					? typedRequest.rawTarget
					: undefined,
			files: Array.isArray(typedRequest.files)
				? (typedRequest.files as MarkdownSaveAttachmentsRequest["files"])
				: undefined,
		},
		adapters: createServerMarkdownAdapters(
			settings.general.editor,
			sandboxRoot,
		),
	};
}

function createServerMarkdownAdapters(
	editorSettings: OnethingMarkdownEditorSettings | undefined,
	sandboxRoot: string,
): OnethingMarkdownAssetServiceAdapters {
	return {
		getEditorSettings: () =>
			sanitizeServerMarkdownEditorSettings(editorSettings, sandboxRoot),
		getNoteRoots: () => [],
	};
}

function sanitizeServerMarkdownEditorSettings(
	editorSettings: OnethingMarkdownEditorSettings | undefined,
	sandboxRoot: string,
): OnethingMarkdownEditorSettings {
	return {
		markdownNoteAttachmentDirectory: sanitizeServerMarkdownAttachmentDirectory(
			editorSettings?.markdownNoteAttachmentDirectory,
			sandboxRoot,
		),
		markdownProjectAttachmentDirectory:
			sanitizeServerMarkdownAttachmentDirectory(
				editorSettings?.markdownProjectAttachmentDirectory,
				sandboxRoot,
			),
	};
}

function sanitizeServerMarkdownAttachmentDirectory(
	value: string | undefined,
	sandboxRoot: string,
): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (
		trimmed === "~" ||
		trimmed.startsWith("~/") ||
		trimmed.startsWith("$HOME/")
	)
		return undefined;
	const target = resolve(
		isAbsolute(trimmed) ? trimmed : join(sandboxRoot, trimmed),
	);
	return isPathInside(target, sandboxRoot) ? target : undefined;
}

function cleanServerMarkdownTarget(rawTarget: string): string {
	let target = rawTarget.trim();
	const wiki = target.match(/^!?\[\[([\s\S]+)\]\]$/);
	if (wiki) target = wiki[1].trim();
	if (target.startsWith("<") && target.endsWith(">"))
		target = target.slice(1, -1).trim();
	target = target.split("|")[0].trim();
	target = target.split("#")[0].trim();
	try {
		return decodeURI(target);
	} catch {
		return target;
	}
}

function isServerMarkdownTargetSafe(
	documentPath: string,
	sandboxRoot: string,
	rawTarget: string,
): boolean {
	const trimmed = rawTarget.trim();
	if (!trimmed) return true;
	if (trimmed.startsWith("#")) return true;

	const target = cleanServerMarkdownTarget(rawTarget);
	if (!target) return true;
	if (
		/^[a-z][a-z\d+.-]*:/i.test(target) &&
		!target.toLowerCase().startsWith("file:")
	)
		return true;

	if (target.toLowerCase().startsWith("file:")) {
		try {
			return isPathInside(fileURLToPath(target), sandboxRoot);
		} catch {
			return false;
		}
	}

	if (isAbsolute(target)) return isPathInside(resolve(target), sandboxRoot);
	const parts = target.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.includes("..") || parts.includes("~")) return false;
	return isPathInside(resolve(dirname(documentPath), target), sandboxRoot);
}

async function isServerMarkdownObsidianConfigSafe(
	documentPath: string,
	sandboxRoot: string,
): Promise<boolean> {
	let current = dirname(documentPath);
	while (isPathInside(current, sandboxRoot)) {
		const obsidianDir = join(current, ".obsidian");
		if (existsSync(obsidianDir)) {
			try {
				const raw = await readFile(join(obsidianDir, "app.json"), "utf-8");
				const parsed = JSON.parse(raw) as { attachmentFolderPath?: unknown };
				const folder =
					typeof parsed.attachmentFolderPath === "string"
						? parsed.attachmentFolderPath.trim()
						: "";
				if (!folder) return true;
				if (
					folder === "~" ||
					folder.startsWith("~/") ||
					folder.startsWith("$HOME/")
				)
					return false;
				const attachmentRoot = resolve(
					isAbsolute(folder) ? folder : join(current, folder),
				);
				return isPathInside(attachmentRoot, sandboxRoot);
			} catch {
				return true;
			}
		}

		const parent = dirname(current);
		if (parent === current) return true;
		current = parent;
	}
	return true;
}

function sanitizeServerMarkdownAsset(
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	asset: MarkdownAssetResolution,
): MarkdownAssetResolution {
	if (!asset.absolutePath) return asset;
	const sandboxRoot = workspaceSandboxRoot(serverWorkspaceRoot, context);
	if (isPathInside(asset.absolutePath, sandboxRoot)) return asset;
	return {
		kind: "missing",
		rawTarget: asset.rawTarget,
		error: "Markdown asset path must stay inside the workspace sandbox root.",
	};
}

function sanitizeServerMarkdownAttachmentResult(
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
	result: MarkdownSaveAttachmentsResponse,
): MarkdownSaveAttachmentsResponse {
	if (!result.success || !result.attachments?.length) return result;
	const sandboxRoot = workspaceSandboxRoot(serverWorkspaceRoot, context);
	if (
		result.attachments.every((attachment) =>
			isPathInside(attachment.absolutePath, sandboxRoot),
		)
	) {
		return result;
	}
	return {
		success: false,
		error: "Markdown attachments must stay inside the workspace sandbox root.",
		code: "WORKSPACE_PATH",
	};
}

function getServerProjectDirsStoreForContext(
	stores: Map<string, ServerProjectDirsStore>,
	dataRoot: string,
	context: RuntimeRequestContext,
): ServerProjectDirsStore {
	const key = ownerKey(context);
	let store = stores.get(key);
	if (!store) {
		store = new ServerProjectDirsStore(
			join(
				dataRoot,
				"owners",
				safePathSegment(context.userId),
				safePathSegment(context.workspaceId),
				"project-dirs.json",
			),
		);
		stores.set(key, store);
	}
	return store;
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

function getServerMediaServiceForContext(
	services: Map<string, MediaLibraryService>,
	dataRoot: string,
	context: RuntimeRequestContext,
	desktopStorePath?: string,
): MediaLibraryService {
	const key = ownerKey(context);
	let service = services.get(key);
	if (!service) {
		service = new MediaLibraryService(
			serverMediaLibraryPaths(dataRoot, context, desktopStorePath),
		);
		services.set(key, service);
	}
	return service;
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
		dataRoot,
		"owners",
		safePathSegment(context.userId),
		safePathSegment(context.workspaceId),
		"media",
	);
	return {
		indexPath: join(root, "index.json"),
		imagesDir: join(root, "images"),
		filesDir: join(root, "files"),
	};
}

function serverMediaFileUrl(filePath?: string): string | undefined {
	if (!filePath) return undefined;
	return `/api/media/file/${encodeURIComponent(basename(filePath))}`;
}

function toServerClientMediaAsset(
	asset: OnethingMediaAsset,
): OnethingMediaAsset {
	return {
		...asset,
		filePath: serverMediaFileUrl(asset.filePath),
		thumbnailPath: serverMediaFileUrl(asset.thumbnailPath),
	};
}

function toServerClientLegacyMediaItem(
	item: OnethingLegacyMediaItem,
): OnethingLegacyMediaItem {
	return {
		...item,
		filePath: serverMediaFileUrl(item.filePath) || "",
	};
}

function toMediaSession(session: ServerChatSession) {
	return {
		id: session.id,
		messages: session.messages.map((message) => ({
			id: message.id,
			role: message.role,
			attachments: message.attachments,
		})),
	};
}

function normalizeServerMediaFileName(input: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith("/api/media/file/")) {
		return basename(
			decodeURIComponent(trimmed.slice("/api/media/file/".length)),
		);
	}
	if (trimmed.startsWith("media://")) {
		return basename(decodeURIComponent(trimmed.slice("media://".length)));
	}
	return basename(trimmed);
}

function resolveServerMediaFilePath(
	services: Map<string, MediaLibraryService>,
	dataRoot: string,
	context: RuntimeRequestContext,
	input: string,
	desktopStorePath?: string,
): { path: string; mimeType: string } | null {
	const fileName = normalizeServerMediaFileName(input);
	if (!fileName || fileName === "." || fileName === "..") return null;

	const service = getServerMediaServiceForContext(
		services,
		dataRoot,
		context,
		desktopStorePath,
	);
	const paths = serverMediaLibraryPaths(dataRoot, context, desktopStorePath);
	const candidates = service.listAssets({ includeHidden: true });
	for (const asset of candidates) {
		if (!asset.filePath || basename(asset.filePath) !== fileName) continue;
		const resolvedPath = resolve(asset.filePath);
		const inImages = isPathInside(resolvedPath, resolve(paths.imagesDir));
		const inFiles = isPathInside(resolvedPath, resolve(paths.filesDir));
		if (!inImages && !inFiles) return null;
		return {
			path: resolvedPath,
			mimeType: asset.mimeType,
		};
	}
	return null;
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

function canRevokePermissionGrant(
	grantId: string,
	sessions: readonly SessionWorkspaceRef[],
	serverWorkspaceRoot: string,
	context: RuntimeRequestContext,
): boolean {
	const workspaceRoots = new Set<string>([
		workspaceSandboxRoot(serverWorkspaceRoot, context),
	]);
	for (const session of sessions) {
		if (listSessionGrants(session.id).some((grant) => grant.id === grantId))
			return true;
		workspaceRoots.add(
			workspaceSandboxRootForSession(serverWorkspaceRoot, session),
		);
		if (session.workingDirectory) workspaceRoots.add(session.workingDirectory);
	}

	const owner = { userId: context.userId, workspaceId: context.workspaceId };
	for (const workspaceRoot of workspaceRoots) {
		if (
			listWorkspaceGrants(workspaceRoot, owner).some(
				(grant: PermissionGrant) => grant.id === grantId,
			)
		) {
			return true;
		}
	}
	return false;
}

function readPermissionTrackingEvent(event: unknown): {
	type: "permission:request" | "permission:timeout" | "permission:settled";
	requestId: string;
} | null {
	if (!event || typeof event !== "object") return null;
	const candidate = event as Record<string, unknown>;
	const type = candidate.type;
	if (
		type !== "permission:request" &&
		type !== "permission:timeout" &&
		type !== "permission:settled"
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
	if (candidate.type !== "session:variables-updated") return null;
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

function serverSchedulerPaths(
	dataRoot: string,
	context = defaultRequestContext(),
	desktopStorePath?: string,
): {
	statePath: string;
	tasksPath: string;
	runsDir: string;
} {
	if (desktopStorePath && isDefaultServerRequestContext(context)) {
		return {
			statePath: join(
				getOnethingSchedulerDir({ storePath: desktopStorePath }),
				"state.json",
			),
			tasksPath: getOnethingSchedulerTasksPath({ storePath: desktopStorePath }),
			runsDir: getOnethingSchedulerRunsDir({ storePath: desktopStorePath }),
		};
	}

	const schedulerRoot = join(
		dataRoot,
		"owners",
		safePathSegment(context.userId),
		safePathSegment(context.workspaceId),
		"scheduler",
	);
	return {
		statePath: join(schedulerRoot, "state.json"),
		tasksPath: join(schedulerRoot, "tasks.json"),
		runsDir: join(schedulerRoot, "runs"),
	};
}

function isServerUserSchedulerTask(
	schedulerRuntime: ServerSchedulerRuntime,
	id: string,
): boolean {
	return id.startsWith("user:") || Boolean(schedulerRuntime.userTasks.get(id));
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
		dataRoot,
		"owners",
		safePathSegment(context.userId),
		safePathSegment(context.workspaceId),
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

function workspaceSandboxRoot(
	workspaceRoot: string,
	context = defaultRequestContext(),
): string {
	return join(
		workspaceRoot,
		safePathSegment(context.userId),
		safePathSegment(context.workspaceId),
	);
}

function workspaceSandboxRootForSession(
	workspaceRoot: string,
	session: SessionWorkspaceRef,
): string {
	return join(
		workspaceRoot,
		safePathSegment(session.userId ?? defaultRequestContext().userId),
		safePathSegment(session.workspaceId ?? defaultRequestContext().workspaceId),
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

function safePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function ownerKey(context = defaultRequestContext()): string {
	return `${context.userId}:${context.workspaceId}`;
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
