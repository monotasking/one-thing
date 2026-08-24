/**
 * Agent provider for background "utility" work — the calls the app makes on
 * its own rather than on a user turn: skill review, session TOC, and anything
 * else that should run on `settings.tools.toolCallModel` instead of whatever
 * model the chat happens to be using.
 *
 * This assembles the four steps every such caller needs (resolve the tool-call
 * model → look up its provider config → resolve auth → build the agent
 * provider). Each caller used to open-code them, which is how skill review and
 * title generation ended up with subtly different fallback rules.
 *
 * See docs/design/session-toc.md §10.
 */
import type { AgentProvider } from "@onething/core/agent-loop";
import type { AppSettings } from "@shared/ipc.js";
import { createAgentProviderFromRuntime } from "../agent-loop/index.js";
import { pickOnethingProviderOptions } from "@onething/runtime/providers";
import {
	getProviderApiType,
	resolveProviderAuth,
} from "../engine/stream/provider-helpers.js";
import { resolveUtilityModel } from "@onething/runtime/providers/utility-model.wiring";
import { applySessionSpaceCredentials } from "./space-credentials.js";
import type { CreateAgentProviderFromRuntimeOptions } from '@onething/runtime/agent-loop/providers/factory'

export interface UtilityProviderRef {
	provider: AgentProvider;
	providerId: string;
	model: string;
	thinking?: boolean;
	thinkingEffort?: unknown;
	thinkingByModel?: Record<string, boolean | undefined>;
	thinkingEffortByModel?: Record<string, unknown>;
}

export interface CreateUtilityProviderOptions {
	workingDirectory?: string;
	sessionId?: string;
	/**
	 * When the tool-call model is not configured, fall back to the chat
	 * provider instead of giving up.
	 *
	 * Off by default, which is the conservative choice: background work that
	 * silently runs on an expensive chat model is worse than background work
	 * that does not run. Title generation opts in (it must always produce
	 * something); skill review does not.
	 */
	fallbackToChatProvider?: boolean;
}

// The routing question ("which provider/model does background work use?") lives
// in its own leaf so the plugin LLM surface can ask it without dragging the
// agent-loop in behind it. See utility-model.ts.
export { resolveUtilityModel } from "@onething/runtime/providers/utility-model.wiring";

/**
 * Returns undefined whenever the provider cannot be built — unconfigured,
 * unknown provider, or missing auth. Callers treat that as "skip this work",
 * never as an error: background work must not surface failures to the user.
 */
export async function createUtilityProvider(
	settings: AppSettings,
	options: CreateUtilityProviderOptions = {},
): Promise<UtilityProviderRef | undefined> {
	const resolved = resolveUtilityModel(
		settings,
		options.fallbackToChatProvider === true,
	);
	if (!resolved) return undefined;

	// per-space 凭证(批 B3):这条路自己读 settings,所以隔离闸也得自己挂一次。
	// 会话属于非 default 空间而那个空间没配这个 provider → 拿不到 auth →
	// 与「没配工具模型」同一条出路:静默跳过,后台工作永不向用户报错。
	const providerConfig = applySessionSpaceCredentials(
		options.sessionId ?? "",
		resolved.providerId,
		settings.ai?.providers?.[resolved.providerId],
	);
	if (!providerConfig) return undefined;

	const authContext = await resolveProviderAuth(resolved.providerId, providerConfig);
	if (!authContext) return undefined;

	const createAgentProviderFromRuntimeOptions: CreateAgentProviderFromRuntimeOptions = {
		workingDirectory: options.workingDirectory,
		localSessionId: options.sessionId,
	};
	const provider = createAgentProviderFromRuntime(
		resolved.providerId,
		{
			...providerConfig,
			// Background work reads settings directly rather than going through
			// getEffectiveProviderConfig, so it has to pack the provider's own
			// dials itself — otherwise a zhipu coding-plan / qwen intl account
			// would quietly bill its side-line calls to the wrong endpoint.
			providerOptions: pickOnethingProviderOptions(
				resolved.providerId,
				providerConfig as unknown as Record<string, unknown>,
			),
			model: resolved.model,
			apiKey: authContext.kind === "api-key" ? authContext.apiKey : "",
			authContext,
			oauthToken:
				authContext.kind === "oauth" ? authContext.token : providerConfig.oauthToken,
			apiType: getProviderApiType(settings, resolved.providerId),
		},
		createAgentProviderFromRuntimeOptions,
	);
	if (!provider) return undefined;

	const toolCallModel = settings.tools?.toolCallModel;
	return {
		provider,
		providerId: resolved.providerId,
		model: resolved.model,
		thinking:
			typeof toolCallModel?.thinking === "boolean" ? toolCallModel.thinking : undefined,
		thinkingEffort: toolCallModel?.thinkingEffort,
		thinkingByModel: providerConfig.thinkingByModel,
		thinkingEffortByModel: providerConfig.thinkingEffortByModel,
	};
}
