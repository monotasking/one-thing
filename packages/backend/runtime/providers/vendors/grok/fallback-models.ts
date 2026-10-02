/**
 * xAI 目录(models.dev 的 `xai`)拿不到时的兜底行 —— `grok` 与 `grok-oauth` 读同一本目录,兜底也是
 * 同一张(订阅那半边 `vendors/grok-oauth/` 借这里)。
 *
 * 服务商自述试点 P2 第 4 批从 backend `wiring/providers/model-registry.ts` 的 `GROK_FALLBACK_MODELS` /
 * `PROVIDER_FALLBACK_CATALOGS` 搬回家,逐字;经 `VendorRuntime.fallbackModels` 登记。
 */
import type { OnethingOpenRouterModel } from "../../model-registry.js";
import type { VendorFallbackModels } from "../runtimes.js";

// Fallback models for Grok (grok / grok-oauth) when models.dev data is unavailable.
// These provide at least the default model so users don't see "No models found" on first load.
export const GROK_FALLBACK_MODELS: Record<string, OnethingOpenRouterModel> = {
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

export const GROK_FALLBACK_CATALOG: VendorFallbackModels = {
	model: (modelId) => GROK_FALLBACK_MODELS[modelId],
	all: () => Object.values(GROK_FALLBACK_MODELS),
};
