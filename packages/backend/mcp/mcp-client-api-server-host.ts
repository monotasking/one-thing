/**
 * HTTP 服务器那一侧的 MCP 宿主(MCP 第二入口的一个方面,决策 D26)。
 *
 * server runtime 对 MCP 的全部要求:
 *
 *  - 选客户端工厂:缺省是**不联网**的 `DisabledServerMCPClient`;`ONETHING_SERVER_MCP_CONNECTIONS=1`
 *    换成真客户端(`ONETHING_SERVER_MCP_STDIO=1` 再放开 stdio);测试可以直接递工厂。
 *  - 这个进程是 core 进程(`processPorts: 'own'`)时:盖 clientInfo 版本、装客户端工厂、
 *    让产品后端的 MCP 子系统起起来;嵌在宿主里时三件都不碰。
 *  - 默认 owner 路由到产品后端那台 `MCPManager` 单例(引擎的 MCP 桥绑死在它上面)。
 *  - 收尾:停掉按 owner 隔离的管理器(默认那台归产品后端的 `own('mcp')`),还原客户端宿主。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { readFileSync } from "node:fs";
import {
	MCPManager as appMCPManager,
	configureMCPClientHost,
} from "@onething/backend/mcp";
import {
	configureMCPClientIdentity,
	createMCPServerState,
	HeadlessMCPManager,
	type MCPClientLike,
	ServerMCPClient,
} from "@onething/backend/mcp";
import type { McpSubsystem } from "@onething/backend/mcp";
import { getLogger } from '@onething/backend/logging'
import { defaultRequestContext, ownerKey } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { MCPServerConfig, MCPServerState } from "@shared/ipc/mcp.js";

// 日志命名空间沿用搬家前的 `server.runtime`:`mcp subsystem started` 那一行 log:smoke 读得到。
const log = getLogger('server.runtime')

export type ServerMCPClientFactory = (config: MCPServerConfig) => MCPClientLike;
type ServerMCPManager = HeadlessMCPManager<MCPClientLike>;

export interface ServerMcpHostPorts {
	/** `persistsMessages` 与产品后端的 MCP 子系统(只要 `start`);每次现读。 */
	backend: { readonly persistsMessages: boolean; readonly mcp?: Pick<McpSubsystem, "start"> };
	ownsProcessPorts: boolean;
	options: {
		enableMCPConnections?: boolean;
		allowMCPStdio?: boolean;
		mcpClientFactory?: ServerMCPClientFactory;
	};
}

/** 收尾时一步一步记账的那只函数(失败记一行、不中断后面的步)。 */
export type ServerTeardownAttempt = (step: string, run: () => void | Promise<void>) => Promise<void>;

export function createServerMcpHost(ports: ServerMcpHostPorts) {
	const { backend, ownsProcessPorts, options } = ports;
	const mcpManagersByOwner = new Map<string, ServerMCPManager>();
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
			 * `settings/settings-store.ts` 的 repository,`filePath: getOnethingSettingsPath`,
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
			 * 初版实测把 `apps/backend-server` 那 5s 预算吃干净(5.06s + `shutdown did not
			 * finish in time; pending session writes may be lost`),从前是 0.05s。
			 * **用户裁定不接受无界等待**,于是 `McpSubsystem.dispose()` 现在自带
			 * 3000ms 上限(见 `mcp/mcp-subsystem.ts` 的
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
						 * `apps/backend-server/src/main.ts` 要等 runtime 装配完才
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

	/** 收尾第一步:停按 owner 隔离的管理器;默认那台归产品后端,只由它自己的登记关。 */
	const stopScopedManagers = async (attempt: ServerTeardownAttempt): Promise<void> => {
		// Stop scoped workers before saving. The default manager belongs to
		// the Backend and is disposed only by its own resource registration.
		for (const manager of mcpManagersByOwner.values()) {
			if (backend.persistsMessages && manager === appMCPManager) continue;
			await attempt('scoped MCP manager', () => manager.shutdown());
		}
		mcpManagersByOwner.clear();
	};

	/** 还原客户端宿主(只有 core 进程自己装过才还原)。 */
	const restoreHost = (): void => {
		if (backend.persistsMessages && ownsProcessPorts) configureMCPClientHost(null);
	};

	return { stopScopedManagers, restoreHost };
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
