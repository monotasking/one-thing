/**
 * models.dev 目录的**单份磁盘缓存**(`docs/design/provider-settings-rework-2026-09.md` §5.4)。
 *
 * 从前每刷新一家 provider 就整份拉一次 `https://models.dev/api.json`(几 MB),一轮
 * 「全部刷新」按家数各拉一次;没有磁盘缓存、没有 ETag,离线就一家都刷不出来。现在:
 *
 *  · 一份文件 `<store>/cache/models-dev.json`,形状 `{ version: 1, etag?, fetchedAt, data }`,
 *    `data` 是 api.json 原样;写法是临时文件 + rename(写到一半被杀不留半个文件);
 *  · `get({ maxAgeMs = 24h, force })`:新鲜就直接读;过期或 `force` 时发**条件请求**
 *    (`If-None-Match`)—— 304 只把 `fetchedAt` 推到现在,200 整份换。`force` 也是
 *    条件请求,不是无条件重拉:刷新钮要的是「确认一下有没有新的」,不是「再下一遍」;
 *  · 网络失败而手上有缓存 → 交缓存并标 `stale: true`(一行 warn);没缓存又失败 → 抛;
 *  · **单飞**:同一时刻只有一发在路上,并发的第二个调用者搭同一发。
 *
 * 所有 provider 的刷新与批 3 的参数建议索引都读这一份。
 *
 * 纯产品层:文件系统、路径、fetch、时钟全部注入,Electron-free。缓存文件不是日志,
 * 不住 `log/`,`LogDirJanitor` 不管它(删了只是下一次多打一发网络)。
 */
import { getLogger } from "../logging/logging.js";
import type { OnethingModelsDevResponse } from "./model-registry.js";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_CACHE_FILE_NAME = "models-dev.json";
/** 24 小时内不重拉。models.dev 一天变不了几次,而目录只是读数的来源之一。 */
export const MODELS_DEV_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const log = getLogger("providers.models-dev");

/** 盘上那份文件的形状。`version` 是给将来换形状用的:不认识的版本读作「没有缓存」。 */
export interface ModelsDevCacheFile {
	version: 1;
	etag?: string;
	fetchedAt: number;
	data: OnethingModelsDevResponse;
}

/** 这个模块要的那几口文件系统操作 —— `node:fs/promises` 的真子集。 */
export interface ModelsDevCacheFs {
	readFile(filePath: string, encoding: "utf8"): Promise<string>;
	writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>;
	rm?(filePath: string, options: { force: true }): Promise<void>;
}

export interface ModelsDevCacheDeps {
	/** 缓存文件的绝对路径;函数形式在每次读写时现算(store 根可能在测试之间换)。 */
	filePath: string | (() => string);
	fs: ModelsDevCacheFs;
	fetch: typeof globalThis.fetch;
	now?: () => number;
	url?: string;
	/** 每发请求都带的头(`User-Agent` 之类)。`Accept` / `If-None-Match` 由这里补。 */
	headers?: Record<string, string>;
	/** 每发网络请求自己的信号(超时之类)。调用方的 `signal` 不进请求 —— 见 `revalidate`。 */
	requestSignal?: () => AbortSignal | undefined;
}

export interface GetModelsDevDataOptions {
	/** 多老算过期。缺省 24 小时。 */
	maxAgeMs?: number;
	/** 不看新鲜度,发一次条件请求(304 = 没变)。 */
	force?: boolean;
	signal?: AbortSignal;
}

export interface ModelsDevDataResult {
	data: OnethingModelsDevResponse;
	fetchedAt: number;
	/** true = 这一次想问网络但没问到,交的是旧缓存。 */
	stale: boolean;
	/** 这份数据从哪来:新鲜缓存 / 304 确认过的缓存 / 200 新下的 / 网络失败退回的缓存。 */
	from: "cache" | "not-modified" | "network" | "stale-cache";
}

export interface ModelsDevCache {
	get(options?: GetModelsDevDataOptions): Promise<ModelsDevDataResult>;
}

function isModelsDevCacheFile(value: unknown): value is ModelsDevCacheFile {
	if (!value || typeof value !== "object") return false;
	const file = value as Partial<ModelsDevCacheFile>;
	return (
		file.version === 1 &&
		typeof file.fetchedAt === "number" &&
		Number.isFinite(file.fetchedAt) &&
		!!file.data &&
		typeof file.data === "object" &&
		(file.etag === undefined || typeof file.etag === "string")
	);
}

function dirnameOf(filePath: string): string {
	const index = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	return index > 0 ? filePath.slice(0, index) : filePath;
}

/** 调用方取消 = 这个调用者不等了;共享的那一发照跑(它的结果仍会落进缓存)。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function errorFields(error: unknown): { message: string } {
	return { message: error instanceof Error ? error.message : String(error) };
}

export function createModelsDevCache(deps: ModelsDevCacheDeps): ModelsDevCache {
	const now = deps.now ?? Date.now;
	const url = deps.url ?? MODELS_DEV_API_URL;
	const resolvePath = () =>
		typeof deps.filePath === "function" ? deps.filePath() : deps.filePath;

	/** 读过一次就留在内存里 —— 几 MB 的 JSON 不该每刷新一家就解析一遍。按路径认。 */
	let memo: { path: string; file: ModelsDevCacheFile } | undefined;
	/** 单飞:在路上的那一发。 */
	let inflight: { path: string; promise: Promise<ModelsDevDataResult> } | undefined;

	async function readCached(filePath: string): Promise<ModelsDevCacheFile | undefined> {
		if (memo?.path === filePath) return memo.file;
		let text: string;
		try {
			text = await deps.fs.readFile(filePath, "utf8");
		} catch {
			return undefined; // 没有文件 = 没有缓存
		}
		try {
			const parsed: unknown = JSON.parse(text);
			if (!isModelsDevCacheFile(parsed)) {
				log.warn("models.dev cache file has an unknown shape; ignoring it", { filePath });
				return undefined;
			}
			memo = { path: filePath, file: parsed };
			return parsed;
		} catch (error) {
			log.warn("models.dev cache file is not valid JSON; ignoring it", {
				filePath,
				...errorFields(error),
			});
			return undefined;
		}
	}

	/** 原子写:临时文件 + rename。写失败不让这一次刷新失败 —— 数据已经在手上了。 */
	async function writeCached(filePath: string, file: ModelsDevCacheFile): Promise<void> {
		memo = { path: filePath, file };
		const temporary = `${filePath}.${now()}-${Math.random().toString(36).slice(2)}.tmp`;
		try {
			await deps.fs.mkdir(dirnameOf(filePath), { recursive: true });
			await deps.fs.writeFile(temporary, JSON.stringify(file), "utf8");
			await deps.fs.rename(temporary, filePath);
		} catch (error) {
			log.warn("failed to write models.dev cache", { filePath, ...errorFields(error) });
			await deps.fs.rm?.(temporary, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * 真去问网络的那一发。**不吃调用方的信号**:它是单飞共享的,一个调用者取消不该
	 * 掐掉搭车的另一个;调用方的取消在 `get` 里用 `raceAbort` 各自生效。
	 */
	async function revalidate(
		filePath: string,
		cached: ModelsDevCacheFile | undefined,
	): Promise<ModelsDevDataResult> {
		try {
			const response = await deps.fetch(url, {
				headers: {
					Accept: "application/json",
					...deps.headers,
					...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
				},
				signal: deps.requestSignal?.(),
			});
			if (response.status === 304 && cached) {
				const fetchedAt = now();
				await writeCached(filePath, { ...cached, fetchedAt });
				log.debug("models.dev catalog not modified", { etag: cached.etag });
				return { data: cached.data, fetchedAt, stale: false, from: "not-modified" };
			}
			if (!response.ok) throw new Error(`models.dev API error: ${response.status}`);
			const data = (await response.json()) as OnethingModelsDevResponse;
			const etag = response.headers?.get?.("etag") ?? undefined;
			const fetchedAt = now();
			await writeCached(filePath, {
				version: 1,
				...(etag ? { etag } : {}),
				fetchedAt,
				data,
			});
			log.info("models.dev catalog downloaded", {
				providerCount: Object.keys(data).length,
				hasEtag: !!etag,
			});
			return { data, fetchedAt, stale: false, from: "network" };
		} catch (error) {
			if (!cached) throw error;
			log.warn("models.dev fetch failed; using the cached catalog", {
				ageMs: now() - cached.fetchedAt,
				...errorFields(error),
			});
			return { data: cached.data, fetchedAt: cached.fetchedAt, stale: true, from: "stale-cache" };
		}
	}

	return {
		async get(options = {}) {
			options.signal?.throwIfAborted();
			const filePath = resolvePath();
			const maxAgeMs = options.maxAgeMs ?? MODELS_DEV_DEFAULT_MAX_AGE_MS;
			const cached = await readCached(filePath);
			if (cached && !options.force && now() - cached.fetchedAt < maxAgeMs) {
				return { data: cached.data, fetchedAt: cached.fetchedAt, stale: false, from: "cache" };
			}
			if (inflight?.path !== filePath) {
				const promise = revalidate(filePath, cached).finally(() => {
					if (inflight?.promise === promise) inflight = undefined;
				});
				inflight = { path: filePath, promise };
			}
			return raceAbort(inflight.promise, options.signal);
		},
	};
}
