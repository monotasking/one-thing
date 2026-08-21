/**
 * "Which provider/model should background work use?" — the routing question on
 * its own, with nothing else attached.
 *
 * It lives in its own leaf rather than inside `utility-provider.ts` because it
 * has two consumers with *different result shapes*:
 *
 *   - `createUtilityProvider` wants an `AgentProvider` (skill review, session
 *     TOC, title generation) and so pulls in the whole agent-loop;
 *   - the managed plugin LLM surface (`app/plugins/llm.ts` → `api.llm.complete`)
 *     wants a plain `generateChatResponse` call and must NOT drag the
 *     agent-loop in behind it.
 *
 * Same question, same answer, two callers — and answering it twice is exactly
 * how skill review and title generation ended up with subtly different fallback
 * rules before `utility-provider.ts` existed. A zero-dependency leaf keeps one
 * answer without making the cheap caller pay the expensive caller's imports.
 *
 * See docs/design/session-toc.md §10.
 */
import type { AppSettings } from "@shared/ipc.js";

export interface ResolvedUtilityModel {
	providerId: string;
	model: string;
}

/**
 * Resolve the tool-call model, optionally falling back to the chat provider.
 *
 * `fallbackToChatProvider` is off by default at every call site that can
 * legitimately do nothing: background work that silently runs on an expensive
 * chat model is worse than background work that does not run. Callers that
 * must always produce something (title generation, the plugin LLM surface —
 * whose contract is "this host has a managed LLM or it does not") opt in.
 */
export function resolveUtilityModel(
	settings: AppSettings,
	fallbackToChatProvider: boolean,
): ResolvedUtilityModel | undefined {
	const toolCallModel = settings.tools?.toolCallModel;
	const configuredProviderId = toolCallModel?.providerId?.trim();
	const configuredModel = toolCallModel?.model?.trim();

	if (configuredProviderId && settings.ai?.providers?.[configuredProviderId]) {
		const providerConfig = settings.ai.providers[configuredProviderId];
		const model =
			configuredModel ||
			providerConfig?.model ||
			providerConfig?.selectedModels?.[0] ||
			"";
		if (model) return { providerId: configuredProviderId, model };
	}

	if (!fallbackToChatProvider) return undefined;

	const providerId = settings.ai?.provider;
	if (!providerId) return undefined;
	const providerConfig = settings.ai?.providers?.[providerId];
	const model =
		providerConfig?.model || providerConfig?.selectedModels?.[0] || "";
	return model ? { providerId, model } : undefined;
}
