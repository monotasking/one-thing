/**
 * Model Registry Service
 *
 * Electron main owns host adapters here: settings persistence, bound fetch, and
 * provider-direct fallback hooks. Model metadata conversion/query logic lives in
 * @onething/runtime/providers.
 */

import type { OpenRouterModel } from "@shared/ipc.js";
import {
	fetchOnethingModelsDevData,
	getAllOnethingModels,
	getOnethingModelById,
	getOnethingModelCacheStatus,
	getOnethingModelCapabilityEntry,
	getOnethingModelContextLength,
	getOnethingModelDisplayName,
	getOnethingKnownModelMaxOutputTokens,
	getOnethingModelMaxOutputTokens,
	getOnethingModelNameAliases,
	getOnethingModelsForProvider,
	onethingCapabilityEntryToOpenRouterModel,
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
import { getSettings, saveSettings } from "../stores/settings.js";
import { createRequiredAppFetch } from "./bound-fetch.js";
import {
	getCodexFallbackModel,
	getCodexFallbackModels,
} from "./builtin/codex.js";
import { detectModelCapabilities } from "./builtin/github-copilot.js";
import { consolePort, getLogger } from '../wiring/logging/index.js'

const log = getLogger('providers.registry')
/** 注入式鸭子 logger 端口的过渡替身(app/logging/console-port.ts,area ① 统一后删)。 */
const consoleLog = consolePort(log)


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

function getProviderDirectFallbackModel(
	modelId: string,
	providerId?: string,
): OpenRouterModel | undefined {
	if (providerId === "codex") {
		return getCodexFallbackModel(modelId);
	}

	if (providerId === "claude-code-agent") {
		const entry = getProviderConfigs()?.claude?.models?.[modelId];
		if (entry) {
			return onethingCapabilityEntryToOpenRouterModel(
				entry,
			) as OpenRouterModel;
		}
		return getClaudeCodeAgentFallbackModels().find(
			(model) => model.id === modelId,
		);
	}

	if (providerId === "github-copilot") {
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

	// grok / grok-oauth share the same xAI model catalog
	if (providerId === "grok" || providerId === "grok-oauth") {
		return GROK_FALLBACK_MODELS[modelId];
	}

	return undefined;
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
	if (providerId === "codex") return getCodexFallbackModels();
	if (providerId === "grok" || providerId === "grok-oauth")
		return Object.values(GROK_FALLBACK_MODELS);
	if (providerId === "claude-code-agent")
		return getClaudeCodeAgentFallbackModels();
	return [];
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

async function fetchModelsDevData(): Promise<OnethingModelsDevResponse> {
	log.debug("fetching models.dev catalog");

	const data = await fetchOnethingModelsDevData(
		createRequiredAppFetch({ policy: "default" }),
		{
			headers: { "User-Agent": "onething-electron/1.0" },
			signal: AbortSignal.timeout(15000),
		},
	);

	const providerCount = Object.keys(data).length;
	const modelCount = Object.values(data).reduce(
		(sum, provider) => sum + Object.keys(provider.models).length,
		0,
	);
	log.info("models.dev catalog fetched", { modelCount, providerCount });
	return data;
}

/**
 * Refresh models for a specific provider only.
 * Fetches from models.dev and stores results under settings.ai.providers[providerId].models.
 */
export async function refreshProviderModels(providerId: string): Promise<void> {
	await refreshOnethingProviderModels(providerId, {
		getSettings,
		saveSettings,
		fetchModelsDevData,
		logger: consoleLog,
	});
}

/**
 * Refresh models for all configured providers.
 */
export async function refreshAllProviders(): Promise<void> {
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

	await refreshAllOnethingProviderModels({
		getSettings: () => settings,
		saveSettings: (s) => saveSettings(s as any),
		fetchModelsDevData,
		logger: consoleLog,
	});
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

/** Strict: real max output or undefined — never an invented 4096. */
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

export async function getModelMaxOutputTokens(
	modelId: string,
	providerId?: string,
): Promise<number> {
	return getOnethingModelMaxOutputTokens(
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
