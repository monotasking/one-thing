/**
 * server runtime 的门面名册:哪些功能给这台 HTTP 面交了门面、按什么顺序装、按什么顺序拆。
 *
 * 这是 `http-server/` 里**唯一**点名具体功能的 server 门面装配处(与开给界面的操作那张名册
 * `http-server-client-api-roster.ts` 同一个做法):每个功能的门面住在它自己的
 * `<功能>-client-api-<方面>.ts` 里,这里只按顺序把它们装起来、把交出的门面格拼成一张表、
 * 把收尾步按顺序排好。`http-server-runtime.ts` 只读这张表,不认识任何一个功能。
 *
 * ## 两条顺序,写死在这里
 *
 * - **装的顺序** = 2026-10-04 拆分之前那只 4208 行闭包里的顺序(决策 D219):会话仓 → 工作区监视 →
 *   设置仓 → 授权账页存储 → 会话工作集与受众 → 待答权限账 → `ServerRuntimeStore` 总线订阅 → MCP →
 *   OAuth / 设置广播串联 → todo/plan / 草稿纸串联(与 watcher)→ 插件目录端口 → 搜索端口 →
 *   能力 / 会话投递 / 媒体投递 / 语音 / 全局事件。唯一挪动的是几处**纯构造**(工作集、受众工厂、
 *   MCP 客户端工厂的选择)与两只单槽端口「先记下宿主原来那份」的时刻 —— 都不碰任何共享状态,
 *   挪动看不出来(D221);为什么不做成各功能自登记见 D220。
 * - **拆的顺序** = 搬家前 `shutdown()` 里那张表,一格不动:先关工作区监视的新登记门(第一个
 *   `await` 之前),停按 owner 隔离的 MCP 管理器,再按下面 `restores` 的顺序逐步还原,然后清订阅表
 *   与按 owner 的缓存,最后刷会话仓。每一步的标签就是 `server surface cleanup failed { step }`
 *   那一行日志里的 `step`,不改。
 *
 * 加一个新的 server 门面 = 它自己的模块 + 这里装的一行 + (有收尾的话)拆的一行。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSessionAccess } from '@onething/backend/session'
import type { GenericEventBus } from "@onething/backend/event";
import type { AgentEngineSessionEvent, AgentEngineStreamChunk } from "@onething/backend/agent";
import type { GetSessionMessagesPageRequest, GetSessionMessagesPageResponse } from "@shared/ipc/chat.js";
import type { SessionCommand } from "@shared/events/session-commands.js";
import { createServerLiveSessionDelivery } from '../session/session-client-api-live-delivery.js'
import { createAppBackedServerSessionStore, createEchoServerSessionStore } from '../session/session-client-api-server-store.js'
import { createServerSessionWorkingSet } from '../session/session-client-api-server-working-set.js'
import { createServerWorkspaceWatches } from '../file/file-client-api-workspace-watch.js'
import { createServerRuntimeSettingsStore } from '../settings/settings-client-api-server-store.js'
import { createServerSettingsChangeEvents } from '../settings/settings-client-api-change-events.js'
import { configureServerPermissionGrantStorage, createServerPendingPermissions } from '../permission/permission-client-api-pending.js'
import { createServerMcpHost } from '../mcp/mcp-client-api-server-host.js'
import { createServerOAuthTokenEvents } from '../auth/auth-client-api-token-events.js'
import { createServerTodoPlanChangeEvents } from '../todo-plan/todo-plan-client-api-change-events.js'
import { createServerScratchpadChangeEvents } from '../scratchpad/scratchpad-client-api-change-events.js'
import { installServerPluginCatalog } from '../plugin/plugin-client-api-catalog-mirror.js'
import { installServerSearch } from '../search/search-client-api-owner.js'
import { createServerMediaDelivery } from '../media/media-client-api-delivery.js'
import { serverMediaLibraryPaths } from '../media/media-client-api-owner-paths.js'
import { createServerVoiceEventsPort } from '../voice/voice-client-api-server-events.js'
import { createServerCapabilitiesPort } from './http-server-capabilities.js'
import { createServerGlobalEventsPort } from './http-server-global-events.js'
import { defaultRequestContext, isDefaultServerRequestContext, ownerKey } from './http-server-tenant-paths.js'
import type { OnethingRuntimeFacadeOptions } from './http-server-runtime-facade.js'
import type { OnethingServerBackend, OnethingServerRuntimeOptions } from './http-server-runtime-types.js'

/** 装门面要的全部上下文:底座、选项,以及 runtime 已经解析好的几个根目录。 */
export interface ServerSurfaceContext {
	backend: OnethingServerBackend;
	options: OnethingServerRuntimeOptions;
	storePath: string;
	workspaceRoot: string;
	dataRoot: string;
	/** `processPorts === 'own'`:这个进程就是 core 进程,进程级单槽端口由 server runtime 配。 */
	ownsProcessPorts: boolean;
}

/** 收尾时一步一步记账的那只函数(失败记一行、不中断后面的步)。 */
export type ServerTeardownAttempt = (step: string, run: () => void | Promise<void>) => Promise<void>;

/** 门面除 `shutdown` 之外的每一格(形状就是 `createOnethingRuntimeFacade` 的选项)。 */
export type ServerSurfaceSlots = Omit<
	OnethingRuntimeFacadeOptions<
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
	>,
	"shutdown"
>;

export interface ServerSurfaces {
	eventBus: GenericEventBus<AgentEngineSessionEvent>;
	slots: ServerSurfaceSlots;
	/** 按搬家前的顺序拆掉这张表装起来的一切(不含底座本身)。 */
	teardown(attempt: ServerTeardownAttempt): Promise<void>;
}

/** 按顺序装起每个功能的 server 门面。同步、无 `await`:装的过程中没有事件能插进来。 */
export function installServerSurfaces(context: ServerSurfaceContext): ServerSurfaces {
	const { backend, options, storePath, workspaceRoot, dataRoot, ownsProcessPorts } = context;
	const eventBus = backend.eventBus;
	const streamChannel = backend.streamChannel;

	// 会话仓。Real engine backends persist through the @onething/backend repository; a
	// second local repository over the same files would fork the in-memory
	// truth and race writes (intermittent 404/empty history, jsonl ENOENT).
	const sessionStore =
		options.sessionStore ??
		(backend.persistsMessages
			? createAppBackedServerSessionStore(storePath)
			: createEchoServerSessionStore(storePath));
	const workspaceWatches = createServerWorkspaceWatches({ workspaceRoot });
	const settingsStore = createServerRuntimeSettingsStore({ backend, options, storePath, dataRoot });
	if (ownsProcessPorts) {
		configureServerPermissionGrantStorage(dataRoot, {
			readJsonFile: readServerRuntimeJsonFile,
			writeJsonFile: writeServerRuntimeJsonFile,
		});
	}
	const sessions = createServerSessionWorkingSet({
		backend,
		sessionStore,
		eventBus,
		workspaceRoot,
		audienceFactory: options.audienceFactory,
	});
	const pendingPermissions = createServerPendingPermissions({
		backend,
		eventBus,
		resolveSession: sessions.resolveSession,
		getSessionForContext: sessions.getSessionForContext,
	});
	const unsubscribeRuntimeStore = sessions.subscribeRuntimeStore(pendingPermissions.track);
	const mcp = createServerMcpHost({ backend, ownsProcessPorts, options });
	const oauthTokenEvents = createServerOAuthTokenEvents();
	const settingsChangeEvents = createServerSettingsChangeEvents();
	const todoPlanChangeEvents = createServerTodoPlanChangeEvents();
	const scratchpadChangeEvents = createServerScratchpadChangeEvents({ ownsProcessPorts });
	const pluginCatalog = installServerPluginCatalog({
		dataRoot,
		options,
		eventBus,
		getSessionForContext: sessions.getSessionForContext,
	});
	const search = installServerSearch({
		settingsStore,
		sessionStore,
		workspaceRoot,
		dataRoot,
		listSessionsForContext: sessions.listSessionsForContext,
		getSessionForContext: sessions.getSessionForContext,
		getServerCurrentSessionId: sessions.getServerCurrentSessionId,
		readJsonFile: readServerRuntimeJsonFile,
		writeJsonFile: writeServerRuntimeJsonFile,
	});
	const capabilitiesPort = createServerCapabilitiesPort();
	const liveSessionDelivery = createServerLiveSessionDelivery({ eventBus, streamChannel, audienceFactory: sessions.audienceFactory, defaultContext: defaultRequestContext });
	const mediaDelivery = createServerMediaDelivery({
		defaultContext: defaultRequestContext, ownerKey,
		access: createSessionAccess({ findMeta: sessions.findSessionIndexMeta }), sharedLibrary: backend.mediaLibrary,
		libraryPaths: context => serverMediaLibraryPaths(dataRoot, context, isDefaultServerRequestContext(context) ? storePath : undefined),
	});
	const voicePort = createServerVoiceEventsPort();
	const globalEventsPort = createServerGlobalEventsPort(eventBus);

	const slots: ServerSurfaceSlots = {
		capabilities: capabilitiesPort,
		sessions: sessions.sessionsPort,
		messages: sessions.messagesPort,
		// P4c 第五批:`chat` adapter 整只没了。属于**会话域**的六条随
		// `sessionsRouter` 走,剩下的三条真正的聊天面(getHistory / generateTitle /
		// updateMessageThinkingTime)随 `chatRouter` 走 —— 两个宿主从此是同一条
		// 实现,这里不再留第二份。
		events: liveSessionDelivery.events,
		// K2a':全局事件的推送面。会话事件那一格一个字没动 —— 全局事件没有会话
		// 坐标,也就没有环形缓冲与 `?after=` 回放,它是另一格而不是那一格的参数。
		globalEvents: globalEventsPort,
		streams: liveSessionDelivery.streams,
		permissions: pendingPermissions.port,
		// P4c 第十一批:`settings` / `network` 两格 adapter 整只没了 —— 四条数据面
		// (读 / 存 / 系统深浅色 / 代理自检)随 `settingsRouter` 走通用 RPC。
		// 出门脱敏与回来合并两道真护栏搬进 `settings/settings-client-api-projection.ts`,由域处理者
		// 在 `transport === 'http'` 那一支上逐字调用;读写的那份设置从 server 自己
		// 那本 per-owner 缓存改成装配层单例(拍板 #20,同 mcp / oauth / agents 判例)。
		// **推送那一格 E 批加了回来**(数据面四条一字未动):浏览器 / React 壳读的是
		// 同一本 `<store>/settings.json`,却听不见它变了,主题联动因此断在半路。
		// 它骑既有的 `GET /api/events`,不新开路由;出门那份过同一个脱敏投影。
		settings: settingsChangeEvents.port,
		// P4 终态批 A1-b:`query` 这一格没了 —— 数据面随 `searchRouter` 走通用 RPC,
		// **实现一行没搬**(同一个闭包改成注册进 `search/search-client-api-providers.ts` 的单槽
		// 端口,见上面的 `restoreServerSearchPort`)。留下的 `executeAction` 是**窗口
		// 活的 server 侧对应物**:它仍由 `POST /api/search/actions` 调用,而那条路由
		// 正是 A1-a 里 web 壳 `searchWindowRouter.executeAction` 的真实现。
		search: search.adapter,
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
		 * `backend/file/file-client-api.ts`),**护栏跟着走**:域处理者按
		 * `context.transport` 逐方法夹紧 `sandboxRoot`,越界文案逐字沿用这里
		 * 从前那几句(`resolveServerWorkspaceFilePath` 的公式本来就已经委托给
		 * `http-server/http-server-sandbox.ts` 了,现在连调用点也归它)。
		 *
		 * 留下的一条是 `GET /api/files/watch/events` 那条 SSE 的货源。真正的监视器
		 * 登记簿搬到了 `file/file-workspace-watch.ts`,按沙箱根分表 —— `watchStart`
		 * / `watchStop`(请求面,在 router 上)与这里(推送面)指的是同一张表。
		 */
		files: workspaceWatches.port,
		/**
		 * media —— **只剩两条不是 RPC 形状的**(结构债 P4c 第三批)。
		 *
		 * 十一条数据面已整只迁到通用 `POST /api/rpc`(`mediaRouter` +
		 * `backend/media/media-client-api.ts`),连同它们背后那套 per-owner 的第二台
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
		todoPlan: todoPlanChangeEvents.port,
		// 草稿纸没有 per-owner 分表:server 是单用户,而且**引擎在同一个进程里
		// 读同一张纸**(beforeTurn 尾块注入)。第二个仓等于把事实分叉。
		scratchpad: scratchpadChangeEvents.port,
		// P4 终态批 C2:六条读/开关面(list / enable / disable / refresh / commands /
		// executeCommand)随 `pluginsRouter` 走通用 RPC,`/api/plugins*` 那六条 REST
		// 路由与那条 501 的 `/api/plugins/:id/:action` 一起没了。**实现一行没搬** ——
		// 同一批闭包改成注册进 `plugin/plugin-client-api-catalog.ts` 的单槽端口(见下面的
		// `restoreServerPluginCatalogPort`),域在 `transport === 'http'` 那一支上
		// 原样调用,于是 web 读到的仍是这棵只读镜像树,一字不差。
		// P4c 第七批:六条数据面已迁到 `oauthRouter`,连同 server 那台 per-owner 的
		// 第二台 authService(拍板 #20:一个 store 一本令牌账)。这里只剩**推送面** ——
		// `GET /api/oauth/events` 的 SSE 源,它从装配层那条广播端口取货,而不是
		// 自己再挂一次 authService 的监听。
		oauth: oauthTokenEvents.port,
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
	};

	const teardown = async (attempt: ServerTeardownAttempt): Promise<void> => {
		// Close watch admission before the first await in surface teardown.
		const workspaceWatchClosing = workspaceWatches.close();
		void workspaceWatchClosing.catch(() => {});
		await mcp.stopScopedManagers(attempt);
		const restores: Array<[string, () => void | Promise<void>]> = [
			['live session delivery', () => liveSessionDelivery.dispose()],
			['media delivery', () => mediaDelivery.dispose()],
			['runtime store subscription', () => { unsubscribeRuntimeStore(); }],
			['MCP host', mcp.restoreHost],
			['todo host', todoPlanChangeEvents.restore],
			['scratchpad host', scratchpadChangeEvents.restore],
			['OAuth broadcaster', oauthTokenEvents.restore],
			['settings broadcaster', settingsChangeEvents.restore],
			['plugin catalog', pluginCatalog.restore],
			['search port', search.restore],
			['workspace watches', () => workspaceWatchClosing],
			['scratchpad watcher', scratchpadChangeEvents.stopWatcher],
		];
		for (const [label, restore] of restores) await attempt(label, restore);
		todoPlanChangeEvents.clearHandlers();
		scratchpadChangeEvents.clearHandlers();
		search.clearPromptStores();
		pluginCatalog.clearManagers();
		await attempt('session store', () => sessionStore.flushAll());
	};

	return { eventBus, slots, teardown };
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
