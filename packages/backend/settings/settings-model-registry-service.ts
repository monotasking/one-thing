/**
 * Model Registry Service
 *
 * Electron main owns host adapters here: settings persistence, bound fetch, and
 * provider-direct fallback hooks. Model metadata conversion/query logic lives in
 * @onething/backend/provider.
 */

import type { OpenRouterModel } from "@shared/ipc.js";
import {
	createModelsDevCache,
	fetchOnethingModelsDevData,
	fetchProviderDirectModels,
	getAllOnethingModels,
	getOnethingKnownModelMaxOutputTokens,
	getOnethingModelById,
	getOnethingModelCacheStatus,
	getOnethingModelCapabilityEntry,
	getOnethingModelContextLength,
	getOnethingModelDisplayName,
	getOnethingModelNameAliases,
	getOnethingModelsForProvider,
	getProviderManifest,
	MODELS_DEV_CACHE_FILE_NAME,
	onethingModelServesImageOutputInLoop,
	onethingModelSupportsImageGeneration,
	onethingModelSupportsTemperature,
	onethingModelSupportsTools,
	refreshAllOnethingProviderModels,
	refreshOnethingProviderModels,
	saveOnethingProviderModels,
	searchOnethingModels,
	VENDOR_RUNTIMES,
	type ModelsListMapping,
	type OnethingModelCapabilityEntry,
	type OnethingModelRegistryQueryOptions,
	type OnethingModelRegistryRefreshAdapters,
	type OnethingModelRegistryRefreshLogger,
	type OnethingModelsDevResponse,
	type OnethingOpenRouterModel,
	type OnethingProviderModelConfigs,
	type VendorFallbackModels,
} from "@onething/backend/provider";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getOnethingCachePath } from "@onething/backend/storage";
import { getSettings, getSpaceSettings, saveSettings } from "./settings-store.js";
import { createRequiredAppFetch } from "./settings-proxy-fetch.js";
import { DEFAULT_SPACE_ID } from "@onething/backend/space";
import { consolePort, getLogger } from '@onething/backend/logging'
import type { ConsoleLikePort } from '@onething/backend/logging'
import type { AppSettings } from '@shared/ipc.js'

const log = getLogger('providers.registry')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingModelRegistryRefreshLogger = consolePort(log)


function getProviderConfigs(): OnethingProviderModelConfigs | undefined {
	return getSettings()?.ai?.providers as
		| OnethingProviderModelConfigs
		| undefined;
}

/**
 * 目录里没有时的兜底表,**按 provider id 登记**(批 M:从前是一串按名字的 if)。
 * `model` 答单个型号,`all` 答「这家的目录整个是空的」时列什么。没登记 = 没有兜底。
 *
 * 服务商自述试点 P2 第 4 批起每家的兜底行由自己带(`VendorRuntime.fallbackModels`,住
 * `vendors/<id>/`),这里读名册、不点名。名册在调用时才读(它会拉起 agent-loop,模块加载期读会成环)。
 */
function fallbackCatalogOf(providerId: string): VendorFallbackModels | undefined {
	return VENDOR_RUNTIMES.find((vendor) => vendor.id === providerId)?.fallbackModels;
}

function getProviderDirectFallbackModel(
	modelId: string,
	providerId?: string,
): OpenRouterModel | undefined {
	return providerId ? (fallbackCatalogOf(providerId)?.model(modelId) as OpenRouterModel | undefined) : undefined;
}

function getProviderFallbackModels(providerId: string): OpenRouterModel[] {
	return (fallbackCatalogOf(providerId)?.all() as OpenRouterModel[] | undefined) ?? [];
}

function queryOptions(): OnethingModelRegistryQueryOptions {
	return {
		getFallbackModel:
			getProviderDirectFallbackModel as OnethingModelRegistryQueryOptions["getFallbackModel"],
		getFallbackModelsForProvider:
			getProviderFallbackModels as OnethingModelRegistryQueryOptions["getFallbackModelsForProvider"],
	};
}

export function saveProviderModels(
	providerId: string,
	models: OpenRouterModel[],
): void {
	saveOnethingProviderModels(providerId, models as OnethingOpenRouterModel[], {
		getSettings,
		saveSettings,
		logger: consoleLog,
	});
}

/**
 * models.dev 目录的单份缓存(§5.4):`<store>/cache/models-dev.json`。进程里一个实例
 * (它只有一份内存里的解析结果与一发在飞的请求,没有计时器,不需要拆卸);文件路径
 * 每次现算,store 根换了(测试)就是另一份文件。
 */
const modelsDevCache = createModelsDevCache({
	filePath: () => path.join(getOnethingCachePath(), MODELS_DEV_CACHE_FILE_NAME),
	fs: { readFile, writeFile, rename, mkdir, rm },
	fetch: (input, init) => createRequiredAppFetch({ policy: "default" })(input, init),
	headers: { "User-Agent": "onething-electron/1.0" },
	requestSignal: () => AbortSignal.timeout(15000),
});

/**
 * `force` = 刷新钮:不看 24 小时新鲜度,发一次**条件请求**(304 = 没变,不重下)。
 * 缺省 = 新鲜就读文件,一发网络都不打。
 */
async function fetchModelsDevData(
	options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<OnethingModelsDevResponse> {
	const data = await fetchOnethingModelsDevData(modelsDevCache, options);
	log.debug("models.dev catalog ready", { providerCount: Object.keys(data).length, force: !!options.force });
	return data;
}

/**
 * 认亲索引要的那一份 models.dev 快照(批 3 §6.3)。**不看新鲜度**:有缓存文件就读它
 * (一发网络都不打),只有一份都没有时才去问一次(单飞、落盘)。拿不到 = undefined,
 * 目录照常出、只是没有建议。
 */
export async function getModelsDevSnapshot(): Promise<
	{ data: OnethingModelsDevResponse; fetchedAt: number } | undefined
> {
	try {
		const result = await modelsDevCache.get({ maxAgeMs: Number.POSITIVE_INFINITY });
		return { data: result.data, fetchedAt: result.fetchedAt };
	} catch (error) {
		log.debug("models.dev snapshot unavailable; no parameter suggestions", {
			message: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * 「这个空间这一家的密钥是哪一把」—— 拉自定义服务商的 `/models` 时要带上。答案在凭证功能里
 * (`credentials` 的 `resolveSpaceProviderCredentialForSpace`),从前这里直接 import 它;凭证那一侧又要读设置,
 * 于是设置与凭证两个功能互相引用成环(D24 断边 ②,2026-10-04)。现在由装配(`backend.ts`
 * 的 `configureAppRuntimeAdapters`)在装配时把解析函数递进来;没递进来(进程里没装配过 backend)就当这一家
 * 没有密钥。只有「刷新」那一口(`refreshProviderModels`)用它,读目录的那些函数不受影响。
 */
export type ModelCatalogApiKeyResolver = (spaceId: string, providerId: string) => string | undefined

const modelCatalogCredentials: { resolveApiKey?: ModelCatalogApiKeyResolver } = {}

/** 装配时把「取这个空间这一家的密钥」交进来。幂等:后一次覆盖前一次(各次交进来的是同一个无状态的函数)。 */
export function configureModelCatalogCredentials(resolveApiKey: ModelCatalogApiKeyResolver): void {
	modelCatalogCredentials.resolveApiKey = resolveApiKey;
}

/**
 * 一家在某个空间里的直连参数:接口地址 / 模型列表地址 / 自定义头来自那个空间的设置
 * (自定义服务商的定义叠上它在 `providers[id]` 的那一份),密钥来自那个空间的密钥池。
 */
function directModelsConfigOf(providerId: string, spaceId: string) {
	const ai = getSpaceSettings(spaceId)?.ai;
	const custom = ai?.customProviders?.find((provider) => provider.id === providerId);
	const configured = ai?.providers?.[providerId];
	const merged = { ...(custom ?? {}), ...(configured ?? {}) } as {
		baseUrl?: string;
		modelsUrl?: string;
		headers?: Record<string, string>;
		adapter?: { modelsList?: ModelsListMapping };
	};
	const apiKey = modelCatalogCredentials.resolveApiKey?.(spaceId, providerId);
	return {
		baseUrl: merged.baseUrl?.trim() || getProviderManifest(providerId)?.defaultBaseUrl || "",
		...(merged.modelsUrl?.trim() ? { modelsUrl: merged.modelsUrl.trim() } : {}),
		...(merged.headers ? { headers: merged.headers } : {}),
		...(apiKey ? { apiKey } : {}),
		// 批 4:应用过的适配表带着模型列表映射 —— 解析器多一档「按 spec 映射」。
		...(merged.adapter?.modelsList ? { modelsList: merged.adapter.modelsList } : {}),
	};
}

/**
 * Refresh models for a specific provider only.
 * models.dev 家:重拉目录(条件请求)落盘;`endpoint` 家(自定义服务商,批 3 §6.2):
 * 问它自己的 `/models`,接口地址 / 头 / 密钥按 `spaceId` 那个空间取(缺省默认空间)。
 * 目录全空间共享,落盘照旧走默认空间的生效设置(拆分点只落全局那一半)。
 */
export async function refreshProviderModels(
	providerId: string,
	options: { spaceId?: string } = {},
): Promise<void> {
	const spaceId = options.spaceId?.trim() || DEFAULT_SPACE_ID;
	const modelRegistryRefreshAdapters: OnethingModelRegistryRefreshAdapters<AppSettings> = {
		getSettings,
		saveSettings,
		// 这一口是设置页的「刷新」钮:force = 条件请求,不是无条件重拉。
		fetchModelsDevData: () => fetchModelsDevData({ force: true }),
		fetchEndpointModels: (id) =>
			fetchProviderDirectModels({
				...directModelsConfigOf(id, spaceId),
				fetchImpl: (input, init) => createRequiredAppFetch({ policy: "default" })(input, init),
				signal: AbortSignal.timeout(15000),
			}),
		logger: consoleLog,
	};
	await refreshOnethingProviderModels(providerId, modelRegistryRefreshAdapters);
}

/**
 * Refresh models for all configured providers.
 */
export async function refreshAllProviders(options: { signal?: AbortSignal } = {}): Promise<void> {
	options.signal?.throwIfAborted();
	// Ensure grok / grok-oauth have settings entries so they are included
	// in the model refresh cycle. The builtin list already advertises them,
	// but the refresh only iterates configured providers.
	const settings = getSettings();
	for (const pid of ["grok", "grok-oauth"]) {
		if (!settings.ai.providers[pid]) {
			(settings.ai.providers as Record<string, any>)[pid] = {};
		}
	}
	saveSettings(settings);

	const modelRegistryRefreshAdapters2: OnethingModelRegistryRefreshAdapters<AppSettings> = {
		getSettings: () => settings,
		saveSettings: (s) => saveSettings(s as any),
		fetchModelsDevData: async () => {
			const data = await fetchModelsDevData({ signal: options.signal });
			options.signal?.throwIfAborted();
			return data;
		},
		logger: consoleLog,
	};
	await refreshAllOnethingProviderModels(modelRegistryRefreshAdapters2);
}

export const forceRefresh = refreshAllProviders;

export async function getModelsForProvider(
	providerId: string,
): Promise<OpenRouterModel[]> {
	return getOnethingModelsForProvider(
		getProviderConfigs(),
		providerId,
		queryOptions(),
	) as OpenRouterModel[];
}

export async function getAllModels(): Promise<OpenRouterModel[]> {
	return getAllOnethingModels(getProviderConfigs()) as OpenRouterModel[];
}

export async function searchModels(
	query: string,
	providerId?: string,
): Promise<OpenRouterModel[]> {
	return searchOnethingModels(
		getProviderConfigs(),
		query,
		providerId,
		queryOptions(),
	) as OpenRouterModel[];
}

export async function getModelById(
	modelId: string,
	providerId?: string,
): Promise<OpenRouterModel | undefined> {
	return getOnethingModelById(
		getProviderConfigs(),
		modelId,
		providerId,
		queryOptions(),
	) as OpenRouterModel | undefined;
}

/** Numeric USD-per-1M-token pricing (input/output/cacheRead/cacheWrite) for cost math. */
export function getModelCapabilityEntry(
	modelId: string,
	providerId?: string,
): OnethingModelCapabilityEntry | undefined {
	return getOnethingModelCapabilityEntry(getProviderConfigs(), modelId, providerId);
}

export async function getModelContextLength(
	modelId: string,
	providerId?: string,
): Promise<number> {
	return getOnethingModelContextLength(
		getProviderConfigs(),
		modelId,
		providerId,
		queryOptions(),
	);
}

/**
 * 模型的真实输出上限,或 undefined —— 不知道就说不知道。
 * 非 strict 的那只(`getOnethingModelMaxOutputTokens`,末尾 `|| 4096`)已于
 * 2026-09-09 连同它的产地一起删除:上限未知时下游不传 `max_tokens`。
 */
export async function getKnownModelMaxOutputTokens(
	modelId: string,
	providerId?: string,
): Promise<number | undefined> {
	return getOnethingKnownModelMaxOutputTokens(
		getProviderConfigs(),
		modelId,
		providerId,
		queryOptions(),
	);
}

export async function modelSupportsTools(
	modelId: string,
	providerId?: string,
): Promise<boolean> {
	return onethingModelSupportsTools(getProviderConfigs(), modelId, providerId);
}

export async function modelSupportsTemperature(
	modelId: string,
	providerId?: string,
): Promise<boolean> {
	return onethingModelSupportsTemperature(
		getProviderConfigs(),
		modelId,
		providerId,
	);
}

// modelSupportsReasoning(Sync) deleted 2026-07-18 — reasoning support is
// resolved by @onething/backend/provider/model-capability now.

export async function modelSupportsImageGeneration(
	modelId: string,
	providerId?: string,
): Promise<boolean> {
	return onethingModelSupportsImageGeneration(
		getProviderConfigs(),
		modelId,
		providerId,
	);
}

/**
 * 「这个模型在**回合内**出图吗」(拍板 #13)。同步 —— 判据全在已加载的
 * provider 配置里(目录条目 + 用户 override + 账本的名字表),不必等网络。
 */
export function modelServesImageOutputInLoop(
	modelId: string,
	providerId?: string,
): boolean {
	return onethingModelServesImageOutputInLoop(
		getProviderConfigs(),
		modelId,
		providerId,
	);
}

export function getCacheStatus(): {
	lastFetched: number;
	modelCount: number;
	isStale: boolean;
} {
	return getOnethingModelCacheStatus(getProviderConfigs());
}

export function getModelDisplayName(modelId: string): string {
	return getOnethingModelDisplayName(modelId);
}

export function getModelNameAliases(): Record<string, string> {
	return getOnethingModelNameAliases();
}
