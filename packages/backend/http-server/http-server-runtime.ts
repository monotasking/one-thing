/**
 * server runtime:把各功能交出的 server 门面拼成一台 `OnethingRuntimeFacade`,站在一只底座上。
 *
 * 三个入口:
 *
 *  - `createOnethingServerRuntimeOverBackend(backend, options)` —— A 期的核心接缝:在一只**已经存在**
 *    的产品后端上建 runtime。桌面借出来的那只传 `ownsBackend: false` + `processPorts: 'host'`。
 *  - `createDevelopmentOnethingServerRuntime(options)` —— `server:start` 与测试:自己装配一只产品后端
 *    (`http-server-standalone-backend.ts`),或吃测试递进来的 `createBackend` 替身。
 *  - `toOnethingServerBackend(backend)` —— 把产品后端适配成 runtime 认识的底座。
 *
 * 这只文件不认识任何一个具体功能:门面格从哪来、按什么顺序装与拆,都在名册
 * `http-server-runtime-roster.ts` 里;每个功能的门面住在它自己的 `<功能>-client-api-<方面>.ts`。
 * 2026-10-04 之前这里是一只 4208 行、点名约 30 个功能的文件(决策 D88 / D219)。
 */
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { OnethingBackend } from "@onething/backend/backend.js";
import type { GenericEventBus } from "@onething/backend/event";
import type { AgentEngineSessionEvent, AgentEngineStreamChunk } from "@onething/backend/agent";
import { getOnethingStorePath } from "@onething/backend/storage";
import { getLogger } from '@onething/backend/logging'
import type { GetSessionMessagesPageRequest, GetSessionMessagesPageResponse } from "@shared/ipc/chat.js";
import type { SessionCommand } from "@shared/events/session-commands.js";
import { createOnethingRuntimeFacade } from "./http-server-runtime-facade.js";
import { createRealServerBackend } from "./http-server-standalone-backend.js";
import { installServerSurfaces } from "./http-server-runtime-roster.js";
import type {
	OnethingServerBackend,
	OnethingServerRuntime,
	OnethingServerRuntimeOptions,
	OnethingServerRuntimeOverBackendOptions,
	ServerStreamChannelLike,
} from "./http-server-runtime-types.js";

export type {
	OnethingServerBackend,
	OnethingServerRuntime,
	OnethingServerRuntimeOptions,
	OnethingServerRuntimeOverBackendOptions,
	ServerStreamChannelLike,
} from "./http-server-runtime-types.js";

const log = getLogger('server.runtime')

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
		eventBus: backend.eventBus as unknown as GenericEventBus<AgentEngineSessionEvent>,
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

/**
 * 在一只**已经存在**的产品后端之上建 server runtime(A 期的核心接缝)。
 *
 * 桌面主进程装配完 backend 之后调这个:HTTP/SSE 面因此和 renderer 的 IPC 面
 * 共享同一条事件流、同一份内存真相、同一个 seq 分配器 —— 而不是像从前那样
 * 由不带界面的后端进程(`backend-standalone-main.ts`)再装配一只引擎。
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
	// 桌面档的登录 shell PATH 在 `createRealServerBackend` 里等(装配之后、ACP 起名册之前;MCP stdio 更晚,在建 runtime 时)。
	const backend = await createRealServerBackend(storePath, options.logging, options.launchProfile, options.beforeFirstSpawn);
	return createOnethingServerRuntimeOverBackend(backend, {
		...options,
		mcpClientFactory: options.mcpClientFactory ?? options.launchProfile?.mcpClientFactory,
		storePath,
		ownsBackend: true,
	});
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
	const workspaceRoot = resolve(
		options.workspaceRoot ??
			process.env.ONETHING_SERVER_WORKSPACE_ROOT ??
			join(tmpdir(), "onething-server-workspaces"),
	);
	const dataRoot = resolve(
		options.dataRoot ?? process.env.ONETHING_SERVER_DATA_ROOT ?? storePath,
	);
	const surfaces = installServerSurfaces({ backend, options, storePath, workspaceRoot, dataRoot, ownsProcessPorts });
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
		...surfaces.slots,
		shutdown() {
			return shutdownPromise ??= (async () => {
				const failures: unknown[] = [];
				const attempt = async (step: string, run: () => void | Promise<void>): Promise<void> => {
					try { await run(); }
					catch (error) { failures.push(error); log.error('server surface cleanup failed', { step }, error); }
				};
				// 名册按搬家前的顺序拆:先关工作区监视的新登记门(在第一个 `await` 之前),
				// 停按 owner 隔离的 MCP 管理器,逐步还原各个端口,清订阅表与缓存,刷会话仓。
				await surfaces.teardown(attempt);
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
