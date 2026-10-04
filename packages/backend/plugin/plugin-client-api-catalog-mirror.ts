/**
 * HTTP 服务器那一侧的插件目录镜像(插件第二入口的一个方面,决策 D26)。
 *
 * apps/backend-server 的插件目录是**另一棵树**的只读镜像:`owners/<uid>/<wid>/plugin-store/plugins`
 * (不是 `<store>/plugins`),entry 全是 noop,插件代码在 server 上从不执行;唯一真会落盘的是
 * enable 标志。这里有两样:
 *
 *  - `ServerPluginCatalogManager`:按 owner 一台的镜像管理器(内置 `log-monitor`,以及显式递进来
 *    `pluginCommands` 时的 `server-runtime` 命令插件);
 *  - `installServerPluginCatalog`:把六条读 / 开关面注册进 `plugin-client-api-catalog.ts` 的
 *    单槽端口,返回还原函数与清管理器表的函数。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { join } from "node:path";
import {
	createBuiltinPluginDefinitions,
	ensureCorePluginsDir,
	getCorePluginSettingsPath,
	getCorePluginsDir,
	getPluginEnabledWithAdapters,
	readPluginSettingsFile,
	scanCorePlugins,
	setPluginEnabledWithAdapters,
	writePluginSettingsFile,
	type CorePluginSettingsStorageAdapters,
} from "./plugin-loader.js";
import { type CorePluginCommandDefinition, type PluginSettings } from "./plugin-api-types.js";
import { type CorePluginDefinition } from "./plugin-manifest-types.js";
import {
	type CorePluginInfo,
} from "./plugin-manager-base.js";
import {
	ONETHING_LOG_MONITOR_MANIFEST,
} from "./plugin-log-monitor.js";
import {
	executeOnethingPluginCommandForIpc,
	disableOnethingPluginForIpc,
	enableOnethingPluginForIpc,
	listOnethingPluginCommandsForIpc,
	listOnethingPluginsForIpc,
	refreshOnethingPluginsForIpc,
} from "./plugin-ipc-operations.js";
import type { OnethingPluginIpcLogger } from './plugin-ipc-operations.js'
import type { AgentEngineSessionEvent } from "@onething/backend/agent";
import type { GenericEventBus } from "@onething/backend/event";
import { consolePort, getLogger } from '@onething/backend/logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import { tenantDirectory, defaultRequestContext, ownerKey } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { RuntimeRequestContext } from "@onething/backend/http-server/http-server-runtime-facade.js";
import { configureServerPluginCatalogPort } from "./plugin-client-api-catalog.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingPluginIpcLogger = consolePort(log)

export type ServerPluginCommandDefinition = CorePluginCommandDefinition;

export interface ServerPluginCatalogPorts {
	dataRoot: string;
	/** server runtime 的选项对象本身(`pluginCommands` 每次现读,与搬家前同一时刻)。 */
	options: { readonly pluginCommands?: ServerPluginCommandDefinition[] };
	eventBus: GenericEventBus<AgentEngineSessionEvent>;
	/** 按请求上下文取会话(`executeCommand` 只在调用方自己的会话上跑)。 */
	getSessionForContext(sessionId: string, context?: RuntimeRequestContext): unknown;
}

/** 调用即注册进单槽端口;返回还原函数与清按 owner 管理器表的函数。 */
export function installServerPluginCatalog(ports: ServerPluginCatalogPorts) {
	const { dataRoot, options, eventBus, getSessionForContext } = ports;
	const pluginCatalogManagersByOwner = new Map<
		string,
		ServerPluginCatalogManager
	>();
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
	return {
		restore: restoreServerPluginCatalogPort,
		clearManagers: () => pluginCatalogManagersByOwner.clear(),
	};
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

function normalizeServerPluginCommandName(commandName: string): string {
	return commandName.startsWith("/") ? commandName : `/${commandName}`;
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
