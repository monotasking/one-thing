/**
 * GitHub Copilot 的模型目录那一半:列表口取数(GitHub OAuth token → Copilot 补全 token → `/models`)、
 * 列表行的形状、按型号名推的能力与上下文长度、目录里没有时的兜底行。
 *
 * 服务商自述试点 P2 第 4 批从三处搬回家:`providers/github-copilot.ts`(本文件原身)、
 * `providers/model-registry.ts` 的 `copilotModelInfoToOnethingOpenRouterModel`、backend
 * `runtime/providers/{builtin/github-copilot.ts 的取数与缓存, model-registry-service.ts 的兜底行}`。
 * 取数要的 app fetch 由宿主经 `VendorModelsFetcherDeps.fetch` 交进来(policy 名与搬家前一致)。
 */
import { toJsonObject, type JsonValue } from '@shared/json'
import type { OnethingHttpPolicyName } from '../../bound-fetch.js'
import { getLogger } from '../../../logging/index.js'
import { resolveOnethingModelCapabilities } from '../../model-capability.js'
import {
  ONETHING_MODEL_DESCRIPTIONS,
  onethingModelContextLengthHint,
} from '../../model-families/index.js'
import type { OnethingOpenRouterModel } from '../../model-registry.js'

export interface OnethingModelInfo {
  id: string
  name: string
  description?: string
  type?: 'chat' | 'image' | 'embedding' | 'audio' | 'tts' | 'other'
}

export interface OnethingCopilotModelCapabilities {
  hasVision: boolean
  hasImageGeneration: boolean
  hasTools: boolean
  hasReasoning: boolean
  contextLength: number
}

export function modelInfoFromCopilotEntry(entry: JsonValue): OnethingModelInfo | null {
  const record = toJsonObject(entry)
  const id = record.id
  if (typeof id !== 'string' || !id) return null
  const description = record.description
  return {
    id,
    name: id,
    description: typeof description === 'string' ? description : getCopilotModelDescription(id),
    type: 'chat',
  }
}

export function getCopilotModelDescription(modelId: string): string {
  // 型号说明是型号家族的常识,住 `model-families/<family>.ts`,`index.ts` 汇总(P2 第 4 批)。
  return ONETHING_MODEL_DESCRIPTIONS[modelId] || 'GitHub Copilot model'
}

export function detectCopilotModelCapabilities(modelId: string): OnethingCopilotModelCapabilities {
  const id = modelId.toLowerCase()

  // Capability verdicts come from the model-capability ledger (this vendor's rule
  // row in its manifest); the context-length hints are model-family knowledge.
  const resolved = resolveOnethingModelCapabilities({
    providerId: 'github-copilot',
    modelId,
  })
  const hasVision = resolved.vision
  const hasImageGeneration = resolved.imageOutput
  const hasTools = resolved.tools
  const hasReasoning = resolved.reasoning

  // 上下文长度按 id 片段认,表在型号家族的家(`model-families/index.ts`,次序与搬家前那条
  // `if / else if` 链逐字相同);一行都不中 = 128000。
  const contextLength = onethingModelContextLengthHint(id) ?? 128000

  return {
    hasVision,
    hasImageGeneration,
    hasTools,
    hasReasoning,
    contextLength,
  }
}

export function copilotModelInfoToOnethingOpenRouterModel(
	model: { id: string; name?: string; description?: string },
	capabilities = detectCopilotModelCapabilities(model.id),
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

/**
 * 目录里没有这一型时的兜底行(搬家前是 backend `runtime/providers/model-registry-service.ts` 的
 * `copilotFallbackModel`,逐字)。
 */
export function copilotFallbackModel(modelId: string): OnethingOpenRouterModel {
	const caps = detectCopilotModelCapabilities(modelId);
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

// ---------------------------------------------------------------------------
// 列表口取数(搬家前是 backend `runtime/providers/builtin/github-copilot.ts`,逐字;
// `createRequiredAppFetch({ policy })` 换成宿主交进来的 `appFetch(policy)`)
// ---------------------------------------------------------------------------

const log = getLogger('providers.copilot')

/** 宿主的 app fetch(带代理 / 重试策略),按 policy 名取。 */
export type CopilotAppFetch = (policy: OnethingHttpPolicyName) => typeof globalThis.fetch

// Cache for Copilot completion tokens
interface CopilotToken {
  token: string
  expiresAt: number
}

const copilotTokenCache: Map<string, CopilotToken> = new Map()

// Cache for Copilot models
interface CopilotModelsCache {
  models: OnethingModelInfo[]
  cachedAt: number
}

let copilotModelsCache: CopilotModelsCache | null = null
const MODELS_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Exchange GitHub OAuth token for Copilot completion token
 */
async function getCopilotCompletionToken(githubAccessToken: string, appFetch: CopilotAppFetch): Promise<string> {
  // Check cache first
  const cached = copilotTokenCache.get(githubAccessToken)
  if (cached && cached.expiresAt > Date.now() + 60000) { // 1 minute buffer
    return cached.token
  }

  // Request new Copilot token
  const response = await appFetch('auth')('https://api.github.com/copilot_internal/v2/token', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${githubAccessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'onething/1.0',
      'Editor-Version': 'vscode/1.85.1',
      'Editor-Plugin-Version': 'copilot-chat/0.29.1',
    },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to get Copilot token: ${response.status} ${error}`)
  }

  const data = toJsonObject(await response.json())

  // Cache the token
  copilotTokenCache.set(githubAccessToken, {
    token: typeof data.token === 'string' ? data.token : '',
    expiresAt: Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 1800) * 1000, // Default 30 minutes
  })

  if (typeof data.token !== 'string' || !data.token) {
    throw new Error('Failed to get Copilot token: response did not include a token')
  }

  return data.token
}

/**
 * Fetch available models from GitHub Copilot API
 * Uses the Copilot completion token to authenticate
 */
export async function fetchCopilotModels(githubAccessToken: string, appFetch: CopilotAppFetch): Promise<OnethingModelInfo[]> {
  // Check cache first
  if (copilotModelsCache && Date.now() - copilotModelsCache.cachedAt < MODELS_CACHE_TTL) {
    return copilotModelsCache.models
  }

  try {
    // First, get the Copilot completion token
    const copilotToken = await getCopilotCompletionToken(githubAccessToken, appFetch)

    // Fetch models from Copilot API
    const response = await appFetch('default')('https://api.githubcopilot.com/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${copilotToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Copilot-Integration-Id': 'vscode-chat',
        'Editor-Version': 'vscode/1.85.1',
        'Editor-Plugin-Version': 'copilot-chat/0.29.1',
        'User-Agent': 'onething/1.0',
      },
    })

    if (!response.ok) {
      const error = await response.text()
      log.error('fetch copilot models failed', { status: response.status, body: error })
      throw new Error(`Failed to fetch Copilot models: ${response.status}`)
    }

    const data = toJsonObject(await response.json())

    // Parse OpenAI-compatible response format
    const models: OnethingModelInfo[] = Array.isArray(data.data)
      ? data.data.map(modelInfoFromCopilotEntry).filter((model): model is OnethingModelInfo => Boolean(model))
      : []

    // Cache the results
    copilotModelsCache = {
      models,
      cachedAt: Date.now(),
    }

    log.info('copilot models fetched', { count: models.length })
    return models
  } catch (error) {
    log.error('fetch copilot models failed', {}, error)
    throw error
  }
}
