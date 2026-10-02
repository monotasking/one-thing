/**
 * Model Call Interface (Injectable)
 *
 * Runner does NOT embed an HTTP client. CLI injects an OpenAI-compatible
 * fetch-based caller; the desktop app injects one that goes through the
 * app's configured provider stack (so eval requests travel the same
 * message-conversion pipeline as real chats).
 */

/**
 * A chat message as used by the model caller.
 *
 * Tool-calling protocol: an assistant message may carry `toolCalls`
 * (each with the raw JSON arguments string), and a `tool` message answers
 * one of them via `toolCallId`. Callers map these to the provider's wire
 * format (OpenAI-compatible `tool_calls` / `tool_call_id`) — required for
 * faithful agent-loop replay of captured scenes.
 */
export interface EvalChatMessage {
	role: "system" | "user" | "assistant" | "developer" | "tool";
	content: string;
	toolCalls?: Array<{ id: string; name: string; argsJson: string }>;
	toolCallId?: string;
}

/**
 * Tools definition passed to the model.
 */
export interface EvalToolDef {
	type: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Result of a model call for evaluation.
 */
export interface EvalModelResponse {
	content: string;
	toolCalls: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
	}>;
	finishReason: string;
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

/**
 * Model call options.
 */
export interface EvalModelCallOptions {
	messages: EvalChatMessage[];
	model: string;
	/**
	 * Preferred ORIGIN provider for this call (scene replays carry the
	 * provider the incident actually ran on). Callers that can route
	 * per-provider honor it when credentials resolve, and fall back to
	 * their bound provider+model otherwise; callers that can't route
	 * (CLI env-based client) ignore it.
	 */
	provider?: string;
	tools?: EvalToolDef[];
	/** Sampling params from the captured scene (params.json). */
	temperature?: number;
	maxTokens?: number;
	thinking?: "enabled" | "disabled";
	reasoningEffort?: string;
	signal?: AbortSignal;
	/** Metadata for snapshot tracing (caseId, attempt index). */
	metadata?: {
		caseId: string;
		attempt: number;
		runTs: string;
	};
}

/**
 * Injected model caller type.
 * The caller is responsible for authentication, URL routing, and
 * any provider-specific message transformation.
 */
export type EvalModelCaller = (
	options: EvalModelCallOptions,
) => Promise<EvalModelResponse>;
