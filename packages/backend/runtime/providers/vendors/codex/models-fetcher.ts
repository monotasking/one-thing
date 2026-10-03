/**
 * Codex 的**列表口**(manifest `models.kind === 'endpoint'`):不点刷新 = 读缓存 ∪ 用户勾过的兜底;
 * 点了刷新 = 拿登录态现取、落盘,取不到退回缓存 ∪ 整张兜底表。由 `runtime.ts` 的
 * `createModelsFetcher` 交给宿主(`backend/runtime/providers/providers-client-api-models.ts` 按名册建表,不再点名)。
 *
 * 服务商自述试点 P2 第 4 批从 `providers/model-registry.ts` 搬回家(`createOnethingCodexModelsFetcher`
 * 逐字)。
 */
import {
	getConfiguredOnethingFallbackModels,
	mergeOnethingModelsById,
	type OnethingConfiguredModelSelection,
	type OnethingEndpointModelsFetcher,
	type OnethingModelRegistryRefreshLogger,
	type OnethingOpenRouterModel,
} from "../../model-registry.js";

export interface OnethingCodexModelsFetcherOptions {
	fetchCodexModels(): Promise<OnethingOpenRouterModel[]>;
	getModelsForProvider(providerId: string): Promise<OnethingOpenRouterModel[]>;
	saveProviderModels(
		providerId: string,
		models: OnethingOpenRouterModel[],
	): Promise<void> | void;
	getCodexFallbackModels(modelIds?: string[]): OnethingOpenRouterModel[];
	getConfiguredCodexModelSelection():
		| OnethingConfiguredModelSelection
		| undefined;
	logger?: OnethingModelRegistryRefreshLogger;
}

/**
 * Codex 的列表口:不点刷新 = 读缓存 ∪ 用户勾过的兜底;点了刷新 = 拿登录态现取、落盘,
 * 取不到退回缓存 ∪ 整张兜底表。
 */
export function createOnethingCodexModelsFetcher(
	options: OnethingCodexModelsFetcherOptions,
): OnethingEndpointModelsFetcher {
	const configuredFallbacks = (): OnethingOpenRouterModel[] =>
		getConfiguredOnethingFallbackModels(
			options.getConfiguredCodexModelSelection(),
			options.getCodexFallbackModels,
		);
	const cachedWithFallbacks = async (
		providerId: string,
		includeDefaultFallback = false,
	): Promise<OnethingOpenRouterModel[]> => {
		const groups = [
			await options.getModelsForProvider(providerId),
			configuredFallbacks(),
		];
		if (includeDefaultFallback) groups.push(options.getCodexFallbackModels());
		return mergeOnethingModelsById(...groups);
	};
	return {
		async list(request) {
			if (!request.forceRefresh) {
				return {
					success: true,
					models: await cachedWithFallbacks(request.providerId),
				};
			}
			try {
				const models = await options.fetchCodexModels();
				await options.saveProviderModels(request.providerId, models);
				return {
					success: true,
					models: mergeOnethingModelsById(models, configuredFallbacks()),
				};
			} catch (error) {
				options.logger?.warn?.(
					"[Models] Failed to fetch Codex models, using fallback:",
					error instanceof Error ? error.message : String(error),
				);
				return {
					success: true,
					models: await cachedWithFallbacks(request.providerId, true),
				};
			}
		},
	};
}
