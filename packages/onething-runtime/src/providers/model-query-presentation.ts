import type { AgentModelCapabilities, AgentProvider } from '@onething/core/agent-loop'
import {
  agentSupportsInputModality,
  agentSupportsOutputModality,
  resolveAgentModelCapabilities,
} from '@onething/core/agent-loop'

type MaybePromise<T> = T | Promise<T>

export interface OnethingModelQueryIpcLogger {
  error?: (...args: unknown[]) => void
}

export interface GetAllOnethingModelRegistryModelsOptions<TModel = unknown> {
  getAllModels(): MaybePromise<TModel[]>
}

export interface OnethingModelRegistryModelsResult<TModel = unknown> {
  success: true
  models: TModel[]
}

export async function getAllOnethingModelRegistryModels<TModel = unknown>(
  options: GetAllOnethingModelRegistryModelsOptions<TModel>,
): Promise<OnethingModelRegistryModelsResult<TModel>> {
  return {
    success: true,
    models: await options.getAllModels(),
  }
}

export async function getAllOnethingModelRegistryModelsForIpc<TModel = unknown>(
  options: GetAllOnethingModelRegistryModelsOptions<TModel> & { logger?: OnethingModelQueryIpcLogger },
): Promise<OnethingModelRegistryModelsResult<TModel> | { success: false; error: string }> {
  try {
    return await getAllOnethingModelRegistryModels(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'get all models', error)
  }
}

export interface SearchOnethingModelRegistryOptions<TModel = unknown> {
  query: string
  providerId?: string
  searchModels(query: string, providerId?: string): MaybePromise<TModel[]>
}

export async function searchOnethingModelRegistry<TModel = unknown>(
  options: SearchOnethingModelRegistryOptions<TModel>,
): Promise<OnethingModelRegistryModelsResult<TModel>> {
  return {
    success: true,
    models: await options.searchModels(options.query, options.providerId),
  }
}

export async function searchOnethingModelRegistryForIpc<TModel = unknown>(
  options: SearchOnethingModelRegistryOptions<TModel> & { logger?: OnethingModelQueryIpcLogger },
): Promise<OnethingModelRegistryModelsResult<TModel> | { success: false; error: string }> {
  try {
    return await searchOnethingModelRegistry(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'search models', error)
  }
}

export interface RefreshOnethingModelRegistryOptions {
  forceRefresh(): MaybePromise<unknown>
}

export interface RefreshOnethingModelRegistryResult {
  success: true
}

export async function refreshOnethingModelRegistry(
  options: RefreshOnethingModelRegistryOptions,
): Promise<RefreshOnethingModelRegistryResult> {
  await options.forceRefresh()
  return { success: true }
}

export async function refreshOnethingModelRegistryForIpc(
  options: RefreshOnethingModelRegistryOptions & { logger?: OnethingModelQueryIpcLogger },
): Promise<RefreshOnethingModelRegistryResult | { success: false; error: string }> {
  try {
    return await refreshOnethingModelRegistry(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'refresh model registry', error)
  }
}

export interface GetOnethingModelRegistryNameAliasesOptions {
  getModelNameAliases(): Record<string, string>
}

export interface GetOnethingModelRegistryNameAliasesResult {
  success: true
  aliases: Record<string, string>
}

export function getOnethingModelRegistryNameAliases(
  options: GetOnethingModelRegistryNameAliasesOptions,
): GetOnethingModelRegistryNameAliasesResult {
  return {
    success: true,
    aliases: options.getModelNameAliases(),
  }
}

export function getOnethingModelRegistryNameAliasesForIpc(
  options: GetOnethingModelRegistryNameAliasesOptions & { logger?: OnethingModelQueryIpcLogger },
): GetOnethingModelRegistryNameAliasesResult | { success: false; error: string } {
  try {
    return getOnethingModelRegistryNameAliases(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'get model name aliases', error)
  }
}

export interface GetOnethingModelRegistryDisplayNameOptions {
  modelId: string
  getModelDisplayName(modelId: string): string
}

export interface GetOnethingModelRegistryDisplayNameResult {
  success: true
  displayName: string
}

export function getOnethingModelRegistryDisplayName(
  options: GetOnethingModelRegistryDisplayNameOptions,
): GetOnethingModelRegistryDisplayNameResult {
  return {
    success: true,
    displayName: options.getModelDisplayName(options.modelId),
  }
}

export function getOnethingModelRegistryDisplayNameForIpc(
  options: GetOnethingModelRegistryDisplayNameOptions & { logger?: OnethingModelQueryIpcLogger },
): GetOnethingModelRegistryDisplayNameResult | { success: false; error: string } {
  try {
    return getOnethingModelRegistryDisplayName(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'get model display name', error)
  }
}

/**
 * 「这条线上的这个模型,渲染层该开哪几个口」(P4-7)。
 *
 * 与目录查询(`getAll` / `search`)是两件事:那些回的是**目录条目**,这一条回的
 * 是**这条线真正接得住什么** —— 账本(能不能)∧ provider 的传输声明(这条线的
 * codec 放不放得上去)。两半在 `ModelProfile.toAgentModelCapabilities` 里已经合
 * 过一次,这里只投影,不再判第二遍。
 */
export interface OnethingRendererModelCapabilities {
  supportsVision: boolean
  supportsFiles: boolean
  supportsImageOutput: boolean
}

export function projectOnethingRendererModelCapabilities(
  capabilities: AgentModelCapabilities,
): OnethingRendererModelCapabilities {
  return {
    supportsVision: agentSupportsInputModality(capabilities, 'image'),
    supportsFiles: agentSupportsInputModality(capabilities, 'file'),
    supportsImageOutput: agentSupportsOutputModality(capabilities, 'image'),
  }
}

export interface GetOnethingModelCapabilitiesOptions {
  providerId: string
  model: string
  /** 装配层的事:把设置里的凭据/目录折成 provider。认不出就给 undefined。 */
  createProvider(providerId: string, model: string): AgentProvider | undefined
}

export interface OnethingModelCapabilitiesResult {
  success: true
  capabilities: OnethingRendererModelCapabilities
}

export async function getOnethingModelCapabilities(
  options: GetOnethingModelCapabilitiesOptions,
): Promise<OnethingModelCapabilitiesResult> {
  if (!options.providerId || !options.model) {
    throw new Error('providerId and model are required')
  }
  const provider = options.createProvider(options.providerId, options.model)
  if (!provider) throw new Error(`unsupported provider: ${options.providerId}`)
  return {
    success: true,
    capabilities: projectOnethingRendererModelCapabilities(
      await resolveAgentModelCapabilities(provider, options.model),
    ),
  }
}

export async function getOnethingModelCapabilitiesForIpc(
  options: GetOnethingModelCapabilitiesOptions & { logger?: OnethingModelQueryIpcLogger },
): Promise<OnethingModelCapabilitiesResult | { success: false; error: string }> {
  try {
    return await getOnethingModelCapabilities(options)
  } catch (error) {
    return modelQueryIpcError(options.logger, 'get model capabilities', error)
  }
}

function modelQueryIpcError(
  logger: OnethingModelQueryIpcLogger | undefined,
  label: string,
  error: unknown,
): { success: false; error: string } {
  logger?.error?.(`[Models] Failed to ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }
}
