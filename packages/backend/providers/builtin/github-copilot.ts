/**
 * GitHub Copilot Provider Definition
 *
 * Uses OAuth Device Flow authentication with GitHub Copilot subscription.
 * Requires two-step token exchange: GitHub OAuth -> Copilot completion token.
 */

import type { ModelInfo } from '@shared/ipc.js'
import { createRequiredAppFetch } from '../bound-fetch.js'
import { toJsonObject } from '@shared/json.js'
import {
  detectCopilotModelCapabilities,
  githubCopilotBuiltinProvider,
  modelInfoFromCopilotEntry,
  type OnethingCopilotModelCapabilities,
} from '@onething/runtime/providers'
import { getLogger } from '../../logging/index.js'

const log = getLogger('providers.copilot')


// Cache for Copilot completion tokens
interface CopilotToken {
  token: string
  expiresAt: number
}

const copilotTokenCache: Map<string, CopilotToken> = new Map()

// Cache for Copilot models
interface CopilotModelsCache {
  models: ModelInfo[]
  cachedAt: number
}

let copilotModelsCache: CopilotModelsCache | null = null
const MODELS_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

/**
 * Exchange GitHub OAuth token for Copilot completion token
 */
async function getCopilotCompletionToken(githubAccessToken: string): Promise<string> {
  // Check cache first
  const cached = copilotTokenCache.get(githubAccessToken)
  if (cached && cached.expiresAt > Date.now() + 60000) { // 1 minute buffer
    return cached.token
  }

  // Request new Copilot token
  const response = await createRequiredAppFetch({ policy: 'auth' })('https://api.github.com/copilot_internal/v2/token', {
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
export async function fetchCopilotModels(githubAccessToken: string): Promise<ModelInfo[]> {
  // Check cache first
  if (copilotModelsCache && Date.now() - copilotModelsCache.cachedAt < MODELS_CACHE_TTL) {
    return copilotModelsCache.models
  }

  try {
    // First, get the Copilot completion token
    const copilotToken = await getCopilotCompletionToken(githubAccessToken)

    // Fetch models from Copilot API
    const response = await createRequiredAppFetch({ policy: 'default' })('https://api.githubcopilot.com/models', {
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
    const models: ModelInfo[] = Array.isArray(data.data)
      ? data.data.map(modelInfoFromCopilotEntry).filter((model): model is ModelInfo => Boolean(model))
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

export type ModelCapabilities = OnethingCopilotModelCapabilities
export const detectModelCapabilities = detectCopilotModelCapabilities

/**
 * Clear the models cache (useful when token changes)
 */
export function clearCopilotModelsCache(): void {
  copilotModelsCache = null
}

export default githubCopilotBuiltinProvider
