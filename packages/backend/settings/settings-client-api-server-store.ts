/**
 * HTTP 服务器那一侧的设置仓(设置第二入口的一个方面,决策 D26)。
 *
 * server runtime 按请求上下文读写设置用的那只 `ServerSettingsStore`:
 *
 *  - 默认 owner 读写 `<store>/settings.json`(与进程里的引擎同一个文件),其余 owner 各一份
 *    `<root>/<uid>/<wid>.json`(`createDefaultContextServerSettingsStore`);
 *  - 显式 `ONETHING_SERVER_SETTINGS_ROOT` / `options.settingsRoot` 把所有 owner 一起挪到那个目录;
 *  - 真引擎上,默认 owner 存完设置就丢掉 app 设置缓存,引擎下一次读才是新值
 *    (`createServerRuntimeSettingsStore`)。
 *
 * 2026-10-04 从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { invalidateSettingsCache as invalidateAppSettingsCache, mergeWithDefaults } from "@onething/backend/settings";
import { getOnethingSettingsPath } from "@onething/backend/storage";
import { defaultRequestContext, isDefaultServerRequestContext } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { RuntimeRequestContext } from "@onething/backend/http-server/http-server-runtime-facade.js";
import type { AppSettings } from "@shared/ipc/settings.js";

export interface ServerSettingsStore {
	load(context: RuntimeRequestContext): Promise<AppSettings | undefined>;
	save(context: RuntimeRequestContext, settings: AppSettings): Promise<void>;
}

export interface ServerRuntimeSettingsStorePorts {
	/** 只读 `persistsMessages` 一格(真引擎 = 存完要丢 app 设置缓存)。 */
	backend: { readonly persistsMessages: boolean };
	options: { settingsRoot?: string; settingsStore?: ServerSettingsStore };
	storePath: string;
	dataRoot: string;
}

/** server runtime 用的那只设置仓:选底仓,真引擎上再包一层「存完丢 app 缓存」。 */
export function createServerRuntimeSettingsStore(ports: ServerRuntimeSettingsStorePorts): ServerSettingsStore {
	const { backend, options, storePath, dataRoot } = ports;
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
	return settingsStore;
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
