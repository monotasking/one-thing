/**
 * Evals Provider Adapter
 *
 * Bridges the injectable EvalModelCaller interface (from
 * packages/onething-runtime/src/evals/model-call.ts) to the app's
 * configured provider credentials.
 *
 * Design D3: The runner does not embed an HTTP client. This adapter
 * provides the model-call function using settings-derived API keys
 * and base URLs, so eval runs use the same provider configuration
 * as real chats (same base URL, same API key, same auth).
 *
 * Future: replace raw fetch with proper provider-stack integration
 * (AI SDK generateText) once non-streaming single-turn support is
 * confirmed across all providers (§7 风险).
 */

import * as store from "@onething/backend/store.js";
import type { EvalModelCaller } from "@onething/runtime";
import { onethingBaseBuiltinProviders } from "@onething/runtime/providers";
import { recordUsage } from "@onething/backend/wiring/usage/index.js";
import { getLogger } from "@onething/backend/logging/index.js";

const log = getLogger("ipc.evals");

interface ResolvedEvalsCredentials {
	ok: boolean;
	apiKey?: string;
	baseUrl?: string;
	reason?: string;
}

/**
 * Resolve API credentials for an eval run without making a request, so
 * EVALS_RUN_START can fail fast instead of recording a run where every
 * attempt throws "No API key".
 */
export function resolveEvalsCredentials(
	providerId: string,
): ResolvedEvalsCredentials {
	const settings = store.getSettings();
	const providerConfig = (settings?.ai?.providers as any)?.[providerId];

	if (providerConfig?.authType === "oauth") {
		return {
			ok: false,
			reason: `Provider "${providerId}" uses OAuth; eval runs currently support API-key providers only`,
		};
	}

	const apiKey: string =
		providerConfig?.apiKey || (settings?.ai as any)?.apiKey || "";
	// Fall back to the provider's own registered default base URL, not a
	// hardcoded OpenAI endpoint — e.g. deepseek without an explicit baseUrl
	// must resolve to https://api.deepseek.com.
	const builtinDefault = onethingBaseBuiltinProviders.find(
		(p) => p.id === providerId,
	)?.info.defaultBaseUrl;
	const baseUrl: string =
		providerConfig?.baseUrl || builtinDefault || "https://api.openai.com/v1";

	if (!apiKey) {
		return {
			ok: false,
			reason: `No API key configured for provider "${providerId}"`,
		};
	}

	return { ok: true, apiKey, baseUrl };
}

export function createEvalsModelCaller(
	providerId: string,
	model: string,
): EvalModelCaller {
	return async (opts) => {
		// Scene replays carry the ORIGIN provider/model (scene/params.json).
		// Route to that provider when its credentials resolve — otherwise a
		// claude incident would silently "reproduce" on the eval-default
		// endpoint while the transcript claims the original model. When the
		// origin can't be served, fall back to the eval binding INCLUDING its
		// model name (the origin model doesn't exist on the fallback endpoint).
		let effectiveModel = model;
		let effectiveProviderId = providerId;
		let credentials = resolveEvalsCredentials(providerId);
		if (opts.provider && opts.provider !== providerId) {
			const origin = resolveEvalsCredentials(opts.provider);
			if (origin.ok) {
				credentials = origin;
				effectiveProviderId = opts.provider;
				effectiveModel = opts.model || model;
			} else {
				log.warn("origin provider unavailable, falling back", {
					originProvider: opts.provider,
					reason: origin.reason,
					fallbackProvider: providerId,
					fallbackModel: model,
				});
			}
		} else if (opts.provider === providerId && opts.model) {
			// Same provider: honor the scene's exact model.
			effectiveModel = opts.model;
		}
		if (!credentials.ok) {
			throw new Error(credentials.reason);
		}
		const apiKey = credentials.apiKey!;
		const baseUrl = credentials.baseUrl!;

		const body: Record<string, unknown> = {
			model: effectiveModel,
			messages: opts.messages.map((m) => {
				// Full tool-calling protocol so agent-loop replay is faithful
				if (m.role === "tool") {
					return {
						role: "tool",
						tool_call_id: m.toolCallId,
						content: m.content,
					};
				}
				const base: Record<string, unknown> = {
					role: m.role === "developer" ? "system" : m.role,
					content: m.content,
				};
				if (m.role === "assistant" && m.toolCalls?.length) {
					base.tool_calls = m.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function",
						function: { name: tc.name, arguments: tc.argsJson },
					}));
				}
				return base;
			}),
			max_tokens: opts.maxTokens ?? 2048,
		};

		// Mirror the production deepseek rule: thinking-enabled requests carry
		// thinking/reasoning_effort and OMIT temperature.
		if (opts.thinking) {
			body.thinking = { type: opts.thinking };
			if (opts.thinking === "enabled" && opts.reasoningEffort) {
				body.reasoning_effort = opts.reasoningEffort;
			}
		}
		if (opts.thinking !== "enabled") {
			body.temperature = opts.temperature ?? 0;
		}

		if (opts.tools && opts.tools.length > 0) {
			body.tools = opts.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description || "",
					parameters: t.parameters || {
						type: "object",
						properties: {},
					},
				},
			}));
			body.tool_choice = "auto";
		}

		const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: opts.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
		}

		const data: any = await response.json();
		const choice = data.choices?.[0];
		if (!choice) throw new Error("No choices in response");

		const message = choice.message || {};
		const toolCalls = (message.tool_calls || []).map((tc: any) => ({
			id: tc.id,
			name: tc.function?.name || "unknown",
			args: (() => {
				try {
					return JSON.parse(tc.function?.arguments || "{}");
				} catch {
					return {};
				}
			})(),
		}));

		if (data.usage) {
			try {
				recordUsage({
					providerId: effectiveProviderId,
					modelId: effectiveModel,
					source: "evals",
					usage: {
						inputTokens: data.usage.prompt_tokens ?? 0,
						outputTokens: data.usage.completion_tokens ?? 0,
						totalTokens: data.usage.total_tokens,
					},
				});
			} catch (error) {
				log.error("record usage failed", undefined, error);
			}
		}

		return {
			content: message.content || "",
			toolCalls,
			finishReason: choice.finish_reason || "stop",
			usage: data.usage
				? {
						promptTokens: data.usage.prompt_tokens,
						completionTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens,
					}
				: undefined,
		};
	};
}
