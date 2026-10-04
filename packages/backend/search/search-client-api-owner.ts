/**
 * HTTP 服务器那一侧按 owner 装的搜索(搜索第二入口的一个方面,决策 D26)。
 *
 * 不可信那一支(非回环部署的 server)上,搜索不能共用进程里那一份 store 级索引 —— 索引里
 * 没有 owner,共用就是让 bob 读到 alice 的会话。所以这里按请求上下文现装一份
 * `SearchService`:会话 / 消息 / 文件 / 提示词全按这个 owner 取,索引型能力如实答不可用。
 *
 * 两样东西:
 *
 *  - `installServerSearch`:把 `query` 注册进 `search-client-api-providers.ts` 的单槽端口,
 *    返回门面的 `search` 一格(`executeAction`,今天原样回声)、还原函数与清按 owner 缓存的函数;
 *  - `listServerToolFiles`:沙箱里的文件遍历(跳过 `.git`,按 glob 过滤),搜索的 `files` 能力用。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { stat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createOnethingSearchService,
	type SearchServiceRequest,
} from "./search-service.js";
import {
	type OnethingSearchProvidersAdapters,
} from "./search-providers.js";
import {
	unavailableIndexFace,
} from "./search-service-setup.js";
import { noteVaultsNow, primaryNoteVaultNow } from "@onething/backend/note";
import { OnethingPromptStore } from "@onething/backend/prompt";
import type { OnethingPromptStoreAdapters } from '@onething/backend/prompt'
import { mergeWithDefaults } from "@onething/backend/settings";
import { getLogger } from '@onething/backend/logging'
import { tenantDirectory, defaultRequestContext, ownerKey } from "@onething/backend/http-server/http-server-tenant-paths.js";
import { workspaceSandboxRoot } from "@onething/backend/http-server/http-server-sandbox.js";
import type {
	RuntimeMutationResult,
	RuntimeRequestContext,
	RuntimeSearchAdapter,
} from "@onething/backend/http-server/http-server-runtime-facade.js";
import type { ChatMessage, ChatSession, SessionMeta } from "@shared/ipc/chat.js";
import type { AppSettings } from "@shared/ipc/settings.js";
import { configureServerSearchPort } from "./search-client-api-providers.js";

// 日志命名空间沿用搬家前的 `server.runtime`。
const log = getLogger('server.runtime')

/** 这个 owner 的设置从哪读(与 server runtime 的设置仓同一只)。 */
interface ServerSearchSettingsStore {
	load(context: RuntimeRequestContext): Promise<AppSettings | undefined>;
}

export interface ServerSearchPorts {
	settingsStore: ServerSearchSettingsStore;
	workspaceRoot: string;
	dataRoot: string;
	listSessionsForContext(context?: RuntimeRequestContext): SessionMeta[];
	getSessionForContext(sessionId: string, context?: RuntimeRequestContext): ChatSession | undefined;
	getServerCurrentSessionId(context?: RuntimeRequestContext): string;
	/** 会话消息的读口:就是 server runtime 的会话仓那一只(按方法调用,与搬家前同一个接收者)。 */
	sessionStore: { getMessages(sessionId: string): readonly ChatMessage[] };
	/** 搬家前 server runtime 自己那对 JSON 读写(缺文件 = 缺省值;写 = pretty + 换行)。 */
	readJsonFile<T>(filePath: string, defaultValue: T): T;
	writeJsonFile<T>(filePath: string, data: T): void;
}

/** 调用即注册进单槽端口;返回门面的 `search` 一格、还原函数与清按 owner 缓存的函数。 */
export function installServerSearch(ports: ServerSearchPorts) {
	const { settingsStore, sessionStore, workspaceRoot, dataRoot, listSessionsForContext, getSessionForContext, getServerCurrentSessionId } = ports;
	const readServerRuntimeJsonFile = ports.readJsonFile;
	const writeServerRuntimeJsonFile = ports.writeJsonFile;
	const settingsByOwner = new Map<string, AppSettings>();
	const promptStoresByOwner = new Map<string, OnethingPromptStore>();

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
		// 读出来的设置今天没有人用,但这一次读(含读盘与可能的解析失败)是搬家前就有的行为,
		// 拆分时原样保留(决策 D221)。
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
			// 笔记库是**这台机器上的**(不按 owner 分),晚绑定地现取 —— 夹紧的
			// 宿主上它是空表,`notes` 那一类于是整组不出现(P2)。
			getNoteVaults: noteVaultsNow,
			getPrimaryNoteVault: primaryNoteVaultNow,
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

	/**
	 * `POST /api/search/actions` 背后那一只 —— **今天只是原样回传**。
	 *
	 * P2 删掉了这里唯一的分支:`create-daily-note:<path>` → 建文件 → 回
	 * `open-file:<path>`。那条路是 A1-a 之前 Vue 壳 `searchWindowRouter.executeAction`
	 * 的落点,而那个壳 2026-09-04 已经退役,仓里一个调用方都没有了(React 壳的
	 * `runAction` 今天还是一句「这个动作还接不上」的提示)。更要紧的是它是
	 * **第二个「建今天那篇日记」的产地**:真正那一条走 `search.invoke` → `notes`
	 * 能力 → `NoteVault.createDailyNote`(吃用户的日记文件夹 / 格式 / 模板),
	 * 留着这一条就是让 server 按自己那套语义再建一遍。
	 *
	 * 路由本身留着(契约没动),于是一个不认识的动作号仍然得到一个诚实的回声。
	 */
	const resolveSearchActionForContext = async (
		actionId: string,
		_context = defaultRequestContext(),
	): Promise<{ success: boolean; actionId?: string; error?: string }> => {
		return { success: true, actionId };
	};

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
			 * (`http-server/__tests__/http-server-routes.test.ts` 里「bob 看不见 alice 的会话」那条)。
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

	const runtimeSearchAdapter: RuntimeSearchAdapter<RuntimeMutationResult> = {
		executeAction(actionId: string, context = defaultRequestContext()) {
			return resolveSearchActionForContext(actionId, context);
		},
	};

	return {
		adapter: runtimeSearchAdapter,
		restore: restoreServerSearchPort,
		clearPromptStores: () => promptStoresByOwner.clear(),
	};
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
	settingsStore: ServerSearchSettingsStore,
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

function isPathInside(candidate: string, root: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
