/**
 * GitHub Copilot 的**列表口**(manifest `models.kind === 'endpoint'`):每次现取;取不到退回设置里的
 * 缓存目录。由 `runtime.ts` 的 `createModelsFetcher` 交给宿主(`backend/runtime/providers/providers-client-api-models.ts`
 * 按名册建表,不再点名)。
 *
 * 服务商自述试点 P2 第 4 批从 `providers/model-registry.ts` 搬回家(`fetchOnethingGitHubCopilotModelsWithAuth`
 * 与 `createOnethingCopilotModelsFetcher` 逐字)。
 */
import type {
	OnethingAccessTokenLike,
	OnethingEndpointModelsFetcher,
	OnethingModelRegistryRefreshLogger,
	OnethingOpenRouterModel,
} from "../../model-registry.js";
import { copilotModelInfoToOnethingOpenRouterModel } from "./models.js";

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

export interface OnethingCopilotModelsFetcherOptions {
	fetchCopilotModels(): Promise<
		Array<{ id: string; name?: string; description?: string }>
	>;
	getModelsForProvider(providerId: string): Promise<OnethingOpenRouterModel[]>;
	logger?: OnethingModelRegistryRefreshLogger;
}

/** Copilot 的列表口:每次现取;取不到退回设置里的缓存目录。 */
export function createOnethingCopilotModelsFetcher(
	options: OnethingCopilotModelsFetcherOptions,
): OnethingEndpointModelsFetcher {
	return {
		async list(request) {
			try {
				const copilotModels = await options.fetchCopilotModels();
				return {
					success: true,
					models: copilotModels.map((model) =>
						copilotModelInfoToOnethingOpenRouterModel(model),
					),
				};
			} catch (error) {
				options.logger?.warn?.(
					"[Models] Failed to fetch Copilot models:",
					error instanceof Error ? error.message : String(error),
				);
				const registryModels = await options.getModelsForProvider(
					request.providerId,
				);
				if (registryModels.length > 0) {
					return { success: true, models: registryModels };
				}
				return {
					success: false,
					error: "No models available. Please refresh the model registry.",
				};
			}
		},
	};
}
