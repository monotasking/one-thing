/**
 * Model Registry Service
 *
 * Electron main owns host adapters here: settings persistence, bound fetch, and
 * provider-direct fallback hooks. Model metadata conversion/query logic lives in
 * @onething/runtime/providers.
 */

import type { OpenRouterModel } from "@shared/ipc.js";
import {
	catalogFactsOf,
	fetchOnethingModelsDevData,
	getProviderManifest,
	getAllOnethingModels,
	getOnethingModelById,
	getOnethingModelCacheStatus,
	getOnethingModelCapabilityEntry,
	getOnethingModelContextLength,
	getOnethingModelDisplayName,
	getOnethingKnownModelMaxOutputTokens,
	getOnethingModelNameAliases,
	getOnethingModelsForProvider,
	onethingCapabilityEntryToOpenRouterModel,
	onethingModelServesImageOutputInLoop,
	onethingModelSupportsImageGeneration,
	onethingModelSupportsTemperature,
	onethingModelSupportsTools,
	refreshAllOnethingProviderModels,
	refreshOnethingProviderModels,
	saveOnethingProviderModels,
	searchOnethingModels,
	type OnethingModelCapabilityEntry,
	type OnethingModelRegistryQueryOptions,
	type OnethingModelsDevResponse,
	type OnethingOpenRouterModel,
	type OnethingProviderModelConfigs,
} from "@onething/runtime/providers";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createModelsDevCache,
	MODELS_DEV_CACHE_FILE_NAME,
} from "@onething/runtime/providers/models-dev-cache";
import { getOnethingCachePath } from "@onething/runtime/storage/paths";
import { getSettings, getSpaceSettings, saveSettings } from "../../stores/settings.js";
import { fetchProviderDirectModels } from "@onething/runtime/providers/models-endpoint";
import { DEFAULT_SPACE_ID } from "@onething/runtime/spaces/types";
import { resolveSpaceProviderCredentialForSpace } from "./space-credentials.js";
import { createRequiredAppFetch } from "../../provider-binding/bound-fetch.js";
import {
	getCodexFallbackModel,
	getCodexFallbackModels,
} from "./builtin/codex.js";
import { detectModelCapabilities } from "./builtin/github-copilot.js";
import { consolePort, getLogger } from '../logging/index.js'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { OnethingModelRegistryRefreshLogger } from '@onething/runtime/providers/model-registry'
import type { AppSettings } from '@shared/ipc.js'
import type { OnethingModelRegistryRefreshAdapters } from '@onething/runtime/providers/model-registry'

const log = getLogger('providers.registry')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingModelRegistryRefreshLogger = consolePort(log)


// Fallback models for Grok (grok / grok-oauth) when models.dev data is unavailable.
// These provide at least the default model so users don't see "No models found" on first load.
const GROK_FALLBACK_MODELS: Record<string, OpenRouterModel> = {
	"grok-4.5": {
		id: "grok-4.5",
		name: "grok-4.5",
		description: "Grok 4.5",
		context_length: 500000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 500000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
	"grok-4.3": {
		id: "grok-4.3",
		name: "grok-4.3",
		description: "Grok 4.3",
		context_length: 1000000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 1000000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
	"grok-4.20-0309-reasoning": {
		id: "grok-4.20-0309-reasoning",
		name: "grok-4.20-0309-reasoning",
		description: "Grok 4 reasoning",
		context_length: 1000000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 1000000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
	"grok-4.20-0309-non-reasoning": {
		id: "grok-4.20-0309-non-reasoning",
		name: "grok-4.20-0309-non-reasoning",
		description: "Grok 4 non-reasoning",
		context_length: 1000000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 1000000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "temperature"],
	},
	"grok-4.20-multi-agent-0309": {
		id: "grok-4.20-multi-agent-0309",
		name: "grok-4.20-multi-agent-0309",
		description: "Grok 4 multi-agent",
		context_length: 1000000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 1000000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
	"grok-build-0.1": {
		id: "grok-build-0.1",
		name: "grok-build-0.1",
		description: "Grok Build",
		context_length: 256000,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 256000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
	"grok-3-latest": {
		id: "grok-3-latest",
		name: "grok-3-latest",
		description: "Latest Grok 3 model",
		context_length: 131072,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 131072,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "temperature"],
	},
	"grok-3-fast-latest": {
		id: "grok-3-fast-latest",
		name: "grok-3-fast-latest",
		description: "Fast Grok 3 model",
		context_length: 131072,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 131072,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "temperature"],
	},
	"grok-3-mini-latest": {
		id: "grok-3-mini-latest",
		name: "grok-3-mini-latest",
		description: "Grok 3 Mini reasoning model",
		context_length: 131072,
		architecture: {
			modality: "multimodal",
			input_modalities: ["text", "image"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 131072,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: ["tools", "reasoning", "temperature"],
	},
};

function getProviderConfigs(): OnethingProviderModelConfigs | undefined {
	return getSettings()?.ai?.providers as
		| OnethingProviderModelConfigs
		| undefined;
}

function claudeCodeAgentFallbackModelById(modelId: string): OpenRouterModel | undefined {
	// 手填条目没有参数,不拿它盖掉下面那张兜底表(批 2)。
	const entry = catalogFactsOf(getProviderConfigs()?.claude?.models?.[modelId]);
	if (entry) {
		return onethingCapabilityEntryToOpenRouterModel(entry) as OpenRouterModel;
	}
	return getClaudeCodeAgentFallbackModels().find((model) => model.id === modelId);
}

function copilotFallbackModel(modelId: string): OpenRouterModel {
	const caps = detectModelCapabilities(modelId);
	const inputModalities = ["text"];
	const outputModalities = ["text"];
	const supportedParams: string[] = [];
	if (caps.hasVision) inputModalities.push("image");
	if (caps.hasImageGeneration) outputModalities.push("image");
	if (caps.hasTools) supportedParams.push("tools");
	if (caps.hasReasoning) supportedParams.push("reasoning");

	return {
		id: modelId,
		name: modelId,
		description: "",
		context_length: caps.contextLength,
		architecture: {
			modality: caps.hasImageGeneration ? "image" : "text",
			input_modalities: inputModalities,
			output_modalities: outputModalities,
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: caps.contextLength,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: supportedParams,
	};
}

/**
 * 目录里没有时的兜底表,**按 provider id 登记**(批 M:从前是一串按名字的 if)。
 * `model` 答单个型号,`all` 答「这家的目录整个是空的」时列什么。没登记 = 没有兜底。
 */
interface ProviderFallbackCatalog {
	model(modelId: string): OpenRouterModel | undefined;
	all(): OpenRouterModel[];
}

const GROK_FALLBACK_CATALOG: ProviderFallbackCatalog = {
	model: (modelId) => GROK_FALLBACK_MODELS[modelId],
	all: () => Object.values(GROK_FALLBACK_MODELS),
};

const PROVIDER_FALLBACK_CATALOGS: Readonly<Record<string, ProviderFallbackCatalog>> = {
	codex: {
		model: (modelId) => getCodexFallbackModel(modelId),
		all: () => getCodexFallbackModels(),
	},
	"claude-code-agent": {
		model: claudeCodeAgentFallbackModelById,
		all: () => getClaudeCodeAgentFallbackModels(),
	},
	"github-copilot": {
		model: copilotFallbackModel,
		all: () => [],
	},
	// grok / grok-oauth 读同一本 xAI 目录,兜底也是同一张。
	grok: GROK_FALLBACK_CATALOG,
	"grok-oauth": GROK_FALLBACK_CATALOG,
};

function getProviderDirectFallbackModel(
	modelId: string,
	providerId?: string,
): OpenRouterModel | undefined {
	return providerId ? PROVIDER_FALLBACK_CATALOGS[providerId]?.model(modelId) : undefined;
}

function claudeCodeAgentFallbackModel(
	id: string,
	name: string,
	contextLength: number,
): OpenRouterModel {
	return {
		id,
		name,
		description: `${name} via local Claude Code CLI`,
		context_length: contextLength,
		architecture: {
			modality: "text",
			input_modalities: ["text"],
			output_modalities: ["text"],
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: contextLength,
			max_completion_tokens: 64000,
			is_moderated: false,
		},
		supported_parameters: ["reasoning"],
	};
}

/**
 * The CLI drives the same Claude models the API providers already know:
 * reuse the claude provider's registry entries (real context windows and
 * capability flags from models.dev) and only hard-code when the registry
 * has never been populated.
 */
function getClaudeCodeAgentFallbackModels(): OpenRouterModel[] {
	const claudeModels = getProviderConfigs()?.claude?.models ?? {};
	const resolve = (
		id: string,
		name: string,
		contextLength: number,
	): OpenRouterModel => {
		const entry = claudeModels[id];
		if (!entry) return claudeCodeAgentFallbackModel(id, name, contextLength);
		const model = onethingCapabilityEntryToOpenRouterModel(
			entry,
		) as OpenRouterModel;
		return {
			...model,
			description: `${model.name || name} via local Claude Code CLI`,
		};
	};
	return [
		claudeCodeAgentFallbackModel(
			"claude-code-agent",
			"Default (CLI configured)",
			200000,
		),
		resolve("claude-fable-5", "Claude Fable 5", 1000000),
		resolve("claude-opus-5", "Claude Opus 5", 500000),
		resolve("claude-sonnet-5", "Claude Sonnet 5", 500000),
		resolve("claude-haiku-4-5", "Claude Haiku 4.5", 200000),
	];
}

function getProviderFallbackModels(providerId: string): OpenRouterModel[] {
	return PROVIDER_FALLBACK_CATALOGS[providerId]?.all() ?? [];
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
	};
	const resolution = resolveSpaceProviderCredentialForSpace(spaceId, providerId);
	const apiKey = resolution.kind === "entry" ? resolution.entry.apiKey : undefined;
	return {
		baseUrl: merged.baseUrl?.trim() || getProviderManifest(providerId)?.defaultBaseUrl || "",
		...(merged.modelsUrl?.trim() ? { modelsUrl: merged.modelsUrl.trim() } : {}),
		...(merged.headers ? { headers: merged.headers } : {}),
		...(apiKey ? { apiKey } : {}),
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
// resolved by @onething/runtime/providers/model-capability now.

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
