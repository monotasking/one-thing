/**
 * Codex Provider Definition
 *
 * Uses ChatGPT subscription OAuth credentials against the Codex backend.
 *
 * 这里只剩**非请求路径**的那一半:模型列表、ChatGPT 用量拉取、原生工具元数据、
 * `prepareCallOptions`。`createCodexModel`(`doStream`/`doGenerate`)与
 * `createCodexFetch` 那条自带 SSE / usage / 错误 / effort 的请求路径在 P1-d2 整条
 * 删除 —— 生产零调用方,codex 的真实通路是 `agent-loop/providers/wires/`
 * 上的 `OpenAIResponsesWire` × `CODEX_DIALECT`(设计稿 §9 P1「第二套 codex」)。
 */

import type {
  CodexProviderUsage,
  OAuthToken,
  OpenRouterModel,
} from '@shared/ipc.js'
import type { ProviderCallOptions, ProviderCallPreparationContext, ProviderDefinition } from '@onething/runtime/providers/types.wiring'
import { createRequiredAppFetch } from '../../../provider-binding/bound-fetch.js'
import {
  buildOnethingCodexModelsUrl,
  buildOnethingCodexHeaders,
  codexBuiltinProvider,
  codexModelInfoToOnethingOpenRouterModel,
  fetchOnethingCodexModels,
  fetchOnethingCodexUsage,
  getOnethingCodexFallbackModel,
  getOnethingCodexFallbackModels,
  normalizeOnethingCodexUsagePayload,
  ONETHING_CODEX_BASE_URL,
  ONETHING_CODEX_CLIENT_VERSION,
  ONETHING_CODEX_DEFAULT_MODEL,
  ONETHING_CODEX_FALLBACK_INSTRUCTIONS,
  ONETHING_CODEX_PROVIDER_ID,
  ONETHING_CODEX_USAGE_URL,
  prepareOnethingCodexCallOptions,
  type OnethingCodexRawValue,
} from '@onething/runtime/providers'

export const CODEX_PROVIDER_ID = ONETHING_CODEX_PROVIDER_ID
export const CODEX_BASE_URL = ONETHING_CODEX_BASE_URL
export const CODEX_USAGE_URL = ONETHING_CODEX_USAGE_URL
export const CODEX_DEFAULT_MODEL = ONETHING_CODEX_DEFAULT_MODEL
export const CODEX_CLIENT_VERSION = ONETHING_CODEX_CLIENT_VERSION
export const CODEX_FALLBACK_INSTRUCTIONS = ONETHING_CODEX_FALLBACK_INSTRUCTIONS

type CodexRawValue = OnethingCodexRawValue

type FetchFn = typeof globalThis.fetch

export function buildCodexHeaders(token: OAuthToken): Record<string, string> {
  return buildOnethingCodexHeaders(token)
}

export function prepareCodexCallOptions(
  options: ProviderCallOptions,
  _context: ProviderCallPreparationContext,
): ProviderCallOptions {
  return prepareOnethingCodexCallOptions(options)
}

export function buildCodexModelsUrl(): string {
  return buildOnethingCodexModelsUrl()
}

export function getCodexFallbackModel(modelId: string = CODEX_DEFAULT_MODEL): OpenRouterModel {
  return getOnethingCodexFallbackModel(modelId) as OpenRouterModel
}

export function getCodexFallbackModels(modelIds: string[] = [CODEX_DEFAULT_MODEL]): OpenRouterModel[] {
  return getOnethingCodexFallbackModels(modelIds) as OpenRouterModel[]
}

export function codexModelInfoToOpenRouterModel(raw: CodexRawValue): OpenRouterModel | null {
  return codexModelInfoToOnethingOpenRouterModel(raw) as OpenRouterModel | null
}

export async function fetchCodexModels(token: OAuthToken): Promise<OpenRouterModel[]> {
  return fetchOnethingCodexModels(token, createRequiredAppFetch({ policy: 'default' })) as Promise<OpenRouterModel[]>
}

export function normalizeCodexUsagePayload(payload: CodexRawValue): CodexProviderUsage {
  return normalizeOnethingCodexUsagePayload(payload) as CodexProviderUsage
}

export async function fetchCodexUsage(
  token: OAuthToken,
  fetchImpl: FetchFn = createRequiredAppFetch({ policy: 'default' }),
): Promise<CodexProviderUsage> {
  return fetchOnethingCodexUsage(token, fetchImpl) as Promise<CodexProviderUsage>
}

const codexProvider: ProviderDefinition = {
  id: codexBuiltinProvider.id,
  info: codexBuiltinProvider.info as ProviderDefinition['info'],
  prepareCallOptions: prepareCodexCallOptions,
}

export default codexProvider
