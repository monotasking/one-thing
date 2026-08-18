import type { JsonObject } from "@onething/core";
import { detectCopilotModelCapabilities as detectCopilotLikeModelCapabilities } from "./github-copilot.js";
import { getOnethingModelsDevProviderId } from "./models-dev-catalog.js";
import type { OnethingKimiEndpointConfig } from "./kimi.js";
import {
	ONETHING_QWEN_PROVIDER_ID,
	onethingQwenBackfillModels,
	type OnethingQwenEndpointConfig,
} from "./qwen.js";
// Catalog-key rules live in models-dev-catalog.ts (the renderer imports that
// file alone); re-exported here so existing callers keep their import path.
export {
	getOnethingModelsDevProviderId,
	ONETHING_PROVIDER_MAPPING,
} from "./models-dev-catalog.js";

export const ONETHING_MODELS_DEV_API = "https://models.dev/api.json";

const CLAUDE_CODE_MODEL_PATTERNS = [
	"claude-sonnet",
	"claude-haiku",
	"claude-opus",
	"claude-3-5",
	"claude-3.5",
	"claude-3.7",
	"claude-4",
];

const MODEL_NAME_ALIASES: Record<string, string> = {
	"gemini-2.5-flash-image": "Nano-Banana",
	"gemini-2.5-flash-image-preview": "Nano-Banana Preview",
};

export interface OnethingModelsDevModel {
	id: string;
	name: string;
	family?: string;
	release_date?: string;
	last_updated?: string;
	reasoning?: boolean;
	temperature?: boolean;
	tool_call?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	limit?: { context?: number; output?: number };
	modalities?: { input?: string[]; output?: string[] };
}

export interface OnethingModelsDevProvider {
	id: string;
	name: string;
	models: Record<string, OnethingModelsDevModel>;
}

export type OnethingModelsDevResponse = Record<
	string,
	OnethingModelsDevProvider
>;

export interface OnethingOpenRouterModel {
	id: string;
	name: string;
	description?: string;
	context_length: number;
	architecture: {
		modality: string;
		input_modalities: string[];
		output_modalities: string[];
		tokenizer: string;
	};
	pricing: {
		prompt: string;
		completion: string;
		request: string;
		image: string;
	};
	top_provider: {
		context_length: number;
		max_completion_tokens: number;
		is_moderated: boolean;
	};
	supported_parameters: string[];
	last_updated?: string;
	providerMetadata?: JsonObject;
}

export interface OnethingModelCapabilityOverride {
	tools?: boolean;
	vision?: boolean;
	reasoning?: boolean;
	imageOutput?: boolean;
	audio?: boolean;
}

export interface OnethingModelCapabilityEntry {
	id: string;
	name: string;
	provider: string;
	contextLength: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsReasoning: boolean;
	supportsImageOutput: boolean;
	supportsTemperature: boolean;
	inputModalities: string[];
	outputModalities: string[];
	pricing: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	lastUpdated?: string;
	providerMetadata?: JsonObject;
}

export interface OnethingProviderModelConfig extends OnethingQwenEndpointConfig {
	models?: Record<string, OnethingModelCapabilityEntry>;
	modelsLastFetched?: number;
	modelCapabilitiesByModel?: Record<string, OnethingModelCapabilityOverride>;
	/** Per-model context-window override, keyed by model id. */
	contextLengthByModel?: Record<string, number>;
}

export type OnethingProviderModelConfigs = Record<
	string,
	OnethingProviderModelConfig | undefined
>;

export interface OnethingModelRegistryQueryOptions {
	getFallbackModelsForProvider?(providerId: string): OnethingOpenRouterModel[];
	getFallbackModel?(
		modelId: string,
		providerId?: string,
	): OnethingOpenRouterModel | undefined;
}

export interface OnethingModelRegistrySettingsLike {
	ai: {
		providers: OnethingProviderModelConfigs;
	};
}

export interface OnethingModelRegistryRefreshLogger {
	log?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

export interface OnethingModelRegistryRefreshAdapters<
	TSettings extends
		OnethingModelRegistrySettingsLike = OnethingModelRegistrySettingsLike,
> {
	getSettings(): TSettings;
	saveSettings(settings: TSettings): void;
	fetchModelsDevData(): Promise<OnethingModelsDevResponse>;
	now?(): number;
	logger?: OnethingModelRegistryRefreshLogger;
}

export interface OnethingConfiguredModelSelection {
	model?: string;
	selectedModels?: string[];
}

export interface OnethingACPAgentModelLike {
	id: string;
	name?: string;
	description?: string;
	command?: string;
	args?: string[];
	enabled?: boolean;
}

export interface FetchOnethingModelsDevDataOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface GetOnethingModelsWithCapabilitiesRequest {
	providerId: string;
	forceRefresh?: boolean;
}

export interface GetOnethingModelsWithCapabilitiesResult {
	success: boolean;
	models?: OnethingOpenRouterModel[];
	error?: string;
}

export interface GetOnethingModelsWithCapabilitiesProviderIds {
	githubCopilot?: readonly string[];
	codex?: readonly string[];
	acp?: readonly string[];
}

export interface GetOnethingModelsWithCapabilitiesAdapters {
	getModelsForProvider(providerId: string): Promise<OnethingOpenRouterModel[]>;
	fetchCopilotModels(): Promise<
		Array<{ id: string; name?: string; description?: string }>
	>;
	fetchCodexModels(): Promise<OnethingOpenRouterModel[]>;
	saveProviderModels(
		providerId: string,
		models: OnethingOpenRouterModel[],
	): Promise<void> | void;
	getCodexFallbackModels(modelIds?: string[]): OnethingOpenRouterModel[];
	getConfiguredCodexModelSelection():
		| OnethingConfiguredModelSelection
		| undefined;
	getACPAgents(): OnethingACPAgentModelLike[] | undefined;
	providerIds?: GetOnethingModelsWithCapabilitiesProviderIds;
	logger?: OnethingModelRegistryRefreshLogger;
}

export interface OnethingAccessTokenLike {
	accessToken?: string | null;
}

export interface FetchOnethingGitHubCopilotModelsWithAuthOptions<
	TModel = unknown,
> {
	providerId?: string;
	getToken(
		providerId: string,
	):
		| Promise<OnethingAccessTokenLike | null | undefined>
		| OnethingAccessTokenLike
		| null
		| undefined;
	fetchCopilotModels(accessToken: string): Promise<TModel[]> | TModel[];
	missingTokenError?: string;
}

export async function fetchOnethingGitHubCopilotModelsWithAuth<
	TModel = unknown,
>(
	options: FetchOnethingGitHubCopilotModelsWithAuthOptions<TModel>,
): Promise<TModel[]> {
	const providerId = options.providerId ?? "github-copilot";
	const token = await options.getToken(providerId);
	if (!token?.accessToken) {
		throw new Error(
			options.missingTokenError ?? "Not logged in to GitHub Copilot",
		);
	}
	return await options.fetchCopilotModels(token.accessToken);
}


export async function fetchOnethingModelsDevData(
	fetchImpl: typeof globalThis.fetch,
	options: FetchOnethingModelsDevDataOptions = {},
): Promise<OnethingModelsDevResponse> {
	const response = await fetchImpl(ONETHING_MODELS_DEV_API, {
		headers: {
			Accept: "application/json",
			...options.headers,
		},
		signal: options.signal,
	});

	if (!response.ok) throw new Error(`models.dev API error: ${response.status}`);

	return response.json() as Promise<OnethingModelsDevResponse>;
}

export function getRefreshableOnethingProviderIds(
	providers: OnethingProviderModelConfigs | undefined,
): string[] {
	if (!providers) return [];
	return Object.keys(providers).filter((providerId) => {
		if (providerId === "custom") return false;
		if (providerId === "codex") return false;
		return true;
	});
}

export function mergeOnethingModelsById<TModel extends { id: string }>(
	...groups: TModel[][]
): TModel[] {
	const merged = new Map<string, TModel>();
	for (const group of groups) {
		for (const model of group) {
			if (!merged.has(model.id)) {
				merged.set(model.id, model);
			}
		}
	}
	return Array.from(merged.values());
}

export function getConfiguredOnethingModelIds(
	config?: OnethingConfiguredModelSelection,
): string[] {
	return Array.from(
		new Set(
			[
				...(config?.selectedModels ?? []),
				...(config?.model ? [config.model] : []),
			].filter(Boolean),
		),
	);
}

export function getConfiguredOnethingFallbackModels(
	config: OnethingConfiguredModelSelection | undefined,
	getFallbackModels: (modelIds?: string[]) => OnethingOpenRouterModel[],
): OnethingOpenRouterModel[] {
	const modelIds = getConfiguredOnethingModelIds(config);
	return modelIds.length > 0 ? getFallbackModels(modelIds) : [];
}

export function copilotModelInfoToOnethingOpenRouterModel(
	model: { id: string; name?: string; description?: string },
	capabilities = detectCopilotLikeModelCapabilities(model.id),
): OnethingOpenRouterModel {
	const inputModalities = ["text"];
	const outputModalities = ["text"];
	const supportedParameters: string[] = [];
	if (capabilities.hasVision) inputModalities.push("image");
	if (capabilities.hasImageGeneration) outputModalities.push("image");
	if (capabilities.hasTools) supportedParameters.push("tools");
	if (capabilities.hasReasoning) supportedParameters.push("reasoning");

	return {
		id: model.id,
		name: model.name || model.id,
		description: model.description || "",
		context_length: capabilities.contextLength,
		architecture: {
			modality: capabilities.hasImageGeneration ? "image" : "text",
			input_modalities: inputModalities,
			output_modalities: outputModalities,
			tokenizer: "unknown",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: capabilities.contextLength,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: supportedParameters,
	};
}

export function acpAgentToOnethingOpenRouterModel(
	agent: OnethingACPAgentModelLike,
): OnethingOpenRouterModel {
	return {
		id: agent.id,
		name: agent.name || agent.id,
		description:
			agent.description ||
			`ACP agent command: ${[agent.command, ...(agent.args ?? [])].filter(Boolean).join(" ")}`,
		context_length: 128000,
		architecture: {
			modality: "text",
			input_modalities: ["text"],
			output_modalities: ["text"],
			tokenizer: "external",
		},
		pricing: { prompt: "0", completion: "0", request: "0", image: "0" },
		top_provider: {
			context_length: 128000,
			max_completion_tokens: 16384,
			is_moderated: false,
		},
		supported_parameters: [],
		providerMetadata: {
			acp: {
				command: agent.command,
				enabled: agent.enabled,
				status: "local-agent",
			},
		},
	};
}

export function acpAgentsToOnethingOpenRouterModels(
	agents: OnethingACPAgentModelLike[] | undefined,
): OnethingOpenRouterModel[] {
	return (agents ?? []).map(acpAgentToOnethingOpenRouterModel);
}

function providerIdMatches(
	providerId: string,
	values: readonly string[] | undefined,
	defaults: readonly string[],
): boolean {
	return [...defaults, ...(values ?? [])].includes(providerId);
}

function isOnethingGitHubCopilotProviderId(
	providerId: string,
	aliases?: GetOnethingModelsWithCapabilitiesProviderIds,
): boolean {
	return providerIdMatches(providerId, aliases?.githubCopilot, [
		"github-copilot",
	]);
}

function isOnethingCodexProviderId(
	providerId: string,
	aliases?: GetOnethingModelsWithCapabilitiesProviderIds,
): boolean {
	return providerIdMatches(providerId, aliases?.codex, ["codex"]);
}

function isOnethingACPProviderId(
	providerId: string,
	aliases?: GetOnethingModelsWithCapabilitiesProviderIds,
): boolean {
	return providerIdMatches(providerId, aliases?.acp, ["acp"]);
}

function getConfiguredCodexFallbackModelsWithAdapters(
	adapters: Pick<
		GetOnethingModelsWithCapabilitiesAdapters,
		"getConfiguredCodexModelSelection" | "getCodexFallbackModels"
	>,
): OnethingOpenRouterModel[] {
	return getConfiguredOnethingFallbackModels(
		adapters.getConfiguredCodexModelSelection(),
		adapters.getCodexFallbackModels,
	);
}

async function getCachedCodexModelsWithFallbacks(
	adapters: Pick<
		GetOnethingModelsWithCapabilitiesAdapters,
		| "getModelsForProvider"
		| "getConfiguredCodexModelSelection"
		| "getCodexFallbackModels"
	>,
	includeDefaultFallback = false,
): Promise<OnethingOpenRouterModel[]> {
	const registryModels = await adapters.getModelsForProvider("codex");
	const groups = [
		registryModels,
		getConfiguredCodexFallbackModelsWithAdapters(adapters),
	];
	if (includeDefaultFallback) {
		groups.push(adapters.getCodexFallbackModels());
	}
	return mergeOnethingModelsById(...groups);
}

export async function getOnethingModelsWithCapabilities(
	request: GetOnethingModelsWithCapabilitiesRequest,
	adapters: GetOnethingModelsWithCapabilitiesAdapters,
): Promise<GetOnethingModelsWithCapabilitiesResult> {
	try {
		if (
			isOnethingGitHubCopilotProviderId(
				request.providerId,
				adapters.providerIds,
			)
		) {
			try {
				const copilotModels = await adapters.fetchCopilotModels();
				return {
					success: true,
					models: copilotModels.map((model) =>
						copilotModelInfoToOnethingOpenRouterModel(model),
					),
				};
			} catch (error) {
				adapters.logger?.warn?.(
					"[Models] Failed to fetch Copilot models:",
					error instanceof Error ? error.message : String(error),
				);
				const registryModels =
					await adapters.getModelsForProvider("github-copilot");
				if (registryModels.length > 0) {
					return { success: true, models: registryModels };
				}
				return {
					success: false,
					error: "No models available. Please refresh the model registry.",
				};
			}
		}

		if (isOnethingCodexProviderId(request.providerId, adapters.providerIds)) {
			if (!request.forceRefresh) {
				return {
					success: true,
					models: await getCachedCodexModelsWithFallbacks(adapters),
				};
			}

			try {
				const models = await adapters.fetchCodexModels();
				await adapters.saveProviderModels("codex", models);
				return {
					success: true,
					models: mergeOnethingModelsById(
						models,
						getConfiguredCodexFallbackModelsWithAdapters(adapters),
					),
				};
			} catch (error) {
				adapters.logger?.warn?.(
					"[Models] Failed to fetch Codex models, using fallback:",
					error instanceof Error ? error.message : String(error),
				);
				return {
					success: true,
					models: await getCachedCodexModelsWithFallbacks(adapters, true),
				};
			}
		}

		if (isOnethingACPProviderId(request.providerId, adapters.providerIds)) {
			return {
				success: true,
				models: acpAgentsToOnethingOpenRouterModels(adapters.getACPAgents()),
			};
		}

		const models = await adapters.getModelsForProvider(request.providerId);
		return { success: true, models };
	} catch (error) {
		adapters.logger?.error?.(
			"[Models] Failed to get models with capabilities:",
			error,
		);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function saveOnethingProviderModels<
	TSettings extends OnethingModelRegistrySettingsLike,
>(
	providerId: string,
	models: OnethingOpenRouterModel[],
	adapters: Pick<
		OnethingModelRegistryRefreshAdapters<TSettings>,
		"getSettings" | "saveSettings" | "now" | "logger"
	>,
): void {
	const settings = adapters.getSettings();
	const providerConfig = settings.ai.providers[providerId] || {};
	providerConfig.models = createOnethingModelEntriesFromOpenRouterModels(
		providerId,
		models,
	);
	providerConfig.modelsLastFetched = adapters.now?.() ?? Date.now();
	settings.ai.providers[providerId] = providerConfig;
	adapters.saveSettings(settings);
	adapters.logger?.log?.(
		`[ModelRegistry] Saved ${Object.keys(providerConfig.models).length} provider-direct models for ${providerId}`,
	);
}

export async function refreshOnethingProviderModels<
	TSettings extends OnethingModelRegistrySettingsLike,
>(
	providerId: string,
	adapters: OnethingModelRegistryRefreshAdapters<TSettings>,
): Promise<void> {
	adapters.logger?.log?.(
		`[ModelRegistry] Refreshing models for provider: ${providerId}`,
	);

	if (providerId === "codex") {
		adapters.logger?.log?.(
			"[ModelRegistry] Codex models are loaded from the authenticated Codex backend",
		);
		return;
	}

	const data = await adapters.fetchModelsDevData();
	const settings = adapters.getSettings();
	const providerConfig = settings.ai.providers[providerId] || {};
	const models = createOnethingModelEntriesFromModelsDev(
		providerId,
		data,
		providerConfig,
	);

	if (!models) {
		adapters.logger?.warn?.(
			`[ModelRegistry] No models.dev data found for provider: ${providerId} (dev key: ${getOnethingModelsDevProviderId(providerId, providerConfig)})`,
		);
		return;
	}

	providerConfig.models = models;
	providerConfig.modelsLastFetched = adapters.now?.() ?? Date.now();
	settings.ai.providers[providerId] = providerConfig;

	adapters.saveSettings(settings);
	adapters.logger?.log?.(
		`[ModelRegistry] Saved ${Object.keys(models).length} models for provider ${providerId}`,
	);
}

export async function refreshAllOnethingProviderModels<
	TSettings extends OnethingModelRegistrySettingsLike,
>(adapters: OnethingModelRegistryRefreshAdapters<TSettings>): Promise<void> {
	const settings = adapters.getSettings();
	const providers = settings?.ai?.providers;
	if (!providers) return;

	const providerIds = getRefreshableOnethingProviderIds(providers);

	adapters.logger?.log?.(
		`[ModelRegistry] Refreshing models for ${providerIds.length} providers: ${providerIds.join(", ")}`,
	);

	const data = await adapters.fetchModelsDevData();

	for (const providerId of providerIds) {
		const providerConfig = providers[providerId] || {};
		const models = createOnethingModelEntriesFromModelsDev(
			providerId,
			data,
			providerConfig,
		);

		if (!models) {
			adapters.logger?.warn?.(
				`[ModelRegistry] No models.dev data for provider: ${providerId}`,
			);
			continue;
		}

		providerConfig.models = models;
		providerConfig.modelsLastFetched = adapters.now?.() ?? Date.now();
		settings.ai.providers[providerId] = providerConfig;

		adapters.logger?.log?.(
			`[ModelRegistry]   ${providerId}: ${Object.keys(models).length} models`,
		);
	}

	adapters.saveSettings(settings);
	adapters.logger?.log?.("[ModelRegistry] All providers refreshed");
}

export function modelsDevModelToOnethingCapabilityEntry(
	model: OnethingModelsDevModel,
	providerId: string,
): OnethingModelCapabilityEntry {
	const inputMods = model.modalities?.input || ["text"];
	const outputMods = model.modalities?.output || ["text"];

	return {
		id: model.id,
		name: MODEL_NAME_ALIASES[model.id] || model.name,
		provider: providerId,
		contextLength: model.limit?.context || 128000,
		// 0 = unknown. Never invent 4096 here: a made-up ceiling later reads as
		// "the model's max" and nobody can tell it apart from a real one.
		maxOutputTokens: model.limit?.output || 0,
		supportsTools: model.tool_call === true,
		supportsVision: inputMods.includes("image"),
		supportsReasoning: model.reasoning === true,
		supportsImageOutput: outputMods.includes("image"),
		supportsTemperature: model.temperature !== false,
		inputModalities: inputMods,
		outputModalities: outputMods,
		pricing: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cache_read ?? 0,
			cacheWrite: model.cost?.cache_write ?? 0,
		},
		lastUpdated: model.last_updated || model.release_date,
	};
}

export function openRouterModelToOnethingCapabilityEntry(
	model: OnethingOpenRouterModel,
	providerId: string,
): OnethingModelCapabilityEntry {
	const inputModalities = model.architecture?.input_modalities || ["text"];
	const outputModalities = model.architecture?.output_modalities || ["text"];
	const supportedParameters = model.supported_parameters || [];

	return {
		id: model.id,
		name: model.name || model.id,
		provider: providerId,
		contextLength:
			model.context_length || model.top_provider?.context_length || 128000,
		maxOutputTokens: model.top_provider?.max_completion_tokens || 0,
		supportsTools: supportedParameters.includes("tools"),
		supportsVision: inputModalities.includes("image"),
		supportsReasoning: supportedParameters.includes("reasoning"),
		supportsImageOutput: outputModalities.includes("image"),
		supportsTemperature: supportedParameters.includes("temperature"),
		inputModalities,
		outputModalities,
		pricing: {
			input: Number(model.pricing?.prompt ?? 0) || 0,
			output: Number(model.pricing?.completion ?? 0) || 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		lastUpdated: model.last_updated,
		providerMetadata: model.providerMetadata,
	};
}

export function onethingCapabilityEntryToOpenRouterModel(
	entry: OnethingModelCapabilityEntry,
): OnethingOpenRouterModel {
	const supportedParams: string[] = [];
	if (entry.supportsTemperature) supportedParams.push("temperature");
	if (entry.supportsTools) supportedParams.push("tools");
	if (entry.supportsReasoning) supportedParams.push("reasoning");

	return {
		id: entry.id,
		name: entry.name,
		context_length: entry.contextLength,
		architecture: {
			modality: entry.supportsVision ? "multimodal" : "text",
			input_modalities: entry.inputModalities,
			output_modalities: entry.outputModalities,
			tokenizer: "unknown",
		},
		pricing: {
			prompt: String(entry.pricing.input),
			completion: String(entry.pricing.output),
			request: "0",
			image: "0",
		},
		top_provider: {
			context_length: entry.contextLength,
			max_completion_tokens: entry.maxOutputTokens,
			is_moderated: false,
		},
		supported_parameters: supportedParams,
		last_updated: entry.lastUpdated,
		providerMetadata: entry.providerMetadata,
	};
}

export function createOnethingModelEntriesFromModelsDev(
	providerId: string,
	data: OnethingModelsDevResponse,
	config?: OnethingQwenEndpointConfig & OnethingKimiEndpointConfig,
): Record<string, OnethingModelCapabilityEntry> | undefined {
	const devProvider = data[getOnethingModelsDevProviderId(providerId, config)];
	if (!devProvider) return undefined;

	const models: Record<string, OnethingModelCapabilityEntry> = {};
	for (const [modelId, model] of Object.entries(devProvider.models)) {
		models[modelId] = modelsDevModelToOnethingCapabilityEntry(
			model,
			providerId,
		);
	}

	if (providerId === ONETHING_QWEN_PROVIDER_ID) {
		// Gap-fill only: a real catalog entry always outranks the backfill.
		for (const model of onethingQwenBackfillModels(config)) {
			if (models[model.id]) continue;
			models[model.id] = modelsDevModelToOnethingCapabilityEntry(
				model,
				providerId,
			);
		}
	}

	return models;
}

export function createOnethingModelEntriesFromOpenRouterModels(
	providerId: string,
	models: OnethingOpenRouterModel[],
): Record<string, OnethingModelCapabilityEntry> {
	const entries: Record<string, OnethingModelCapabilityEntry> = {};
	for (const model of models) {
		entries[model.id] = openRouterModelToOnethingCapabilityEntry(
			model,
			providerId,
		);
	}
	return entries;
}

export function sortOnethingModels(
	models: OnethingOpenRouterModel[],
): OnethingOpenRouterModel[] {
	return [...models].sort((a, b) => {
		const ad = a.last_updated || "";
		const bd = b.last_updated || "";
		if (ad && !bd) return -1;
		if (!ad && bd) return 1;
		if (!ad && !bd) return a.id.localeCompare(b.id);
		return bd.localeCompare(ad);
	});
}

export function getOnethingModelsForProvider(
	providers: OnethingProviderModelConfigs | undefined,
	providerId: string,
	options: OnethingModelRegistryQueryOptions = {},
): OnethingOpenRouterModel[] {
	const models = getProviderModels(providers, providerId);
	if (!models) {
		return options.getFallbackModelsForProvider?.(providerId) ?? [];
	}

	let entries = Object.values(models);
	if (providerId === "claude-code") {
		entries = entries.filter((entry) => {
			const lower = entry.id.toLowerCase();
			return CLAUDE_CODE_MODEL_PATTERNS.some((pattern) =>
				lower.includes(pattern),
			);
		});
	}

	return sortOnethingModels(
		entries.map(onethingCapabilityEntryToOpenRouterModel),
	);
}

export function getAllOnethingModels(
	providers: OnethingProviderModelConfigs | undefined,
): OnethingOpenRouterModel[] {
	if (!providers) return [];

	const all: OnethingOpenRouterModel[] = [];
	for (const providerId of Object.keys(providers)) {
		const models = providers[providerId]?.models;
		if (!models) continue;
		for (const entry of Object.values(models)) {
			all.push(onethingCapabilityEntryToOpenRouterModel(entry));
		}
	}
	return sortOnethingModels(all);
}

export function searchOnethingModels(
	providers: OnethingProviderModelConfigs | undefined,
	query: string,
	providerId?: string,
	options: OnethingModelRegistryQueryOptions = {},
): OnethingOpenRouterModel[] {
	const models = providerId
		? getOnethingModelsForProvider(providers, providerId, options)
		: getAllOnethingModels(providers);
	const lower = query.toLowerCase();
	return models.filter(
		(model) =>
			model.id.toLowerCase().includes(lower) ||
			model.name.toLowerCase().includes(lower) ||
			model.description?.toLowerCase().includes(lower),
	);
}

export function getOnethingModelById(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
	options: OnethingModelRegistryQueryOptions = {},
): OnethingOpenRouterModel | undefined {
	const entry = getModelEntry(providers, modelId, providerId);
	if (entry) return onethingCapabilityEntryToOpenRouterModel(entry);
	return options.getFallbackModel?.(modelId, providerId);
}

/**
 * Raw capability entry with numeric USD-per-1M-token pricing (input/output/
 * cacheRead/cacheWrite), for cost math. `getOnethingModelById` converts this
 * into the legacy OpenRouter string-pricing shape instead — use this
 * accessor when you need to multiply, not just display.
 */
export function getOnethingModelCapabilityEntry(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
): OnethingModelCapabilityEntry | undefined {
	return getModelEntry(providers, modelId, providerId);
}

export function getOnethingModelContextLength(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
	options: OnethingModelRegistryQueryOptions = {},
): number {
	// User override wins: a hand-added or self-hosted model has no registry
	// entry, and the 128000 fallback below would silently mis-budget context
	// compaction for anything with a different window.
	const override = providerId
		? providers?.[providerId]?.contextLengthByModel?.[modelId]
		: undefined;
	if (typeof override === "number" && override > 0) return override;

	const entry = getModelEntry(providers, modelId, providerId);
	if (entry?.contextLength) return entry.contextLength;

	const fallback = options.getFallbackModel?.(modelId, providerId);
	return (
		fallback?.context_length || fallback?.top_provider?.context_length || 128000
	);
}

/**
 * Strict variant: the model's real max output, or undefined when nobody knows.
 * No 4096 fallback (2026-08-15 ruling): a caller that needs "no artificial
 * cap" passes this straight through, and passes nothing when it is unknown.
 */
export function getOnethingKnownModelMaxOutputTokens(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
	options: OnethingModelRegistryQueryOptions = {},
): number | undefined {
	const entry = getModelEntry(providers, modelId, providerId);
	if (entry?.maxOutputTokens) return entry.maxOutputTokens;
	const fallback = options.getFallbackModel?.(modelId, providerId);
	const known = fallback?.top_provider?.max_completion_tokens;
	return known && known > 0 ? known : undefined;
}

export function getOnethingModelMaxOutputTokens(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
	options: OnethingModelRegistryQueryOptions = {},
): number {
	const entry = getModelEntry(providers, modelId, providerId);
	if (entry?.maxOutputTokens) return entry.maxOutputTokens;

	const fallback = options.getFallbackModel?.(modelId, providerId);
	return fallback?.top_provider?.max_completion_tokens || 4096;
}

export function onethingModelSupportsTools(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
): boolean {
	if (providerId === "acp") return false;

	const override = getCapabilityOverride(
		providers,
		modelId,
		providerId,
		"tools",
	);
	if (override !== undefined) return override;

	const entry = getModelEntry(providers, modelId, providerId);
	if (entry) return entry.supportsTools;

	const lower = modelId.toLowerCase();
	if (
		[
			"image",
			"vision-preview",
			"dall-e",
			"imagen",
			"ocr",
			"embedding",
			"asr",
		].some((pattern) => lower.includes(pattern))
	) {
		return false;
	}
	return true;
}

export function onethingModelSupportsTemperature(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
): boolean {
	if (providerId === "acp") return false;

	const entry = getModelEntry(providers, modelId, providerId);
	if (entry) return entry.supportsTemperature;
	return true;
}

// Reasoning support moved to model-capability.ts (resolveOnethingModelCapabilities).
// The two former lookups here (async + sync) had drifted apart and had no
// callers outside this registry — deleted 2026-07-18.

export function onethingModelSupportsImageGeneration(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
): boolean {
	const override = getCapabilityOverride(
		providers,
		modelId,
		providerId,
		"imageOutput",
	);
	if (override !== undefined) return override;

	const lower = modelId.toLowerCase();
	if (lower.includes("gemini") && lower.includes("image")) return true;
	if (
		[
			"dall-e",
			"dalle",
			"imagen",
			"gpt-image",
			"flux",
			"stable-diffusion",
			"midjourney",
		].some((pattern) => lower.includes(pattern))
	) {
		return true;
	}

	const entry = getModelEntry(providers, modelId, providerId);
	if (entry) return entry.supportsImageOutput;

	return false;
}

export function getOnethingModelCacheStatus(
	providers: OnethingProviderModelConfigs | undefined,
): { lastFetched: number; modelCount: number; isStale: boolean } {
	let total = 0;
	let latest = 0;
	if (providers) {
		for (const providerId of Object.keys(providers)) {
			const config = providers[providerId];
			const count = config?.models ? Object.keys(config.models).length : 0;
			total += count;
			if (config?.modelsLastFetched && config.modelsLastFetched > latest)
				latest = config.modelsLastFetched;
		}
	}
	return { lastFetched: latest, modelCount: total, isStale: total === 0 };
}

export function getOnethingModelDisplayName(modelId: string): string {
	return MODEL_NAME_ALIASES[modelId] || modelId;
}

export function getOnethingModelNameAliases(): Record<string, string> {
	return { ...MODEL_NAME_ALIASES };
}

function getProviderModels(
	providers: OnethingProviderModelConfigs | undefined,
	providerId: string,
): Record<string, OnethingModelCapabilityEntry> | undefined {
	return providers?.[providerId]?.models;
}

function getProviderModelEntry(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId: string,
): OnethingModelCapabilityEntry | undefined {
	return providers?.[providerId]?.models?.[modelId];
}

function getAnyModelEntry(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
): OnethingModelCapabilityEntry | undefined {
	if (!providers) return undefined;
	for (const providerId of Object.keys(providers)) {
		const models = providers[providerId]?.models;
		if (models?.[modelId]) return models[modelId];
	}
	return undefined;
}

function getModelEntry(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId?: string,
): OnethingModelCapabilityEntry | undefined {
	if (providerId) return getProviderModelEntry(providers, modelId, providerId);
	return getAnyModelEntry(providers, modelId);
}

function getCapabilityOverride(
	providers: OnethingProviderModelConfigs | undefined,
	modelId: string,
	providerId: string | undefined,
	key: keyof OnethingModelCapabilityOverride,
): boolean | undefined {
	if (!providerId) return undefined;
	return providers?.[providerId]?.modelCapabilitiesByModel?.[modelId]?.[key];
}
